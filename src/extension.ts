import * as vscode from 'vscode';
import { LogDataProvider } from './ApexLogDataProvider';
import { ApexLog } from './ApexLogWrapper';
import * as path from 'path';
import { getConnection, retryOnSessionExpire } from './connection';
import { setLogVisibility, deleteAllLogs, toggleAutoRefresh, showOptions, showSearchBox, clearSearch, clearDownloadedLogs, exportFilteredLogs, setTraceFlagForUser, deleteAllTraceFlagsExceptCurrent } from './commands';
import { ApexLogPanelProvider } from './ApexLogPanel/ApexLogPanelProvider';
import { reconfigureTraceFlagKeepAlive, stopTraceFlagKeepAlive } from './TraceFlagManager';
import { ApexLogDetails } from './ApexLogDetails/ApexLogDetails';
import { outputChannel } from './outputChannel';

export { outputChannel } from './outputChannel';

let logDataProvider: LogDataProvider | undefined;
let logDataProviderPromise: Promise<LogDataProvider> | undefined;
let extensionContext: vscode.ExtensionContext;
let activeProvider: ApexLogPanelProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
    const showOutputOnStart = config.get<boolean>('showOutputOnStart') ?? true;
    context.subscriptions.push(outputChannel);
    if (showOutputOnStart) {
        outputChannel.show(true); // Make output visible
    }
    outputChannel.appendLine('Activating Salesforce Log Viewer extension...');

    // Register the ApexLogDetails command
    ApexLogDetails.registerCommand(context);

    //Creacion de los fileWatchers para comprobar cambios de org en el fichero de configuracion
    setupConfigFileWatchers(context);

    const provider = new ApexLogPanelProvider(context.extensionUri, getLogDataProvider);
    activeProvider = provider;

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('salesforceLogsView', provider)
    );

    //Registrar los comandos de la extension
    registerCommands(context, provider);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async event => {
        if (!event.affectsConfiguration('salesforceAgLogViewer')) {
            return;
        }

        const currentConfig = vscode.workspace.getConfiguration('salesforceAgLogViewer');
        if (logDataProvider) {
            await logDataProvider.applyConfiguration({
                autoRefresh: currentConfig.get('autoRefresh') ?? true,
                refreshInterval: currentConfig.get('refreshInterval') ?? 5000,
                currentUserOnly: currentConfig.get('currentUserOnly') ?? true
            });
        }
        if (event.affectsConfiguration('salesforceAgLogViewer.traceFlagExpirationInterval')) {
            await reconfigureTraceFlagKeepAlive(currentConfig.get('traceFlagExpirationInterval') ?? 15);
        }
    }));
    outputChannel.appendLine('Extension activation complete');

    //TODO: setting para mostrar el panel de logs al activarse o no
    setTimeout(() => {
        vscode.commands.executeCommand('salesforceLogsView.focus');
    }, 500); //Delay antes de cerrar el output panel
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
    const watcher = vscode.workspace.createFileSystemWatcher(configPath);
    let changeTimer: NodeJS.Timeout | undefined;

    const handleConfigChange = () => {
        if (changeTimer) {
            clearTimeout(changeTimer);
        }
        changeTimer = setTimeout(async () => {
        try {
            if (activeProvider) {
                // Always stop all trace flag keep-alive timers before switching orgs
                stopTraceFlagKeepAlive();
                if (!logDataProvider) {
                    const initializedProvider = await getLogDataProvider();
                    const latestConnection = await getConnection();
                    if (initializedProvider.connection !== latestConnection) {
                        await initializedProvider.updateConnection(latestConnection);
                    } else {
                        await initializedProvider.refreshLogs(true, false);
                    }
                    activeProvider.postMessage({ type: 'orgChanged' });
                    return;
                }
                //Mostrar notificacion de cambio de org si el panel esta visible
                if (logDataProvider.isVisible) {
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: 'Switching org and retrieving logs',
                        cancellable: false
                    }, async (progress) => {
                        progress.report({ message: 'Updating connection...' });
                        const newConnection = await getConnection();
                        await logDataProvider!.updateConnection(newConnection);
                        progress.report({ message: 'Refreshing logs...' });
                        await new Promise(res => setTimeout(res, 300));
                    });
                    outputChannel.appendLine('Updated connection and refreshed logs after org change');
                } else {
                    // If not visible, just update connection and logs silently
                    const newConnection = await getConnection();
                    await logDataProvider.updateConnection(newConnection);
                    outputChannel.appendLine('Updated connection and refreshed logs after org change (panel hidden)');
                }
                activeProvider.postMessage({ type: 'orgChanged' });
            }
        } catch (error) {
            outputChannel.appendLine(`Error handling config file change: ${error}`);
        }
        }, 400);
    };

    watcher.onDidCreate(handleConfigChange);
    watcher.onDidChange(handleConfigChange);
    watcher.onDidDelete(handleConfigChange);
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
        ['salesforce-ag-log-viewer.exportFilteredLogs', exportFilteredLogs],
        ['salesforce-ag-log-viewer.setTraceFlagForUser', setTraceFlagForUser],
        ['salesforce-ag-log-viewer.deleteAllTraceFlagsExceptCurrent', deleteAllTraceFlagsExceptCurrent]
    ];

    const disposables = commands.map(([id, handler]) =>
        vscode.commands.registerCommand(id, handler)
    );

    context.subscriptions.push(...disposables);
}

