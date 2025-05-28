import * as vscode from 'vscode';
interface DebugLineInfo {
    line: string;
    originalIndex: number;
}
interface DebugState {
    original: string;
    filtered: boolean;
    debugLines: DebugLineInfo[];
}

//Class to handle the USER_DEBUG filtering functionality for Apex logs
export class ApexLogUserDebug {
    
    // Map to store the original content of files when filtered
    private static readonly debugLogState = new Map<string, DebugState>();

    //Metodo para el boton de mostrar/ocultar los logs de debug
    public static async toggleDebugLogs(editor?: vscode.TextEditor): Promise<void> {
        const logEditor = ApexLogUserDebug.findLogEditor(editor);
        if (!logEditor) {
            vscode.window.showInformationMessage('No Salesforce .log file is active (checked all visible editors).');
            return;
        }

        const doc = logEditor.document;
        const uri = doc.uri.toString();
        const state = ApexLogUserDebug.debugLogState.get(uri);

        if (!state?.filtered) {
            await ApexLogUserDebug.showFilteredView(logEditor, uri);
        } else {
            await ApexLogUserDebug.restoreOriginalView(logEditor, uri, state);
        }
    }

    //Revisa las tabs abiertas y busca un editor de logs de Salesforce
    private static findLogEditor(editor?: vscode.TextEditor): vscode.TextEditor | undefined {
        // Try the passed editor, then activeTextEditor, then any visible editor
        let candidateEditors: vscode.TextEditor[] = [];
        if (editor?.document) candidateEditors.push(editor);
        if (vscode.window.activeTextEditor?.document && vscode.window.activeTextEditor !== editor) {
            candidateEditors.push(vscode.window.activeTextEditor);
        }
        candidateEditors = candidateEditors.concat(
            vscode.window.visibleTextEditors.filter(
                e => e?.document && !candidateEditors.includes(e)
            )
        );

        //Revisa las tabs abiertas y busca un editor de logs de Salesforce
        for (const ed of candidateEditors) {
            if (!ed?.document) continue;
            if (ApexLogUserDebug.isSalesforceLogDocument(ed.document)) {
                return ed;
            }
        }

        return undefined;
    }

    //Metodo para detectar si el documento es un .log
    private static isSalesforceLogDocument(doc: vscode.TextDocument): boolean {
        const fileName = doc.fileName || '';
        return fileName.toLowerCase().endsWith('.log');
    }

    //Metodo para mostrar los USER_DEBUG filtrados
    private static async showFilteredView(logEditor: vscode.TextEditor, uri: string): Promise<void> {
        const doc = logEditor.document;
        const original = doc.getText();
        const debugLines = ApexLogUserDebug.extractUserDebugLinesWithIndex(original);
        
        if (debugLines.length === 0) {
            vscode.window.showInformationMessage('No USER_DEBUG lines found in this log.');
            return;
        }

        try {
            //Guardamos el estado original del log + la posicion de los USER_DEBUG
            ApexLogUserDebug.debugLogState.set(uri, { 
                original, 
                filtered: true,
                debugLines
            });
            
            await ApexLogUserDebug.updateFileContent(logEditor, debugLines.map(d => d.line).join('\n'));
            await ApexLogUserDebug.moveCursorToTop(logEditor);

        } catch (error: any) {
            ApexLogUserDebug.handleError(error);
        }
    }

    //Metodo para restaurar la vista original del log
    private static async restoreOriginalView(logEditor: vscode.TextEditor, uri: string, state: DebugState): Promise<void> {
        try {
            const currentLine = logEditor.selection.active.line;
            const debugLineInfo = state.debugLines[currentLine];
            
            await ApexLogUserDebug.updateFileContent(logEditor, state.original);

            // Restore cursor position to the original line if we have the mapping
            if (debugLineInfo && debugLineInfo.originalIndex >= 0) {
                await ApexLogUserDebug.moveCursorToPosition(logEditor, debugLineInfo.originalIndex);
            }

            ApexLogUserDebug.debugLogState.delete(uri);
            
        } catch (error: any) {
            ApexLogUserDebug.handleError(error);
        }
    }

    //Metodo para actualizar el contenido del archivo de log y que no salga como modificado
    private static async updateFileContent(logEditor: vscode.TextEditor, content: string): Promise<void> {
        const writeData = Buffer.from(content, 'utf8');
        await vscode.workspace.fs.writeFile(logEditor.document.uri, writeData);
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait for file to be reloaded
    }

    //Metodo para mover el cursor al inicio del log cuando se filtran los USER_DEBUG
    private static async moveCursorToTop(logEditor: vscode.TextEditor): Promise<void> {
        const startPos = new vscode.Position(0, 0);
        logEditor.selection = new vscode.Selection(startPos, startPos);
        logEditor.revealRange(
            new vscode.Range(startPos, startPos),
            vscode.TextEditorRevealType.AtTop
        );
    }

    //Metodo para mover el cursor a la posicion especifica donde se encuentra el USER_DEBUG
    private static async moveCursorToPosition(logEditor: vscode.TextEditor, line: number): Promise<void> {
        const position = new vscode.Position(line, 0);
        logEditor.selection = new vscode.Selection(position, position);
        logEditor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenter
        );
    }

    private static handleError(error: any): void {
        vscode.window.showErrorMessage(`Error: ${error.message ?? 'Unknown error'}`);
        console.error('Error:', error);
    }

    // Extrae y filtra las líneas USER_DEBUG con sus índices (numero de linea) originales
    private static extractUserDebugLinesWithIndex(original: string): DebugLineInfo[] {
        const lines = original.split(/\r?\n/);
        return lines
            .map((line, index) => ({ line, index }))
            .filter(({ line }) => line.toUpperCase().includes('USER_DEBUG'))
            .map(({ line, index }) => {
                // Extract [line] and message part
                // Regex: ...|USER_DEBUG|[line]|DEBUG|message
                const match = line.match(/\|USER_DEBUG\|\[(\d+)\]\|DEBUG\|(.*)$/i);
                if (match) {
                    return {
                        line: `[${match[1]}] ${match[2].trim()}`,
                        originalIndex: index
                    };
                }
                return { line, originalIndex: index };
            });
    }

    //Metodo para registrar el comando de mostrar/ocultar los logs de debug
    public static registerCommand(context: vscode.ExtensionContext): void {
        const toggleCommand = vscode.commands.registerCommand(
            'salesforce-ag-log-viewer.toggleDebugLogs',
            ApexLogUserDebug.toggleDebugLogs // do NOT use .bind(this)
        );
        
        context.subscriptions.push(toggleCommand);
    }
}
