import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApexLog } from '../ApexLogWrapper';

const pathExists = vi.fn();
const ensureDir = vi.fn();
const writeFile = vi.fn();
const stat = vi.fn();
const readdir = vi.fn();
const remove = vi.fn();
const move = vi.fn();
const openTextDocument = vi.fn();
const showTextDocument = vi.fn();
const setTextDocumentLanguage = vi.fn();

vi.mock('fs-extra', () => ({
    default: { pathExists, ensureDir, writeFile, stat, readdir, remove, move },
    pathExists,
    ensureDir,
    writeFile,
    stat,
    readdir,
    remove,
    move,
}));

vi.mock('vscode', () => ({
    window: {
        createOutputChannel: () => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() }),
        visibleTextEditors: [],
        showTextDocument,
        tabGroups: { all: [], close: vi.fn() },
    },
    workspace: {
        openTextDocument,
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
    },
    languages: { setTextDocumentLanguage },
    commands: { executeCommand: vi.fn() },
}));

function createLog(): ApexLog {
    return new ApexLog({
        Id: '07L000000000001',
        Application: 'Unknown',
        DurationMilliseconds: 100,
        Location: '',
        LogLength: 1024,
        LogUser: { Name: 'Ada' },
        Operation: 'Execute Anonymous',
        Request: '',
        StartTime: '2026-08-31T10:00:00.000Z',
        Status: 'Success'
    }, {} as never);
}

describe('ApexLogFileManager', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        readdir.mockResolvedValue([]);
        stat.mockResolvedValue({ size: 1024, mtimeMs: Date.now() });
        writeFile.mockImplementation(async (_path: string, content: string) => {
            stat.mockResolvedValue({ size: Buffer.byteLength(content, 'utf8'), mtimeMs: Date.now() });
        });
        move.mockResolvedValue(undefined);
        remove.mockResolvedValue(undefined);
        openTextDocument.mockResolvedValue({ uri: { fsPath: 'log' } });
    });

    it('opens a valid cached log without loading the body', async () => {
        pathExists.mockResolvedValue(true);
        const loadBody = vi.fn();
        const { ApexLogFileManager } = await import('../ApexLogFileManager');

        await new ApexLogFileManager('C:\\workspace').showLog(createLog(), loadBody);

        expect(loadBody).not.toHaveBeenCalled();
        expect(setTextDocumentLanguage).toHaveBeenCalledWith(expect.anything(), 'salesforce-apex-log');
        expect(showTextDocument).toHaveBeenCalledOnce();
    });

    it('shares concurrent downloads for the same log', async () => {
        pathExists.mockResolvedValue(false);
        let resolveBody!: (value: string) => void;
        const loadBody = vi.fn(() => new Promise<string>(resolve => { resolveBody = resolve; }));
        const { ApexLogFileManager } = await import('../ApexLogFileManager');
        const manager = new ApexLogFileManager('C:\\workspace');

        const first = manager.showLog(createLog(), loadBody);
        const second = manager.showLog(createLog(), loadBody);
        await vi.waitFor(() => expect(loadBody).toHaveBeenCalledOnce());
        resolveBody('log body');
        await Promise.all([first, second]);

        expect(loadBody).toHaveBeenCalledOnce();
        expect(writeFile).toHaveBeenCalledOnce();
        expect(move).toHaveBeenCalledOnce();
    });

    it('rejects a failed body download so the row can be retried', async () => {
        pathExists.mockResolvedValue(false);
        const loadBody = vi.fn().mockRejectedValue(new Error('network unavailable'));
        const { ApexLogFileManager } = await import('../ApexLogFileManager');

        await expect(new ApexLogFileManager('C:\\workspace').showLog(createLog(), loadBody))
            .rejects.toThrow('network unavailable');
        expect(writeFile).not.toHaveBeenCalled();
    });
});