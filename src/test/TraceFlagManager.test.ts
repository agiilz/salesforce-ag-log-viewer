import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';

function createConnection(query: (soql: string) => Promise<unknown>) {
    return {
        instanceUrl: 'https://example.my.salesforce.com',
        tooling: {
            query: vi.fn(query),
            update: vi.fn(async () => ({ success: true })),
            create: vi.fn(async () => ({ id: '7tf000000000001AAA' })),
            delete: vi.fn(async () => ({ success: true })),
        },
    } as unknown as Connection;
}

describe('trace flag management', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('preserves and extends an active developer-log trace flag', async () => {
        const expiration = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        const connection = createConnection(async () => ({
            records: [{
                Id: '7tf000000000001AAA',
                DebugLevelId: '7dl000000000001AAA',
                LogType: 'DEVELOPER_LOG',
                StartDate: new Date().toISOString(),
                ExpirationDate: expiration,
                TracedEntityId: '005000000000001AAA'
            }]
        }));
        const { ensureTraceFlag, stopTraceFlagKeepAlive } = await import('../TraceFlagManager');

        await ensureTraceFlag(connection, '005000000000001AAA', 15, false);

        expect(connection.tooling.update).toHaveBeenCalledOnce();
        expect(connection.tooling.create).not.toHaveBeenCalled();
        expect(connection.tooling.delete).not.toHaveBeenCalled();
        stopTraceFlagKeepAlive();
    });

    it('creates a trace flag only when none exists', async () => {
        const connection = createConnection(async (soql) => soql.includes('FROM TraceFlag')
            ? { records: [] }
            : { records: [{ Id: '7dl000000000001AAA' }] });
        const { ensureTraceFlag, stopTraceFlagKeepAlive } = await import('../TraceFlagManager');

        await ensureTraceFlag(connection, '005000000000001AAA', 15, false);

        expect(connection.tooling.create).toHaveBeenCalledWith('TraceFlag', expect.objectContaining({
            TracedEntityId: '005000000000001AAA',
            DebugLevelId: '7dl000000000001AAA',
            LogType: 'DEVELOPER_LOG'
        }));
        expect(connection.tooling.delete).not.toHaveBeenCalled();
        stopTraceFlagKeepAlive();
    });

    it('does not reschedule a keep-alive stopped during an in-flight update', async () => {
        vi.useFakeTimers();
        let resolveUpdate!: (value: { success: boolean }) => void;
        const expiration = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        const connection = createConnection(async () => ({
            records: [{
                Id: '7tf000000000001AAA',
                DebugLevelId: '7dl000000000001AAA',
                LogType: 'DEVELOPER_LOG',
                StartDate: new Date().toISOString(),
                ExpirationDate: expiration,
                TracedEntityId: '005000000000001AAA'
            }]
        }));
        const initialUpdate = vi.mocked(connection.tooling.update);
        initialUpdate.mockResolvedValueOnce({ success: true, id: '7tf000000000001AAA', errors: [] });
        initialUpdate.mockImplementationOnce(() => new Promise(resolve => { resolveUpdate = resolve; }) as never);
        const { ensureTraceFlag, stopTraceFlagKeepAlive } = await import('../TraceFlagManager');
        await ensureTraceFlag(connection, '005000000000001AAA', 5, true);

        vi.advanceTimersByTime(4 * 60 * 1000);
        await Promise.resolve();
        expect(initialUpdate).toHaveBeenCalledTimes(2);
        stopTraceFlagKeepAlive();
        resolveUpdate({ success: true });
        await Promise.resolve();
        vi.advanceTimersByTime(10 * 60 * 1000);
        await Promise.resolve();

        expect(initialUpdate).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });
});