import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { DateTime } from 'luxon';
import { DeveloperLog } from './developerLog';

export class LogViewer {
    static readonly START_MARKER = '|CODE_UNIT_STARTED|[EXTERNAL]|execute_anonymous_apex\n';
    static readonly END_MARKER = '|CODE_UNIT_FINISHED|execute_anonymous_apex\n';

    constructor(private readonly storagePath?: string) {}

    public get logsPath(): string | undefined {
        return this.storagePath ? path.resolve(this.storagePath, '.logs') : undefined;
    }

    public async showLog(log: DeveloperLog): Promise<void> {
        const logBody = await log.getBody();
        const fileName = DateTime.fromJSDate(log.startTime)
            .toFormat('MM-dd-yyyy_HH-mm-ss')
            .replace(/\//g, '-') + '_' + log.id + '.log';
        return this.openLog(logBody, fileName);
    }

    private async openLog(logBody: string, logFileName: string): Promise<void> {
        const formattedLog = this.formatLog(logBody);

        if (this.logsPath) {
            const fullLogPath = path.join(this.logsPath, logFileName);
            await fs.ensureDir(this.logsPath);
            await fs.writeFile(fullLogPath, formattedLog);

            const document = await vscode.workspace.openTextDocument(fullLogPath);
            if (document) {
                await vscode.languages.setTextDocumentLanguage(document, 'apexlog');
                await vscode.window.showTextDocument(document, { preview: true });
            }
        } else {
            const document = await vscode.workspace.openTextDocument({ content: formattedLog });
            if (document) {
                await vscode.languages.setTextDocumentLanguage(document, 'apexlog');
                await vscode.window.showTextDocument(document, { preview: true });
            }
        }
    }

    private formatLog(log: string): string {
        // Strip any duplicate ENTERING_MANAGED_PKG statements
        return log.replace(/(^[0-9:.() ]+\|ENTERING_MANAGED_PKG\|.*\n)+/gm, '$1');
    }
} 