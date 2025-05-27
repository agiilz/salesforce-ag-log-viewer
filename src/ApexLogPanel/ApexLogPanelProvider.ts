import * as vscode from 'vscode';
import { LogDataProvider } from '../ApexLogDataProvider';
import * as fs from 'fs';
import * as path from 'path';
import { openLog } from '../extension';

export class ApexLogPanelProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private readonly _logDataProvider: LogDataProvider;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        logDataProvider: LogDataProvider
    ) {
        this._logDataProvider = logDataProvider;
    }    public async refresh(): Promise<void> {
        if (this._logDataProvider) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'Refreshing Salesforce logs...',
                cancellable: false
            }, async () => {
                await this._logDataProvider.refreshLogs(false, true);
            });
        }
    }public postMessage(message: any) {
        if (this._view) {
            this._view.webview.postMessage(message);
        }
    }

    public showSearchBoxInWebview() {
        this.postMessage({ type: 'showSearchBox' });
    }    public updateView(data?: any[], isAutoRefresh: boolean = false) {
        const gridData = data || this._logDataProvider?.getGridData();
        this.postMessage({ 
            type: 'updateData',
            data: gridData,
            isAutoRefresh: isAutoRefresh
        });
    }public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        this._logDataProvider.setPanelVisibility(webviewView.visible);
        // Always load logs when panel becomes visible, regardless of auto-refresh setting
        if (webviewView.visible) {
            // Don't await here to avoid blocking webview setup
            this._logDataProvider.refreshLogs(true, false);
        }

        webviewView.onDidChangeVisibility(async () => {
            this._logDataProvider.setPanelVisibility(webviewView.visible);
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

        webviewView.webview.html = this.getHtmlForWebview(scriptUri, styleUri);        webviewView.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'ready') {
                let initialData = this._logDataProvider?.getGridData();
                
                // If no data available, force a refresh
                if (!initialData || initialData.length === 0) {
                    await this._logDataProvider.refreshLogs(true, false);
                    initialData = this._logDataProvider?.getGridData();
                }
                
                this.updateView(initialData, false);
            } else if (message.command === 'openLog') {
                await openLog({ id: message.log.id });
            } else if (message.command === 'inlineSearch') {
                this._logDataProvider?.setSearchFilter(message.text);
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
