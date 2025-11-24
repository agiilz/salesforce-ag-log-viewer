export interface IApexLogPanelProvider {
    postMessage(message: any): void;
    updateView(data?: any[], isAutoRefresh?: boolean, errorInfo?: { hasError: boolean, message?: string }): void;
    refresh(): Promise<void>;
}
