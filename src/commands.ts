import * as vscode from 'vscode';
import { getLogDataProvider } from './extension';
import { enableTraceFlagForUser, disableTraceFlagForUser } from './TraceFlagManager';
import { retryOnSessionExpire } from './connection';

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

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Deleting Salesforce logs...",
        cancellable: false
    }, async (progress) => {
        try {
            const provider = await getLogDataProvider();
            const connection = provider.connection;

            progress.report({ message: "Querying log IDs..." });
            const result = await retryOnSessionExpire(
                async (conn) => await conn.tooling.query('SELECT Id FROM ApexLog LIMIT 10000'),
                provider
            ) as { records: { Id: string }[] };

            if (!result.records || result.records.length === 0) {
                vscode.window.showInformationMessage('No logs found to delete.');
                provider.notifyDataChange();
                return;
            }

            const logIds = result.records.map(record => record.Id);
            const chunkSize = 200;
            let deletedCount = 0;

            for (let i = 0; i < logIds.length; i += chunkSize) {
                const chunk = logIds.slice(i, i + chunkSize);
                progress.report({
                    message: `Deleting logs ${i + 1}-${Math.min(i + chunkSize, logIds.length)} of ${logIds.length}...`
                });

                try {
                    await Promise.all(chunk.map(id =>
                        connection.request({
                            method: 'DELETE',
                            url: `/services/data/v58.0/sobjects/ApexLog/${id}`
                        }).then(() => {
                            deletedCount++;
                        }).catch(err => {
                            if (!/entity is deleted|not found|resource does not exist/i.test(err?.message || '')) {
                                throw err;
                            }
                        })
                    ));
                } catch (err: any) {
                    console.error('Delete chunk error:', err);
                    throw new Error(`Error deleting log chunk: ${err.message || err}`);
                }
            }

            vscode.window.showInformationMessage(`Successfully deleted ${deletedCount} logs.`);
            await provider.refreshLogs();
            provider.notifyDataChange();

        } catch (error: any) {
            const errorMessage = error?.message || 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to delete logs: ${errorMessage}`);
            console.error('Delete all logs failed:', error);
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
    const traceFlagExpiration = config.get<number>('traceFlagExpirationInterval') ?? 15;
    const showOutputOnStart = config.get<boolean>('showOutputOnStart') ?? true;

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
        },
        {
            label: "Trace Flag update expiration time interval",
            description: `${traceFlagExpiration} min` + (traceFlagExpiration < 5 ? ' (minimum 5)' : ''),
            detail: "Set the update interval (in minutes) for Salesforce trace flags expiration time. Minimum: 5, Default: 15."
        },
        {
            label: "Show Output on Start",
            description: showOutputOnStart ? "✓ Enabled" : "✗ Disabled",
            detail: "Show the Salesforce AG Log Viewer output channel when the extension starts",
            picked: showOutputOnStart
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
        case "Trace Flag update expiration time interval":
            await setTraceFlagExpirationInterval(config, traceFlagExpiration);
            break;
        case "Show Output on Start":
            await setShowOutputOnStart(config, showOutputOnStart);
            break;
    }
}

//Set trace flag expiration interval in minutes + validation input
async function setTraceFlagExpirationInterval(config: vscode.WorkspaceConfiguration, current: number) {
    const interval = await vscode.window.showInputBox({
        prompt: "Enter trace flag expiration interval in minutes (minimum 5)",
        value: current.toString(),
        validateInput: (value) => {
            const num = parseInt(value);
            if (isNaN(num) || num < 5) {
                return "Please enter a valid number greater than or equal to 5";
            }
            return null;
        }
    });
    if (interval) {
        await config.update('traceFlagExpirationInterval', parseInt(interval), vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Trace flag expiration interval set to ${interval} minutes`);
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

// Command to set trace flag for a selected user
export async function setTraceFlagForUser() {
    try {
        const provider = await getLogDataProvider();
        const connection = provider.connection;
        const currentUserId = await provider.getCurrentUserId();
        
        // Query all active users except current user
        const userResult = await connection.query<any>(
            `SELECT Id, Name, Username FROM User WHERE IsActive = true AND Id != '${currentUserId}' ORDER BY Name`
        );
        if (!userResult.records || userResult.records.length === 0) {
            vscode.window.showWarningMessage('No active users found in the org.');
            return;
        }

        // Query all active trace flags for users
        const traceFlagResult = await retryOnSessionExpire(async (conn) => await conn.tooling.query(`SELECT Id, TracedEntityId, ExpirationDate FROM TraceFlag WHERE ExpirationDate > ${new Date().toISOString()}`), provider) as { records: any[] };
        const userIdToTraceFlag = new Map<string, string>();
        for (const tf of traceFlagResult.records || []) {
            userIdToTraceFlag.set(tf.TracedEntityId, tf.Id);
        }
        const items = userResult.records.map((user: any) => {
            const hasFlag = userIdToTraceFlag.has(user.Id);
            const icon = hasFlag ? '✅' : '❌';
            return {
                label: `${icon} ${user.Name}`,
                description: user.Username,
                userId: user.Id,
                hasTraceFlag: hasFlag
            };
        });
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a user to enable a trace flag',
            ignoreFocusOut: true
        });
        if (!picked) return;
        if (picked.hasTraceFlag) {
            await disableTraceFlagForUser(connection, picked.userId);
            vscode.window.showInformationMessage(`Trace flag disabled for user: ${picked.label}`);
            return;
        } else {
            await enableTraceFlagForUser(connection, picked.userId);
            vscode.window.showInformationMessage(`Trace flag enabled and will be auto-updated for user: ${picked.label}`);
        }
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        vscode.window.showErrorMessage(`Failed to manage trace flag for user: ${errorMessage}`);
    }
}

// Command to delete all trace flags except the current user's
export async function deleteAllTraceFlagsExceptCurrent() {
    try {
        const provider = await getLogDataProvider();
        const connection = provider.connection;
        const currentUserId = await provider.getCurrentUserId();
        // Query all trace flags except the current user's and the active ones
        const nowIso = new Date().toISOString();
        const traceFlagResult = await retryOnSessionExpire(async (conn) => await conn.tooling.query(`SELECT Id, TracedEntityId FROM TraceFlag WHERE TracedEntityId != '${currentUserId}' AND ExpirationDate < ${nowIso}`), provider) as { records: any[] };
        if (!traceFlagResult.records || traceFlagResult.records.length === 0) {
            vscode.window.showInformationMessage('No trace flags found to delete');
            return;
        }
        for (const tf of traceFlagResult.records) {
            await retryOnSessionExpire(async (conn) => await conn.tooling.delete('TraceFlag', tf.Id), provider);
        }
        vscode.window.showInformationMessage('All trace flags deleted except the current user.');
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        vscode.window.showErrorMessage(`Failed to delete trace flags: ${errorMessage}`);
    }
}

// Opcion para mostrar el output channel al iniciar la extension
async function setShowOutputOnStart(config: vscode.WorkspaceConfiguration, current: boolean) {
    const newValue = !current;
    await config.update('showOutputOnStart', newValue, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Show Output on Start set to ${newValue ? 'Enabled' : 'Disabled'}`);
}