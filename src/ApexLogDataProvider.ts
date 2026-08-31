import * as vscode from 'vscode';
import { Connection } from 'jsforce';
import { ApexLog, ApexLogRecord } from './ApexLogWrapper';
import { ApexLogFileManager } from './ApexLogFileManager';
import { ensureTraceFlag } from './TraceFlagManager';
import { outputChannel } from './outputChannel';
import { getConnectedOrgUsername, retryOnSessionExpire } from './connection';
import { IApexLogPanelProvider } from './ApexLogPanel/IApexLogPanelProvider';

export interface LogDataChangeEvent {
    data: any[];
    isAutoRefresh: boolean;
}

export interface PanelFilters {
    text: string;
    useRegex: boolean;
    status: string;
    user: string;
    favoritesOnly: boolean;
    dateFrom: string;
    minimumDurationMs: number;
    minimumSizeKb: number;
    exceptionsOnly: boolean;
}

export interface LogViewerConfiguration {
    autoRefresh: boolean;
    refreshInterval: number;
    currentUserOnly: boolean;
}

export interface PanelMeta {
    activeOrg: string;
    isRefreshing: boolean;
    lastSuccessfulRefresh?: string;
    loadedCount: number;
    visibleCount: number;
    hasMore: boolean;
    filters: PanelFilters;
    users: string[];
    statuses: string[];
}

export class LogDataProvider implements vscode.Disposable {
    private readonly _onDidChangeData = new vscode.EventEmitter<LogDataChangeEvent>();
    readonly onDidChangeData = this._onDidChangeData.event;

    private logs: ApexLog[] = [];
    private filteredLogs: ApexLog[] = [];
    private filters: PanelFilters = {
        text: '',
        useRegex: false,
        status: '',
        user: '',
        favoritesOnly: false,
        dateFrom: '',
        minimumDurationMs: 0,
        minimumSizeKb: 0,
        exceptionsOnly: false
    };
    private favorites = new Set<string>();
    private loadedLimit = 100;
    private readonly maximumLoadedLogs = 1000;
    private hasMore = false;
    private lastSuccessfulRefresh?: string;
    private autoRefreshScheduledId?: NodeJS.Timeout;
    private autoRefreshPaused: boolean = true;
    private isRefreshing: boolean = false;
    private refreshQueue: Promise<void> = Promise.resolve();
    private currentUserId?: string;
    public readonly logFileManager: ApexLogFileManager;
    private readonly context: vscode.ExtensionContext;
    private _isVisible: boolean = false;
    private activeProvider?: IApexLogPanelProvider;

