import { Connection } from 'jsforce';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { outputChannel } from './outputChannel';

let currentOrgUsername: string | undefined;
let currentConnection: Connection | undefined;
let pendingConnection: Promise<Connection> | undefined;
let pendingOrgUsername: string | undefined;
let connectionAttemptGeneration = 0;

export function getConnectedOrgUsername(): string | undefined {
    return currentOrgUsername;
}

//Obtenemos la conexion a la org de Salesforce
export async function getConnection(forceRefresh: boolean = false): Promise<Connection> {
    const newOrgUsername = await getCurrentOrgFromConfig();
    if (!newOrgUsername) {
        throw new Error('No target org found in .sf/config.json');
    }

    if (pendingConnection && pendingOrgUsername === newOrgUsername) {
        return pendingConnection;
    }

    //Si la org ha cambiado, crea una nueva conexion
    if (!forceRefresh && currentConnection && currentOrgUsername === newOrgUsername) {
        return currentConnection;
    }

    if (forceRefresh && currentOrgUsername === newOrgUsername) {
        currentConnection = undefined;
    }

    pendingOrgUsername = newOrgUsername;
    const attemptGeneration = ++connectionAttemptGeneration;
    const connectionAttempt = createConnection(newOrgUsername);
    pendingConnection = connectionAttempt;

    try {
        const newConnection = await connectionAttempt;
        if (attemptGeneration !== connectionAttemptGeneration) {
            return getConnection(forceRefresh);
        }
        currentConnection = newConnection;
        currentOrgUsername = newOrgUsername;
        return newConnection;
    } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to connect to Salesforce: ${errorMessage}`);
        throw error;
    } finally {
        if (pendingConnection === connectionAttempt) {
            pendingConnection = undefined;
            pendingOrgUsername = undefined;
        }

    }
}

//Metodo para crear una nueva conexion a la org de Salesforce
async function createConnection(newOrgUsername: string): Promise<Connection> {

    outputChannel.appendLine(`Org changed: ${currentOrgUsername} -> ${newOrgUsername}`);

    // Get org details and access token in parallel (sf startup is slow on Windows)
    const start = Date.now();
    const [orgDetailsResult, tokenResultResult] = await Promise.all([
        executeCommand(['org', 'display', '--json', '-o', newOrgUsername]),
        executeCommand(['org', 'auth', 'show-access-token', '--target-org', newOrgUsername, '--json'])
    ]);
    outputChannel.appendLine(`sf commands completed in ${Date.now() - start}ms`);

    const orgDetails = JSON.parse(orgDetailsResult.stdout);
    if (!orgDetails.result) {
        throw new Error(`Failed to get org details for ${newOrgUsername}`);
    }

    // Usamos sf org auth show-access-token para obtener el token.
    const tokenResult = JSON.parse(tokenResultResult.stdout);
    if (!tokenResult.result?.accessToken) {
        throw new Error(`Failed to get access token for ${newOrgUsername}`);
    }

    return new Connection({
        instanceUrl: orgDetails.result.instanceUrl,
        accessToken: tokenResult.result.accessToken
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
    } catch (error) {
        const errorCode = (error as NodeJS.ErrnoException)?.code;
        if (errorCode === 'ENOENT') {
            outputChannel.appendLine(`Target org not found in ${location} config`);
        } else {
            const message = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(`Could not read ${location} Salesforce config at ${configPath}: ${message}`);
        }
    }
    return undefined;
}

function executeCommand(args: string[]): Promise<{ stdout: string, stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile('sf', args, { timeout: 90000, maxBuffer: 10 * 1024 * 1024 }, (error: Error | null, stdout: string, stderr: string) => {
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
export interface ConnectionProvider {
    connection: Connection;
    replaceConnection?: (connection: Connection) => void;
}

export async function retryOnSessionExpire<T>(fn: (connection: Connection) => Promise<T>, provider?: ConnectionProvider): Promise<T> {
    let connection = provider?.connection ?? await getConnection();
    try {
        return await fn(connection);
    } catch (error: unknown) {
        if (isExpiredSession(error)) {
            outputChannel.appendLine('Session expired, attempting to reconnect...');
            const newConnection = await getConnection(true);
            if (provider?.replaceConnection) {
                provider.replaceConnection(newConnection);
            } else if (provider) {
                provider.connection = newConnection;
            }
            return await fn(newConnection);
        }
        throw error;
    }
}

function isExpiredSession(error: unknown): boolean {
    const errorWithCode = error as { errorCode?: unknown; code?: unknown; message?: unknown };
    if (errorWithCode?.errorCode === 'INVALID_SESSION_ID' || errorWithCode?.code === 'INVALID_SESSION_ID') {
        return true;
    }

    const message = error instanceof Error ? error.message : String(error);
    return /INVALID_SESSION_ID|Session expired|expired access token/i.test(message);
}