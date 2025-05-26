import * as vscode from 'vscode';
import { getLogDataProvider } from './extension';

//Metodo para cambiar la visibilidad de los logs que se muestran en el panel
export async function setLogVisibility() {
    const provider = await getLogDataProvider();
    const currentSetting = provider.getCurrentUserOnlySetting();

    const items: vscode.QuickPickItem[] = [
        {
            label: `${currentSetting ? '✓' : '  '} Current user only`,
            description: "Display only the Salesforce developer logs for the currently connected user",
            picked: currentSetting
        },
        {
            label: `${!currentSetting ? '✓' : '  '} All users`,
            description: "Display Salesforce developer logs from all users with active trace flags on the target org",
            picked: !currentSetting
        }
    ];

    const selection = await vscode.window.showQuickPick(items, {
        placeHolder: "Select log visibility setting"
    });

    if (!selection) {
        return; // User cancelled
    }

    const wantsCurrentUserOnly = selection.label.includes("Current user only");

    if (wantsCurrentUserOnly !== currentSetting) {
        try {
            await provider.setCurrentUserOnly(wantsCurrentUserOnly);
            const status = wantsCurrentUserOnly ? 'Current User Only' : 'All Users';
            vscode.window.showInformationMessage(`Log visibility set to: ${status}`);
        } catch (error: any) {
            const errorMessage = error?.message || 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to set log visibility: ${errorMessage}`);
        }
    }
}

//Metodo para borrar todos los logs de Apex de la org de Salesforce
export async function deleteAllLogs() {
    const confirmation = await vscode.window.showWarningMessage(
        'Are you sure you want to delete ALL Apex logs from your Salesforce org? This action cannot be undone.',
        { modal: true },
        'Delete All Logs'
    );

    if (confirmation !== 'Delete All Logs') {
        vscode.window.showInformationMessage('Delete logs operation cancelled.');
        return;
    }

    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Deleting Salesforce logs...",
        cancellable: false
    }, async (progress) => {
        try {
            const provider = await getLogDataProvider();
            const connection = provider.connection;

            progress.report({ message: "Querying log IDs..." });
            const result = await connection.tooling.query<{ Id: string }>('SELECT Id FROM ApexLog');
            
            if (!result.records || result.records.length === 0) {
                vscode.window.showInformationMessage('No logs found to delete.');
                // Force refresh and update grid to empty
                //await provider.refreshLogs();
                provider.notifyDataChange();
                return;
            }

            const logIds = result.records.map(record => record.Id);
            const totalLogs = logIds.length;
            progress.report({ message: `Found ${totalLogs} logs. Deleting...` });

            const chunkSize = 200;
            //TODO:   Promise.allSettled for parallel delete if API allows
            for (let i = 0; i < logIds.length; i += chunkSize) {
                const chunk = logIds.slice(i, i + chunkSize);
                progress.report({ 
                    message: `Deleting logs ${i + 1}-${Math.min(i + chunkSize, totalLogs)} of ${totalLogs}...`, 
                    increment: (chunk.length / totalLogs) * 100 
                });
                await connection.tooling.destroy('ApexLog', chunk);
            }

            vscode.window.showInformationMessage(`Successfully deleted ${totalLogs} logs.`);
            await provider.refreshLogs();
            provider.notifyDataChange();
            
            /* TODO: Uncomment if you want to clear the local downloaded logs cache

            // Also clear the local downloaded logs cache to avoid VS Code showing new logs as deleted
            await provider.logViewer.clearDownloadedLogs(); 


            // Close all open editors for files in the .logs directory to avoid showing deleted files
            const logsPath = provider.logViewer.logsPath;
            if (logsPath) {
                const openEditors = vscode.window.visibleTextEditors;
                for (const editor of openEditors) {
                    if (editor.document.uri.fsPath.startsWith(logsPath)) {
                        //await vscode.window.showTextDocument(editor.document, { preview: false });
                        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    }
                }
            }*/

        } catch (error: any) {
            const errorMessage = error?.message || 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to delete logs: ${errorMessage}`);
        }
    });
}

