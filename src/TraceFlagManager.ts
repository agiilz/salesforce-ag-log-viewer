/**
    This module manages the creation and deletion of trace flags in Salesforce.
    It ensures that a debug level exists in the org and creates a trace flag for the user if it doesn't exist.

    TODO:
    - Add support for creation of custom debug levels with the parameters specified by the user
    - Add support for enabling/disabling trace flags for different users
    - Add support for trace flags for other entities (e.g. Apex classes, triggers)
    - Add support for setting expiration date for trace flags
*/

import { Connection } from 'jsforce';
import * as vscode from 'vscode';
import { outputChannel } from './extension';

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

// Store timer and trace flag id for keep-alive
let traceFlagKeepAliveTimer: NodeJS.Timeout | null = null;
let currentTraceFlagId: string | null = null;

// Start the keep-alive loop for the trace flag
export async function startTraceFlagKeepAlive(connection: Connection, userId: string) {
    // Get expiration interval from config, default 15, min 5
    const config = vscode.workspace.getConfiguration('salesforceAgLogViewer');
    let minutes = config.get<number>('traceFlagExpirationInterval') ?? 15;
    if (minutes < 5) minutes = 5;
    await ensureTraceFlag(connection, userId, minutes); // Pass interval
}

// Stop the keep-alive loop
export function stopTraceFlagKeepAlive() {
    if (traceFlagKeepAliveTimer) {
        clearTimeout(traceFlagKeepAliveTimer);
        traceFlagKeepAliveTimer = null;
    }
    currentTraceFlagId = null;
}

//Function to ensure the trace flag is set for the user
//This function will check if a trace flag already exists for the user and create one if it doesn't
export async function ensureTraceFlag(connection: Connection, userId: string, expirationMinutes?: number): Promise<void> {
    try {
        outputChannel.appendLine(`Checking trace flag for user: ${userId}`);
        //Set the debug level for the trace flag
        const debugLevelId = await ensureDebugLevel(connection);
        // Check for existing trace flag
        const existingFlags = await connection.tooling.query<TraceFlag>(
            `SELECT Id, DebugLevelId, LogType, StartDate, ExpirationDate FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = '${LOG_TYPE}'`
        );
        outputChannel.appendLine(`Existing flags found: ${existingFlags.records?.length || 0}`);
        //Delete existing trace flags from the user
        if (existingFlags.records && existingFlags.records.length > 0) {
            for (const flag of existingFlags.records) {
                outputChannel.appendLine(`Deleting current trace flag: ${flag.Id}`);
                await connection.tooling.delete('TraceFlag', flag.Id);
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
        currentTraceFlagId = traceFlagId;
        scheduleTraceFlagExtension(connection, traceFlagId, minutes); 
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        outputChannel.appendLine(`Trace flag error: ${error}`);
        vscode.window.showErrorMessage(`Failed to manage trace flag: ${errorMessage}`);
        throw error;
    }
}

// Schedule the timer to extend the trace flag expiration
function scheduleTraceFlagExtension(connection: Connection, traceFlagId: string, minutes: number) {
    if (traceFlagKeepAliveTimer) {
        clearTimeout(traceFlagKeepAliveTimer);
    }
    
    // Set timer to fire at (minutes - 1) minutes
    const interval = Math.max(minutes - 1, 1) * 60 * 1000;
    traceFlagKeepAliveTimer = setTimeout(async () => {
        try {
            await extendTraceFlagExpiration(connection, traceFlagId, minutes);
            outputChannel.appendLine(`Trace flag extended successfully: ${traceFlagId}` + ' in: ' + minutes + ' minutes');
            scheduleTraceFlagExtension(connection, traceFlagId, minutes); // Reschedule
        } catch (err) {
            outputChannel.appendLine(`Failed to extend trace flag: ${err}`);
        }
    }, interval);
}

// Extend the expiration of the trace flag by N minutes from now
async function extendTraceFlagExpiration(connection: Connection, traceFlagId: string, minutes: number) {
    const now = new Date();
    const newExpiration = new Date(now.getTime() + minutes * 60 * 1000);
    const result = await connection.tooling.update('TraceFlag', {
        Id: traceFlagId,
        ExpirationDate: newExpiration.toISOString()
    });
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
    const result = await connection.tooling.create('TraceFlag', {
        TracedEntityId: userId,
        DebugLevelId: debugLevelId,
        LogType: LOG_TYPE,
        StartDate: now.toISOString(),
        ExpirationDate: future.toISOString()
    });

    const response = Array.isArray(result) ? result[0] : result;

    if (!response.success) {
        throw new Error(`Failed to create new trace flag: ${JSON.stringify(response.errors)}`);
    }
    outputChannel.appendLine(`Created new trace flag with ID: ${response.id}`);
    return response.id;
}

//Function to ensure the debug level exists in the org
async function ensureDebugLevel(connection: Connection): Promise<string> {
    try {
        outputChannel.appendLine(`Checking for debug level: ${LEVEL_NAME}`);
        
        // Check for existing debug level in the org
        const existingLevels = await connection.tooling.query<DebugLevel>(
            `SELECT Id, ApexCode, Visualforce, Database, System FROM DebugLevel WHERE DeveloperName = '${LEVEL_NAME}'`
        );

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

    const result = await connection.tooling.create('DebugLevel', {
        DeveloperName: LEVEL_NAME,
        MasterLabel: 'SF Log Viewer Debug Level',
        ApexCode: 'FINE',
        Visualforce: 'INFO',
        Database: 'INFO',
        System: 'DEBUG'
    });

    const response = Array.isArray(result) ? result[0] : result; 
    
    if (!response.success) {
        throw new Error(`Failed to create debug level: ${JSON.stringify(response.errors)}`);
    }

    outputChannel.appendLine(`Created new debug level with ID: ${response.id}`);
    return response.id;
}

// Enable trace flag for a specific user
export async function enableTraceFlagForUser(connection: Connection, userId: string, expirationMinutes?: number): Promise<void> {
    await ensureTraceFlag(connection, userId, expirationMinutes);
}

// Disable (delete) all trace flags for a specific user
export async function disableTraceFlagForUser(connection: Connection, userId: string): Promise<void> {
    try {
        outputChannel.appendLine(`Disabling trace flags for user: ${userId}`);
        const existingFlags = await connection.tooling.query<TraceFlag>(
            `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}'`
        );
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