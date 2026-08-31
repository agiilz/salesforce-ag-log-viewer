import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { ApexLog } from './ApexLogWrapper';
import { outputChannel } from './outputChannel';

export class ApexLogFileManager {
    private readonly inFlightLogs = new Map<string, Promise<void>>();

    constructor(
        private readonly storagePath?: string
    ) { }

    public get logsPath(): string | undefined {
        return this.storagePath ? path.resolve(this.storagePath, '.logs') : undefined;
    }

    //Para obtener el nombre del log en el sistema de archivos
    private getLogFileName(log: ApexLog): string {
        //El nombre del log se basa en el log StartTime + ID para tener un valor unico
        const d = log.startTime;
        const pad = (n: number) => n.toString().padStart(2, '0');
        //Formateamos la fecha a--> 05-22-2025_15-30-00
        const formatted =
            `${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${d.getFullYear()}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;

        return `${formatted}_${log.id}.log`;
    }

    //Para obtener la ruta completa del log en el sistema de archivos
    private getLogPath(log: ApexLog): string | undefined {
        if (!this.logsPath) return undefined;
        return path.join(this.logsPath, this.getLogFileName(log));
    }

    //Metodo para abrir el log en el editor
    public async showLog(log: ApexLog, loadBody: () => Promise<string> = () => log.getBody()): Promise<void> {
        const inFlight = this.inFlightLogs.get(log.id);
        if (inFlight) {
            return inFlight;
        }

        const operation = this.openOrDownloadLog(log, loadBody);
        this.inFlightLogs.set(log.id, operation);
        try {
            await operation;
        } finally {
            this.inFlightLogs.delete(log.id);
        }
    }

    private async openOrDownloadLog(log: ApexLog, loadBody: () => Promise<string>): Promise<void> {
        const logPath = this.getLogPath(log);
        let fileExists = false;

        if (logPath) {
            try {
                fileExists = await fs.pathExists(logPath);
            } catch (fsErr) {
                outputChannel.appendLine(`File system error: ${fsErr}`);
                throw fsErr;
            }
            if (fileExists) {
                const stats = await fs.stat(logPath);
                if (stats.size === 0 || (log.size > 0 && stats.size < Math.min(log.size, 256))) {
                    outputChannel.appendLine(`Removing incomplete cached log: ${logPath}`);
                    await fs.remove(logPath);
                    fileExists = false;
                }
            }
            if (fileExists) {
                //Si el fichero existe localmente, se abre en el editor
                try {
                    outputChannel.appendLine(`Opening cached log: ${logPath}`);
                    const document = await vscode.workspace.openTextDocument(logPath);
                    await vscode.languages.setTextDocumentLanguage(document, 'salesforce-apex-log');
                    await vscode.window.showTextDocument(document, { preview: false });
                    return;
                } catch (openErr) {
                    outputChannel.appendLine(`Error opening cached log: ${openErr}`);
                    throw openErr;
                }
            }

            //Si el fichero ha sido borrado (por el boton de borrar logs localmente) 
            // y el editor esta abierto, cerramos el editor antes de recrear el fichero para que no aparezca como borrado
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    const input = tab.input;
                    if (input instanceof vscode.TabInputText && input.uri.fsPath === logPath) {
                        await vscode.window.tabGroups.close(tab);
                    }
                }
            }
        }

        // Si el fichero no existe localmente lo descargamos de la Org
        try {
            outputChannel.appendLine(`Downloading new log: ${log.operation} (${(log.size / 1024).toFixed(1)} KB)`);
            const logBody = await loadBody();
            const fileName = this.getLogFileName(log);
            outputChannel.appendLine('Processing and saving log...');
            await this.openLog(logBody, fileName, log.size);

            //Refresco del explorador de archivos del VsCode para que aparezca el nuevo log
            await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
            outputChannel.appendLine('Log downloaded and opened successfully');

        } catch (error) {
            outputChannel.appendLine(`Error downloading log: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    //Para abrir el registro de Log en el editor
    private async openLog(logBody: string, logFileName: string, expectedSize: number): Promise<void> {
        //log.replace(/(^[0-9:.() ]+\|ENTERING_MANAGED_PKG\|.*\n)+/gm, '$1');
        let document: vscode.TextDocument;
        if (this.logsPath) {
            //Si existe la ruta de logs, se crea alli el archivo log y se abre en el editor
            const fullLogPath = path.join(this.logsPath, logFileName);
            const temporaryPath = `${fullLogPath}.${process.pid}.${Date.now()}.tmp`;
            await fs.ensureDir(this.logsPath);
            try {
                await fs.writeFile(temporaryPath, logBody);
                const temporaryStats = await fs.stat(temporaryPath);
                const bodySize = Buffer.byteLength(logBody, 'utf8');
                if ((expectedSize > 0 && bodySize === 0) || temporaryStats.size !== bodySize) {
                    throw new Error(`Downloaded log file is incomplete: expected ${bodySize} bytes, wrote ${temporaryStats.size}`);
                }
                await fs.move(temporaryPath, fullLogPath, { overwrite: true });
            } finally {
                await fs.remove(temporaryPath).catch(() => undefined);
            }
            await this.pruneCache();
            await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
            document = await vscode.workspace.openTextDocument(fullLogPath);
        } else {
            //Si no existe la ruta de logs, se crea un nuevo documento temporal y se abre en el editor
            document = await vscode.workspace.openTextDocument({ content: logBody });
        }
        await vscode.languages.setTextDocumentLanguage(document, 'salesforce-apex-log');
        await vscode.window.showTextDocument(document, { preview: false });
    }

    public async hasCachedLog(log: ApexLog): Promise<boolean> {
        const logPath = this.getLogPath(log);
        return Boolean(logPath && await fs.pathExists(logPath));
    }

    private async pruneCache(): Promise<void> {
        if (!this.logsPath || !await fs.pathExists(this.logsPath)) {
            return;
        }
        const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
        const maximumFiles = Math.max(config.get<number>('cacheMaxFiles') ?? 100, 10);
        const retentionDays = Math.max(config.get<number>('cacheRetentionDays') ?? 14, 1);
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const entries = await Promise.all((await fs.readdir(this.logsPath))
            .filter(name => name.toLowerCase().endsWith('.log'))
            .map(async name => {
                const filePath = path.join(this.logsPath!, name);
                const stats = await fs.stat(filePath);
                return { filePath, modified: stats.mtimeMs };
            }));
        entries.sort((first, second) => second.modified - first.modified);
        const openFiles = new Set(vscode.workspace.textDocuments.map(document => document.uri.fsPath));
        const expired = entries.filter((entry, index) =>
            !openFiles.has(entry.filePath) && (index >= maximumFiles || entry.modified < cutoff)
        );
        await Promise.all(expired.map(entry => fs.remove(entry.filePath)));
    }

    //Para borrar los logs descargados localmente
    public async clearDownloadedLogs(): Promise<void> {
        if (this.logsPath && await fs.pathExists(this.logsPath)) {
            await fs.emptyDir(this.logsPath);

            //Cerrar todas las tabs que coincidan con los logs locales borrados
            //TODO: meter que sea una setting opcional
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    const input = tab.input;
                    const uri = input instanceof vscode.TabInputText
                        ? input.uri
                        : input instanceof vscode.TabInputTextDiff
                            ? input.modified
                            : undefined;
                    if (uri?.fsPath === this.logsPath || uri?.fsPath.startsWith(`${this.logsPath}${path.sep}`)) {
                        await vscode.window.tabGroups.close(tab);
                    }
                }
            }

        }
    }
}