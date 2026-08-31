import { beforeEach, describe, expect, it, vi } from 'vitest';

let targetOrg = 'first@example.com';
let failNextOrg: string | undefined;
const execFileMock = vi.fn();

vi.mock('child_process', () => ({
    execFile: execFileMock,
}));

vi.mock('fs', () => ({
    default: {
        promises: {
            readFile: vi.fn(async (filePath: string) => {
                if (filePath.includes('.sf')) {
                    return JSON.stringify({ 'target-org': targetOrg });
                }
                throw new Error('File not found');
            }),
        },
    },
    promises: {
        readFile: vi.fn(async (filePath: string) => {
            if (filePath.includes('.sf')) {
                return JSON.stringify({ 'target-org': targetOrg });
            }
            throw new Error('File not found');
        }),
    },
}));

vi.mock('jsforce', () => ({
    Connection: class MockConnection {
        public readonly instanceUrl: string;
        public readonly accessToken: string;

        constructor(options: { instanceUrl: string; accessToken: string }) {
            this.instanceUrl = options.instanceUrl;
            this.accessToken = options.accessToken;
        }
    },
}));

function installSuccessfulCliMock() {
    execFileMock.mockImplementation((_file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        const orgIndex = Math.max(args.indexOf('-o'), args.indexOf('--target-org'));
        const org = orgIndex >= 0 ? args[orgIndex + 1] : targetOrg;
        if (failNextOrg === org) {
            failNextOrg = undefined;
            callback(new Error(`Authentication failed for ${org}`), '', '');
            return;
        }
        const result = args.includes('show-access-token')
            ? { result: { accessToken: `token-${org}` } }
            : { result: { instanceUrl: `https://${org.replace('@', '-')}.example` } };
        queueMicrotask(() => callback(null, JSON.stringify(result), ''));
    });
}

describe('Salesforce connection cache', () => {
    beforeEach(() => {
        vi.resetModules();
        execFileMock.mockReset();
        targetOrg = 'first@example.com';
        failNextOrg = undefined;
        installSuccessfulCliMock();
    });

    it('deduplicates concurrent authentication for the same org', async () => {
        const { getConnection } = await import('../connection');

        const [first, second] = await Promise.all([getConnection(), getConnection()]);

        expect(first).toBe(second);
        expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('does not commit a new org until authentication succeeds', async () => {
        const { getConnection } = await import('../connection');
        const first = await getConnection();
        targetOrg = 'second@example.com';
        failNextOrg = targetOrg;

        await expect(getConnection()).rejects.toThrow('Authentication failed');
        const second = await getConnection();

        expect(second).not.toBe(first);
        expect((second as unknown as { accessToken: string }).accessToken).toBe('token-second@example.com');
        expect(execFileMock).toHaveBeenCalledTimes(6);
    });

    it('forces a fresh token and retries once for an expired session', async () => {
        const { getConnection, retryOnSessionExpire } = await import('../connection');
        const initial = await getConnection();
        let attempts = 0;

        const result = await retryOnSessionExpire(async (connection) => {
            attempts++;
            if (attempts === 1) {
                throw new Error('INVALID_SESSION_ID');
            }
            return connection;
        });

        expect(result).not.toBe(initial);
        expect(attempts).toBe(2);
        expect(execFileMock).toHaveBeenCalledTimes(4);
    });

    it('does not retry non-session failures', async () => {
        const { retryOnSessionExpire } = await import('../connection');
        const operation = vi.fn(async () => {
            throw new Error('PERMISSION_DENIED');
        });

        await expect(retryOnSessionExpire(operation)).rejects.toThrow('PERMISSION_DENIED');
        expect(operation).toHaveBeenCalledTimes(1);
        expect(execFileMock).toHaveBeenCalledTimes(2);
    });

    it('does not let an older org authentication overwrite a newer org', async () => {
        const callbacks = new Map<string, Array<(error: Error | null, stdout: string, stderr: string) => void>>();
        execFileMock.mockImplementation((_file: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
            const orgIndex = Math.max(args.indexOf('-o'), args.indexOf('--target-org'));
            const org = args[orgIndex + 1];
            const key = `${org}:${args.includes('show-access-token') ? 'token' : 'details'}`;
            callbacks.set(key, [...(callbacks.get(key) ?? []), callback]);
        });
        const { getConnection } = await import('../connection');

        const oldAttempt = getConnection();
        await vi.waitFor(() => expect(callbacks.size).toBe(2));
        targetOrg = 'second@example.com';
        const newAttempt = getConnection();
        await vi.waitFor(() => expect(callbacks.size).toBe(4));

        callbacks.get('second@example.com:details')?.[0](null, JSON.stringify({ result: { instanceUrl: 'https://second.example' } }), '');
        callbacks.get('second@example.com:token')?.[0](null, JSON.stringify({ result: { accessToken: 'token-second' } }), '');
        const newConnection = await newAttempt;
        callbacks.get('first@example.com:details')?.[0](null, JSON.stringify({ result: { instanceUrl: 'https://first.example' } }), '');
        callbacks.get('first@example.com:token')?.[0](null, JSON.stringify({ result: { accessToken: 'token-first' } }), '');
        const reconciledOldAttempt = await oldAttempt;

        expect(reconciledOldAttempt).toBe(newConnection);
        expect(await getConnection()).toBe(newConnection);
        expect((newConnection as unknown as { accessToken: string }).accessToken).toBe('token-second');
    });
});