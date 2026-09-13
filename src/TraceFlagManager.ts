/**
    This module manages the creation and deletion of trace flags in Salesforce.
    It ensures that a debug level exists in the org and creates a trace flag for the user if it doesn't exist.

    TODO:
    - Add support for trace flags for other entities (e.g. Apex classes, triggers)
*/

import { Connection } from 'jsforce';
import * as vscode from 'vscode';
import { outputChannel } from './extension';
import { ensureDebugLevel } from './DebugLevelManager';

export interface TraceFlag {
    Id: string;
    DebugLevelId: string;
    LogType: string;
    StartDate: string;
    ExpirationDate: string;
    TracedEntityId: string;
}

// Use the same log type as the Developer Console.
const LOG_TYPE = 'DEVELOPER_LOG';

interface TraceFlagSession {
    connection: Connection;
    expirationMinutes: number;
    timer?: NodeJS.Timeout;
    pending?: Promise<void>;
    traceFlagId?: string;
    renewalFailed?: boolean;
}

// Removing a session also invalidates work already awaiting a Salesforce response.
const traceFlagSessions = new Map<string, TraceFlagSession>();

// Start the keep-alive loop for the trace flag
export async function startTraceFlagKeepAlive(connection: Connection, userId: string) {
    await ensureTraceFlag(connection, userId);
}

function expirationInterval(minutes = vscode.workspace.getConfiguration('salesforceAgLogViewer').get<number>('traceFlagExpirationInterval') ?? 15): number {
    // Salesforce requires ExpirationDate to be strictly less than 24 hours after StartDate.
    return Number.isFinite(minutes) ? Math.min(1439, Math.max(5, Math.floor(minutes))) : 15;
}

export function updateTraceFlagExpirationInterval(): void {
    const minutes = expirationInterval();
    for (const [userId, session] of traceFlagSessions) {
        if (session.expirationMinutes === minutes) continue;
        session.expirationMinutes = minutes;
        // In-flight work will notice the new interval before scheduling its next renewal.
        if (!session.pending) scheduleTraceFlagExtension(session, userId, 0);
    }
}

// Stop the keep-alive loop for all users or a specific user
export function stopTraceFlagKeepAlive(userId?: string) {
    for (const [uid, session] of traceFlagSessions) {
        if (userId && uid !== userId) continue;
        if (session.timer) clearTimeout(session.timer);
        traceFlagSessions.delete(uid);
    }
}

