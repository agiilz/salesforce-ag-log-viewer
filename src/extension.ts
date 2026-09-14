import * as vscode from 'vscode';
import { LogDataProvider } from './ApexLogDataProvider';
import { ApexLog } from './ApexLogWrapper';
import * as path from 'path';
import { getConnection, retryOnSessionExpire } from './connection';
import { setLogVisibility, deleteAllLogs, toggleAutoRefresh, showOptions, showSearchBox, clearSearch, clearDownloadedLogs, setTraceFlagForUser, deleteAllTraceFlagsExceptCurrent } from './commands';
import { ApexLogPanelProvider } from './ApexLogPanel/ApexLogPanelProvider';
import { stopTraceFlagKeepAlive } from './TraceFlagManager';
import { ApexLogDetails } from './ApexLogDetails/ApexLogDetails';
import { initializeDebugLevels } from './DebugLevelManager';
import { selectDebugLevel, createDebugLevel } from './DebugLevelCommands';

let logDataProvider: LogDataProvider | undefined;
let extensionContext: vscode.ExtensionContext;
let activeProvider: ApexLogPanelProvider | undefined;
let initializationPromise: Promise<void> | undefined;
let reconnectPromise: Promise<void> | undefined;
let reconnectRequested = false;
let extensionComponentsRegistered = false;
let focusScheduled = false;
let extensionActive = false;
export const outputChannel = vscode.window.createOutputChannel('Salesforce AG Log Viewer');

export async function activate(context: vscode.ExtensionContext) {
    extensionActive = true;
    extensionContext = context;
    initializeDebugLevels(context.workspaceState);
    const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
    const showOutputOnStart = config.get<boolean>('showOutputOnStart') ?? true;
    context.subscriptions.push(outputChannel);
    if (showOutputOnStart) {
        outputChannel.show(true); // Make output visible
    }
    outputChannel.appendLine('Activating Salesforce Log Viewer extension...');

    // Register commands that must remain available even if the first connection
    // attempt fails. This allows the user to recover without reloading VS Code.
    ApexLogDetails.registerCommand(context);
    context.subscriptions.push(
        vscode.commands.registerCommand('salesforce-ag-log-viewer.retryConnection', retryConnection)
    );

    // The view must be registered before authentication. Otherwise a missing or
    // expired org leaves VS Code with a contributed view but no data provider.
    activeProvider = new ApexLogPanelProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('salesforceLogsView', activeProvider)
    );
    registerCommands(context, activeProvider);

    if (!focusScheduled) {
        focusScheduled = true;
        setTimeout(() => {
            void vscode.commands.executeCommand('salesforceLogsView.focus');
        }, 500);
    }

    // Watch org configuration before connecting so creating/changing the target
    // org after a failed activation can recover the extension automatically.
    setupConfigFileWatchers(context);

    void initializeExtensionComponents().catch(error => {
        reportConnectionFailure('Activation', error);
    });
}

async function initializeExtensionComponents(forceReconnect: boolean = false): Promise<void> {
    if (!extensionActive) return;

    if (extensionComponentsRegistered) {
        const currentProvider = logDataProvider;
        if (forceReconnect && currentProvider) {
            const connection = await getConnection({ forceRefresh: true });
            if (!extensionActive || logDataProvider !== currentProvider) return;
            await currentProvider.updateConnection(connection);
        }
        return;
    }

    if (initializationPromise) {
        await initializationPromise;
        if (forceReconnect) await initializeExtensionComponents(true);
        return;
    }

    initializationPromise = (async () => {
        const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
        const connection = await getConnection({ forceRefresh: forceReconnect });
        if (!extensionActive) return;

        const dataProvider = await LogDataProvider.create(
            extensionContext,
            connection,
            {
                autoRefresh: config.get('autoRefresh') ?? true,
                refreshInterval: config.get('refreshInterval') ?? 5000,
                currentUserOnly: config.get('currentUserOnly') ?? true
            }
        );
        if (!extensionActive) {
            dataProvider.dispose();
            stopTraceFlagKeepAlive();
            return;
        }

        const panelProvider = activeProvider;
        if (!panelProvider) throw new Error('Salesforce Logs view provider is not registered.');

        dataProvider.setActiveProvider(panelProvider);
        logDataProvider = dataProvider;
        panelProvider.setLogDataProvider(dataProvider);

        extensionContext.subscriptions.push(
            dataProvider.onDidChangeData(({ data, isAutoRefresh }) => {
                panelProvider.updateView(data, isAutoRefresh);
            })
        );

        extensionComponentsRegistered = true;
        outputChannel.appendLine('Extension activation complete');
    })();

    try {
        await initializationPromise;
    } catch (error) {
        // A partially created provider has not been registered at this point, so
        // clear it and allow the Retry Connection command to start cleanly.
        logDataProvider?.dispose();
        logDataProvider = undefined;
        activeProvider?.setLogDataProvider(undefined);
        throw error;
    } finally {
        initializationPromise = undefined;
    }
}

export async function retryConnection(): Promise<void> {
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Connecting to Salesforce...',
        cancellable: false
    }, async () => {
        try {
            await reconnectToConfiguredOrg();
            activeProvider?.postMessage({ type: 'connectionRestored' });
            outputChannel.appendLine('Salesforce connection restored successfully');
            vscode.window.showInformationMessage('Salesforce Log Viewer connected successfully.');
        } catch (error) {
            reportConnectionFailure('Retry connection', error);
        }
    });
}

