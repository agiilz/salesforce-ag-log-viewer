import { Connection } from 'jsforce';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { outputChannel } from './extension';

let currentOrgUsername: string | undefined;
let currentConnection: Connection | undefined;

//Obtenemos la conexion a la org de Salesforce
export async function getConnection(): Promise<Connection> {
    const newOrgUsername = await getCurrentOrgFromConfig();
    if (!newOrgUsername) {
        throw new Error('No target org found in .sf/config.json');
    }

    //Si la org ha cambiado, crea una nueva conexion
    if (!currentConnection || currentOrgUsername !== newOrgUsername) {
        try{
            await createConnection(newOrgUsername);
        }catch (error: any) {
            const errorMessage = error?.message || 'Unknown error occurred';
            vscode.window.showErrorMessage(`Failed to connect to Salesforce: ${errorMessage}`);
            throw error;
        }
        
    }

    return currentConnection!;
}

//Metodo para crear una nueva conexion a la org de Salesforce
async function createConnection(newOrgUsername: string): Promise<void> {
    
    outputChannel.appendLine(`Org changed: ${currentOrgUsername} -> ${newOrgUsername}`);
    currentOrgUsername = newOrgUsername;

    // Get org details using the target org
    const { stdout: orgDetailsOutputSF } = await executeCommand(`sf org display --json -o "${newOrgUsername}"`);
    const orgDetails = JSON.parse(orgDetailsOutputSF);

    if (!orgDetails.result) {
        throw new Error(`Failed to get org details for ${newOrgUsername}`);
    }

    currentConnection = new Connection({
        instanceUrl: orgDetails.result.instanceUrl,
        accessToken: orgDetails.result.accessToken
    });
}

//Metodo para obtener la org actual desde el fichero de configuracion .sf/config.json
export async function getCurrentOrgFromConfig(): Promise<string | undefined> {
   
    //Obtener la configuracion del workspace actual (proyecto)
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceRoot) {
        const org = await readTargetOrg(path.join(workspaceRoot, '.sf', 'config.json'), 'workspace');
        if (org) return org;
    }

    //Obtener la configuracion del usuario (global)
    //Busca en la carpeta de usuario .sf/config.json
    const homeDir = process.env.USERPROFILE ?? process.env.HOME;
    if (homeDir) {
        const org = await readTargetOrg(path.join(homeDir, '.sf', 'config.json'), 'user');
        if (org) return org;
    } else {
        outputChannel.appendLine('Could not find home directory');
    }

    outputChannel.appendLine('No target-org found in any config file. Checked workspace and user folder.');
    return undefined;
}

//Metodo para leer la org desde el fichero de configuracion
async function readTargetOrg(configPath: string, location: string): Promise<string | undefined> {
    try {
        const configContent = await fs.promises.readFile(configPath, 'utf8');
        const config = JSON.parse(configContent);
        if (config['target-org']) {
            outputChannel.appendLine(`Found target org in ${location} config: ${config['target-org']}`);
            return config['target-org'];
        }
    } catch {
        outputChannel.appendLine(`Target org not found in ${location} config`);
    }
    return undefined;
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

/**
 * Runs a Salesforce API call and automatically retries once if the session is expired.
 * @param fn The function to execute, which should use the current connection.
 * @param provider Optional LogDataProvider to update connection if needed.
 */
export async function retryOnSessionExpire<T>(fn: (connection: Connection) => Promise<T>, provider?: any): Promise<T> {
    let connection = provider?.connection ?? await getConnection();
    try {
        return await fn(connection);
    } catch (error: any) {
        const msg = error?.message || error?.toString() || '';
        if (msg.includes('INVALID_SESSION_ID') || msg.includes('Session expired') || msg.includes('expired access token')) {
            outputChannel.appendLine('Session expired, attempting to reconnect...');
            const newConnection = await getConnection();
            if (provider && typeof provider.updateConnection === 'function') {
                await provider.updateConnection(newConnection);
            }
            return await fn(newConnection);
        }
        throw error;
    }
}