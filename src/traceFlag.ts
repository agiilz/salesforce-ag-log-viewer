import { Connection } from 'jsforce';
import * as vscode from 'vscode';

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

export async function ensureTraceFlag(connection: Connection, userId: string): Promise<void> {
    try {
        console.log('Checking trace flag for user:', userId);
        
        const debugLevelId = await ensureDebugLevel(connection);

        // Check for existing trace flag
        const existingFlags = await connection.tooling.query<TraceFlag>(
            `SELECT Id, DebugLevelId, LogType, StartDate, ExpirationDate FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = 'DEVELOPER_LOG'`
        );
        console.log('Existing flags found:', existingFlags.records?.length || 0);

        const now = new Date();
        const future = new Date(now);
        future.setHours(future.getHours() + 24); // Set expiration to 24 hours from now

        // Delete existing trace flags
        if (existingFlags.records && existingFlags.records.length > 0) {
            for (const flag of existingFlags.records) {
                console.log('Deleting current trace flag:', flag.Id);
                await connection.tooling.delete('TraceFlag', flag.Id);
            }
        }

        // Create new trace flag
        console.log('Creating new trace flag...');
        const createResult = await connection.tooling.create('TraceFlag', {
            TracedEntityId: userId,
            DebugLevelId: debugLevelId,
            LogType: 'DEVELOPER_LOG',
            StartDate: now.toISOString(),
            ExpirationDate: future.toISOString()
        });

        if (Array.isArray(createResult)) {
            if (!createResult[0].success) {
                throw new Error(`Failed to create trace flag: ${JSON.stringify(createResult[0].errors)}`);
            }
            console.log('Created new trace flag with ID:', createResult[0].id);
        } else {
            if (!createResult.success) {
                throw new Error(`Failed to create trace flag: ${JSON.stringify(createResult.errors)}`);
            }
            console.log('Created new trace flag with ID:', createResult.id);
        }

    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        console.error('Trace flag error:', error);
        vscode.window.showErrorMessage(`Failed to manage trace flag: ${errorMessage}`);
        throw error;
    }
}

async function ensureDebugLevel(connection: Connection): Promise<string> {
    const LEVEL_NAME = 'SFDC_DevConsole';
    
    try {
        console.log('Checking for debug level:', LEVEL_NAME);
        
        // Check for existing debug level
        const existingLevels = await connection.tooling.query<DebugLevel>(
            `SELECT Id, ApexCode, Visualforce, Database, System FROM DebugLevel WHERE DeveloperName = '${LEVEL_NAME}'`
        );

        if (existingLevels.records && existingLevels.records.length > 0) {
            console.log('Found existing debug level:', existingLevels.records[0].Id);
            return existingLevels.records[0].Id;
        }

        // Create new debug level if there are none
        console.log('No existing debug level found, creating a new one...');
        const result = await connection.tooling.create('DebugLevel', {
            DeveloperName: LEVEL_NAME,
            MasterLabel: 'SF Log Viewer Debug Level',
            ApexCode: 'FINE',
            Visualforce: 'INFO',
            Database: 'INFO',
            System: 'DEBUG'
        });

        if (Array.isArray(result)) {
            if (!result[0].success) {
                throw new Error(`Failed to create debug level: ${JSON.stringify(result[0].errors)}`);
            }
            console.log('Created new debug level with ID:', result[0].id);
            return result[0].id;
        }
        
        if (!result.success) {
            throw new Error(`Failed to create debug level: ${JSON.stringify(result.errors)}`);
        }
        console.log('Created new debug level with ID:', result.id);
        return result.id;
    } catch (error: any) {
        const errorMessage = error?.message || 'Unknown error occurred';
        console.error('Debug level error:', error);
        vscode.window.showErrorMessage(`Failed to manage debug level: ${errorMessage}`);
        throw error;
    }
}