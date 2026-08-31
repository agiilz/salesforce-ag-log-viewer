import type { PanelFilters, PanelMeta } from './ApexLogDataProvider';

export type PanelToHostMessage =
    | { command: 'ready' }
    | { command: 'openLog'; log: { id: string } }
    | { command: 'inlineSearch'; text: string }
    | { command: 'setFilters'; filters: Partial<PanelFilters> }
    | { command: 'toggleFavorite'; logId: string }
    | { command: 'exportFilteredLogs' }
    | { command: 'loadOlder' }
    | { command: 'compareLogs'; logIds: [string, string] };

export type HostToPanelMessage =
    | { type: 'updateData'; data: any[]; isAutoRefresh: boolean; errorInfo: { hasError: boolean; message?: string } | null; meta?: PanelMeta }
    | { type: 'logDownloadState'; logId: string; state: 'downloading' | 'downloaded' | 'failed'; message?: string }
    | { type: 'logDownloaded'; logId: string }
    | { type: 'showSearchBox' }
    | { type: 'clearDownloadedState' }
    | { type: 'orgChanged'; activeOrg?: string };

export function parsePanelMessage(value: unknown): PanelToHostMessage | undefined {
    if (!isRecord(value) || typeof value.command !== 'string') {
        return undefined;
    }
    switch (value.command) {
        case 'ready':
        case 'loadOlder':
        case 'exportFilteredLogs':
            return { command: value.command };
        case 'openLog':
            return isRecord(value.log) && isSalesforceId(value.log.id)
                ? { command: 'openLog', log: { id: value.log.id } }
                : undefined;
        case 'inlineSearch':
            return typeof value.text === 'string' ? { command: 'inlineSearch', text: value.text.slice(0, 500) } : undefined;
        case 'setFilters':
            return isRecord(value.filters) ? { command: 'setFilters', filters: sanitizeFilters(value.filters) } : undefined;
        case 'toggleFavorite':
            return isSalesforceId(value.logId) ? { command: 'toggleFavorite', logId: value.logId } : undefined;
        case 'compareLogs':
            if (Array.isArray(value.logIds) && value.logIds.length === 2 && value.logIds.every(isSalesforceId)) {
                return { command: 'compareLogs', logIds: [value.logIds[0], value.logIds[1]] };
            }
            return undefined;
        default:
            return undefined;
    }
}

function sanitizeFilters(value: Record<string, unknown>): Partial<PanelFilters> {
    return {
        ...(typeof value.text === 'string' ? { text: value.text.slice(0, 500) } : {}),
        ...(typeof value.useRegex === 'boolean' ? { useRegex: value.useRegex } : {}),
        ...(typeof value.status === 'string' ? { status: value.status.slice(0, 100) } : {}),
        ...(typeof value.user === 'string' ? { user: value.user.slice(0, 200) } : {}),
        ...(typeof value.favoritesOnly === 'boolean' ? { favoritesOnly: value.favoritesOnly } : {}),
        ...(typeof value.dateFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.dateFrom) ? { dateFrom: value.dateFrom } : {}),
        ...(typeof value.minimumDurationMs === 'number' && Number.isFinite(value.minimumDurationMs) ? { minimumDurationMs: Math.max(value.minimumDurationMs, 0) } : {}),
        ...(typeof value.minimumSizeKb === 'number' && Number.isFinite(value.minimumSizeKb) ? { minimumSizeKb: Math.max(value.minimumSizeKb, 0) } : {}),
        ...(typeof value.exceptionsOnly === 'boolean' ? { exceptionsOnly: value.exceptionsOnly } : {})
    };
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null;
}

function isSalesforceId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value);
}