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
            `Log Details: ${path.basename(fileName)}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'ApexLogDetails')] }
        );
        const htmlPath = path.join(extensionUri.fsPath, 'src', 'ApexLogDetails', 'ApexLogDetails.html');
        let html = fs.readFileSync(htmlPath, 'utf8');
        const scriptUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ApexLogDetails', 'ApexLogDetails.js'));
        const styleUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ApexLogDetails', 'ApexLogDetails.css'));
        const parserUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'src', 'ApexLogDetails', 'ApexLogParser.js'));
        html = html.replace('${scriptUri}', scriptUri.toString());
        html = html.replace('${styleUri}', styleUri.toString());
        html = html.replace('${parserUri}', parserUri.toString());
        html = html.replace(/\$\{cspSource\}/g, panel.webview.cspSource);
        // Send once the document is ready, including after a hidden webview
        // is recreated. Register before setting HTML to avoid a ready race.
        let logLines: string[] | undefined;
        const messages = panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg && msg.type === 'ready') {
                panel.webview.postMessage({ logContent, fileName: path.basename(fileName), logId: fileName });
            } else if (msg?.type === 'copyLogLine' && Number.isInteger(msg.index) && msg.index >= 0) {
                logLines ??= logContent.split(/\r?\n/);
                if (msg.index >= logLines.length) return;
                try {
                    await vscode.env.clipboard.writeText(logLines[msg.index]);
                    panel.webview.postMessage({ type: 'copyLogLineResult', index: msg.index, success: true });
                } catch {
                    panel.webview.postMessage({ type: 'copyLogLineResult', index: msg.index, success: false });
                }
            }
        });
        panel.onDidDispose(() => messages.dispose());
        panel.webview.html = html;
    }
}
