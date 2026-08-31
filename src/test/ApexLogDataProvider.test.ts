import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';

class EventEmitter<T> {
    public readonly event = vi.fn();
    public fire = vi.fn((_value: T) => undefined);
    public dispose = vi.fn();
}

vi.mock('vscode', () => ({
    EventEmitter,
    ConfigurationTarget: { Global: 1 },
    Uri: { file: (value: string) => ({ fsPath: value }) },
    workspace: {
        workspaceFolders: [{ uri: { fsPath: 'C:\\workspace' } }],
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback, update: vi.fn() }),
        openTextDocument: vi.fn(),
        fs: { writeFile: vi.fn() },
    },
    window: {
        createOutputChannel: () => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() }),
        showErrorMessage: vi.fn(),
        showInformationMessage: vi.fn(),
        showSaveDialog: vi.fn(),
    },
    commands: { executeCommand: vi.fn() },
}));

vi.mock('../TraceFlagManager', () => ({ ensureTraceFlag: vi.fn() }));

function createContext() {
    return {
        workspaceState: {
            get: vi.fn((_key: string, fallback: unknown) => fallback),
            update: vi.fn(),
        },
    } as never;
}

describe('LogDataProvider refresh behavior', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('fails closed when current-user identity is unavailable', async () => {
        const query = vi.fn();
        const connection = {
            instanceUrl: 'https://example.my.salesforce.com',
            identity: vi.fn().mockRejectedValue(new Error('identity unavailable')),
            tooling: { query },
        } as unknown as Connection;
        const { LogDataProvider } = await import('../ApexLogDataProvider');
        const provider = new LogDataProvider(createContext(), connection, {
            autoRefresh: false,
            refreshInterval: 5000,
            currentUserOnly: true,
        });
        const updateView = vi.fn();
        provider.setActiveProvider({ updateView, postMessage: vi.fn(), refresh: vi.fn() });

        await provider.refreshLogs();

        expect(query).not.toHaveBeenCalled();
        expect(updateView).toHaveBeenLastCalledWith([], false, expect.objectContaining({ hasError: true }));
    });

    it('queues load older with a new query limit while a refresh is active', async () => {
        let resolveSecond!: (value: { records: unknown[] }) => void;
        const query = vi.fn()
            .mockResolvedValueOnce({ records: Array.from({ length: 101 }, (_, index) => createRecord(index)) })
            .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve; }))
            .mockResolvedValueOnce({ records: Array.from({ length: 201 }, (_, index) => createRecord(index)) });
        const connection = {
            instanceUrl: 'https://example.my.salesforce.com',
            tooling: { query },
        } as unknown as Connection;
        const { LogDataProvider } = await import('../ApexLogDataProvider');
        const provider = new LogDataProvider(createContext(), connection, {
            autoRefresh: false,
            refreshInterval: 5000,
            currentUserOnly: false,
        });

        await provider.refreshLogs();
        const activeRefresh = provider.refreshLogs();
        await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
        const loadOlder = provider.loadOlder();
        resolveSecond({ records: Array.from({ length: 101 }, (_, index) => createRecord(index)) });
        await Promise.all([activeRefresh, loadOlder]);

        expect(query).toHaveBeenCalledTimes(3);
        expect(query.mock.calls[1][0]).toContain('LIMIT 101');
        expect(query.mock.calls[2][0]).toContain('LIMIT 201');
        expect(provider.getPanelMeta().loadedCount).toBe(200);
        expect(provider.getPanelMeta().hasMore).toBe(true);
    });
});

function createRecord(index: number) {
    return {
        Id: `07L${String(index).padStart(12, '0')}`,
        Application: 'Unknown',
        DurationMilliseconds: index,
        Location: '',
        LogLength: 1024,
        LogUser: { Name: 'Ada' },
        Operation: `Operation ${index}`,
        Request: '',
        StartTime: new Date(Date.now() - index * 1000).toISOString(),
        Status: 'Success',
    };
}