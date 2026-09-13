import * as vscode from 'vscode';
import { Connection } from 'jsforce';
import { getLogDataProvider, outputChannel } from './extension';
import {
    DebugLevel, DEFAULT_DEBUG_LEVEL_NAME, createDebugLevelRecord, ensureDebugLevel,
    findDebugLevel, getDebugLevelConfiguration, getSelectedDebugLevelName,
    listDebugLevels, saveSelectedDebugLevel, validateDebugLevelName
} from './DebugLevelManager';
import { applyDebugLevelToTraceFlags } from './TraceFlagManager';

// Avoid overlapping pickers saving/applying different selections out of order.
let commandRunning = false;

export async function selectDebugLevel(): Promise<void> {
    await configureDebugLevel(false);
}

export async function createDebugLevel(): Promise<void> {
    await configureDebugLevel(true);
}

async function configureDebugLevel(createNew: boolean): Promise<void> {
    if (commandRunning) return;
    commandRunning = true;
    let saved = false;
    let createdName: string | undefined;
    try {
        const provider = await getLogDataProvider();
        const connection = provider.connection;
        const isCurrent = () => provider.connection === connection;
        const assertCurrent = () => {
            if (!isCurrent()) throw new Error('The Salesforce org changed. Open Debug Level again.');
        };
        const currentName = await getSelectedDebugLevelName(connection);
        const levels = await listDebugLevels(connection);
        assertCurrent();

        let name: string;
        let id: string | undefined;
        if (!createNew) {
            const items = levels.map(level => ({
                label: `${level.DeveloperName === currentName ? '$(check) ' : ''}${level.DeveloperName}`,
                description: level.MasterLabel,
                detail: `Apex Code: ${level.ApexCode} · Database: ${level.Database} · System: ${level.System}`,
                name: level.DeveloperName,
                create: false
            }));
            // The default can be restored even when it has not yet been created.
            if (!levels.some(level => level.DeveloperName === DEFAULT_DEBUG_LEVEL_NAME)) {
                items.push({ label: DEFAULT_DEBUG_LEVEL_NAME, description: 'Extension default', detail: 'Create the original default level when selected', name: DEFAULT_DEBUG_LEVEL_NAME, create: false });
            }
            items.unshift({ label: '$(add) Create New Debug Level...', description: '', detail: 'Configure log categories, then create and use the level', name: '', create: true });
            const picked = await vscode.window.showQuickPick(items, {
                title: `Debug Level · Current: ${currentName}`,
                placeHolder: 'Choose the level for trace flags managed by this extension in this org',
                matchOnDescription: true,
                ignoreFocusOut: true
            });
            if (!picked) return;
            assertCurrent();
            createNew = picked.create;
            name = picked.name;
        } else {
            name = '';
        }

        if (createNew) {
            const created = await promptForDebugLevel(connection, levels, assertCurrent);
            if (!created) return;
            name = created.name;
            id = created.id;
            createdName = name;
            assertCurrent();
        } else {
            // Revalidate after the picker: another client may have deleted it.
            id = await findDebugLevel(connection, name);
            assertCurrent();
            if (!id && name !== DEFAULT_DEBUG_LEVEL_NAME) {
                throw new Error(`Debug level "${name}" no longer exists. Select or create another level.`);
            }
        }

        const currentUserId = await provider.getCurrentUserId();
        assertCurrent();
        await saveSelectedDebugLevel(connection, name, isCurrent);
        saved = true;
        assertCurrent();
        id ??= await ensureDebugLevel(connection, isCurrent);
        assertCurrent();
        if (!id) throw new Error('Salesforce did not return a debug level ID.');
        await applyDebugLevelToTraceFlags(connection, currentUserId, id, isCurrent);
        assertCurrent();
        vscode.window.showInformationMessage(`Debug level "${name}" ${createdName ? 'created and selected' : 'selected'} for this org. The extension uses it for active and future trace flags. Only new logs are affected.`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`Debug level configuration failed: ${message}`);
        const prefix = saved ? 'Debug level selection saved, but could not apply it to all active trace flags.'
            : createdName ? `Debug level "${createdName}" was created, but could not be selected.`
                : 'Could not configure debug level.';
        vscode.window.showErrorMessage(`${prefix} ${message}`);
    } finally {
        commandRunning = false;
    }
}

async function promptForDebugLevel(connection: Connection, existing: DebugLevel[], assertCurrent: () => void): Promise<{ name: string; id: string } | undefined> {
    const { categories, nameMaxLength } = await getDebugLevelConfiguration(connection);
    assertCurrent();
    const name = await vscode.window.showInputBox({
        title: 'Create Debug Level',
        prompt: 'Enter a unique debug level name (also used as its label)',
        ignoreFocusOut: true,
        validateInput: value => validateDebugLevelName(value, existing, nameMaxLength)
    });
    if (name === undefined) return;
    assertCurrent();
    const validation = validateDebugLevelName(name, existing, nameMaxLength);
    if (validation) throw new Error(validation);
    const settings: Record<string, string> = Object.fromEntries(categories.map(category => [category.name, category.defaultValue]));
    while (true) {
        const picked = await vscode.window.showQuickPick([
            { label: '$(check) Create and Use Debug Level', description: name, category: undefined },
            ...categories.map(category => ({ label: category.label, description: settings[category.name], category }))
        ], {
            title: `Create Debug Level · ${name}`,
            placeHolder: 'Select a category to change its verbosity, then create the level',
            ignoreFocusOut: true
        });
        if (!picked) return;
        assertCurrent();
        if (!picked.category) {
            const id = await createDebugLevelRecord(connection, name, settings);
            return { name, id };
        }
        const category = picked.category;
        const value = await vscode.window.showQuickPick(category.values.map(value => ({
            label: value,
            description: value === settings[category.name] ? 'Current' : '',
            value
        })), { title: `${name} · ${category.label}`, placeHolder: 'Choose log verbosity', ignoreFocusOut: true });
        assertCurrent();
        if (value) settings[category.name] = value.value;
    }
}
