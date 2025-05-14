import { Connection } from 'jsforce';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

let currentOrgUsername: string | undefined;
const outputChannel = vscode.window.createOutputChannel('Salesforce Connection');

export async function createConnection(): Promise<Connection> {
    try {
        const newOrgUsername = await getCurrentOrgFromConfig();
        if (!newOrgUsername) {
            throw new Error('No target org found in .sf/config.json');
        }

        // Check if org has changed
        if (currentOrgUsername !== undefined && currentOrgUsername !== newOrgUsername) {
            outputChannel.appendLine(`Org changed: ${currentOrgUsername} -> ${newOrgUsername}`);
        }
        currentOrgUsername = newOrgUsername;

        // Get org details using the target org
        const { stdout: orgDetailsOutputSF } = await executeCommand(`sf org display --json -o ${newOrgUsername}`);
        const orgDetails = JSON.parse(orgDetailsOutputSF);
        
        if (!orgDetails.result) {
            throw new Error(`Failed to get org details for ${newOrgUsername}`);
        }

        return new Connection({
            instanceUrl: orgDetails.result.instanceUrl,
            accessToken: orgDetails.result.accessToken
        });
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        vscode.window.showErrorMessage(`Failed to connect to Salesforce: ${errorMessage}`);
        throw error;
    }
}

export async function getCurrentOrgFromConfig(): Promise<string | undefined> {
    try {
        // First try workspace root
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
        if (workspaceRoot) {
            const sfConfigPath = path.join(workspaceRoot, '.sf', 'config.json');
            try {
                const configContent = await fs.promises.readFile(sfConfigPath, 'utf8');
                const config = JSON.parse(configContent);
                if (config['target-org']) {
                    outputChannel.appendLine(`Found target org in workspace config: ${config['target-org']}`);
                    return config['target-org'];
                }
            } catch (error) {
                outputChannel.appendLine('No config found in workspace, checking user home directory');
            }
        }

        // Try user's home directory
        const homeDir = process.env.USERPROFILE ?? process.env.HOME;
        if (!homeDir) {
            outputChannel.appendLine('Could not find home directory');
            return undefined;
        }

        const sfConfigPath = path.join(homeDir, '.sf', 'config.json');
        try {
            const configContent = await fs.promises.readFile(sfConfigPath, 'utf8');
            const config = JSON.parse(configContent);
            if (config['target-org']) {
                outputChannel.appendLine(`Found target org in user config: ${config['target-org']}`);
                return config['target-org'];
            } else {
                outputChannel.appendLine('No target-org found in config file');
                return undefined;
            }
        } catch (error) {
            outputChannel.appendLine(`Error reading .sf/config.json: ${error}`);
            return undefined;
        }
    } catch (error) {
        outputChannel.appendLine(`Error getting current org from config: ${error}`);
        return undefined;
    }
}

function executeCommand(command: string): Promise<{ stdout: string, stderr: string }> {
    return new Promise((resolve, reject) => {
        exec(command, (error: Error | null, stdout: string, stderr: string) => {
            if (error) {
                reject(error);
            } else {
                resolve({ stdout, stderr });
            }
        });
    });
}