    constructor(
        context: vscode.ExtensionContext,
        public connection: Connection,
        private readonly config: LogViewerConfiguration,
        activeProvider?: IApexLogPanelProvider
    ) {
        this.context = context;
        this.activeProvider = activeProvider;
        this.logFileManager = new ApexLogFileManager(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
        this.logs = [];
        this.filteredLogs = [];
        this.loadFavorites();
        this.autoRefreshPaused = !this.config.autoRefresh;
        // Do NOT start auto-refresh here. Only start when panel is visible.
    }

    static async create(
        context: vscode.ExtensionContext,
        connection: Connection,
        config: LogViewerConfiguration,
        activeProvider?: IApexLogPanelProvider
    ): Promise<LogDataProvider> {
        const provider = new LogDataProvider(context, connection, config, activeProvider);
        await provider.initialize();
        return provider;
    }

    public setActiveProvider(provider: IApexLogPanelProvider) {
        this.activeProvider = provider;
    }

    public showSearchBox(): void {
        this.activeProvider?.postMessage({ type: 'showSearchBox' });
    }

    public get isVisible(): boolean {
        return this._isVisible;
    }

    //Metodo para inicializar el LogDataProvider
    // Se asegura de que el trace flag esté activo para el usuario actual
    private async initialize() {
        let errorInfo;
        try {
            this.currentUserId ??= await this.getCurrentUserId();
            // Always create trace flag for the current user, regardless of mode
            if (this.currentUserId) {
                await ensureTraceFlag(this.connection, this.currentUserId);
            }
            // Do NOT call refreshLogs here or anywhere except when panel is visible.
        } catch (error) {
            console.error('LogDataProvider initialization error:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(`LogDataProvider initialization error: ${errorMessage}`);
            errorInfo = { hasError: true, message: errorMessage };
        }
        if (errorInfo && this.activeProvider?.updateView) {
            this.activeProvider.updateView(this.getGridData(), false, errorInfo);
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
    public refreshLogs(isInitialLoad: boolean = false, isAutoRefresh: boolean = false): Promise<void> {
        const refresh = this.refreshQueue.then(() => this.performRefresh(isInitialLoad, isAutoRefresh));
        this.refreshQueue = refresh.catch(() => undefined);
        return refresh;
    }

    private async performRefresh(isInitialLoad: boolean, isAutoRefresh: boolean): Promise<void> {
        const requestedLimit = this.loadedLimit;
        this.isRefreshing = true;
        this.activeProvider?.updateView(this.getGridData(), isAutoRefresh);
        let errorInfo: { hasError: boolean, message?: string } | undefined = undefined;
        try {
            if (this.config.currentUserOnly && !this.currentUserId) {
                this.currentUserId = await this.getCurrentUserId();
            }

            //Contruccion de la query para obtener los ApexLogs
            let query = 'SELECT Id, Application, DurationMilliseconds, LogLength, LogUser.Name, Operation, Request, StartTime, Status FROM ApexLog';
            if (this.config.currentUserOnly) {
                if (!this.currentUserId) {
                    throw new Error('Current Salesforce user could not be identified. Refusing to load unfiltered logs.');
                }
                query += ` WHERE LogUserId = '${this.currentUserId}'`;
            }
            query += ` ORDER BY StartTime DESC LIMIT ${Math.min(requestedLimit + 1, this.maximumLoadedLogs + 1)}`;

            const result = await retryOnSessionExpire(async (conn) => await conn.tooling.query(query), this) as { records: ApexLogRecord[] };

            if (!result.records || result.records.length === 0) {
                //Si no hay registros en la org, se limpia el array de logs para mostrarlo vacio al usuario
                this.logs = [];
                this.filteredLogs = [];
                this.hasMore = false;
            } else {
                //Procesa los logs obtenidos de la org
                this.hasMore = result.records.length > requestedLimit && requestedLimit < this.maximumLoadedLogs;
                this.processLogs({ records: result.records.slice(0, requestedLimit) }, isInitialLoad);
            }
            this.lastSuccessfulRefresh = new Date().toISOString();
        } catch (error: any) {
            outputChannel.appendLine(`Log refresh error: ${error}`);
            vscode.window.showErrorMessage(`Failed to refresh logs: ${error.message}`);
            // Detect common error scenarios and propagate errorInfo
            errorInfo = { hasError: true, message: error instanceof Error ? error.message : String(error) };
        } finally {
            this.isRefreshing = false;
            // Always schedule the next refresh if auto-refresh is enabled, regardless of isInitialLoad
            if (!this.autoRefreshPaused) {
                this.scheduleRefresh();
            }
            // Always notify panel, with errorInfo if present
            if (this.activeProvider?.updateView) {
                this.activeProvider.updateView(this.getGridData(), isAutoRefresh, errorInfo);
            } else {
                this._notifyDataChange(isAutoRefresh);
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
            this.filters.text = '';
            this._filterLogs();
        } else {
            //Si no es la primera carga mira si tiene que filtrar los logs en caso de que haya un filtro activo
            this._filterLogs();
            //TODO: que no filtre cuando cambio de tab, que se reinicie el filtro?
        }
    }

    //Metodo para saber si el panel esta visible al usuario y tiene que seguir autorefrescando los logs
    public setPanelVisibility(visible: boolean) {
        this._isVisible = visible;
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
        if (this._isVisible) {
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

        if (this._isVisible && !this.autoRefreshPaused && !this.isRefreshing) {
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

        if (enabled && this._isVisible) {
            //Si se activa el autorefresh y el panel está visible inicia el autorefresh
            this.startAutoRefresh();
        } else {
            this.stopAutoRefresh();
        }
    }

    public getAutoRefreshSetting(): boolean {
        return this.config.autoRefresh;
    }

    public async applyConfiguration(next: LogViewerConfiguration): Promise<void> {
        const refreshIntervalChanged = this.config.refreshInterval !== next.refreshInterval;
        const autoRefreshChanged = this.config.autoRefresh !== next.autoRefresh;
        const currentUserOnlyChanged = this.config.currentUserOnly !== next.currentUserOnly;

        this.config.refreshInterval = Math.max(1000, next.refreshInterval);
        this.config.autoRefresh = next.autoRefresh;
        this.config.currentUserOnly = next.currentUserOnly;

        if (autoRefreshChanged) {
            if (this.config.autoRefresh && this._isVisible) {
                this.startAutoRefresh();
            } else {
                this.stopAutoRefresh();
            }
        } else if (refreshIntervalChanged && !this.autoRefreshPaused) {
            this.scheduleRefresh();
        }

        if (currentUserOnlyChanged) {
            this.loadedLimit = 100;
            await this.refreshLogs(true, false);
        }
    }

    //Metodo para obtener los datos de los logs en formato adecuado para el grid del panel
    public getGridData(): any[] {
        return this.filteredLogs.map(log => ({
            id: log.id,
            user: log.user,
            time: (() => {
                const date = new Date(log.startTime);
                const timeStr = date.toLocaleTimeString(undefined, {
                    hour12: false,
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                });
                const dateStr = date.toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                });
                // Para ordenación, se incluye el timestamp en ms
                return `${timeStr}|||${timeStr} ${dateStr}|||${date.getTime()}`;
            })(),
            status: log.status,
            favorite: this.favorites.has(log.id),
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
        this.filters.text = text;
        this._filterLogs();
        this._notifyDataChange(false);
    }

    //Metodo para limpiar el filtro de los logs y notificar al panel TODO:Sin uso actual
    public clearSearch() {
        this.filters.text = '';
        this._filterLogs();
        this._notifyDataChange(false);
    }

    //Metodo para filtrar los logs segun el texto de busqueda
    private _filterLogs() {
        const searchLower = this.filters.text.toLowerCase();
        let searchPattern: RegExp | undefined;
        if (this.filters.useRegex && this.filters.text) {
            try {
                searchPattern = new RegExp(this.filters.text, 'i');
            } catch {
                searchPattern = undefined;
            }
        }
        this.filteredLogs = this.logs.filter(log => {
            const operation = log.operation.toLowerCase();
            const user = log.user.toLowerCase();
            const matchesText = !searchLower || (searchPattern
                ? searchPattern.test(log.operation) || searchPattern.test(log.user)
                : operation.includes(searchLower) || user.includes(searchLower));
            const matchesStatus = !this.filters.status || log.status === this.filters.status;
            const matchesUser = !this.filters.user || log.user === this.filters.user;
            const matchesFavorite = !this.filters.favoritesOnly || this.favorites.has(log.id);
            const matchesDate = !this.filters.dateFrom || log.startTime.getTime() >= new Date(this.filters.dateFrom).getTime();
            const matchesDuration = log.durationMilliseconds >= this.filters.minimumDurationMs;
            const matchesSize = log.size >= this.filters.minimumSizeKb * 1024;
            const matchesException = !this.filters.exceptionsOnly || /exception|fatal|failed/i.test(`${log.status} ${log.operation}`);
            return matchesText && matchesStatus && matchesUser && matchesFavorite && matchesDate && matchesDuration && matchesSize && matchesException;
        });
    }

    public setFilters(filters: Partial<PanelFilters>): void {
        this.filters = {
            text: typeof filters.text === 'string' ? filters.text.slice(0, 500) : this.filters.text,
            useRegex: typeof filters.useRegex === 'boolean' ? filters.useRegex : this.filters.useRegex,
            status: typeof filters.status === 'string' ? filters.status.slice(0, 100) : this.filters.status,
            user: typeof filters.user === 'string' ? filters.user.slice(0, 200) : this.filters.user,
            favoritesOnly: typeof filters.favoritesOnly === 'boolean' ? filters.favoritesOnly : this.filters.favoritesOnly,
            dateFrom: typeof filters.dateFrom === 'string'
                ? (/^\d{4}-\d{2}-\d{2}$/.test(filters.dateFrom) ? filters.dateFrom : '')
                : this.filters.dateFrom,
            minimumDurationMs: typeof filters.minimumDurationMs === 'number' && Number.isFinite(filters.minimumDurationMs) ? Math.max(filters.minimumDurationMs, 0) : this.filters.minimumDurationMs,
            minimumSizeKb: typeof filters.minimumSizeKb === 'number' && Number.isFinite(filters.minimumSizeKb) ? Math.max(filters.minimumSizeKb, 0) : this.filters.minimumSizeKb,
            exceptionsOnly: typeof filters.exceptionsOnly === 'boolean' ? filters.exceptionsOnly : this.filters.exceptionsOnly
        };
        this._filterLogs();
        this._notifyDataChange(false);
    }

    public async toggleFavorite(logId: string): Promise<void> {
        if (this.favorites.has(logId)) {
            this.favorites.delete(logId);
        } else {
            this.favorites.add(logId);
        }
        await this.context.workspaceState.update(this.favoritesStorageKey, [...this.favorites]);
        this._filterLogs();
        this._notifyDataChange(false);
    }

    public async loadOlder(): Promise<void> {
        if (!this.hasMore || this.loadedLimit >= this.maximumLoadedLogs) {
            return;
        }
        this.loadedLimit = Math.min(this.loadedLimit + 100, this.maximumLoadedLogs);
        await this.refreshLogs(false, false);
    }

    public async compareLogs(logIds: [string, string]): Promise<void> {
        const logs = logIds.map(logId => this.logs.find(log => log.id === logId));
        if (!logs[0] || !logs[1]) {
            throw new Error('Both logs must be loaded before they can be compared.');
        }

        const documents = await Promise.all(logs.map(async log => {
            const body = await retryOnSessionExpire(connection => log!.getBody(connection), this);
            return vscode.workspace.openTextDocument({ content: body, language: 'salesforce-apex-log' });
        }));
        await vscode.commands.executeCommand(
            'vscode.diff',
            documents[0].uri,
            documents[1].uri,
            `Compare ${logs[0].operation} / ${logs[1].operation}`
        );
    }

    public async exportFilteredLogs(): Promise<void> {
        const destination = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('salesforce-logs.csv'),
            filters: { CSV: ['csv'] },
            saveLabel: 'Export filtered logs'
        });
        if (!destination) {
            return;
        }

        const header = ['Id', 'User', 'Start Time', 'Status', 'Size Bytes', 'Operation', 'Duration Milliseconds'];
        const rows = this.filteredLogs.map(log => [
            log.id,
            log.user,
            log.startTime.toISOString(),
            log.status,
            log.size,
            log.operation,
            log.durationMilliseconds
        ]);
        const csv = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
        await vscode.workspace.fs.writeFile(destination, Buffer.from(csv, 'utf8'));
        vscode.window.showInformationMessage(`Exported ${rows.length} logs to CSV.`);
    }

    public getPanelMeta(): PanelMeta {
        return {
            activeOrg: getConnectedOrgUsername() ?? this.connection.instanceUrl,
            isRefreshing: this.isRefreshing,
            lastSuccessfulRefresh: this.lastSuccessfulRefresh,
            loadedCount: this.logs.length,
            visibleCount: this.filteredLogs.length,
            hasMore: this.hasMore,
            filters: { ...this.filters },
            users: [...new Set(this.logs.map(log => log.user))].sort((a, b) => a.localeCompare(b)),
            statuses: [...new Set(this.logs.map(log => log.status))].sort((a, b) => a.localeCompare(b))
        };
    }

    private get favoritesStorageKey(): string {
        return `salesforceAgLogViewer.favorites.${this.connection.instanceUrl.toLowerCase()}`;
    }

    private loadFavorites(): void {
        this.favorites = new Set(this.context.workspaceState.get<string[]>(this.favoritesStorageKey, []));
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
    }

    //Metodo para saber si el setting de mostrar solo logs del usuario actual esta activo
    public getCurrentUserOnlySetting(): boolean {
        return this.config.currentUserOnly;
    }

    //Metodo para obtener el ID del usuario actual de la conexion a la org de Salesforce
    public async getCurrentUserId(): Promise<string> {
        const result = await retryOnSessionExpire(connection => connection.identity(), this);
        return result.user_id;
    }

    public replaceConnection(newConnection: Connection): void {
        this.connection = newConnection;
    }

    //Metodo para actualizar la conexion a la org de Salesforce
    // Se asegura de que el trace flag esté activo para el usuario actual
    // y refresca los logs con la nueva conexión
    public async updateConnection(newConnection: Connection) {
        await this.refreshQueue;
        this.connection = newConnection;
        this.loadedLimit = 100;
        this.loadFavorites();

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

    public clearDownloadedState(): void {
        this.logs.forEach(log => {
            log.uiStatus = log.status;
        });
        this.activeProvider?.postMessage({ type: 'clearDownloadedState' });
        this._filterLogs();
        this._notifyDataChange(false);
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

function csvCell(value: string | number): string {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}