//Metodo que se llama cuando la extension se desactiva (standard)
export function deactivate() {
    stopTraceFlagKeepAlive();
    if (logDataProvider) {
        logDataProvider.dispose();
        logDataProvider = undefined;
    }
}

//Obtener el provider de la extension con la configuracion y conexion actual
export async function getLogDataProvider(): Promise<LogDataProvider> {
    if (logDataProvider) {
        return logDataProvider;
    }
    if (!logDataProviderPromise) {
        logDataProviderPromise = (async () => {
        const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
        const connection = await getConnection();
            const provider = await LogDataProvider.create(
            extensionContext,
            connection,
            {
                autoRefresh: config.get('autoRefresh') ?? true,
                refreshInterval: config.get('refreshInterval') ?? 5000,
                currentUserOnly: config.get('currentUserOnly') ?? true
            }
        );
            if (activeProvider) {
                provider.setActiveProvider(activeProvider);
                extensionContext.subscriptions.push(provider.onDidChangeData(({ data, isAutoRefresh }) => {
                    activeProvider?.updateView(data, isAutoRefresh);
                }));
            }
            logDataProvider = provider;
        outputChannel.appendLine('Log provider initialized (lazy)');
            return provider;
        })().finally(() => {
            logDataProviderPromise = undefined;
        });
    }
    return logDataProviderPromise;
}

//Metodo que abre un log especifico por su ID una vez el usuario ha dado click en el log
export async function openLog(data: { id: string }) {
    try {
        const provider = await getLogDataProvider();
        activeProvider?.postMessage({ type: 'logDownloadState', logId: data.id, state: 'downloading' });
        // Use retryOnSessionExpire to handle session expiration
        const result = await retryOnSessionExpire(
            (conn) => conn.tooling.retrieve('ApexLog', data.id) as Promise<any>,
            provider
        );
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
        }, provider.connection);

        if (!await provider.logFileManager.hasCachedLog(log)) {
            const warningMb = Math.max(vscode.workspace.getConfiguration('salesforceAgLogViewer').get<number>('largeLogWarningMb') ?? 5, 1);
            if (log.size >= warningMb * 1024 * 1024) {
                const choice = await vscode.window.showWarningMessage(
                    `This log is ${(log.size / 1024 / 1024).toFixed(1)} MB.`,
                    { modal: true, detail: 'Download the complete log or open an in-memory preview of the first 1,000 lines.' },
                    'Download Full Log',
                    'Open Preview'
                );
                if (choice === 'Open Preview') {
                    const body = await retryOnSessionExpire(connection => log.getBody(connection), provider);
                    const preview = body.split(/\r?\n/).slice(0, 1000).join('\n');
                    const document = await vscode.workspace.openTextDocument({
                        content: `${preview}\n\n--- Preview limited to the first 1,000 lines ---`,
                        language: 'salesforce-apex-log'
                    });
                    await vscode.window.showTextDocument(document, { preview: false });
                    provider.markLogAsOpened(log.id);
                    activeProvider?.postMessage({ type: 'logDownloadState', logId: data.id, state: 'downloaded' });
                    return;
                }
                if (choice !== 'Download Full Log') {
                    activeProvider?.postMessage({ type: 'logDownloadState', logId: data.id, state: 'failed', message: 'Download cancelled.' });
                    return;
                }
            }
        }

        await provider.logFileManager.showLog(log, () => retryOnSessionExpire(
            (connection) => log.getBody(connection),
            provider
        ));

        // Mark the log as opened (set status to 'downloaded' and refresh UI)
        logDataProvider?.markLogAsOpened(log.id);
        activeProvider?.postMessage({ type: 'logDownloadState', logId: data.id, state: 'downloaded' });
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        activeProvider?.postMessage({ type: 'logDownloadState', logId: data.id, state: 'failed', message: errorMessage });
        vscode.window.showErrorMessage(`Failed to open log: ${errorMessage}`);
    }
}