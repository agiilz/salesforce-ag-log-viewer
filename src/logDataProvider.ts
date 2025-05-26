import * as vscode from 'vscode';
import { Connection } from 'jsforce';
import { ApexLog, ApexLogRecord } from './ApexLogWrapper';
import { ApexLogFileManager } from './ApexLogFileManager';
import { ensureTraceFlag } from './traceFlag';
import { outputChannel } from './extension';

export interface LogDataChangeEvent {
    data: any[];
    isAutoRefresh: boolean;
}

export class LogDataProvider implements vscode.Disposable {
    private readonly _onDidChangeData = new vscode.EventEmitter<LogDataChangeEvent>();
    readonly onDidChangeData = this._onDidChangeData.event;

    private logs: ApexLog[] = [];
    private filteredLogs: ApexLog[] = [];
    private searchText: string = '';
    private autoRefreshScheduledId?: NodeJS.Timeout;
    private autoRefreshPaused: boolean = true;
    private isRefreshing: boolean = false;
    private currentUserId?: string;
    public readonly logFileManager: ApexLogFileManager;
    private readonly context: vscode.ExtensionContext;
    private isVisible: boolean = false;

    // Column definitions for the data grid
    readonly columns = [
        { label: 'User', field: 'user', width: 150 },
        { label: 'Time', field: 'time', width: 80 },
        { label: 'Status', field: 'status', width: 80 },
        { label: 'Size', field: 'size', width: 80 },
        { label: 'Operation', field: 'operation', width: 400 },
        { label: 'Duration', field: 'duration', width: 80 }
    ];

    constructor(
        context: vscode.ExtensionContext,
        public connection: Connection,  
        private readonly config: {
            autoRefresh: boolean;
            refreshInterval: number;
            currentUserOnly: boolean;
        },
        private readonly activeProvider?: any
    ) {
        this.context = context;
        this.logFileManager = new ApexLogFileManager(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, activeProvider);
        this.logs = [];
        this.filteredLogs = [];
        this.autoRefreshPaused = !this.config.autoRefresh;
        // Do NOT start auto-refresh here. Only start when panel is visible.
    }

    static async create(
        context: vscode.ExtensionContext,
        connection: Connection,
        config: {
            autoRefresh: boolean;
            refreshInterval: number;
            currentUserOnly: boolean;
        },
        activeProvider?: any
    ): Promise<LogDataProvider> {
        const provider = new LogDataProvider(context, connection, config, activeProvider);
        await provider.initialize();
        return provider;
    }

    private async initialize() {
        try {
            if (!this.currentUserId) {
                this.currentUserId = await this.getCurrentUserId();
            }
            // Always create trace flag for the current user, regardless of mode
            if (this.currentUserId) {
                await ensureTraceFlag(this.connection, this.currentUserId);
            }
            // Do NOT call refreshLogs here or anywhere except when panel is visible.
        } catch (error) {
            console.error('LogDataProvider initialization error:', error);
            throw error;
        }
    }

    dispose() {
        this._onDidChangeData.dispose();
        this.stopAutoRefresh();
    }

    private _notifyDataChange(isAutoRefresh: boolean) {
        const gridData = this.getGridData();
        this._onDidChangeData.fire({ data: gridData, isAutoRefresh });
    }
    
    //Metodo para refrescar los ApexLogs de la org de Salesforce
    public async refreshLogs(isInitialLoad: boolean = false, isAutoRefresh: boolean = false): Promise<void> {
        if (this.isRefreshing) {
            return;
        }
        this.isRefreshing = true;
        outputChannel.appendLine('Refreshing logs...');
        
        //Contruccion de la query para obtener los ApexLogs
        // Si currentUserOnly está activado, se filtra por el ID del usuario actual
        let query = 'SELECT Id, Application, DurationMilliseconds, LogLength, LogUser.Name, Operation, Request, StartTime, Status FROM ApexLog';
        if (this.config.currentUserOnly && this.currentUserId) {
            query += ` WHERE LogUserId = '${this.currentUserId}'`;
        }
        query += ' ORDER BY StartTime DESC LIMIT 100'; //TO DO: Cambiar el limite de logs a mostrar segun setting

        try {
            const result = await this.connection.tooling.query<ApexLogRecord>(query);

            if (!result.records || result.records.length === 0) {
                //Si no hay registros en la org, se limpia el array de logs para mostrarlo vacio al usuario
                this.logs = [];
                this.filteredLogs = [];
            } else {
                //Procesa los logs obtenidos de la org
                this.processLogs(result, isInitialLoad);
            }

            //Notifica los nuevos logs al panel
            this._notifyDataChange(isAutoRefresh);

        } catch (error: any) {
            outputChannel.appendLine(`Log refresh error: ${error}`);
            vscode.window.showErrorMessage(`Failed to refresh logs: ${error.message}`);
        } finally {
            this.isRefreshing = false;
            // Always schedule the next refresh if auto-refresh is enabled, regardless of isInitialLoad
            if (!this.autoRefreshPaused) {
                this.scheduleRefresh();
            }
        }
    }

    //Metodo para procesar los logs obtenidos de la org de Salesforce
    private processLogs(result: { records: ApexLogRecord[] }, isInitialLoad: boolean) {
        //Convierte los registros obtenidos en instancias de ApexLog
        const newLogs = result.records.map(record => new ApexLog(record, this.connection));
        
        this.logs = newLogs
            .filter(log => log.operation !== '<empty>') //TO DO: Filtrar logs con operación vacía o no segun setting
            .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())

