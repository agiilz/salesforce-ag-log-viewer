import * as vscode from 'vscode';
import { LogDataProvider } from '../ApexLogDataProvider';
import * as fs from 'fs';
import * as path from 'path';
import { openLog } from '../extension';

import { IApexLogPanelProvider } from './IApexLogPanelProvider';

export class ApexLogPanelProvider implements vscode.WebviewViewProvider, IApexLogPanelProvider {
    private _view?: vscode.WebviewView;
    private _logDataProvider?: LogDataProvider;
    private _connectionError?: string;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        logDataProvider?: LogDataProvider
    ) {
        this._logDataProvider = logDataProvider;
    }

    public setLogDataProvider(logDataProvider: LogDataProvider | undefined): void {
        this._logDataProvider = logDataProvider;
        if (!logDataProvider) return;

        this._connectionError = undefined;
        if (this._view) {
            logDataProvider.setPanelVisibility(this._view.visible);
            this.updateView(logDataProvider.getGridData());
            if (this._view.visible) {
                void logDataProvider.refreshLogs(true, false);
            }
        }
    }

    public showConnectionError(error: unknown): void {
        this._connectionError = error instanceof Error ? error.message : String(error);
        this.updateView([], false, { hasError: true, message: this._connectionError });
    }

    public async refresh(): Promise<void> {
        const logDataProvider = this._logDataProvider;
        if (!logDataProvider) {
            await vscode.commands.executeCommand('salesforce-ag-log-viewer.retryConnection');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Refreshing Salesforce logs...',
            cancellable: false
        }, async () => {
            await logDataProvider.refreshLogs(false, true);
        });
    }

    public postMessage(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    public showSearchBoxInWebview() {
        this.postMessage({ type: 'showSearchBox' });
    }

    /**
     * Update the panel view. If errorInfo is provided, send it to the webview for fallback UI.
     */
    public updateView(data?: any[], isAutoRefresh: boolean = false, errorInfo?: { hasError: boolean, message?: string }) {
        const gridData = data || this._logDataProvider?.getGridData();
        this.postMessage({
            type: 'updateData',
            data: gridData,
            isAutoRefresh: isAutoRefresh,
            errorInfo: errorInfo || null
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        this._logDataProvider?.setPanelVisibility(webviewView.visible);
        // Always load logs when panel becomes visible, regardless of auto-refresh setting
        if (webviewView.visible && this._logDataProvider) {
            // Don't await here to avoid blocking webview setup
            void this._logDataProvider.refreshLogs(true, false);
        }

        webviewView.onDidChangeVisibility(async () => {
            this._logDataProvider?.setPanelVisibility(webviewView.visible);
            if (webviewView.visible) {
                await this.refresh();
            }
        });

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                this._extensionUri
            ]
        };

        const scriptUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'ApexLogPanel', 'ApexLogPanel.js')
        );
        const styleUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'ApexLogPanel', 'ApexLogPanel.css')
        );

        webviewView.webview.html = this.getHtmlForWebview(scriptUri, styleUri);
        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'ready') {
                const logDataProvider = this._logDataProvider;
                if (!logDataProvider) {
                    this.updateView([], false, {
                        hasError: true,
                        message: this._connectionError ?? 'Connecting to Salesforce...'
                    });
                    return;
                }

                let initialData: any[] = [];
                let errorInfo: { hasError: boolean, message?: string } | null = null;
                try {
                    initialData = logDataProvider.getGridData();
                    // If no data available, force a refresh
                    if (!initialData || initialData.length === 0) {
                        await logDataProvider.refreshLogs(true, false);
                        initialData = logDataProvider.getGridData();
                    }
                } catch (err: any) {
                    // Detect common error causes
                    errorInfo = { hasError: true, message: err?.message || 'Unknown error' };
                }
                // If gridData is empty and errorInfo is set, show fallback
                this.updateView(initialData, false, errorInfo || undefined);
            } else if (message.command === 'openLog') {
                try {
                    await openLog({ id: message.log.id });
                } catch (err: any) {
                    // If log open fails, show error fallback
                    this.updateView([], false, { hasError: true, message: err?.message || 'Failed to open log.' });
                }
            } else if (message.command === 'inlineSearch') {
                try {
                    this._logDataProvider?.setSearchFilter(message.text);
                    this.updateView();
                } catch (err: any) {
                    this.updateView([], false, { hasError: true, message: err?.message || 'Search failed.' });
                }
            } else if (message.command === 'retryConnection') {
                await vscode.commands.executeCommand('salesforce-ag-log-viewer.retryConnection');
            }
        });
    }

    private getHtmlForWebview(scriptUri: vscode.Uri, styleUri: vscode.Uri) {
        const templatePath = path.join(this._extensionUri.fsPath, 'src', 'ApexLogPanel', 'ApexLogPanel.html');
        let template = fs.readFileSync(templatePath, 'utf8');
        template = template.replace('${scriptUri}', scriptUri.toString());
        template = template.replace('${styleUri}', styleUri.toString());
        return template;
    }
}
