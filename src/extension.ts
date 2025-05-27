import * as vscode from 'vscode';
import { LogDataProvider } from './ApexLogDataProvider';
import { ApexLog } from './ApexLogWrapper';
import * as path from 'path';
import { getConnection } from './connection';
import { setLogVisibility, deleteAllLogs, toggleAutoRefresh, showOptions, showSearchBox, clearSearch, clearDownloadedLogs } from './commands';
import { ApexLogPanelProvider } from './ApexLogPanel/ApexLogPanelProvider';
import { ApexLogUserDebug } from './ApexLogUserDebug';

let logDataProvider: LogDataProvider | undefined;
let extensionContext: vscode.ExtensionContext;
let activeProvider: ApexLogPanelProvider | undefined;
export const outputChannel = vscode.window.createOutputChannel('Salesforce AG Log Viewer');

export async function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    context.subscriptions.push(outputChannel);
    outputChannel.show(true); // Make output visible
    outputChannel.appendLine('Activating Salesforce Log Viewer extension...');
    
    // Register the ApexLogUserDebug command
    ApexLogUserDebug.registerCommand(context);
    
    try {
        //Creacion de los fileWatchers para comprobar cambios de org en el fichero de configuracion
        setupConfigFileWatchers(context);

        // Use getLogDataProvider to ensure provider is initialized
        const provider = new ApexLogPanelProvider(context.extensionUri, await getLogDataProvider());
        activeProvider = provider;
        (logDataProvider as any).activeProvider = provider;
        
        context.subscriptions.push(
            vscode.window.registerWebviewViewProvider('salesforceLogsView', provider)
        );

        //Registrar los comandos de la extension
        registerCommands(context, provider);
        
        //Suscribirse a eventos de cambio de datos del LogDataProvider
        (await getLogDataProvider()).onDidChangeData(({ data, isAutoRefresh }) => {
            provider.updateView(data, isAutoRefresh);
        });

        outputChannel.appendLine('Extension activation complete');

        //TODO: Hacer que no se enfoque el output si no se quiere
        //Despues de mostrar el output, enfocar el panel de logs
        setTimeout(() => {
            vscode.commands.executeCommand('salesforceLogsView.focus');
        }, 500); //Delay antes de cerrar el output panel

    } catch (error: any) {
        const errorMessage = error?.message ?? 'Unknown error occurred';
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

//Metodo para crear un watcher de cambios en el fichero de configuracion .sf/config.json
function createConfigWatcher(configPath: string): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(configPath);
    
    watcher.onDidChange(async () => {
        try {
            if (logDataProvider && activeProvider) {
                //Mostrar notificacion de cambio de org si el panel esta visible
                if (logDataProvider['isVisible']) {
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: 'Switching org and retrieving logs',
                        cancellable: false
                    }, async (progress) => {                        progress.report({ message: 'Updating connection...' });
                        const newConnection = await getConnection();
                        await (logDataProvider as any).updateConnection(newConnection);
                        progress.report({ message: 'Refreshing logs...' });
                        await new Promise(res => setTimeout(res, 300));
                    });
                    outputChannel.appendLine('Updated connection and refreshed logs after org change');
                    // Send orgChanged message to webview to close search bar
                    activeProvider.postMessage({ type: 'orgChanged' });
                } else {                    
                    // If not visible, just update connection and logs silently
                    const newConnection = await getConnection();
                    await (logDataProvider as any).updateConnection(newConnection);
                    outputChannel.appendLine('Updated connection and refreshed logs after org change (panel hidden)');
                    
                }
            }
        } catch (error) {
            outputChannel.appendLine(`Error handling config file change: ${error}`);
        }
    });
    return watcher;
}

// Este metodo registra los comandos de la extension y los asocia a sus handlers
function registerCommands(context: vscode.ExtensionContext, provider: ApexLogPanelProvider) {
    type CommandHandler = (...args: any[]) => any;    const commands: [string, CommandHandler][] = [
        ['salesforce-ag-log-viewer.refreshLogs', async () => await provider.refresh()],
        ['salesforce-ag-log-viewer.openLog', openLog],
        ['salesforce-ag-log-viewer.toggleCurrentUserOnly', setLogVisibility],
        ['salesforce-ag-log-viewer.toggleAutoRefresh', toggleAutoRefresh],
        ['salesforce-ag-log-viewer.deleteAllLogs', deleteAllLogs],
        ['salesforce-ag-log-viewer.showOptions', showOptions],
        ['salesforce-ag-log-viewer.showSearchBox', showSearchBox],
        ['salesforce-ag-log-viewer.clearSearch', clearSearch],
        ['salesforce-ag-log-viewer.clearDownloadedLogs', clearDownloadedLogs],
        // The toggleDebugLogs command is already registered by ApexLogUserDebug.registerCommand
    ];

    const disposables = commands.map(([id, handler]) => 
        vscode.commands.registerCommand(id, handler)
    );
    
    context.subscriptions.push(...disposables);
}

//Metodo que se llama cuando la extension se desactiva (standard)
export function deactivate() {
    if (logDataProvider) {
        (logDataProvider as any).dispose();
        logDataProvider = undefined;
    }
}

//Obtener el provider de la extension con la configuracion y conexion actual
export async function getLogDataProvider(): Promise<LogDataProvider> {
    if (!logDataProvider) {
        // Create and initialize the log provider if it doesn't exist
        const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
        const connection = await getConnection();
        logDataProvider = await LogDataProvider.create(
            extensionContext,
            connection,
            {
                autoRefresh: config.get('autoRefresh') ?? true,
                refreshInterval: config.get('refreshInterval') ?? 5000,
                currentUserOnly: config.get('currentUserOnly') ?? true
            }
        );
        outputChannel.appendLine('Log provider initialized (lazy)');
    }
    return logDataProvider;
}

//Metodo que abre un log especifico por su ID una vez el usuario ha dado click en el log
export async function openLog(data: { id: string }) {
    try {
        const provider = await getLogDataProvider();
        // Query the full log details with type assertion
        const result = await provider.connection.tooling.retrieve('ApexLog', data.id) as any;
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

        await provider.logFileManager.showLog(log);

        // Mark the log as opened (set status to 'downloaded' and refresh UI)
        logDataProvider?.markLogAsOpened(log.id);
    } catch (error: any) {
        const errorMessage = error?.message ?? 'Unknown error occurred';
        vscode.window.showErrorMessage(`Failed to open log: ${errorMessage}`);
    }
}