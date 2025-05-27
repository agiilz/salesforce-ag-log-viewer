import * as vscode from 'vscode';

/**
 * Class to handle the USER_DEBUG filtering functionality for Apex logs
 */
export class ApexLogUserDebug {
    
    // Map to store the original content of files to restore when toggling
    private static readonly debugLogState = new Map<string, { original: string, filtered: boolean }>();

    /**
     * Toggle between showing only USER_DEBUG lines and showing all lines in a log file
     * @param editor Optional text editor, if not provided will use the active text editor
     */
    public static async toggleDebugLogs(editor?: vscode.TextEditor) {
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

        // Debug: log all candidate editors
        console.log('ApexLogUserDebug: candidateEditors:', candidateEditors.map(e => e?.document?.fileName));

        // Enhanced detection logic (arrow function to preserve 'this')
        const isSalesforceLogDocument = (doc: vscode.TextDocument): boolean => {
            const fileName = doc.fileName || '';
            const langId = doc.languageId;
            // Accept .log extension
            if (fileName.toLowerCase().endsWith('.log')) return true;
            // Accept custom language ids
            if (langId === 'log' || langId === 'apexlog') return true;
            // Accept Salesforce log filename pattern (e.g., 05-27-2025_18-07-53_07LJW00000LgjFx2AJ.log)
            if (/\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}_[0-9A-Za-z]{15,18}\.log$/i.test(fileName)) return true;
            // Accept untitled/virtual docs with log-like content
            if (doc.isUntitled || fileName === '' || fileName.startsWith('Untitled-')) {
                // Check first 10 lines for USER_DEBUG or EXECUTION_STARTED
                const text = doc.getText(new vscode.Range(0, 0, Math.min(10, doc.lineCount), 0));
                if (/USER_DEBUG|EXECUTION_STARTED|CODE_UNIT_STARTED|CODE_UNIT_FINISHED/.test(text)) {
                    return true;
                }
            }
            return false;
        };

        let logEditor: vscode.TextEditor | undefined;
        for (const ed of candidateEditors) {
            if (!ed?.document) continue;
            const doc = ed.document;
            // Debug: log each doc
            console.log('ApexLogUserDebug: checking doc:', doc.fileName, doc.languageId, doc.isUntitled);
            if (isSalesforceLogDocument(doc)) {
                logEditor = ed;
                break;
            }
        }

        if (!logEditor) {
            vscode.window.showInformationMessage('No Salesforce .log file is active (checked all visible editors).');
            return;
        }

        const doc = logEditor.document;
        const uri = doc.uri.toString();
        const isFiltered = ApexLogUserDebug.debugLogState.get(uri)?.filtered;
        if (!isFiltered) {
            const original = doc.getText();
            // Only show the [line] and message part for USER_DEBUG lines
            // Example: 17:16:52.2 (115339004)|USER_DEBUG|[559]|DEBUG|WpRecordsHijosSAP:()
            // Should show: [559] WpRecordsHijosSAP:()
            const debugLines = original.split(/\r?\n/)
                .filter(line => line.toUpperCase().includes('USER_DEBUG'))
                .map(line => {
                    // Extract [line] and message part
                    // Regex: ...|USER_DEBUG|[line]|DEBUG|message
                    const match = line.match(/\|USER_DEBUG\|\[(\d+)\]\|DEBUG\|(.*)$/i);
                    if (match) {
                        return `[${match[1]}] ${match[2].trim()}`;
                    }
                    return line; // fallback
                });
            if (debugLines.length === 0) {
                vscode.window.showInformationMessage('No USER_DEBUG lines found in this log.');
                return;
            }
            try {
                ApexLogUserDebug.debugLogState.set(uri, { original, filtered: true });
                const edit = new vscode.WorkspaceEdit();
                edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), debugLines.join('\n'));
                const success = await vscode.workspace.applyEdit(edit);
                if (success) {
                    vscode.window.showInformationMessage(`Showing ${debugLines.length} USER_DEBUG lines`);
                } else {
                    vscode.window.showErrorMessage('Failed to filter log.');
                }
            } catch (error: any) {
                vscode.window.showErrorMessage(`Error: ${error.message ?? 'Unknown error'}`);
                console.error('Error:', error);
            }
        } else {
            const state = ApexLogUserDebug.debugLogState.get(uri);
            if (state) {
                try {
                    const edit = new vscode.WorkspaceEdit();
                    edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), state.original);
                    const success = await vscode.workspace.applyEdit(edit);
                    if (success) {
                        ApexLogUserDebug.debugLogState.set(uri, { original: state.original, filtered: false });
                        vscode.window.showInformationMessage('Showing all log lines');
                    } else {
                        vscode.window.showErrorMessage('Failed to restore log.');
                    }
                } catch (error: any) {
                    vscode.window.showErrorMessage(`Error: ${error.message ?? 'Unknown error'}`);
                    console.error('Error:', error);
                }
            }
        }
    }

    /**
     * Register the command and menu items for the debug logs functionality
     * @param context Extension context for registering commands
     */
    public static registerCommand(context: vscode.ExtensionContext): void {
        // Register the toggle debug logs command
        const toggleCommand = vscode.commands.registerCommand(
            'salesforce-ag-log-viewer.toggleDebugLogs',
            ApexLogUserDebug.toggleDebugLogs // do NOT use .bind(this)
        );
        
        context.subscriptions.push(toggleCommand);
    }
}
