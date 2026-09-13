import { Connection } from 'jsforce';
import * as vscode from 'vscode';

export const DEFAULT_DEBUG_LEVEL_NAME = 'SFDC_DevConsole';

// Preserve the settings used by the extension when creating its default level.
const DEFAULT_LEVEL_SETTINGS: Record<string, string> = {
    ApexCode: 'FINEST',
    Visualforce: 'FINER',
    Database: 'INFO',
    System: 'DEBUG',
    Callout: 'INFO',
    Workflow: 'INFO',
    Validation: 'INFO'
};

export interface DebugLevel {
    Id: string;
    DeveloperName: string;
    MasterLabel: string;
    ApexCode: string;
    Database: string;
    System: string;
}

export interface DebugCategory {
    name: string;
    label: string;
    values: string[];
    defaultValue: string;
}

let workspaceState: vscode.Memento | undefined;

export function initializeDebugLevels(state: vscode.Memento): void {
    workspaceState = state;
}

async function selectionKey(connection: Connection): Promise<string> {
    const identity = await connection.identity();
    if (!identity.organization_id) throw new Error('Salesforce identity did not return an org ID.');
    return `debugLevel.${identity.organization_id}`;
}

export async function getSelectedDebugLevelName(connection: Connection): Promise<string> {
    const key = await selectionKey(connection);
    return workspaceState?.get<string>(key) || DEFAULT_DEBUG_LEVEL_NAME;
}

export async function saveSelectedDebugLevel(connection: Connection, name: string, isCurrent: () => boolean): Promise<void> {
    const key = await selectionKey(connection);
    if (!isCurrent()) throw new Error('The Salesforce org changed. Select the debug level again.');
    if (!workspaceState) throw new Error('Debug level preferences are not initialized.');
    await workspaceState.update(key, name);
}

export async function listDebugLevels(connection: Connection): Promise<DebugLevel[]> {
    let result = await connection.tooling.query<DebugLevel>(
        'SELECT Id, DeveloperName, MasterLabel, ApexCode, Database, System FROM DebugLevel ORDER BY DeveloperName'
    );
    const levels = [...result.records];
    while (!result.done && result.nextRecordsUrl) {
        result = await connection.tooling.queryMore<DebugLevel>(result.nextRecordsUrl);
        levels.push(...result.records);
    }
    return levels;
}

export async function findDebugLevel(connection: Connection, name: string): Promise<string | undefined> {
    const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await connection.tooling.query<{ Id: string }>(
        `SELECT Id FROM DebugLevel WHERE DeveloperName = '${escapedName}' LIMIT 1`
    );
    return result.records[0]?.Id;
}

export async function ensureDebugLevel(connection: Connection, isCurrent: () => boolean): Promise<string | undefined> {
    const name = await getSelectedDebugLevelName(connection);
    if (!isCurrent()) return;
    const id = await findDebugLevel(connection, name);
    if (!isCurrent()) return;
    if (id) return id;
    if (name !== DEFAULT_DEBUG_LEVEL_NAME) {
        throw new Error(`Debug level "${name}" no longer exists in this org. Use "Select Debug Level" to choose or create a level.`);
    }
    // Only the legacy default is created automatically. Never silently replace a
    // missing custom level with different logging settings.
    try {
        return await createDebugLevelRecord(connection, name, DEFAULT_LEVEL_SETTINGS);
    } catch (error) {
        if (!isCurrent()) return;
        // Another user/session may have created the default after our query.
        const concurrentId = await findDebugLevel(connection, name);
        if (concurrentId) return concurrentId;
        throw error;
    }
}

export async function getDebugLevelConfiguration(connection: Connection): Promise<{ categories: DebugCategory[]; nameMaxLength: number }> {
    const description = await connection.tooling.describe('DebugLevel');
    const categoryNames = ['ApexCode', 'ApexProfiling', 'Callout', 'Database', 'System', 'Validation', 'Visualforce', 'Workflow', 'Wave', 'Nba'];
    const categories: DebugCategory[] = [];
    for (const name of categoryNames) {
        const field = description.fields.find(candidate => candidate.name === name && candidate.createable);
        if (!field) continue;
        const values = (field.picklistValues ?? []).filter(value => value.active).map(value => value.value);
        if (!values.length) throw new Error(`Salesforce returned no supported values for ${field.label}.`);
        const preferred = DEFAULT_LEVEL_SETTINGS[name] ?? 'INFO';
        categories.push({
            name, label: field.label, values,
            defaultValue: values.includes(preferred) ? preferred : values[0]
        });
    }
    if (!categories.some(category => category.name === 'ApexCode')) {
        throw new Error('Your Salesforce user cannot create debug levels. Check your permissions.');
    }
    const nameField = description.fields.find(field => field.name === 'DeveloperName');
    const labelField = description.fields.find(field => field.name === 'MasterLabel');
    return { categories, nameMaxLength: Math.min(nameField?.length || 40, labelField?.length || 80) };
}

export function validateDebugLevelName(name: string, existing: DebugLevel[], maxLength: number): string | undefined {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name.endsWith('_') || name.includes('__')) {
        return 'Start with a letter; use only letters, numbers and single underscores, with no trailing underscore.';
    }
    if (name.length > maxLength) return `Use at most ${maxLength} characters.`;
    if (existing.some(level => level.DeveloperName.toLowerCase() === name.toLowerCase())) {
        return 'A debug level with this name already exists. Choose a different name.';
    }
    return undefined;
}

export async function createDebugLevelRecord(connection: Connection, name: string, settings: Record<string, string>): Promise<string> {
    const result = await connection.tooling.create('DebugLevel', {
        ...settings,
        DeveloperName: name,
        MasterLabel: name
    });
    if (!result.success || !result.id) throw new Error(`Failed to create debug level: ${JSON.stringify(result.errors)}`);
    return result.id;
}
