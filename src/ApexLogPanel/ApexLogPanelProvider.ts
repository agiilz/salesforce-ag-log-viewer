import * as vscode from 'vscode';
import { LogDataProvider } from '../ApexLogDataProvider';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { openLog } from '../extension';
import { HostToPanelMessage, parsePanelMessage } from '../webviewMessages';

import { IApexLogPanelProvider } from './IApexLogPanelProvider';

export class ApexLogPanelProvider implements vscode.WebviewViewProvider, IApexLogPanelProvider {
    private _view?: vscode.WebviewView;
    private _logDataProvider?: LogDataProvider;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _getLogDataProvider: () => Promise<LogDataProvider>
    ) { } public async refresh(): Promise<void> {
        try {
            const logDataProvider = await this.getLogDataProvider();
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Refreshing Salesforce logs...',
                cancellable: false
            }, async () => {
                await logDataProvider.refreshLogs(false, true);
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.updateView([], false, { hasError: true, message });
        }
    } public postMessage(message: HostToPanelMessage) {
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
        const gridData = data || this._logDataProvider?.getGridData() || [];
        this.postMessage({
            type: 'updateData',
            data: gridData,
            isAutoRefresh: isAutoRefresh,
            errorInfo: errorInfo || null,
            meta: this._logDataProvider?.getPanelMeta()
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken,
    ) {
        if (token.isCancellationRequested) {
            return;
        }
        this._view = webviewView;

        webviewView.onDidChangeVisibility(async () => {
            if (token.isCancellationRequested) {
                return;
            }
            this._logDataProvider?.setPanelVisibility(webviewView.visible);
            if (webviewView.visible && this._logDataProvider) {
                await this.refresh();
            }
        });

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'src', 'ApexLogPanel')
            ]
        };

        const scriptUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'ApexLogPanel', 'ApexLogPanel.js')
        );
        const styleUri = webviewView.webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'src', 'ApexLogPanel', 'ApexLogPanel.css')
        );

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview, scriptUri, styleUri);
        webviewView.webview.onDidReceiveMessage(async (rawMessage) => {
            if (token.isCancellationRequested) {
                return;
            }
            const message = parsePanelMessage(rawMessage);
            if (!message) {
                return;
            }
            try {
            if (message.command === 'ready') {
                let initialData: any[] = [];
                let errorInfo: { hasError: boolean, message?: string } | null = null;
                try {
                    const logDataProvider = await this.getLogDataProvider();
                    logDataProvider.setPanelVisibility(webviewView.visible);
                    initialData = logDataProvider.getGridData();
                    // If no data available, force a refresh
                    if (!initialData || initialData.length === 0) {
                        await logDataProvider.refreshLogs(true, false);
                        return;
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
                    const logDataProvider = await this.getLogDataProvider();
                    logDataProvider.setSearchFilter(message.text);
                } catch (err: any) {
                    this.updateView([], false, { hasError: true, message: err?.message || 'Search failed.' });
                }
            } else if (message.command === 'setFilters') {
                const logDataProvider = await this.getLogDataProvider();
                logDataProvider.setFilters(message.filters);
            } else if (message.command === 'toggleFavorite') {
                const logDataProvider = await this.getLogDataProvider();
                await logDataProvider.toggleFavorite(message.logId);
            } else if (message.command === 'loadOlder') {
                const logDataProvider = await this.getLogDataProvider();
                await logDataProvider.loadOlder();
            } else if (message.command === 'compareLogs') {
                const logDataProvider = await this.getLogDataProvider();
                await logDataProvider.compareLogs(message.logIds);
            } else if (message.command === 'exportFilteredLogs') {
                const logDataProvider = await this.getLogDataProvider();
                await logDataProvider.exportFilteredLogs();
            }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                vscode.window.showErrorMessage(`Salesforce Logs: ${errorMessage}`);
            }
        });
    }

    private async getLogDataProvider(): Promise<LogDataProvider> {
        if (!this._logDataProvider) {
            this._logDataProvider = await this._getLogDataProvider();
        }
        return this._logDataProvider;
    }

    private getHtmlForWebview(webview: vscode.Webview, scriptUri: vscode.Uri, styleUri: vscode.Uri) {
        const templatePath = path.join(this._extensionUri.fsPath, 'src', 'ApexLogPanel', 'ApexLogPanel.html');
        let template = fs.readFileSync(templatePath, 'utf8');
        const nonce = randomBytes(16).toString('base64');
        template = template.replace('${scriptUri}', scriptUri.toString());
        template = template.replace('${styleUri}', styleUri.toString());
        template = template.split('${nonce}').join(nonce);
        template = template.replace('${cspSource}', webview.cspSource);
        return template;
    }
}
