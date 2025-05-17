import * as vscode from 'vscode';
import { LogDataProvider } from './logDataProvider';
import { DeveloperLog } from './developerLog';
import * as fs from 'fs';
import * as path from 'path';
import { createConnection } from './connection';
import { setLogVisibility, deleteAllLogs, toggleAutoRefresh, showOptions, showSearchBox, clearSearch, clearDownloadedLogs } from './commands';

let logDataProvider: LogDataProvider | undefined;
let extensionContext: vscode.ExtensionContext;
export const outputChannel = vscode.window.createOutputChannel('Salesforce AG Log Viewer');
let activeProvider: LogViewProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    context.subscriptions.push(outputChannel);
    outputChannel.show(true); // Make output visible
    outputChannel.appendLine('Activating Salesforce Log Viewer extension...');

    try {
        // Create and register the webview provider first
        const provider = new LogViewProvider(context.extensionUri);
        activeProvider = provider;
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('salesforceLogsView', provider)
        );

        // Set up config file watchers
        setupConfigFileWatchers(context);

        // Create and initialize the log provider with the webview provider
        await getLogDataProvider(); // Only create, do not refresh logs yet
        outputChannel.appendLine('Log provider initialized');

        // Register commands
        registerCommands(context, provider);

        // Subscribe to data changes
        logDataProvider?.onDidChangeData(({ data, isAutoRefresh }) => {
            provider.updateView(data, isAutoRefresh);
        });

        outputChannel.appendLine('Extension activation complete');

        // After showing output, always focus the Salesforce Log Viewer panel webview
        setTimeout(() => {
            vscode.commands.executeCommand('salesforceLogsView.focus');
        }, 500); // Small delay to ensure output is shown first
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
                // Only show spinner if the panel is visible
                if (logDataProvider['isVisible']) {
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: 'Switching org and retrieving logs',
                        cancellable: false
                    }, async (progress) => {
                        progress.report({ message: 'Updating connection...' });
                        const newConnection = await createConnection();
                        await logDataProvider!.updateConnection(newConnection);
                        progress.report({ message: 'Refreshing logs...' });
                        await new Promise(res => setTimeout(res, 300));
                    });
                    outputChannel.appendLine('Updated connection and refreshed logs after org change');
                    // Send orgChanged message to webview to close search bar
                    activeProvider?.postMessage({ type: 'orgChanged' });
                } else {
                    // If not visible, just update connection and logs silently
                    const newConnection = await createConnection();
                    await logDataProvider!.updateConnection(newConnection);
                    outputChannel.appendLine('Updated connection and refreshed logs after org change (panel hidden)');
                }
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
        ['salesforce-ag-log-viewer.clearSearch', clearSearch],
        ['salesforce-ag-log-viewer.clearDownloadedLogs', clearDownloadedLogs]
    ];

    const disposables = commands.map(([id, handler]) => 
        vscode.commands.registerCommand(id, handler)
    );
    
    context.subscriptions.push(...disposables);
}

class LogViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _logDataProvider?: LogDataProvider;

    constructor(
        private readonly _extensionUri: vscode.Uri
    ) {}

    public async refresh(): Promise<void> {
        if (this._logDataProvider) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Refreshing Salesforce logs...',
                cancellable: false
            }, async () => {
                await this._logDataProvider!.refreshLogs(false, true);
            });
        }
    }

    public postMessage(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    public showSearchBoxInWebview() {
        this.postMessage({ type: 'showSearchBox' });
    }

    public updateView(data?: any[], isAutoRefresh: boolean = false) {
        const gridData = data || this._logDataProvider?.getGridData();
        this.postMessage({ 
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
        this._logDataProvider = logDataProvider;

        // Set initial visibility state
        this._logDataProvider?.setVisibility(webviewView.visible);

        // Ensure auto-refresh starts if enabled and panel is visible
        if (this._logDataProvider && this._logDataProvider.getAutoRefreshSetting() && webviewView.visible) {
            // @ts-ignore: access private method for fix
            this._logDataProvider.startAutoRefresh();
            // Fetch logs immediately when panel becomes visible
            this._logDataProvider.refreshLogs(true, false);
        }

        // Handle visibility changes
        webviewView.onDidChangeVisibility(async () => {
            this._logDataProvider?.setVisibility(webviewView.visible);
            // If becoming visible, just refresh the logs
            if (webviewView.visible) {
                await this.refresh();
            }
        });

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
                const initialData = this._logDataProvider?.getGridData();
                this.updateView(initialData, false);
            } else if (message.command === 'openLog') {
                await openLog({ id: message.log.id });
            } else if (message.command === 'inlineSearch') {
                this._logDataProvider?.setSearchFilter(message.text);
            }
        });
    }

    private _getHtmlForWebview(scriptUri: vscode.Uri, styleUri: vscode.Uri) {
        const templatePath = path.join(this._extensionUri.fsPath, 'src', 'templates', 'logViewer.html');
        let template = fs.readFileSync(templatePath, 'utf8');

        // Replace template variables with actual URIs
        template = template.replace('${scriptUri}', scriptUri.toString());
        template = template.replace('${styleUri}', styleUri.toString());

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
        
        logDataProvider = await LogDataProvider.create(
            extensionContext,
            connection,
            {
                autoRefresh: config.get('autoRefresh') ?? true,
                refreshInterval: config.get('refreshInterval') ?? 5000,
                currentUserOnly: config.get('currentUserOnly') ?? true
            },
            activeProvider
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