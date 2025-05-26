import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs-extra';
import { ApexLog } from './ApexLogWrapper';
import { outputChannel } from './extension';

export class ApexLogFileManager {

    constructor(
        private readonly storagePath?: string,
        private readonly activeProvider?: any
    ) {}

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
    public async showLog(log: ApexLog): Promise<void> {
        const logPath = this.getLogPath(log);
        let fileExists = false;

        if (logPath) {
            fileExists = await fs.pathExists(logPath);
            if (fileExists) {
                //Si el fichero existe localmente, se abre en el editor
                outputChannel.appendLine(`Opening cached log: ${logPath}`);
                const document = await vscode.workspace.openTextDocument(logPath);
                await vscode.languages.setTextDocumentLanguage(document, 'apexlog');
                await vscode.window.showTextDocument(document, { preview: false });
                this.notifyLogDownloaded(log.id);
                return;
            }

            //Si el fichero ha sido borrado (por el boton de borrar logs localmente) 
            // y el editor esta abierto, cerramos el editor antes de recrear el fichero para que no aparezca como borrado
            for (const editor of vscode.window.visibleTextEditors) {
                if (editor.document.uri.fsPath === logPath) {
                    await vscode.window.showTextDocument(editor.document, { preview: false });
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    await new Promise(res => setTimeout(res, 300));
                }
            }
        }

        // Si el fichero no existe localmente lo descargamos de la Org
        try {
            outputChannel.appendLine(`Downloading new log: ${log.operation} (${(log.size / 1024).toFixed(1)} KB)`);
            const logBody = await log.getBody();
            const fileName = this.getLogFileName(log);
            outputChannel.appendLine('Processing and saving log...');
            await this.openLog(logBody, fileName);
            
            //Refresco del explorador de archivos del VsCode para que aparezca el nuevo log
            await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
            outputChannel.appendLine('Log downloaded and opened successfully');
            
            //Enviar notificacion al WebView de que el log ha sido descargado
            this.notifyLogDownloaded(log.id);
        } catch (error) {
            outputChannel.appendLine(`Error downloading log: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }
    }

    //Notificar al WebView que el log ha sido descargado
    private notifyLogDownloaded(logId: string) {
        if (this.activeProvider?.postMessage) {
            this.activeProvider.postMessage({ 
                type: 'logDownloaded',
                logId: logId 
            });
        }
    }

    //Para abrir el registro de Log en el editor
    private async openLog(logBody: string, logFileName: string): Promise<void> {
        //log.replace(/(^[0-9:.() ]+\|ENTERING_MANAGED_PKG\|.*\n)+/gm, '$1');
        let document: vscode.TextDocument;
        if (this.logsPath) {
            //Si existe la ruta de logs, se crea alli el archivo log y se abre en el editor
            const fullLogPath = path.join(this.logsPath, logFileName);
            await fs.ensureDir(this.logsPath);
            await fs.writeFile(fullLogPath, logBody);
            await vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
            document = await vscode.workspace.openTextDocument(fullLogPath);
        } else {
            //Si no existe la ruta de logs, se crea un nuevo documento temporal y se abre en el editor
            document = await vscode.workspace.openTextDocument({ content: logBody });
        }
        await vscode.languages.setTextDocumentLanguage(document, 'apexlog');
        await vscode.window.showTextDocument(document, { preview: false });
    }

    //Para borrar los logs descargados localmente
    public async clearDownloadedLogs(): Promise<void> {
        if (this.logsPath && await fs.pathExists(this.logsPath)) {
            await fs.emptyDir(this.logsPath);
            
            //Cerrar todas las tabs que coincidan con los logs locales borrados
            //TODO: meter que sea una setting opcional
            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    if (
                        tab.input && typeof tab.input === 'object' && tab.input !== null && 'uri' in tab.input &&
                        (tab.input as any).uri.fsPath.startsWith(this.logsPath)
                    ){
                        await vscode.window.tabGroups.close(tab);
                    }
                }
            }

        }
    }
}