// Workspace and home config events can arrive together. Complete one switch
// before starting another, then read the latest target if an event arrived meanwhile.
async function reconnectToConfiguredOrg(): Promise<void> {
    reconnectRequested = true;
    if (!reconnectPromise) {
        reconnectPromise = (async () => {
            while (reconnectRequested) {
                reconnectRequested = false;
                stopTraceFlagKeepAlive();
                try {
                    await initializeExtensionComponents(true);
                } catch (error) {
                    if (!reconnectRequested) throw error;
                }
            }
        })().finally(() => { reconnectPromise = undefined; });
    }
    return reconnectPromise;
}

function reportConnectionFailure(context: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    outputChannel.appendLine(`${context} error: ${errorMessage}`);
    console.error(`${context} error:`, error);
    activeProvider?.showConnectionError(error);

    void vscode.window.showErrorMessage(
        `Salesforce Log Viewer could not connect: ${errorMessage}`,
        'Try Again',
        'Show Output'
    ).then(selection => {
        if (selection === 'Try Again') {
            void vscode.commands.executeCommand('salesforce-ag-log-viewer.retryConnection');
        } else if (selection === 'Show Output') {
            outputChannel.show(true);
        }
    });
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

//Metodo para crear un watcher de cambios en el fichero de configuracion .sf/config.json
function createConfigWatcher(configPath: string): vscode.FileSystemWatcher {
    const pattern = new vscode.RelativePattern(path.dirname(configPath), path.basename(configPath));
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handleConfigChange = async () => {
        try {
            if (logDataProvider?.isVisible) {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification,
                    title: 'Switching org and retrieving logs',
                    cancellable: false
                }, reconnectToConfiguredOrg);
            } else {
                await reconnectToConfiguredOrg();
            }
            outputChannel.appendLine('Updated connection and refreshed logs after org change');
            activeProvider?.postMessage({ type: 'orgChanged' });
        } catch (error) {
            reportConnectionFailure('Org configuration change', error);
        }
    };

    watcher.onDidChange(handleConfigChange);
    watcher.onDidCreate(handleConfigChange);
    return watcher;
}

// Este metodo registra los comandos de la extension y los asocia a sus handlers
function registerCommands(context: vscode.ExtensionContext, provider: ApexLogPanelProvider) {
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
        ['salesforce-ag-log-viewer.clearDownloadedLogs', clearDownloadedLogs],
        ['salesforce-ag-log-viewer.setTraceFlagForUser', setTraceFlagForUser],
        ['salesforce-ag-log-viewer.selectDebugLevel', selectDebugLevel],
        ['salesforce-ag-log-viewer.createDebugLevel', createDebugLevel],
        ['salesforce-ag-log-viewer.deleteAllTraceFlagsExceptCurrent', deleteAllTraceFlagsExceptCurrent]
    ];

    const disposables = commands.map(([id, handler]) =>
        vscode.commands.registerCommand(id, handler)
    );

    context.subscriptions.push(...disposables);
}

//Metodo que se llama cuando la extension se desactiva (standard)
export function deactivate() {
    extensionActive = false;
    stopTraceFlagKeepAlive();
    if (logDataProvider) {
        logDataProvider.dispose();
        logDataProvider = undefined;
    }
    activeProvider?.setLogDataProvider(undefined);
    activeProvider = undefined;
    extensionComponentsRegistered = false;
}

//Obtener el provider de la extension con la configuracion y conexion actual
export async function getLogDataProvider(): Promise<LogDataProvider> {
    if (!logDataProvider) {
        await initializeExtensionComponents();
    }
    if (!logDataProvider) {
        throw new Error('Salesforce Log Viewer is not connected. Run "Retry Salesforce Connection".');
    }
    return logDataProvider;
}

//Metodo que abre un log especifico por su ID una vez el usuario ha dado click en el log
export async function openLog(data: { id: string }) {
    let isCurrent = () => true;
    try {
        const provider = await getLogDataProvider();
        let connection = provider.connection;
        isCurrent = () => provider.connection === connection;
        // Use retryOnSessionExpire to handle session expiration
        const result = await retryOnSessionExpire(
            (conn) => {
                connection = conn;
                return conn.tooling.retrieve('ApexLog', data.id) as Promise<any>;
            },
            provider
        );
        if (!isCurrent()) return;
        if (!result) {
            throw new Error(`Log with ID ${data.id} not found`);
        }

        // Create an ApexLog instance with the retrieved data
        const log = new ApexLog({
            Id: result.Id,
            LogUser: { Name: result.LogUser?.Name ?? 'Unknown' },
            Operation: result.Operation ?? '',
            StartTime: result.StartTime ?? new Date().toISOString(),
            Status: result.Status ?? '',
            LogLength: result.LogLength ?? 0,
            DurationMilliseconds: result.DurationMilliseconds ?? 0,
            Application: result.Application ?? '',
            Location: result.Location ?? '',
            Request: result.Request ?? ''
        }, connection);

        await provider.logFileManager.showLog(log, isCurrent);

        // Mark the log as opened (set status to 'downloaded' and refresh UI)
        if (isCurrent()) provider.markLogAsOpened(log.id);
    } catch (error) {
        if (!isCurrent()) return;
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to open log: ${errorMessage}`);
        activeProvider?.postMessage({ type: 'logOpenFailed', logId: data.id });
    }
}
