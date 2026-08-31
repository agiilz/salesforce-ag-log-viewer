import { describe, expect, it } from 'vitest';
import { parsePanelMessage } from '../webviewMessages';

describe('panel message validation', () => {
    it('rejects malformed commands and Salesforce IDs', () => {
        expect(parsePanelMessage(null)).toBeUndefined();
        expect(parsePanelMessage({ command: 'unknown' })).toBeUndefined();
        expect(parsePanelMessage({ command: 'openLog', log: { id: '../secret' } })).toBeUndefined();
        expect(parsePanelMessage({ command: 'compareLogs', logIds: ['07L000000000001', 'bad'] })).toBeUndefined();
    });

    it('accepts valid log and comparison IDs', () => {
        const first = '07L000000000001';
        const second = '07L000000000002AAA';

        expect(parsePanelMessage({ command: 'openLog', log: { id: first } })).toEqual({
            command: 'openLog',
            log: { id: first }
        });
        expect(parsePanelMessage({ command: 'compareLogs', logIds: [first, second] })).toEqual({
            command: 'compareLogs',
            logIds: [first, second]
        });
    });

    it('bounds and sanitizes filter input', () => {
        const message = parsePanelMessage({
            command: 'setFilters',
            filters: {
                text: 'x'.repeat(600),
                useRegex: true,
                status: 'Success',
                user: 'Ada',
                favoritesOnly: true,
                ignored: 'value'
            }
        });

        expect(message?.command).toBe('setFilters');
        if (message?.command !== 'setFilters') return;
        expect(message.filters.text).toHaveLength(500);
        expect(message.filters).toEqual({
            text: 'x'.repeat(500),
            useRegex: true,
            status: 'Success',
            user: 'Ada',
            favoritesOnly: true
        });
    });
});