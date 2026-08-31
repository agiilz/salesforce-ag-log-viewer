import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { outputChannel } from '../outputChannel';

export class ApexLogDetails {
    public static registerCommand(context: vscode.ExtensionContext) {
        const disposable = vscode.commands.registerCommand('salesforce-ag-log-viewer.showLogDetails', async () => {
            const editor = vscode.window.activeTextEditor;
            const isSalesforceLog = editor?.document.languageId === 'salesforce-apex-log'
                || editor?.document.fileName.toLowerCase().endsWith('.log');
            if (!editor || !isSalesforceLog) {
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
        const nonce = randomBytes(16).toString('base64');
        html = html.replace('${scriptUri}', scriptUri.toString());
        html = html.replace('${styleUri}', styleUri.toString());
        html = html.split('${nonce}').join(nonce);
        html = html.replace('${cspSource}', panel.webview.cspSource);
        panel.webview.html = html;
        const shortFileName = path.basename(fileName);
        // Enviar logContent directamente tras setear el HTML
        panel.webview.postMessage({ type: 'loadLog', logContent, fileName: shortFileName });
        // Soporte para recarga: si el webview pide el log, reenviarlo
        panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg && msg.type === 'ready') {
                await panel.webview.postMessage({ type: 'loadLog', logContent, fileName: shortFileName });
            } else if (msg && msg.type === 'export' && (msg.format === 'raw' || msg.format === 'summary-json')) {
                const defaultName = msg.format === 'raw'
                    ? shortFileName
                    : `${path.parse(shortFileName).name}-summary.json`;
                const destination = await vscode.window.showSaveDialog({
                    defaultUri: vscode.Uri.file(path.join(path.dirname(fileName), defaultName)),
                    filters: msg.format === 'raw' ? { 'Log files': ['log'] } : { JSON: ['json'] }
                });
                if (!destination) {
                    return;
                }
                const content = msg.format === 'raw'
                    ? logContent
                    : JSON.stringify(sanitizeSummary(msg.summary), null, 2);
                await vscode.workspace.fs.writeFile(destination, Buffer.from(content, 'utf8'));
            }
        });
    }
}

function sanitizeSummary(value: unknown): Record<string, string | number> {
    if (typeof value !== 'object' || value === null) {
        return {};
    }
    const result: Record<string, string | number> = {};
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string') {
            result[key.slice(0, 100)] = item.slice(0, 1000);
        } else if (typeof item === 'number' && Number.isFinite(item)) {
            result[key.slice(0, 100)] = item;
        }
    }
    return result;
}
