import * as vscode from 'vscode';
import { Connection } from 'jsforce';
import { DeveloperLog, DeveloperLogRecord } from './developerLog';
import { LogViewer } from './logViewer';
import { ensureTraceFlag } from './traceFlag';
import { outputChannel } from './extension';

export interface LogDataChangeEvent {
    data: any[];
    isAutoRefresh: boolean;
}

export class LogDataProvider implements vscode.Disposable {
    private readonly _onDidChangeData = new vscode.EventEmitter<LogDataChangeEvent>();
    readonly onDidChangeData = this._onDidChangeData.event;

    private logs: DeveloperLog[] = [];
    private filteredLogs: DeveloperLog[] = [];
    private searchText: string = '';
    private lastRefresh?: Date;
    private autoRefreshScheduledId?: NodeJS.Timeout;
    private autoRefreshPaused: boolean = true;
    private isRefreshing: boolean = false;
    private currentUserId?: string;
    public readonly logViewer: LogViewer;
    private readonly context: vscode.ExtensionContext;
    private isVisible: boolean = false;

    // Column definitions for the data grid
    readonly columns = [
        { label: 'User', field: 'user', width: 150 },
        { label: 'Time', field: 'time', width: 80 },
        { label: 'Status', field: 'status', width: 200 },
        { label: 'Size', field: 'size', width: 70 },
        { label: 'Operation', field: 'operation', width: 400 },
        { label: 'Duration', field: 'duration', width: 80 }
    ];

    constructor(
        context: vscode.ExtensionContext,
        public connection: Connection,  // Changed from readonly to modifiable
        private readonly config: {
            autoRefresh: boolean;
            refreshInterval: number;
            currentUserOnly: boolean;
        }
    ) {
        this.context = context;
        this.logViewer = new LogViewer(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
        this.logs = [];
        this.filteredLogs = [];
        this.autoRefreshPaused = !this.config.autoRefresh; // Initialize based on config
        
        // Start auto-refresh if enabled in config
        if (this.config.autoRefresh) {
            this.startAutoRefresh();
        }
    }

    static async create(
        context: vscode.ExtensionContext,
        connection: Connection,
        config: {
            autoRefresh: boolean;
            refreshInterval: number;
            currentUserOnly: boolean;
        }
    ): Promise<LogDataProvider> {
        const provider = new LogDataProvider(context, connection, config);
        await provider.initialize();
        return provider;
    }

    private async initialize() {
        try {
            if (!this.currentUserId) {
                this.currentUserId = await this.getCurrentUserId();
            }
            
            // Only create trace flag if we're in currentUserOnly mode
            if (this.config.currentUserOnly && this.currentUserId) {
                await ensureTraceFlag(this.connection, this.currentUserId);
                await this.refreshLogs(true, false);
            } else {
                await this.refreshLogs(true, false);
            }
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

    public async refreshLogs(isInitialLoad: boolean = false, isAutoRefresh: boolean = false): Promise<void> {
        if (this.isRefreshing) {
            return;
        }
        this.isRefreshing = true;
        outputChannel.appendLine('Refreshing logs...');
        try {
            const refreshDate = new Date();
            let query = 'SELECT Id, Application, DurationMilliseconds, LogLength, LogUser.Name, Operation, Request, StartTime, Status FROM ApexLog';

            if (this.config.currentUserOnly && this.currentUserId) {
                query += ` WHERE LogUserId = '${this.currentUserId}'`;
            }

            query += ' ORDER BY StartTime DESC LIMIT 100';

            const result = await this.connection.tooling.query<DeveloperLogRecord>(query);
            this.lastRefresh = refreshDate;

            if (isInitialLoad) {
                this.logs = [];
                this.filteredLogs = [];
            }

            if (result.records?.length > 0) {
                const newLogs = result.records.map(record => new DeveloperLog(record, this.connection));

                if (isInitialLoad) {
                    this.logs = newLogs;
                } else {
            const uniqueLogEntries = new Map<string, DeveloperLog>();
            newLogs.forEach(log => uniqueLogEntries.set(log.id, log));
                this.logs.forEach(log => {
                    if (!uniqueLogEntries.has(log.id)) {
                        uniqueLogEntries.set(log.id, log);
                    }
                });
                    this.logs = Array.from(uniqueLogEntries.values());
                }
            } else if (isInitialLoad) {
                this.logs = [];
            }

            this.logs = this.logs
                .filter(log => log.operation !== '<empty>')
                .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
                .slice(0, 100);

            if (isInitialLoad) {
                this.searchText = '';
                this.filteredLogs = [...this.logs];
            } else {
                this._filterLogs();
            }

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

    public setVisibility(visible: boolean) {
        this.isVisible = visible;
        if (visible && this.config.autoRefresh && this.autoRefreshPaused) {
            // Resume auto-refresh if it was enabled in config
                this.startAutoRefresh();
        } else if (!visible && !this.autoRefreshPaused) {
            // Pause auto-refresh when panel becomes hidden
            this.stopAutoRefresh();
        }
    }

    private startAutoRefresh() {
        // Only start if panel is visible
        if (this.isVisible) {
            this.autoRefreshPaused = false;
            this.scheduleRefresh();
        }
    }

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

        // Get current user ID and ensure trace flag
        if (this.config.currentUserOnly) {
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
}