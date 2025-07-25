import * as vscode from 'vscode';
import { Connection } from 'jsforce';
import { ApexLog, ApexLogRecord } from './ApexLogWrapper';
import { ApexLogFileManager } from './ApexLogFileManager';
import { ensureTraceFlag } from './TraceFlagManager';
import { outputChannel } from './extension';
import { retryOnSessionExpire } from './connection';

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
    ): Promise<LogDataProvider> {        const provider = new LogDataProvider(context, connection, config, activeProvider);
        await provider.initialize();
        return provider;
    }

    //Metodo para inicializar el LogDataProvider
    // Se asegura de que el trace flag esté activo para el usuario actual
    private async initialize() {
        try {
            this.currentUserId ??= await this.getCurrentUserId();
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
        //outputChannel.appendLine('Refreshing logs...');
        
        //Contruccion de la query para obtener los ApexLogs
        // Si currentUserOnly está activado, se filtra por el ID del usuario actual
        let query = 'SELECT Id, Application, DurationMilliseconds, LogLength, LogUser.Name, Operation, Request, StartTime, Status FROM ApexLog';
        if (this.config.currentUserOnly && this.currentUserId) {
            query += ` WHERE LogUserId = '${this.currentUserId}'`;
        }
        query += ' ORDER BY StartTime DESC LIMIT 100'; //TODO: Cambiar el limite de logs a mostrar segun setting

        try {

            const result = await retryOnSessionExpire(async (conn) => await conn.tooling.query(query), this) as { records: ApexLogRecord[] };

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
            .filter(log => log.operation !== '<empty>') //TODO: Filtrar logs con operación vacía o no segun setting
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

    //Metodo para programar el autorefresh de logs segun el intervalo configurado
    // Solo se ejecuta si el panel está visible y el auto-refresh no está pausado
    private scheduleRefresh() {
        if (this.autoRefreshScheduledId) {
            clearTimeout(this.autoRefreshScheduledId);
        }

        if (this.isVisible && !this.autoRefreshPaused && !this.isRefreshing) {
            this.autoRefreshScheduledId = setTimeout(() => this.refreshLogs(false, true), this.config.refreshInterval);
        }
    }

    //metodo para activar o desactivar el autorefresh de logs
    public async setAutoRefresh(enabled: boolean): Promise<void> {
        if (this.config.autoRefresh === enabled) {
            return;
        }
        this.config.autoRefresh = enabled;
        const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
        await config.update('autoRefresh', this.config.autoRefresh, vscode.ConfigurationTarget.Global);

        if (enabled && this.isVisible) {
            //Si se activa el autorefresh y el panel está visible inicia el autorefresh
            this.startAutoRefresh();
        } else {
            this.stopAutoRefresh();
        }
    }

    public getAutoRefreshSetting(): boolean {
        return this.config.autoRefresh;
    }

    //Metodo para obtener los datos de los logs en formato adecuado para el grid del panel
    public getGridData(): any[] {
        return this.filteredLogs.map(log => ({
            id: log.id,
            user: log.user,
            time: (() => {
                const date = new Date(log.startTime);
                const timeStr = date.toLocaleTimeString('es-ES', {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                });
                const dateStr = date.toLocaleDateString('es-ES', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                });
                // Para ordenación, se incluye el timestamp en ms
                return `${timeStr}|||${timeStr} ${dateStr}|||${date.getTime()}`;
            })(),
            status: log.status,
            uiStatus: log.uiStatus, // Para saber si el log está sin leer, descargado o en proceso de descarga
            size: (() => {
                let value, unit;
                if (log.size >= 1024 * 1024) {
                    value = (log.size / 1024 / 1024).toFixed(1);
                    unit = 'MB';
                } else {
                    value = (log.size / 1024).toFixed(1);
                    unit = 'KB';
                }
                // Devuelve un string normal, con espacios para alinear, sin HTML ni cambio de fuente
                return value.padStart(6, ' ') + ' ' + unit;
            })(),
            operation: log.operation,
            duration: (() => {
                let value, unit;
                if (log.durationMilliseconds >= 1000) {
                    value = (log.durationMilliseconds / 1000).toFixed(2);
                    unit = 's';
                } else {
                    value = log.durationMilliseconds.toString();
                    unit = 'ms';
                }
                return value.padStart(6, ' ') + ' ' + unit;
            })(),
        }));
    }

    //Metodo para setear el texto de busqueda para filtrar los logs
    public setSearchFilter(text: string) {
        this.searchText = text;
        this._filterLogs();
        this._notifyDataChange(false);
    }

    //Metodo para limpiar el filtro de los logs y notificar al panel TODO:Sin uso actual
    public clearSearch() {
        this.searchText = '';
        this._filterLogs();
        this._notifyDataChange(false);
    }
    
    //Metodo para filtrar los logs segun el texto de busqueda
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

    //Metodo para setear el modo de mostrar solo logs del usuario currente
    public async setCurrentUserOnly(showCurrentUserOnly: boolean): Promise<void> {
        if (this.config.currentUserOnly === showCurrentUserOnly) {
            //Si el setting ya esta activo, no hace nada
            return;
        }
        this.config.currentUserOnly = showCurrentUserOnly;
        const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
        await config.update('currentUserOnly', this.config.currentUserOnly, vscode.ConfigurationTarget.Global);

        //Comprobar que el usuario actual tiene un trace flag activo
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
        //Refresca los logs con el nuevo setting
        await this.refreshLogs(true, false);
        this._notifyDataChange(false);
    }

    //Metodo para saber si el setting de mostrar solo logs del usuario actual esta activo
    public getCurrentUserOnlySetting(): boolean {
        return this.config.currentUserOnly;
    }

    //Metodo para obtener el ID del usuario actual de la conexion a la org de Salesforce
    public async getCurrentUserId(): Promise<string> {
        const result = await this.connection.identity();
        return result.user_id;
    }

    //Metodo para actualizar la conexion a la org de Salesforce
    // Se asegura de que el trace flag esté activo para el usuario actual
    // y refresca los logs con la nueva conexión
    public async updateConnection(newConnection: Connection) {
        this.connection = newConnection;
       
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

        //Refresca los logs con la nueva conexión
        await this.refreshLogs(true, false);
    }

    //Metodo para notificar al panel que ha habido un cambio en los datos
    public notifyDataChange(isAutoRefresh: boolean = false) {
        this._notifyDataChange(isAutoRefresh);
    }

    //Metodo para marcar un log como abierto en el panel y este se ponga en status downloaded
    public markLogAsOpened(logId: string) {
        //Busca el log por su ID en la lista de logs y cambia su estado a 'downloaded'
        const log = this.logs.find(l => l.id === logId);
        if (log && log.uiStatus !== 'downloaded') {
            log.uiStatus = 'downloaded';
            this._filterLogs();
            this._notifyDataChange(false);
        }
    }
}