//Metodo para activar el autorefresco de logs en el panel
export async function toggleAutoRefresh() {
    const provider = await getLogDataProvider();
    const currentSetting = provider.getAutoRefreshSetting();

    const items: vscode.QuickPickItem[] = [
        {
            label: `${currentSetting ? '✓' : '  '} Auto-refresh enabled`,
            description: "Automatically refresh logs at the configured interval",
            picked: currentSetting
        },
        {
            label: `${!currentSetting ? '✓' : '  '} Auto-refresh disabled`,
            description: "Manually refresh logs using the refresh button",
            picked: !currentSetting
        }
    ];

    const selection = await vscode.window.showQuickPick(items, {
        placeHolder: "Select auto-refresh setting"
    });

    if (!selection) {
        return;
    }

    const wantsAutoRefresh = selection.label.includes("enabled");

    if (wantsAutoRefresh !== currentSetting) {
        try {
            await provider.setAutoRefresh(wantsAutoRefresh);
            const status = wantsAutoRefresh ? 'Enabled' : 'Disabled';
            vscode.window.showInformationMessage(`Auto-refresh ${status}`);
        } catch (error: any) {
            const errorMessage = error?.message || 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to set auto-refresh: ${errorMessage}`);
        }
    }
}

//Metodo para mostrar el menu de configuracion generales
export async function showOptions() {
    const provider = await getLogDataProvider();
    const currentAutoRefresh = provider.getAutoRefreshSetting();
    const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');

    const items: vscode.QuickPickItem[] = [
        {
            label: "Auto-refresh",
            description: currentAutoRefresh ? "✓ Enabled" : "✗ Disabled",
            detail: "Automatically refresh logs at the configured interval",
            picked: currentAutoRefresh
        },
        {
            label: "Refresh Interval",
            description: `${config.get('refreshInterval')}ms`,
            detail: "Set the interval between automatic refreshes"
        }
    ];

    const selection = await vscode.window.showQuickPick(items, {
        placeHolder: "Select an option to configure"
    });

    if (!selection) {
        return;
    }

    //Ir a la opcion seleccionada del menu
    switch (selection.label) {
        case "Auto-refresh":
            await toggleAutoRefresh();
            break;
        case "Refresh Interval":
            await setRefreshInterval(config);
            break;
    }
}

//Metodo para setear el intervalo de refresco de logs
async function setRefreshInterval(config: vscode.WorkspaceConfiguration) {
    const interval = await vscode.window.showInputBox({
        prompt: "Enter refresh interval in milliseconds",
        value: config.get('refreshInterval')?.toString(),
        validateInput: (value) => {
            const num = parseInt(value);
            if (isNaN(num) || num < 1000) {
                return "Please enter a valid number greater than 1000";
            }
            return null;
        }
    });
    if (interval) {
        await config.update('refreshInterval', parseInt(interval), vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Refresh interval set to ${interval}ms`);
    }
}

//Metodo para mostrar el buscador de logs
export async function showSearchBox() {
    try {
        const provider = await getLogDataProvider();
        //Usar el buscador del panel
        const activeProvider = (provider as any).activeProvider;
        if (activeProvider && typeof activeProvider.showSearchBoxInWebview === 'function') {
            activeProvider.showSearchBoxInWebview();
        }
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        vscode.window.showErrorMessage(`Failed to filter logs: ${errorMessage}`);
    }
}

//Metodo para limpiar el filtro de busqueda de logs TODO: Sin uso actualmente
export async function clearSearch() {
    try {
        const provider = await getLogDataProvider();
        provider.clearSearch();
        vscode.window.showInformationMessage('Search filter cleared');
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        vscode.window.showErrorMessage(`Failed to clear search: ${errorMessage}`);
    }
}

//Metodo para limpiar los logs descargados localmente
export async function clearDownloadedLogs() {
    const confirmation = await vscode.window.showWarningMessage(
        'Are you sure you want to clear all downloaded log files? This action cannot be undone.',
        { modal: true },
        'Clear Downloaded Logs'
    );

    if (confirmation !== 'Clear Downloaded Logs') {
        vscode.window.showInformationMessage('Clear downloaded logs operation cancelled.');
        return;
    }

    try {
        const provider = await getLogDataProvider();
        await provider.logFileManager.clearDownloadedLogs();
        vscode.window.showInformationMessage('Downloaded logs cleared successfully.');
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        vscode.window.showErrorMessage(`Failed to clear downloaded logs: ${errorMessage}`);
    }
}