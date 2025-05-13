import * as vscode from 'vscode';
import { LogDataProvider } from './logDataProvider';
import { DeveloperLog } from './developerLog';
import * as fs from 'fs';
import * as path from 'path';
import { createConnection } from './connection';
import { setLogVisibility, deleteAllLogs, toggleAutoRefresh, showOptions, showSearchBox, clearSearch } from './commands';

let logDataProvider: LogDataProvider | undefined;
let extensionContext: vscode.ExtensionContext;
let outputChannel: vscode.OutputChannel;
let activeProvider: LogViewProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    outputChannel = vscode.window.createOutputChannel('Salesforce Log Viewer');
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine('Activating Salesforce Log Viewer extension...');

    try {
        // Set up config file watchers
        setupConfigFileWatchers(context);

        // Create and initialize the log provider
        const logProvider = await getLogDataProvider();
        await logProvider.refreshLogs(true);
        outputChannel.appendLine('Initial logs fetched');

        // Create and register the webview provider
        const provider = new LogViewProvider(context.extensionUri, logProvider);
        activeProvider = provider;
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('salesforceLogsView', provider)
        );

        // Register commands
        registerCommands(context, provider);

        // Subscribe to data changes
        logProvider.onDidChangeData(({ data, isAutoRefresh }) => {
            outputChannel.appendLine('Data changed event triggered');
            provider.updateView(data, isAutoRefresh);
        });

        outputChannel.appendLine('Extension activation complete');
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        outputChannel.appendLine(`Activation error: ${errorMessage}`);
        console.error('Activation error:', error);
        vscode.window.showErrorMessage(`Failed to initialize Salesforce Log Viewer: ${errorMessage}`);
    }
}

function setupConfigFileWatchers(context: vscode.ExtensionContext) {
    // Watch workspace config
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
    if (workspaceRoot) {
        const workspaceWatcher = createConfigWatcher(path.join(workspaceRoot, '.sf', 'config.json'));
        context.subscriptions.push(workspaceWatcher);
    }

    // Watch user home config
    const homeDir = process.env.USERPROFILE ?? process.env.HOME;
    if (homeDir) {
        const homeWatcher = createConfigWatcher(path.join(homeDir, '.sf', 'config.json'));
        context.subscriptions.push(homeWatcher);
    }
}

function createConfigWatcher(configPath: string): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(configPath);
    watcher.onDidChange(async () => {
        try {
            if (logDataProvider && activeProvider) {
                const newConnection = await createConnection();
                await logDataProvider.updateConnection(newConnection);
                outputChannel.appendLine('Updated connection and refreshed logs after org change');
            }
        } catch (error) {
            outputChannel.appendLine(`Error handling config file change: ${error}`);
        }
    });
    return watcher;
}

function registerCommands(context: vscode.ExtensionContext, provider: LogViewProvider) {
    type CommandHandler = (...args: any[]) => any;
    const commands: [string, CommandHandler][] = [
        ['salesforce-ag-log-viewer.refreshLogs', async () => await provider.refresh()],
        ['salesforce-ag-log-viewer.openLog', openLog],
        ['salesforce-ag-log-viewer.toggleCurrentUserOnly', setLogVisibility],
        ['salesforce-ag-log-viewer.toggleAutoRefresh', toggleAutoRefresh],
        ['salesforce-ag-log-viewer.deleteAllLogs', deleteAllLogs],
        ['salesforce-ag-log-viewer.showOptions', showOptions],
        ['salesforce-ag-log-viewer.showSearchBox', showSearchBox],
        ['salesforce-ag-log-viewer.clearSearch', clearSearch]
    ];

    const disposables = commands.map(([id, handler]) => 
        vscode.commands.registerCommand(id, handler)
    );
    
    context.subscriptions.push(...disposables);
}

class LogViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private _logDataProvider: LogDataProvider
    ) {
        // Subscribe to data changes
        this._logDataProvider.onDidChangeData(({ data, isAutoRefresh }) => {
            this.updateView(data, isAutoRefresh);
        });
    }

    public async refresh(): Promise<void> {
        await this._logDataProvider.refreshLogs(false, true);
    }

    public updateLogDataProvider(newProvider: LogDataProvider) {
        // Unsubscribe from old provider
        this._logDataProvider.dispose();
        // Update to new provider
        this._logDataProvider = newProvider;
        // Subscribe to new provider's events
        this._logDataProvider.onDidChangeData(({ data, isAutoRefresh }) => {
            this.updateView(data, isAutoRefresh);
        });
        // Update the view with new data
        this.updateView();
    }

    private postMessageToWebview(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    public updateView(data?: any[], isAutoRefresh: boolean = false) {
        const gridData = data || this._logDataProvider.getGridData();
        this.postMessageToWebview({ 
            type: 'updateData',
            data: gridData,
            isAutoRefresh: isAutoRefresh
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        // Handle visibility changes
        webviewView.onDidChangeVisibility(() => {
            this._logDataProvider.setVisibility(webviewView.visible);
            // If becoming visible, refresh immediately to show current data
            if (webviewView.visible) {
                this.refresh();
            }
        });

        // Set initial visibility state
        this._logDataProvider.setVisibility(webviewView.visible);

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        // Create URIs for the external files
        const scriptUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'templates', 'logViewer.js')
        );
        const styleUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'templates', 'logViewer.css')
        );

        webviewView.webview.html = this._getHtmlForWebview(scriptUri, styleUri);

        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'ready') {
                const initialData = this._logDataProvider.getGridData();
                this.updateView(initialData, false);
            } else if (message.command === 'openLog') {
                await openLog({ id: message.log.id });
            }
        });
    }

    private _getHtmlForWebview(scriptUri: vscode.Uri, styleUri: vscode.Uri) {
        const templatePath = path.join(this._extensionUri.fsPath, 'src', 'templates', 'logViewer.html');
        let template = fs.readFileSync(templatePath, 'utf8');

        // Replace the script and style sources with webview URIs
        template = template.replace(
            'href="logViewer.css"',
            `href="${styleUri}"`
        );
        template = template.replace(
            'src="logViewer.js"',
            `src="${scriptUri}"`
        );

        return template;
    }
}

export function deactivate() {
    if (logDataProvider) {
        logDataProvider.dispose();
        logDataProvider = undefined;
    }
}

export async function getLogDataProvider(): Promise<LogDataProvider> {
    if (!logDataProvider) {
        const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
        const connection = await createConnection();
        
        logDataProvider = new LogDataProvider(
            extensionContext,
            connection,
            {
                autoRefresh: config.get('autoRefresh') ?? true,
                refreshInterval: config.get('refreshInterval') ?? 5000,
                currentUserOnly: config.get('currentUserOnly') ?? true
            }
        );
    }
    return logDataProvider;
}

async function openLog(data: { id: string }) {
    try {
        const provider = await getLogDataProvider();
        // Query the full log details with type assertion
        const result = await provider.connection.tooling.retrieve('ApexLog', data.id) as any;
        if (!result) {
            throw new Error(`Log with ID ${data.id} not found`);
        }

        // Create a DeveloperLog instance with the retrieved data
        const log = new DeveloperLog({
            Id: result.Id,
            LogUser: { Name: result.LogUser?.Name || 'Unknown' },
            Operation: result.Operation || '',
            StartTime: result.StartTime || new Date().toISOString(),
            Status: result.Status || '',
            LogLength: result.LogLength || 0,
            DurationMilliseconds: result.DurationMilliseconds || 0,
            Application: result.Application || '',
            Location: result.Location || '',
            Request: result.Request || ''
        }, provider.connection);

        await provider.logViewer.showLog(log);
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        vscode.window.showErrorMessage(`Failed to open log: ${errorMessage}`);
    }
}