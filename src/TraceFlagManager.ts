/**
    This module manages the creation and deletion of trace flags in Salesforce.
    It ensures that a debug level exists in the org and creates a trace flag for the user if it doesn't exist.

    TODO:
    - Add support for creation of custom debug levels with the parameters specified by the user
    - Add support for trace flags for other entities (e.g. Apex classes, triggers)
*/

import { Connection } from 'jsforce';
import * as vscode from 'vscode';
import { outputChannel } from './extension';
import { retryOnSessionExpire } from './connection';

export interface DebugLevel {
    Id: string;
    DeveloperName: string;
    MasterLabel: string;
    ApexCode: string;
    Visualforce: string;
    Database: string;
    System: string;
}

export interface TraceFlag {
    Id: string;
    DebugLevelId: string;
    LogType: string;
    StartDate: string;
    ExpirationDate: string;
    TracedEntityId: string;
}

//Define the debug level name/log type the same as the one used by the Developer Console
const LEVEL_NAME = 'SFDC_DevConsole';
const LOG_TYPE = 'DEVELOPER_LOG';

// Store timers and trace flag ids for keep-alive per user
const traceFlagKeepAliveTimers: Map<string, NodeJS.Timeout> = new Map();
const userTraceFlagIds: Map<string, string> = new Map();

// Start the keep-alive loop for the trace flag
export async function startTraceFlagKeepAlive(connection: Connection, userId: string) {
    // Get expiration interval from config, default 15, min 5
    const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
    let minutes = config.get<number>('traceFlagExpirationInterval') ?? 15;
    if (minutes < 5) minutes = 5;
    await ensureTraceFlag(connection, userId, minutes); // Pass interval
}

// Stop the keep-alive loop for all users or a specific user
export function stopTraceFlagKeepAlive(userId?: string) {
    if (userId) {
        if (traceFlagKeepAliveTimers.has(userId)) {
            clearTimeout(traceFlagKeepAliveTimers.get(userId)!);
            traceFlagKeepAliveTimers.delete(userId);
            userTraceFlagIds.delete(userId);
        }
    } else {
        for (const [uid, timer] of traceFlagKeepAliveTimers.entries()) {
            clearTimeout(timer);
        }
        traceFlagKeepAliveTimers.clear();
        userTraceFlagIds.clear();
    }
}

//Function to ensure the trace flag is set for the user
//This function will check if a trace flag already exists for the user and create one if it doesn't
export async function ensureTraceFlag(connection: Connection, userId: string, expirationMinutes?: number, keepAlive: boolean = true): Promise<void> {
    try {
        outputChannel.appendLine(`Checking trace flag for user: ${userId}`);
        //Set the debug level for the trace flag
        const debugLevelId = await ensureDebugLevel(connection);
        // Check for existing trace flag
        const existingFlags = await retryOnSessionExpire(async (conn) => await conn.tooling.query(`SELECT Id, DebugLevelId, LogType, StartDate, ExpirationDate FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = '${LOG_TYPE}'`), null) as { records: TraceFlag[] };
        outputChannel.appendLine(`Existing flags found: ${existingFlags.records?.length || 0}`);
        //Delete existing trace flags from the user
        if (existingFlags.records && existingFlags.records.length > 0) {
            for (const flag of existingFlags.records) {
                outputChannel.appendLine(`Deleting current trace flag: ${flag.Id}`);
                await retryOnSessionExpire(async (conn) => await conn.tooling.delete('TraceFlag', flag.Id), null);
            }
        }
        // Use config or default for expiration interval
        let minutes = expirationMinutes;
        if (!minutes) {
            const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
            minutes = config.get<number>('traceFlagExpirationInterval') ?? 15;
        }

        //Create new trace flag with custom expiration
        const traceFlagId = await createTraceFlag(connection, userId, debugLevelId, minutes);
        outputChannel.appendLine(`Successfully created and activated trace flag: ${traceFlagId}`);
        userTraceFlagIds.set(userId, traceFlagId);
        if (keepAlive) {
            scheduleTraceFlagExtension(connection, userId, traceFlagId, minutes);
        }
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        outputChannel.appendLine(`Trace flag error: ${error}`);
        vscode.window.showErrorMessage(`Failed to manage trace flag: ${errorMessage}`);
        throw error;
    }
}