//Function to ensure the trace flag is set for the user
//This function will check if a trace flag already exists for the user and create one if it doesn't
export async function ensureTraceFlag(connection: Connection, userId: string, expirationMinutes?: number, keepAlive: boolean = true): Promise<void> {
    const existing = traceFlagSessions.get(userId);
    if (existing?.connection === connection && existing.pending) {
        return existing.pending;
    }
    stopTraceFlagKeepAlive(userId);
    const session: TraceFlagSession = { connection, expirationMinutes: expirationInterval(expirationMinutes) };
    traceFlagSessions.set(userId, session);
    session.pending = configureTraceFlag(session, userId, keepAlive);
    try {
        await session.pending;
    } catch (error) {
        if (traceFlagSessions.get(userId) !== session) return;
        outputChannel.appendLine(`Trace flag error for user ${userId}: ${error}`);
        vscode.window.showErrorMessage(`Failed to manage trace flag for user ${userId}: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
    } finally {
        session.pending = undefined;
        if (!session.timer && traceFlagSessions.get(userId) === session) {
            traceFlagSessions.delete(userId);
        }
    }
}

async function configureTraceFlag(session: TraceFlagSession, userId: string, keepAlive: boolean): Promise<void> {
    const connection = session.connection;
    const isCurrent = () => traceFlagSessions.get(userId) === session;
    outputChannel.appendLine(`Checking trace flag for user: ${userId} on ${connection.instanceUrl}`);
    const debugLevelId = await ensureDebugLevel(connection, isCurrent);
    if (!isCurrent() || !debugLevelId) return;
    // Keep this user's IDs on the connection that created the session.
    const existingFlags = await connection.tooling.query(`SELECT Id, DebugLevelId, LogType, StartDate, ExpirationDate FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = '${LOG_TYPE}'`) as { records: TraceFlag[] };
    if (!isCurrent()) return;
    outputChannel.appendLine(`Existing flags found: ${existingFlags.records?.length || 0}`);
    if (existingFlags.records && existingFlags.records.length > 0) {
        for (const flag of existingFlags.records) {
            outputChannel.appendLine(`Deleting current trace flag: ${flag.Id}`);
            await connection.tooling.delete('TraceFlag', flag.Id);
            if (!isCurrent()) return;
        }
    }
    const minutes = session.expirationMinutes;
    const traceFlagId = await createTraceFlag(connection, userId, debugLevelId, minutes);
    if (!isCurrent()) return;
    session.traceFlagId = traceFlagId;
    outputChannel.appendLine(`Successfully created and activated trace flag: ${traceFlagId}`);
    if (keepAlive) {
        scheduleTraceFlagExtension(session, userId, minutes === session.expirationMinutes ? undefined : 0);
    }
}

// Schedule the timer to extend the trace flag expiration for a user
function scheduleTraceFlagExtension(session: TraceFlagSession, userId: string, delayMs = Math.max(session.expirationMinutes - 1, 1) * 60 * 1000) {
    if (traceFlagSessions.get(userId) !== session) return;
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(async () => {
        if (traceFlagSessions.get(userId) !== session) return;
        session.timer = undefined;
        session.pending = renewTraceFlag(session, userId);
        try {
            await session.pending;
        } finally {
            session.pending = undefined;
        }
    }, delayMs);
}

async function renewTraceFlag(session: TraceFlagSession, userId: string): Promise<void> {
    const minutes = session.expirationMinutes;
    try {
        if (session.traceFlagId) {
            try {
                await extendTraceFlagExpiration(session.connection, session.traceFlagId, minutes);
            } catch (error) {
                if (!hasErrorCode(error, ['NOT_FOUND', 'ENTITY_IS_DELETED'])) throw error;
                session.traceFlagId = undefined;
            }
        }
        if (traceFlagSessions.get(userId) !== session) return;
        if (!session.traceFlagId) {
            // A flag deleted outside the extension needs to be recreated.
            await configureTraceFlag(session, userId, true);
        } else {
            scheduleTraceFlagExtension(session, userId, minutes === session.expirationMinutes ? undefined : 0);
        }
        session.renewalFailed = false;
    } catch (error) {
        if (traceFlagSessions.get(userId) !== session) return;
        outputChannel.appendLine(`Failed to renew trace flag for user ${userId}: ${error}`);
        if (!isTransientError(error)) {
            stopTraceFlagKeepAlive(userId);
            vscode.window.showErrorMessage(`Trace flag renewal stopped for user ${userId}: ${error instanceof Error ? error.message : String(error)}. Fix the error and enable the trace flag again.`);
            return;
        }
        if (!session.renewalFailed) {
            session.renewalFailed = true;
            vscode.window.showWarningMessage(`Could not renew the trace flag for user ${userId}. Retrying every 30 seconds; log capture may pause until the connection recovers.`);
        }
        scheduleTraceFlagExtension(session, userId, 30_000);
    }
}

function hasErrorCode(error: any, codes: string[]): boolean {
    return [error, ...(Array.isArray(error?.errors) ? error.errors : [])].some(item =>
        [item, item?.errorCode, item?.statusCode, item?.code, item?.name].some(code => codes.includes(code)));
}

function isTransientError(error: any): boolean {
    const status = error?.statusCode ?? error?.status;
    // jsforce uses ERROR_HTTP_<status> when a proxy returns a non-JSON error.
    return status === 408 || status === 429 || status >= 500 || /^ERROR_HTTP_(408|429|5\d\d)$/.test(error?.errorCode) || hasErrorCode(error, [
        'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
        'INVALID_SESSION_ID', 'REQUEST_LIMIT_EXCEEDED', 'SERVER_UNAVAILABLE', 'UNKNOWN_EXCEPTION', 'UNABLE_TO_LOCK_ROW'
    ]);
}

// Extend the expiration of the trace flag by N minutes from now
async function extendTraceFlagExpiration(connection: Connection, traceFlagId: string, minutes: number) {
    const now = new Date();
    const newExpiration = new Date(now.getTime() + minutes * 60 * 1000);
    const result = await connection.tooling.update('TraceFlag', {
        Id: traceFlagId,
        StartDate: now.toISOString(),
        ExpirationDate: newExpiration.toISOString()
    }) as { success: boolean; errors?: any };
    if (!result.success) {
        throw Object.assign(new Error(`Failed to update trace flag expiration: ${JSON.stringify(result.errors)}`), { errors: result.errors });
    }
    outputChannel.appendLine(`Extended trace flag expiration to: ${newExpiration.toISOString()}`);
}

//Function to create a new trace flag for the user
async function createTraceFlag(connection: Connection, userId: string, debugLevelId: string, minutes: number = 10): Promise<string> {
    const now = new Date();
    const future = new Date(now.getTime() + minutes * 60 * 1000); // Set expiration to N minutes from now

    // Create new trace flag
    const result = await connection.tooling.create('TraceFlag', {
        TracedEntityId: userId,
        DebugLevelId: debugLevelId,
        LogType: LOG_TYPE,
        StartDate: now.toISOString(),
        ExpirationDate: future.toISOString()
    });

    // The result of tooling.create is { id: string } on success, but may have errors if failed
    if (!result.success || !result.id) {
        throw Object.assign(new Error(`Failed to create new trace flag: ${JSON.stringify(result)}`), { errors: result.errors });
    }
    outputChannel.appendLine(`Created new trace flag with ID: ${result.id}`);
    return result.id;
}

// Apply a selection to this connection's managed flags without replacing them or
// interrupting their expiration timers. New sessions read the saved selection.
export async function applyDebugLevelToTraceFlags(connection: Connection, currentUserId: string, debugLevelId: string, isCurrent: () => boolean): Promise<void> {
    const sessions = [...traceFlagSessions].filter(([, session]) => session.connection === connection);
    const failures: string[] = [];
    for (const [userId, session] of sessions) {
        // A flag being created when the selection changed can still use the old
        // level. Wait for it before applying the new one.
        await session.pending?.catch(() => undefined);
        if (!isCurrent()) return;
        if (traceFlagSessions.get(userId) !== session || !session.traceFlagId) continue;
        try {
            const result = await connection.tooling.update('TraceFlag', {
                Id: session.traceFlagId,
                DebugLevelId: debugLevelId
            });
            if (!result.success) throw new Error(JSON.stringify(result.errors));
        } catch (error) {
            failures.push(`${userId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (!isCurrent()) return;
    // Also recover current-user capture if startup failed (for example, because
    // the previously selected debug level was deleted).
    if (traceFlagSessions.get(currentUserId)?.connection !== connection) {
        try {
            await ensureTraceFlag(connection, currentUserId);
        } catch (error) {
            failures.push(`${currentUserId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (failures.length) throw new Error(`Could not update trace flags for ${failures.join('; ')}. Select the level again to retry.`);
}

// Enable trace flag for a specific user, with keep-alive
export async function enableTraceFlagForUser(connection: Connection, userId: string, expirationMinutes?: number): Promise<void> {
    await ensureTraceFlag(connection, userId, expirationMinutes, true);
}

// Disable (delete) all trace flags for a specific user and stop their keep-alive
export async function disableTraceFlagForUser(connection: Connection, userId: string): Promise<void> {
    stopTraceFlagKeepAlive(userId);
    try {
        outputChannel.appendLine(`Disabling trace flags for user: ${userId}`);
        const existingFlags = await connection.tooling.query(
            `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = '${LOG_TYPE}'`
        ) as { records: TraceFlag[] };
        if (existingFlags.records && existingFlags.records.length > 0) {
            for (const flag of existingFlags.records) {
                outputChannel.appendLine(`Deleting trace flag: ${flag.Id}`);
                await connection.tooling.delete('TraceFlag', flag.Id);
            }
        } else {
            outputChannel.appendLine('No trace flags found to disable.');
        }
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        outputChannel.appendLine(`Error disabling trace flag: ${error}`);
        vscode.window.showErrorMessage(`Failed to disable trace flag: ${errorMessage}`);
        throw error;
    }
}
