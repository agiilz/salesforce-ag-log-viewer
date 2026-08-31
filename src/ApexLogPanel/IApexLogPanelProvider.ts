import type { HostToPanelMessage } from '../webviewMessages';

export interface IApexLogPanelProvider {
    postMessage(message: HostToPanelMessage): void;
    updateView(data?: any[], isAutoRefresh?: boolean, errorInfo?: { hasError: boolean, message?: string }): void;
    refresh(): Promise<void>;
}