// Schedule the timer to extend the trace flag expiration for a user
function scheduleTraceFlagExtension(connection: Connection, userId: string, traceFlagId: string, minutes: number) {
    // Clear any existing timer for this user
    if (traceFlagKeepAliveTimers.has(userId)) {
        clearTimeout(traceFlagKeepAliveTimers.get(userId)!);
    }
    // Set timer to fire at (minutes - 1) minutes
    const interval = Math.max(minutes - 1, 1) * 60 * 1000;
    const timer = setTimeout(async () => {
        try {
            await extendTraceFlagExpiration(connection, traceFlagId, minutes);
            outputChannel.appendLine(`Trace flag extended successfully: ${traceFlagId} for user: ${userId} in: ${minutes} minutes`);
            scheduleTraceFlagExtension(connection, userId, traceFlagId, minutes); // Reschedule
        } catch (err) {
            outputChannel.appendLine(`Failed to extend trace flag for user ${userId}: ${err}`);
        }
    }, interval);
    traceFlagKeepAliveTimers.set(userId, timer);
}

// Extend the expiration of the trace flag by N minutes from now
async function extendTraceFlagExpiration(connection: Connection, traceFlagId: string, minutes: number) {
    const now = new Date();
    const newExpiration = new Date(now.getTime() + minutes * 60 * 1000);
    const result = await retryOnSessionExpire(async (conn) => await conn.tooling.update('TraceFlag', {
        Id: traceFlagId,
        ExpirationDate: newExpiration.toISOString()
    }), null) as { success: boolean; errors?: any };
    if (!result.success) {
        throw new Error(`Failed to update trace flag expiration: ${JSON.stringify(result.errors)}`);
    }
    outputChannel.appendLine(`Extended trace flag expiration to: ${newExpiration.toISOString()}`);
}

//Function to create a new trace flag for the user
async function createTraceFlag(connection: Connection, userId: string, debugLevelId: string, minutes: number = 10): Promise<string> {
    const now = new Date();
    const future = new Date(now.getTime() + minutes * 60 * 1000); // Set expiration to N minutes from now

    // Create new trace flag
    const result = await retryOnSessionExpire(async (conn) => await conn.tooling.create('TraceFlag', {
        TracedEntityId: userId,
        DebugLevelId: debugLevelId,
        LogType: LOG_TYPE,
        StartDate: now.toISOString(),
        ExpirationDate: future.toISOString()
    }), null) as { id: string };

    // The result of tooling.create is { id: string } on success, but may have errors if failed
    if (!('id' in result)) {
        throw new Error(`Failed to create new trace flag: ${JSON.stringify(result)}`);
    }
    outputChannel.appendLine(`Created new trace flag with ID: ${result.id}`);
    return result.id;
}

//Function to ensure the debug level exists in the org
async function ensureDebugLevel(connection: Connection): Promise<string> {
    try {
        outputChannel.appendLine(`Checking for debug level: ${LEVEL_NAME}`);
        
        // Check for existing debug level in the org
        const existingLevels = await retryOnSessionExpire(async (conn) => await conn.tooling.query(`SELECT Id, ApexCode, Visualforce, Database, System FROM DebugLevel WHERE DeveloperName = '${LEVEL_NAME}'`), null) as { records: DebugLevel[] };

        if (existingLevels.records && existingLevels.records.length > 0) {
            outputChannel.appendLine(`Found existing debug level: ${existingLevels.records[0].Id}`);
            return existingLevels.records[0].Id;
        }else{
            // Create new debug level if there are none
            outputChannel.appendLine('No existing debug level found, creating a new one...');
            return await createDebugLevel(connection);
        }
            
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        outputChannel.appendLine(`Debug level error: ${error}`);
        vscode.window.showErrorMessage(`Failed to manage debug level: ${errorMessage}`);
        throw error;
    }
}

//Function to create a new debug level in the org
async function createDebugLevel(connection: Connection): Promise<string> {

    const result = await retryOnSessionExpire(async (conn) => await conn.tooling.create('DebugLevel', {
        DeveloperName: LEVEL_NAME,
        MasterLabel: LEVEL_NAME,
        ApexCode: 'FINEST',
        Visualforce: 'FINER',
        Database: 'INFO',
        System: 'DEBUG',
        Callout: 'INFO',
        Workflow: 'INFO',
        Validation: 'INFO'
    }), null) as { id: string }; 
    
    // The result of tooling.create is { id: string } on success, but may have errors if failed
    if (!('id' in result)) {
        throw new Error(`Failed to create debug level: ${JSON.stringify(result)}`);
    }
    outputChannel.appendLine(`Created new debug level with ID: ${result.id}`);
    return result.id;
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
        // Only get expired trace flags
        const nowIso = new Date().toISOString();
        const existingFlags = await retryOnSessionExpire(async (conn) => await conn.tooling.query(
            `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = '${LOG_TYPE}'`
        ), null) as { records: TraceFlag[] };
        if (existingFlags.records && existingFlags.records.length > 0) {
            for (const flag of existingFlags.records) {
                outputChannel.appendLine(`Deleting trace flag: ${flag.Id}`);
                await retryOnSessionExpire(async (conn) => await conn.tooling.delete('TraceFlag', flag.Id), null);
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