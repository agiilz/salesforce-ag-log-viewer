import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { DateTime } from 'luxon';
import { DeveloperLog } from './developerLog';
import { outputChannel } from './extension';

export class LogViewer {
    static readonly START_MARKER = '|CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous_apex\n';
    static readonly END_MARKER = '|CODE_UNIT_FINISHED|execute_anonymous_apex\n';
    private activeDownload: boolean = false;

    constructor(
        private readonly storagePath?: string,
        private readonly activeProvider?: any
    ) {}

    public get logsPath(): string | undefined {
        return this.storagePath ? path.resolve(this.storagePath, '.logs') : undefined;
    }

    private getLogFileName(log: DeveloperLog): string {
        // Deterministic filename: based on log id and start time only
        return (
            DateTime.fromJSDate(log.startTime)
                .toFormat('MM-dd-yyyy_HH-mm-ss')
                .replace(/\//g, '-') + '_' + log.id + '.log'
        );
    }

    private getLogPath(log: DeveloperLog): string | undefined {
        if (!this.logsPath) return undefined;
        return path.join(this.logsPath, this.getLogFileName(log));
    }

    private async logExists(log: DeveloperLog): Promise<boolean> {
        const logPath = this.getLogPath(log);
        if (!logPath) return false;
        return await fs.pathExists(logPath);
    }

    public async showLog(log: DeveloperLog): Promise<void> {
        const logPath = this.getLogPath(log);
        let fileExisted = false;
        if (logPath) {
            fileExisted = await fs.pathExists(logPath);
            // If the file exists and is not deleted, just focus it in a new tab
            if (fileExisted) {
                outputChannel.appendLine(`Opening cached log: ${logPath}`);
                const document = await vscode.workspace.openTextDocument(logPath);
                if (document) {
                    await vscode.languages.setTextDocumentLanguage(document, 'apexlog');
                    await vscode.window.showTextDocument(document, { preview: false });
                    this.notifyLogDownloaded(log.id);
                    return;
                }
            } else {
                // If the file was deleted but an editor is open, close it before recreating
                const openEditors = vscode.window.visibleTextEditors;
                for (const editor of openEditors) {
                    if (editor.document.uri.fsPath === logPath) {
                        await vscode.window.showTextDocument(editor.document, { preview: false });
                        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                        await new Promise(res => setTimeout(res, 300));
                    }
                }
            }
        }
        this.activeDownload = true;
        try {
            outputChannel.appendLine(`Downloading new log: ${log.operation} (${(log.size / 1024).toFixed(1)} KB)`);
            const logBody = await log.getBody();
            const fileName = this.getLogFileName(log);
            outputChannel.appendLine('Processing and saving log...');
            await this.openLog(logBody, fileName);
            await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
            outputChannel.appendLine('Log downloaded and opened successfully');
            this.notifyLogDownloaded(log.id);
        } catch (error) {
            outputChannel.appendLine(`Error downloading log: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        } finally {
            this.activeDownload = false;
        }
    }

    private notifyLogDownloaded(logId: string) {
        if (this.activeProvider?.postMessage) {
            this.activeProvider.postMessage({ 
                type: 'logDownloaded',
                logId: logId 
            });
        }
    }

    private async openLog(logBody: string, logFileName: string): Promise<void> {
        const formattedLog = this.formatLog(logBody);
        if (this.logsPath) {
            const fullLogPath = path.join(this.logsPath, logFileName);
            await fs.ensureDir(this.logsPath);
            await fs.writeFile(fullLogPath, formattedLog);
            await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
            const document = await vscode.workspace.openTextDocument(fullLogPath);
            if (document) {
                await vscode.languages.setTextDocumentLanguage(document, 'apexlog');
                await vscode.window.showTextDocument(document, { preview: false });
            }
        } else {
            const document = await vscode.workspace.openTextDocument({ content: formattedLog });
            if (document) {
                await vscode.languages.setTextDocumentLanguage(document, 'apexlog');
                await vscode.window.showTextDocument(document, { preview: false });
            }
        }
    }

    private formatLog(log: string): string {
        // Strip any duplicate ENTERING_MANAGED_PKG statements
        return log.replace(/(^[0-9:.() ]+\|ENTERING_MANAGED_PKG\|.*\n)+/gm, '$1');
    }

    public async clearDownloadedLogs(): Promise<void> {
        if (this.logsPath && await fs.pathExists(this.logsPath)) {
            await fs.emptyDir(this.logsPath);
        }
    }
}