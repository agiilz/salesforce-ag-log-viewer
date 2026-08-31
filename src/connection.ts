import { Connection, ConnectionConfig } from 'jsforce';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { outputChannel } from './extension';

const DEFAULT_CONNECT_ATTEMPTS = 3;
const CONNECTION_VALIDATION_TIMEOUT_MS = 30_000;

let currentOrgUsername: string | undefined;
let currentConnection: Connection | undefined;
let connectionAttempt: { orgUsername: string; promise: Promise<Connection> } | undefined;
let salesforceCore: typeof import('@salesforce/core') | undefined;

export interface ConnectionOptions {
    forceRefresh?: boolean;
    maxAttempts?: number;
}

/**
 * Gets a validated Salesforce connection for the workspace's target org.
 *
 * Authentication is loaded directly from the same Salesforce Core state used by
 * the `sf` CLI. Avoiding CLI child processes makes extension-host startup much
 * faster and removes the race where `sf` is not ready while VS Code is opening.
 */
export async function getConnection(options: ConnectionOptions = {}): Promise<Connection> {
    const orgUsername = await getCurrentOrgFromConfig();
    if (!orgUsername) {
        throw new Error('No target org found in .sf/config.json');
    }

    if (!options.forceRefresh && currentConnection && currentOrgUsername === orgUsername) {
        return currentConnection;
    }

    // Share an in-flight attempt for the same org so activation, the webview and
    // commands cannot start duplicate authentication work.
    if (connectionAttempt) {
        if (connectionAttempt.orgUsername === orgUsername) {
            return connectionAttempt.promise;
        }
        await connectionAttempt.promise.catch(() => undefined);
    }

    const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_CONNECT_ATTEMPTS);
    const promise = createConnectionWithRetry(orgUsername, maxAttempts, options.forceRefresh ?? false);
    connectionAttempt = { orgUsername, promise };

    try {
        const connection = await promise;
        // Only update the cache after the complete connection attempt succeeds.
        currentOrgUsername = orgUsername;
        currentConnection = connection;
        return connection;
    } finally {
        if (connectionAttempt?.promise === promise) {
            connectionAttempt = undefined;
        }
    }
}

/** Clear the cached connection so the next attempt reloads auth state from disk. */
export function invalidateConnection(): void {
    currentOrgUsername = undefined;
    currentConnection = undefined;
    getSalesforceCore().StateAggregator.clearInstance();
}

async function createConnectionWithRetry(
    orgUsername: string,
    maxAttempts: number,
    forceRefresh: boolean
): Promise<Connection> {
    let lastError: unknown;
    const { StateAggregator } = getSalesforceCore();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (forceRefresh || attempt > 1) {
                StateAggregator.clearInstance();
            }
            return await createConnection(orgUsername, attempt, maxAttempts);
        } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            outputChannel.appendLine(`Connection attempt ${attempt}/${maxAttempts} failed: ${message}`);

            if (attempt < maxAttempts) {
                // Salesforce Core can briefly race with keychain/auth-state startup
                // when the VS Code extension host is launched.
                await delay(attempt * 750);
            }
        }
    }

    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Unable to connect to Salesforce org "${orgUsername}" after ${maxAttempts} attempts: ${message}`);
}

async function createConnection(orgUsername: string, attempt: number, maxAttempts: number): Promise<Connection> {
    const startedAt = Date.now();
    outputChannel.appendLine(`Connecting to org "${orgUsername}" (attempt ${attempt}/${maxAttempts})...`);

    const { AuthInfo, StateAggregator } = getSalesforceCore();
    const stateAggregator = await StateAggregator.getInstance();
    const resolvedUsername = stateAggregator.aliases.resolveUsername(orgUsername);
    const authInfo = await AuthInfo.create({ username: resolvedUsername });
    const authOptions = authInfo.getConnectionOptions();

    if (!authOptions.instanceUrl || !authOptions.accessToken) {
        throw new Error(`Authorization data for "${orgUsername}" is missing an instance URL or access token`);
    }

    // AuthInfo supplies a refresh function for OAuth/JWT orgs, allowing jsforce
    // to renew an expired session without launching the Salesforce CLI.
    const connection = new Connection({
        instanceUrl: authOptions.instanceUrl,
        accessToken: authOptions.accessToken,
        oauth2: authOptions.oauth2,
        refreshFn: authOptions.refreshFn
    } as ConnectionConfig);

    await withTimeout(
        connection.identity(),
        CONNECTION_VALIDATION_TIMEOUT_MS,
        `Timed out while validating the Salesforce connection for "${orgUsername}"`
    );

    outputChannel.appendLine(`Connected to org "${orgUsername}" in ${Date.now() - startedAt}ms`);
    return connection;
}

function getSalesforceCore(): typeof import('@salesforce/core') {
    // Salesforce Core's default pino file transport is resolved from package
    // paths that no longer exist after esbuild bundles the extension. Disable
    // only that file transport before lazily loading the module; extension logs
    // continue to go to the dedicated VS Code output channel.
    if (!salesforceCore) {
        const previousSetting = process.env.SF_DISABLE_LOG_FILE;
        try {
            process.env.SF_DISABLE_LOG_FILE = 'true';
            salesforceCore = require('@salesforce/core') as typeof import('@salesforce/core');
        } finally {
            if (previousSetting === undefined) {
                delete process.env.SF_DISABLE_LOG_FILE;
            } else {
                process.env.SF_DISABLE_LOG_FILE = previousSetting;
            }
        }
    }
    return salesforceCore;
}

// Get the current target org from the workspace or user .sf/config.json file.
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
        const config = JSON.parse(configContent) as Record<string, unknown>;
        const targetOrg = config['target-org'];
        if (typeof targetOrg === 'string' && targetOrg.trim()) {
            outputChannel.appendLine(`Found target org in ${location} config: ${targetOrg}`);
            return targetOrg.trim();
        }
    } catch {
        outputChannel.appendLine(`Target org not found in ${location} config`);
    }
    return undefined;
}

/** Runs a Salesforce API call and retries once with freshly loaded auth on session expiry. */
export async function retryOnSessionExpire<T>(fn: (connection: Connection) => Promise<T>, provider?: any): Promise<T> {
    const connection = provider?.connection ?? await getConnection();
    try {
        return await fn(connection);
    } catch (error: any) {
        const message = error instanceof Error ? error.message : String(error);
        if (isSessionExpiredError(message)) {
            // A failed request from the previous org must not reconnect the
            // provider or replay IDs/queries against the newly selected org.
            if (provider && provider.connection !== connection) throw error;
            outputChannel.appendLine('Session expired, reloading Salesforce authentication...');
            const newConnection = await getConnection({ forceRefresh: true });
            if (provider && provider.connection !== connection) throw error;
            if (provider && typeof provider.updateConnection === 'function') {
                await provider.updateConnection(newConnection);
            }
            return await fn(newConnection);
        }
        throw error;
    }
}

function isSessionExpiredError(message: string): boolean {
    return /INVALID_SESSION_ID|Session expired|expired access token/i.test(message);
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
            })
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}