        if (isInitialLoad) {
            this.searchText = '';
            this.filteredLogs = [...this.logs];
        } else {
            //Si no es la primera carga mira si tiene que filtrar los logs en caso de que haya un filtro activo
            this._filterLogs();
            //TODO: que no filtre cuando cambio de tab, que se reinicie el filtro?
        }
    }


    //Metodo para saber si el panel esta visible al usuario y tiene que seguir autorefrescando los logs
    public setPanelVisibility(visible: boolean) {
        this.isVisible = visible;
        if (visible && this.config.autoRefresh && this.autoRefreshPaused) {
            //Si el panel se vuelve visible, esta configurado el autorefresh y el auto-refresh está pausado, reinicia el auto-refresh
            this.startAutoRefresh();
        } else if (!visible && !this.autoRefreshPaused) {
            //Pausar el auto-refresh si el panel no está visible
            this.stopAutoRefresh();
        }
    }

    //Metodo para iniciar el autorefresh de logs
    private startAutoRefresh() {
        // Only start if panel is visible
        if (this.isVisible) {
            this.autoRefreshPaused = false;
            this.scheduleRefresh();
        }
    }

    //Metodo para parar el autorefresh de logs
    private stopAutoRefresh() {
        this.autoRefreshPaused = true;
        if (this.autoRefreshScheduledId) {
            clearTimeout(this.autoRefreshScheduledId);
            this.autoRefreshScheduledId = undefined;
        }
    }    

    private scheduleRefresh() {
        if (this.autoRefreshScheduledId) {
            clearTimeout(this.autoRefreshScheduledId);
        }
        // Only schedule refresh if panel is visible AND auto-refresh is not paused
        if (this.isVisible && !this.autoRefreshPaused && !this.isRefreshing) {
            this.autoRefreshScheduledId = setTimeout(() => this.refreshLogs(false, true), this.config.refreshInterval);
        }
    }

    public async setAutoRefresh(enabled: boolean): Promise<void> {
        if (this.config.autoRefresh === enabled) {
            return;
        }
        this.config.autoRefresh = enabled;
        const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
        await config.update('autoRefresh', this.config.autoRefresh, vscode.ConfigurationTarget.Global);

        if (enabled && this.isVisible) {
            // Only start auto-refresh if panel is visible
            this.startAutoRefresh();
        } else {
            this.stopAutoRefresh();
        }
    }

    public getAutoRefreshSetting(): boolean {
        return this.config.autoRefresh;
    }

    public getGridData(): any[] {
        return this.filteredLogs.map(log => {
            const cleanLog = {
                id: log.id,
                user: log.user,
                time: new Date(log.startTime).toLocaleTimeString('en-US', {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                }),
                status: log.status,
                size: `${(log.size / 1024).toFixed(1)}KB`,
                operation: log.operation,
                duration: `${log.durationMilliseconds}ms`,
                logData: {
                    id: log.id,
                    startTime: log.startTime,
                    size: log.size,
                    status: log.status,
                    operation: log.operation,
                    user: log.user,
                    durationMilliseconds: log.durationMilliseconds
                }
            };
            return cleanLog;
        });
    }

    public setSearchFilter(text: string) {
        this.searchText = text;
        this._filterLogs();
        this._notifyDataChange(false);
    }

    public clearSearch() {
        this.searchText = '';
        this._filterLogs();
        this._notifyDataChange(false);
    }

    public getSearchFilter(): string {
        return this.searchText;
    }

    private _filterLogs() {
        if (!this.searchText) {
            this.filteredLogs = [...this.logs];
            return;
        }
        const searchLower = this.searchText.toLowerCase();
        this.filteredLogs = this.logs.filter(log => {
            const operation = log.operation.toLowerCase();
            const user = log.user.toLowerCase();
            return operation.includes(searchLower) || user.includes(searchLower);
        });
    }

    public async setCurrentUserOnly(showCurrentUserOnly: boolean): Promise<void> {
        if (this.config.currentUserOnly === showCurrentUserOnly) {
            return;
        }
        this.config.currentUserOnly = showCurrentUserOnly;
        const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
        await config.update('currentUserOnly', this.config.currentUserOnly, vscode.ConfigurationTarget.Global);

        // Always ensure trace flag for the current user, regardless of mode
        try {
            this.currentUserId = await this.getCurrentUserId();
            if (this.currentUserId) {
                await ensureTraceFlag(this.connection, this.currentUserId);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to get current user ID: ${error.message}. Showing all users.`);
            this.config.currentUserOnly = false;
            await config.update('currentUserOnly', this.config.currentUserOnly, vscode.ConfigurationTarget.Global);
        }
        await this.refreshLogs(true, false);
        this._notifyDataChange(false);
    }

    public getCurrentUserOnlySetting(): boolean {
        return this.config.currentUserOnly;
    }

    public async getCurrentUserId(): Promise<string> {
        const result = await this.connection.identity();
        return result.user_id;
    }


    public async updateConnection(newConnection: Connection) {
        this.connection = newConnection;
        // When connection changes, we need to refresh the current user ID if currentUserOnly is enabled
        try {
            this.currentUserId = await this.getCurrentUserId();
            if (this.currentUserId) {
                await ensureTraceFlag(this.connection, this.currentUserId);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to get current user ID: ${error.message}. Showing all users.`);
            this.config.currentUserOnly = false;
            const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
            await config.update('currentUserOnly', false, vscode.ConfigurationTarget.Global);
        }
        // Refresh logs with the new connection
        await this.refreshLogs(true, false);
    }

    public notifyDataChange(isAutoRefresh: boolean = false) {
        this._notifyDataChange(isAutoRefresh);
    }
}