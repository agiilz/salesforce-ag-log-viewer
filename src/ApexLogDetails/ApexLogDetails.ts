import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { outputChannel } from '../extension';

export class ApexLogDetails {
    public static registerCommand(context: vscode.ExtensionContext) {
        const disposable = vscode.commands.registerCommand('salesforce-ag-log-viewer.showLogDetails', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || !editor.document.fileName.endsWith('.log')) {
                vscode.window.showInformationMessage('No Salesforce .log file is active.');
                outputChannel.appendLine('[LogDetails] No active .log file.');
                return;
            }
            const logContent = editor.document.getText();
            outputChannel.appendLine(`[LogDetails] Opening log details for file: ${editor.document.fileName}, length: ${logContent.length}`);
            await ApexLogDetails.showLogDetailsWebview(logContent, editor.document.fileName, context.extensionUri);
        });
        context.subscriptions.push(disposable);
    }

    public static async showLogDetailsWebview(logContent: string, fileName: string, extensionUri: vscode.Uri) {
        outputChannel.appendLine(`[LogDetails] Creating webview for: ${fileName}`);
        const panel = vscode.window.createWebviewPanel(
            'apexLogDetails',
            `Log Details: ${fileName.split('\\').pop()}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'ApexLogDetails')] }
        );
        const htmlPath = path.join(extensionUri.fsPath, 'src', 'ApexLogDetails', 'ApexLogDetails.html');
        let html = fs.readFileSync(htmlPath, 'utf8');
        const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ApexLogDetails', 'ApexLogDetails.js'));
        const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ApexLogDetails', 'ApexLogDetails.css'));
        html = html.replace('${scriptUri}', scriptUri.toString());
        html = html.replace('${styleUri}', styleUri.toString());
        panel.webview.html = html;
        // Enviar logContent directamente tras setear el HTML
        panel.webview.postMessage({ logContent, fileName: fileName.split('\\').pop() });
        // Soporte para recarga: si el webview pide el log, reenviarlo
        panel.webview.onDidReceiveMessage((msg) => {
            if (msg && msg.type === 'ready') {
                panel.webview.postMessage({ logContent, fileName: fileName.split('\\').pop() });
            }
        });
    }
}
