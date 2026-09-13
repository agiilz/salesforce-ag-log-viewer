/* global acquireVsCodeApi, ApexLogParser */
const EXECUTION_TYPES = { unit: 'Apex', method: 'Methods', system: 'System', flow: 'Flow', soql: 'Queries', dml: 'DML' };
class ApexLogDetails {
    constructor() {
        this.vscode = acquireVsCodeApi();
        this.savedState = this.vscode.getState() || {};
        this.ROW_HEIGHT = 24;
        this.BUFFER_SIZE = 12;
        this.COLUMN_DEFAULTS = [28, 132, 210, 102, 480];
        this.COLUMN_MINIMUMS = [28, 110, 100, 70, 200];
        this.columnWidths = this.COLUMN_DEFAULTS.slice();
        this.virtualState = { allRows: [], collapsedBlocks: new Set(), visibleRows: null };
        this.searchText = '';
        this.hideHeapAllocate = true;
        this.onlyUserDebug = false;
        this.selectedLogIndex = null;
        this.revealedLogIndex = null;
        this.revealReturnScrollTop = 0;
        this.executionMapState = { model: null, collapsed: false, zoom: 1, viewStack: [], scrollLeft: 0,
            scrollTop: 0, height: 360, hiddenKinds: new Set(), selectedSpanId: null, selectedMarkerIndex: null };
        this.loadVersion = 0;
        this.methodBlockIds = [];
        this.inspectedVariableIndex = null;
        this.ready = false;
        window.addEventListener('message', event => {
            if (event.data?.type === 'copyLogLineResult') {
                if (event.data.index === this.inspectedVariableIndex) {
                    document.getElementById('variable-copy-status').textContent = event.data.success ? 'Copied' : 'Unable to copy. Select the original text to copy it.';
                }
                return;
            }
            if (typeof event.data?.logContent !== 'string') return;
            if (this.ready) this.loadLog(event.data);
            else this.pendingLog = event.data;
        });
        document.addEventListener('DOMContentLoaded', () => this.initialize());
    }

    initialize() {
        this.viewport = document.getElementById('virtual-viewport');
        this.content = document.getElementById('content-container');
        this.header = document.getElementById('log-table-header-wrapper');
        this.table = document.getElementById('log-table-container');
        this.status = document.getElementById('log-status');
        this.searchInput = document.getElementById('log-search-input');
        this.revealNotice = document.getElementById('reveal-notice');
        this.viewport.addEventListener('scroll', () => {
            this.header.scrollLeft = this.viewport.scrollLeft;
            this.scheduleRows();
            this.scheduleSave();
        }, { passive: true });
        this.searchInput.addEventListener('input', () => {
            this.searchText = this.searchInput.value.trim().toLowerCase();
            this.filtersChanged();
        });
        for (const id of ['hide-heap-allocate', 'only-user-debug']) {
            document.getElementById(id).addEventListener('change', () => {
                this.hideHeapAllocate = document.getElementById('hide-heap-allocate').checked;
                this.onlyUserDebug = document.getElementById('only-user-debug').checked;
                this.filtersChanged();
            });
        }
        document.getElementById('return-to-filters').onclick = () => this.clearReveal();
        this.collapseAllButton = document.getElementById('collapse-all-methods');
        this.collapseAllButton.onclick = () => this.toggleAllMethods();
        this.variableDialog = document.getElementById('variable-dialog');
        document.getElementById('variable-dialog-close').onclick = () => this.variableDialog.close();
        this.variableDialog.addEventListener('close', () => { this.inspectedVariableIndex = null; });
        document.getElementById('variable-copy-raw').onclick = () => {
            if (this.inspectedVariableIndex === null) return;
            document.getElementById('variable-copy-status').textContent = 'Copying…';
            this.vscode.postMessage({ type: 'copyLogLine', index: this.inspectedVariableIndex });
        };
        this.initializeColumns();
        this.initializeExecutionMap();
        this.resizeObserver = new ResizeObserver(() => {
            cancelAnimationFrame(this.resizeFrame);
            this.resizeFrame = requestAnimationFrame(() => {
                this.updateColumns();
                this.renderVisibleRows();
                this.renderExecutionMap();
            });
        });
        this.resizeObserver.observe(this.viewport);
        this.resizeObserver.observe(document.getElementById('execution-scroll'));
        // Save small view state, never the log contents. VS Code retains this
        // state when it tears down a hidden webview's document.
        window.addEventListener('pagehide', () => this.saveState());
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) this.saveState();
        });
        this.ready = true;
        if (this.pendingLog) {
            this.loadLog(this.pendingLog);
            this.pendingLog = null;
        }
        this.vscode.postMessage({ type: 'ready' });
    }

    async parseContent(content) {
        if (content.length < 250000 || typeof Worker === 'undefined') return ApexLogParser.parseAsync(content);
        let worker;
        let url;
        try {
            // VS Code webviews require blob/data URLs for workers. Bundle the
            // same dependency-free parser into a blob instead of importScripts.
            const response = await fetch(document.getElementById('log-parser-script').src);
            if (!response.ok) throw new Error('Unable to load log parser');
            const source = await response.text();
            url = URL.createObjectURL(new Blob([source, '\nself.onmessage = e => self.postMessage(ApexLogParser.parse(e.data));'], { type: 'text/javascript' }));
            worker = new Worker(url);
            return await new Promise((resolve, reject) => {
                worker.onmessage = event => resolve(event.data);
                worker.onerror = reject;
                worker.onmessageerror = reject;
                worker.postMessage(content);
            });
        } catch (error) {
            console.warn('Log parsing worker unavailable; using chunked parsing.', error);
            return ApexLogParser.parseAsync(content);
        } finally {
            if (worker) worker.terminate();
            if (url) URL.revokeObjectURL(url);
        }
    }

    async loadLog(data) {
        const logId = data.logId || data.fileName || '';
        const key = `${logId}:${data.logContent.length}`;
        if (this.loadingKey === key || this.loadedKey === key) return;
        const version = ++this.loadVersion;
        this.loadingKey = key;
        this.status.textContent = 'Loading log…';
        this.status.hidden = false;
        this.table.setAttribute('aria-busy', 'true');
        try {
            const parsed = await this.parseContent(data.logContent);
            if (version !== this.loadVersion) return;
            this.logId = logId;
            this.loadedKey = key;
            this.virtualState.allRows = parsed.rows;
            this.methodBlockIds = parsed.rows.filter(row => row.type === 'entry').map(row => row.blockId);
            if (this.variableDialog.open) this.variableDialog.close();
            this.executionMapState.model = parsed.executionMap;
            this.restoreState(this.savedState.logKey === key ? this.savedState : {});
            this.invalidateRows();
            this.updateColumns();
            this.renderVisibleRows();
            this.viewport.scrollTop = this.restoredScrollTop;
            this.viewport.scrollLeft = this.restoredScrollLeft;
            this.header.scrollLeft = this.viewport.scrollLeft;
            this.renderVisibleRows();
            this.renderExecutionMap();
            this.loadingKey = null;
            this.saveState();
        } catch (error) {
            if (version === this.loadVersion) {
                this.status.textContent = 'Unable to read this log. Reopen Log Details to try again.';
                this.status.hidden = false;
                console.error(error);
            }
        } finally {
            if (version === this.loadVersion) {
                this.loadingKey = null;
                this.table.setAttribute('aria-busy', 'false');
            }
        }
    }

    restoreState(saved) {
        const safeNumber = (value, fallback = 0) => Number.isFinite(value) && value >= 0 ? value : fallback;
        this.hideHeapAllocate = saved.hideHeapAllocate !== false;
        this.onlyUserDebug = saved.onlyUserDebug === true;
        this.searchInput.value = typeof saved.search === 'string' ? saved.search : '';
        this.searchText = this.searchInput.value.trim().toLowerCase();
        document.getElementById('hide-heap-allocate').checked = this.hideHeapAllocate;
        document.getElementById('only-user-debug').checked = this.onlyUserDebug;
        const rows = this.virtualState.allRows;
        const blockIds = new Set(rows.filter(row => row.type === 'entry').map(row => row.blockId));
        this.virtualState.collapsedBlocks = new Set((Array.isArray(saved.collapsedBlocks) ? saved.collapsedBlocks : []).filter(id => blockIds.has(id)));
        const validIndex = index => Number.isInteger(index) && index >= 0 && index < rows.length ? index : null;
        this.selectedLogIndex = validIndex(saved.selectedLogIndex);
        this.revealedLogIndex = validIndex(saved.revealedLogIndex);
        this.revealReturnScrollTop = safeNumber(saved.revealReturnScrollTop);
        this.restoredScrollTop = safeNumber(saved.scrollTop);
        this.restoredScrollLeft = safeNumber(saved.scrollLeft);
        this.columnWidths = this.COLUMN_DEFAULTS.map((width, index) => Math.min(2400, Math.max(this.COLUMN_MINIMUMS[index], safeNumber(saved.columnWidths?.[index], width))));
        const map = this.executionMapState;
        map.collapsed = saved.executionCollapsed === true;
        map.zoom = Math.min(16, Math.max(1, safeNumber(saved.zoom, 1)));
        map.viewStack = [];
        for (const id of Array.isArray(saved.viewStack) ? saved.viewStack : []) {
            const span = map.model.spans[id];
            if (!span || span.parentId !== (map.viewStack.at(-1) ?? null)) break;
            map.viewStack.push(id);
        }
        map.scrollLeft = safeNumber(saved.timelineScrollLeft);
        map.scrollTop = safeNumber(saved.timelineScrollTop);
        map.height = Math.min(700, Math.max(220, safeNumber(saved.executionHeight, 360)));
        map.hiddenKinds = new Set((Array.isArray(saved.executionHiddenKinds) ? saved.executionHiddenKinds : []).filter(kind => Object.hasOwn(EXECUTION_TYPES, kind)));
        map.selectedSpanId = Number.isInteger(saved.selectedSpanId) && map.model.spans[saved.selectedSpanId] ? saved.selectedSpanId : null;
        map.selectedMarkerIndex = Number.isInteger(saved.selectedMarkerIndex) && map.model.markers.some(marker => marker.index === saved.selectedMarkerIndex) ? saved.selectedMarkerIndex : null;
    }

    saveState() {
        clearTimeout(this.saveTimer);
        if (!this.loadedKey || this.loadingKey) return;
        const map = this.executionMapState;
        this.savedState = {
            logKey: this.loadedKey, search: this.searchInput.value,
            hideHeapAllocate: this.hideHeapAllocate, onlyUserDebug: this.onlyUserDebug,
            collapsedBlocks: [...this.virtualState.collapsedBlocks],
            selectedLogIndex: this.selectedLogIndex, revealedLogIndex: this.revealedLogIndex,
            revealReturnScrollTop: this.revealReturnScrollTop,
            scrollTop: this.viewport.scrollTop, scrollLeft: this.viewport.scrollLeft,
            columnWidths: this.columnWidths, executionCollapsed: map.collapsed,
            zoom: map.zoom, viewStack: map.viewStack, timelineScrollLeft: map.scrollLeft,
            timelineScrollTop: map.scrollTop, executionHeight: map.height,
            executionHiddenKinds: [...map.hiddenKinds], selectedSpanId: map.selectedSpanId, selectedMarkerIndex: map.selectedMarkerIndex
        };
        this.vscode.setState(this.savedState);
    }

    scheduleSave() {
        clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveState(), 100);
    }

    invalidateRows() {
        this.virtualState.visibleRows = null;
        this.renderedRange = null;
    }

    getVisibleRows() {
        if (this.virtualState.visibleRows) return this.virtualState.visibleRows;
        const visible = [];
        let hiddenUntil = -1;
        // Walk the complete structure. A search must never remove an exit
        // before folding is evaluated; searches/debug-only intentionally show
        // matches inside folded methods without changing the saved folds.
        for (const row of this.virtualState.allRows) {
            let folded = false;
            if (!this.searchText && !this.onlyUserDebug) {
                folded = row.idx < hiddenUntil;
                if (!folded && row.type === 'entry' && this.virtualState.collapsedBlocks.has(row.blockId)) {
                    hiddenUntil = row.endIndex;
                }
            }
            const matches = !folded &&
                (!this.hideHeapAllocate || row.filterEventType !== 'HEAP_ALLOCATE') &&
                (!this.onlyUserDebug || row.filterEventType === 'USER_DEBUG') &&
                (!this.searchText || row.searchText.includes(this.searchText));
            if (matches || row.idx === this.revealedLogIndex) visible.push(row);
        }
        this.virtualState.visibleRows = visible;
        return visible;
    }

    filtersChanged() {
        this.revealedLogIndex = null;
        this.invalidateRows();
        this.viewport.scrollTop = 0;
        this.renderVisibleRows();
        this.saveState();
    }

    scheduleRows() {
        if (this.rowFrame) return;
        this.rowFrame = requestAnimationFrame(() => {
            this.rowFrame = null;
            this.renderVisibleRows();
        });
    }

    renderVisibleRows() {
        if (!this.content) return;
        this.updateCollapseAllButton();
        const rows = this.getVisibleRows();
        this.content.style.height = `${rows.length * this.ROW_HEIGHT}px`;
        this.viewport.scrollTop = Math.min(this.viewport.scrollTop, Math.max(0, rows.length * this.ROW_HEIGHT - this.viewport.clientHeight));
        const start = Math.max(0, Math.floor(this.viewport.scrollTop / this.ROW_HEIGHT) - this.BUFFER_SIZE);
        const end = Math.min(rows.length, Math.ceil((this.viewport.scrollTop + this.viewport.clientHeight) / this.ROW_HEIGHT) + this.BUFFER_SIZE);
        const range = `${start}:${end}:${this.selectedLogIndex}`;
        if (range === this.renderedRange) return;
        this.renderedRange = range;
        const fragment = document.createDocumentFragment();
        for (let i = start; i < end; i++) {
            const row = rows[i];
            const element = document.createElement('div');
            element.className = `log-row ${row.type} ${row.eventType}${row.severity ? ` severity-${row.severity}` : ''}`;
            element.setAttribute('role', 'row');
            element.setAttribute('aria-rowindex', String(i + 2));
            element.dataset.logIndex = String(row.idx);
            element.style.top = `${i * this.ROW_HEIGHT}px`;
            element.classList.toggle('is-selected', row.idx === this.selectedLogIndex);
            const collapse = document.createElement('div');
            collapse.className = 'log-cell collapse-cell';
            collapse.setAttribute('role', 'cell');
            if (row.type === 'entry' && !this.onlyUserDebug && !this.searchText) {
                const button = document.createElement('button');
                const collapsed = this.virtualState.collapsedBlocks.has(row.blockId);
                button.className = 'collapse-btn';
                button.type = 'button';
                button.textContent = collapsed ? '▶' : '▼';
                button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} method ${row.details}`);
                button.setAttribute('aria-expanded', String(!collapsed));
                button.onclick = () => this.toggleCollapse(row.blockId);
                collapse.appendChild(button);
            }
            element.appendChild(collapse);
            const details = row.level ? `[${row.level}] ${row.details}` : row.details;
            for (const [index, value] of [row.timestamp, row.eventType, row.lineNumber, details].entries()) {
                const cell = document.createElement('div');
                cell.className = 'log-cell';
                cell.setAttribute('role', 'cell');
                if (index === 3 && row.variable) this.renderVariableCell(cell, row);
                else cell.textContent = index === 1 && row.variable ? (row.variable.declaration ? 'Variable declared' : 'Variable assigned') : value;
                cell.title = index === 3 ? `Log line ${row.idx + 1}\n${row.raw}` : value;
                if (index === 3 && row.depth > 0) cell.style.paddingLeft = `${Math.min(row.depth, 20) * 12 + 8}px`;
                element.appendChild(cell);
            }
            fragment.appendChild(element);
        }
        this.content.replaceChildren(fragment);
        this.table.setAttribute('aria-rowcount', String(rows.length + 1));
        this.revealNotice.hidden = this.revealedLogIndex === null;
        if (this.loadedKey) {
            this.status.hidden = rows.length > 0;
            this.status.textContent = this.virtualState.allRows.length ? 'No matching log events.' : 'This log is empty.';
        }
    }

    toggleCollapse(blockId) {
        const blocks = this.virtualState.collapsedBlocks;
        if (blocks.has(blockId)) blocks.delete(blockId);
        else blocks.add(blockId);
        this.invalidateRows();
        this.renderVisibleRows();
        this.saveState();
    }

    updateCollapseAllButton() {
        if (!this.collapseAllButton) return;
        const allCollapsed = this.methodBlockIds.length > 0 && this.virtualState.collapsedBlocks.size === this.methodBlockIds.length;
        this.collapseAllButton.textContent = allCollapsed ? 'Expand all methods' : 'Collapse all methods';
        this.collapseAllButton.disabled = !this.methodBlockIds.length || !!this.searchText || this.onlyUserDebug;
        this.collapseAllButton.title = this.searchText || this.onlyUserDebug
            ? 'Clear search and Debug only to fold methods. Matching events remain visible inside folded methods.'
            : `${allCollapsed ? 'Expand' : 'Collapse'} all ${this.methodBlockIds.length} methods in the log`;
    }

    toggleAllMethods() {
        if (!this.methodBlockIds.length || this.searchText || this.onlyUserDebug) return;
        const allCollapsed = this.virtualState.collapsedBlocks.size === this.methodBlockIds.length;
        this.virtualState.collapsedBlocks = new Set(allCollapsed ? [] : this.methodBlockIds);
        this.revealedLogIndex = null;
        this.invalidateRows();
        this.viewport.scrollTop = 0;
        this.renderVisibleRows();
        this.saveState();
    }

    renderVariableCell(cell, row) {
        const variable = row.variable;
        cell.classList.add('variable-cell');
        const content = document.createElement('span');
        content.className = 'variable-content';
        const append = (text, className, title) => {
            const span = document.createElement('span');
            span.className = className;
            span.textContent = text;
            if (title) span.title = title;
            content.appendChild(span);
        };
        if (variable.type) append(variable.type, 'variable-type', `${variable.type}\nReference: ${variable.reference}\nStatic: ${variable.static}`);
        append(variable.name, 'variable-name');
        if (variable.declaration) append('No value recorded', 'variable-unrecorded');
        else {
            append('=', 'variable-operator');
            const previous = this.virtualState.allRows[variable.previousIndex];
            if (previous?.variable) {
                append(this.variablePreview(previous.variable.value, 60), 'variable-previous', `Previous recorded value · log line ${previous.idx + 1}\n${previous.variable.value}`);
                append('→', 'variable-operator');
            }
            append(this.variablePreview(variable.value), `variable-value value-${variable.kind}`, variable.value);
            if (variable.partial) append('Partial', 'variable-partial', 'Salesforce truncated part of this value.');
        }
        cell.appendChild(content);
        const inspect = document.createElement('button');
        inspect.type = 'button';
        inspect.className = 'variable-inspect log-action';
        inspect.textContent = variable.kind === 'object' || variable.kind === 'array' ? '▸ Inspect' : 'Inspect';
        inspect.setAttribute('aria-label', `Inspect variable ${variable.name} at log line ${row.idx + 1}`);
        inspect.setAttribute('aria-haspopup', 'dialog');
        inspect.onclick = () => this.inspectVariable(row);
        cell.appendChild(inspect);
    }

    variablePreview(value, limit = 140) {
        const text = value.replace(/\r?\n/g, ' ↵ ');
        return text.length > limit ? `${text.slice(0, limit)}…` : text;
    }

    inspectVariable(row) {
        const variable = row.variable;
        this.inspectedVariableIndex = row.idx;
        document.getElementById('variable-dialog-title').textContent = variable.name;
        document.getElementById('variable-dialog-meta').textContent = [variable.type || 'Type not recorded',
            `Log line ${row.idx + 1}`, row.lineNumber ? `Apex line ${row.lineNumber}` : '',
            typeof variable.reference === 'boolean' ? `Reference: ${variable.reference} · Static: ${variable.static}` : '',
            variable.address ? `Address: ${variable.address}` : ''].filter(Boolean).join(' · ');
        const notice = document.getElementById('variable-dialog-notice');
        notice.hidden = !variable.partial;
        notice.textContent = variable.partial ? 'Partial value: Salesforce omitted some content. Only the recorded data is shown.' : '';
        const container = document.getElementById('variable-dialog-value');
        container.replaceChildren();
        const previous = this.virtualState.allRows[variable.previousIndex];
        const addValue = (label, value, kind) => {
            const section = document.createElement('section');
            const heading = document.createElement('h3');
            heading.textContent = label;
            const pre = document.createElement('pre');
            pre.className = `value-${kind}`;
            pre.textContent = this.formatVariableValue(value);
            section.append(heading, pre);
            container.appendChild(section);
        };
        if (previous?.variable) addValue(`Previous recorded value · log line ${previous.idx + 1}`, previous.variable.value, previous.variable.kind);
        addValue(variable.declaration ? 'Declaration' : 'Recorded value', variable.declaration ? 'No value recorded' : variable.value, variable.kind || 'text');
        document.getElementById('variable-dialog-raw').textContent = row.raw;
        this.variableDialog.querySelector('.variable-raw').open = false;
        document.getElementById('variable-copy-status').textContent = '';
        if (!this.variableDialog.open) this.variableDialog.showModal();
    }

    formatVariableValue(value) {
        if (!/^[\[{]/.test(value) || value.length > 100000) return value;
        try { JSON.parse(value); } catch { return value; }
        // Format the original characters, not JSON.stringify(JSON.parse(...)):
        // Apex Long/Decimal literals must retain all their digits.
        let result = '', depth = 0, quoted = false, escaped = false;
        for (let index = 0; index < value.length; index++) {
            const char = value[index];
            if (quoted) {
                result += char;
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') quoted = false;
            } else if (char === '"') { quoted = true; result += char; }
            else if (char === '{' || char === '[') {
                // Deep machine-generated payloads stay raw to bound formatting cost.
                if (++depth > 40) return value;
                result += `${char}\n${'  '.repeat(depth)}`;
            } else if (char === '}' || char === ']') result += `\n${'  '.repeat(--depth)}${char}`;
            else if (char === ',') result += `,\n${'  '.repeat(depth)}`;
            else if (char === ':') result += ': ';
            else if (!/\s/.test(char)) result += char;
        }
        return result;
    }

    scrollToLogIndex(logIndex) {
        const row = this.virtualState.allRows[logIndex];
        if (!row) return;
        const returnTop = this.revealedLogIndex === null ? this.viewport.scrollTop : this.revealReturnScrollTop;
        this.revealedLogIndex = null;
        this.invalidateRows();
        let rows = this.getVisibleRows();
        let index = rows.findIndex(item => item.idx === logIndex);
        if (index < 0) {
            this.revealedLogIndex = logIndex;
            this.revealReturnScrollTop = returnTop;
            this.invalidateRows();
            rows = this.getVisibleRows();
            index = rows.findIndex(item => item.idx === logIndex);
        }
        this.selectedLogIndex = logIndex;
        this.renderVisibleRows();
        this.viewport.scrollTop = index * this.ROW_HEIGHT;
        this.renderVisibleRows();
        this.saveState();
    }

    clearReveal() {
        this.revealedLogIndex = null;
        this.invalidateRows();
        this.renderVisibleRows();
        this.viewport.scrollTop = this.revealReturnScrollTop;
        this.renderVisibleRows();
        this.saveState();
    }

    initializeColumns() {
        for (const handle of document.querySelectorAll('.column-resize')) {
            const index = Number(handle.dataset.column);
            const resize = width => {
                this.columnWidths[index] = Math.min(2400, Math.max(this.COLUMN_MINIMUMS[index], Math.round(width)));
                this.updateColumns();
            };
            handle.onpointerdown = event => {
                if (event.button !== 0) return;
                event.preventDefault();
                const x = event.clientX;
                const width = this.columnWidths[index];
                handle.setPointerCapture(event.pointerId);
                handle.onpointermove = move => resize(width + move.clientX - x);
                handle.onlostpointercapture = () => {
                    handle.onpointermove = null;
                    this.saveState();
                };
            };
            handle.onkeydown = event => {
                if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                event.preventDefault();
                resize(this.columnWidths[index] + (event.key === 'ArrowRight' ? 16 : -16));
                this.saveState();
            };
        }
    }

    updateColumns() {
        const widths = this.columnWidths.slice();
        widths[4] = Math.max(widths[4], this.viewport.clientWidth - widths.slice(0, 4).reduce((sum, width) => sum + width, 0));
        this.table.style.setProperty('--log-columns', widths.map(width => `${width}px`).join(' '));
        this.table.style.setProperty('--log-table-width', `${widths.reduce((sum, width) => sum + width, 0)}px`);
        this.header.style.width = `${this.viewport.clientWidth}px`;
        this.header.scrollLeft = this.viewport.scrollLeft;
        for (const handle of document.querySelectorAll('.column-resize')) handle.setAttribute('aria-valuenow', String(this.columnWidths[Number(handle.dataset.column)]));
    }

    initializeExecutionMap() {
        const ids = ['panel', 'toggle', 'summary', 'back', 'content', 'scroll', 'timeline', 'axis', 'blocks',
            'debug-markers', 'error-markers', 'empty', 'lanes', 'legend', 'breadcrumb', 'zoom-label',
            'previous-issue', 'next-issue', 'focus', 'go-start', 'go-end', 'selection-title', 'selection-meta', 'resize'];
        const e = this.mapElements = Object.fromEntries(ids.map(id => [id, document.getElementById(`execution-${id}`)]));
        const state = this.executionMapState;
        e.toggle.onclick = () => {
            state.collapsed = !state.collapsed;
            this.renderExecutionMap();
            this.saveState();
        };
        e.back.onclick = () => this.setExecutionScope(state.viewStack.slice(0, -1));
        document.getElementById('execution-zoom-out').onclick = () => this.zoomExecution(0.5);
        document.getElementById('execution-zoom-in').onclick = () => this.zoomExecution(2);
        document.getElementById('execution-fit').onclick = () => {
            state.zoom = 1;
            state.scrollLeft = 0;
            this.renderExecutionMap();
            this.saveState();
        };
        e['previous-issue'].onclick = () => this.navigateExecutionIssue(-1);
        e['next-issue'].onclick = () => this.navigateExecutionIssue(1);
        e.focus.onclick = () => this.focusExecutionSpan(state.selectedSpanId);
        e['go-start'].onclick = () => {
            const span = state.model?.spans[state.selectedSpanId];
            this.scrollToLogIndex(span ? span.startIndex : state.selectedMarkerIndex);
        };
        e['go-end'].onclick = () => {
            const span = state.model?.spans[state.selectedSpanId];
            if (span && !span.incomplete && span.endIndex !== null) this.scrollToLogIndex(span.endIndex);
        };
        for (const [kind, label] of Object.entries(EXECUTION_TYPES)) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'execution-type';
            button.dataset.kind = kind;
            button.title = `Show or hide ${label.toLowerCase()} in the timeline`;
            button.onclick = () => {
                if (state.hiddenKinds.has(kind)) state.hiddenKinds.delete(kind);
                else state.hiddenKinds.add(kind);
                this.renderExecutionMap();
                this.saveState();
            };
            e.legend.appendChild(button);
        }
        e.scroll.addEventListener('scroll', () => {
            if (state.collapsed) return;
            state.scrollLeft = e.scroll.scrollLeft;
            state.scrollTop = e.scroll.scrollTop;
            if (!this.timelineFrame) this.timelineFrame = requestAnimationFrame(() => {
                this.timelineFrame = null;
                this.renderExecutionTimeline();
            });
            this.scheduleSave();
        }, { passive: true });
        e.scroll.addEventListener('wheel', event => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            this.zoomExecution(event.deltaY < 0 ? 2 : 0.5, event.clientX - e.scroll.getBoundingClientRect().left);
        }, { passive: false });
        e.scroll.addEventListener('keydown', event => this.executionKeyDown(event));
        e.resize.onpointerdown = event => {
            if (event.button !== 0 || state.collapsed) return;
            event.preventDefault();
            const startY = event.clientY;
            const height = e.panel.getBoundingClientRect().height;
            e.resize.setPointerCapture(event.pointerId);
            e.resize.onpointermove = move => {
                state.height = this.clampExecutionHeight(height + move.clientY - startY);
                this.updateExecutionHeight();
            };
            e.resize.onlostpointercapture = () => {
                e.resize.onpointermove = null;
                this.saveState();
            };
        };
        e.resize.onkeydown = event => {
            if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
            event.preventDefault();
            state.height = this.clampExecutionHeight(event.key === 'Home' ? 360 : e.panel.getBoundingClientRect().height + (event.key === 'ArrowUp' ? -20 : 20));
            this.updateExecutionHeight();
            this.saveState();
        };
    }

    clampExecutionHeight(height) {
        const minimum = window.innerWidth <= 600 ? 240 : 220;
        return Math.round(Math.min(Math.max(minimum, window.innerHeight - 170), Math.max(minimum, Math.min(700, height))));
    }

    updateExecutionHeight() {
        const e = this.mapElements;
        e.panel.style.height = this.executionMapState.collapsed ? 'auto' : `${this.clampExecutionHeight(this.executionMapState.height)}px`;
        e.resize.setAttribute('aria-valuenow', String(this.clampExecutionHeight(this.executionMapState.height)));
        e.resize.setAttribute('aria-valuemin', String(window.innerWidth <= 600 ? 240 : 220));
        e.resize.setAttribute('aria-valuemax', String(this.clampExecutionHeight(700)));
    }

    getExecutionScope() {
        const model = this.executionMapState.model;
        if (!model) return null;
        const selected = model.spans[this.executionMapState.viewStack.at(-1)];
        if (this.executionScope?.model === model && this.executionScope.selected === selected) return this.executionScope;
        // Source ranges, rather than timestamps, keep adjacent events with the
        // same elapsed time out of a focused call's counts and issue navigation.
        const inScope = index => !selected || (index >= selected.startIndex && index <= selected.lastIndex);
        const spans = selected ? model.spans.filter(span => inScope(span.startIndex)) : model.spans;
        const markers = selected ? model.markers.filter(marker => inScope(marker.index)) : model.markers;
        const start = selected ? selected.startTime : model.startTime;
        const end = selected ? selected.endTime : model.endTime;
        const counts = { debug: 0, fatal: 0, error: 0, exception: 0, fault: 0 };
        const kinds = Object.fromEntries(Object.keys(EXECUTION_TYPES).map(kind => [kind, 0]));
        for (const marker of markers) counts[marker.kind]++;
        for (const span of spans) kinds[span.kind]++;
        return this.executionScope = { model, selected, spans, markers, start, end, duration: Math.max(1, end - start),
            baseDepth: selected?.depth || 0, counts, kinds, issues: markers.filter(marker => marker.kind !== 'debug') };
    }

    setExecutionScope(path) {
        const state = this.executionMapState;
        state.viewStack = path;
        state.zoom = 1;
        state.scrollLeft = 0;
        state.scrollTop = 0;
        state.selectedSpanId = path.at(-1) ?? null;
        state.selectedMarkerIndex = null;
        this.renderExecutionMap();
        this.saveState();
    }

    focusExecutionSpan(id) {
        let span = this.executionMapState.model?.spans[id];
        if (!span) return;
        const path = [];
        while (span) {
            path.push(span.id);
            span = this.executionMapState.model.spans[span.parentId];
        }
        this.setExecutionScope(path.reverse());
    }

    zoomExecution(factor, anchor = this.mapElements.scroll.clientWidth / 2) {
        const state = this.executionMapState;
        const zoom = Math.min(16, Math.max(1, state.zoom * factor));
        if (zoom === state.zoom) return;
        state.scrollLeft = (state.scrollLeft + anchor) * zoom / state.zoom - anchor;
        state.zoom = zoom;
        this.renderExecutionMap();
        this.saveState();
    }

    selectExecutionSpan(id) {
        const state = this.executionMapState;
        const span = state.model.spans[id];
        if (!span) return;
        state.selectedSpanId = id;
        state.selectedMarkerIndex = null;
        this.updateExecutionSelection();
        this.scrollToLogIndex(span.startIndex);
    }

    selectExecutionMarker(marker) {
        this.executionMapState.selectedSpanId = null;
        this.executionMapState.selectedMarkerIndex = marker.index;
        this.updateExecutionSelection();
        this.scrollToLogIndex(marker.index);
    }

    navigateExecutionIssue(direction) {
        const scope = this.getExecutionScope();
        if (!scope?.issues.length) return;
        const index = this.selectedLogIndex ?? (direction > 0 ? -1 : Infinity);
        const marker = direction > 0 ? (scope.issues.find(item => item.index > index) || scope.issues[0])
            : (scope.issues.findLast(item => item.index < index) || scope.issues.at(-1));
        const state = this.executionMapState;
        state.collapsed = false;
        state.scrollTop = 0;
        state.scrollLeft = Math.max(0, (marker.time - scope.start) / scope.duration * this.mapElements.scroll.clientWidth * state.zoom - this.mapElements.scroll.clientWidth / 2);
        this.renderExecutionMap();
        this.selectExecutionMarker(marker);
    }

    executionKeyDown(event) {
        const state = this.executionMapState;
        if (!state.model || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(event.key)) return;
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        if (event.key === 'Enter' && event.target !== this.mapElements.scroll) return; // Native button activation.
        event.preventDefault();
        if (event.key === 'Escape') return this.setExecutionScope(state.viewStack.slice(0, -1));
        if (event.key === 'Enter') return this.focusExecutionSpan(state.selectedSpanId);
        const spans = this.getExecutionScope().spans.filter(span => !state.hiddenKinds.has(span.kind));
        const selected = state.model.spans[state.selectedSpanId];
        const index = spans.findIndex(span => span.id === state.selectedSpanId);
        let target;
        if (event.key === 'ArrowLeft') target = spans[index < 0 ? spans.length - 1 : Math.max(0, index - 1)];
        if (event.key === 'ArrowRight') target = spans[Math.min(spans.length - 1, index + 1)];
        if (event.key === 'ArrowUp') target = spans.find(span => span.id === selected?.parentId);
        if (event.key === 'ArrowDown') target = spans.find(span => span.parentId === selected?.id) || spans[0];
        if (!target) return;
        this.selectExecutionSpan(target.id);
        const scope = this.getExecutionScope();
        state.scrollTop = Math.max(0, 72 + (target.depth - scope.baseDepth) * 26 - this.mapElements.scroll.clientHeight / 2);
        state.scrollLeft = Math.max(0, (target.startTime - scope.start) / scope.duration * this.mapElements.scroll.clientWidth * state.zoom - this.mapElements.scroll.clientWidth / 3);
        this.renderExecutionTimeline();
        this.mapElements.scroll.focus({ preventScroll: true });
        this.saveState();
    }

    // Merge tiny spans only within the same depth and type. Even a grouped
    // parent remains selectable and focusable through the inspector.
    groupTimelineItems(items, start, duration, width, time, kind, bucketSize = 10) {
        const groups = new Map();
        for (const item of items) {
            const position = Math.max(0, Math.min(Math.max(0, width - 8), (time(item) - start) / duration * width));
            const key = `${kind(item)}:${Math.floor(position / bucketSize)}`;
            if (!groups.has(key)) groups.set(key, { key, kind: kind(item), position, items: [] });
            groups.get(key).items.push(item);
        }
        // Two events on opposite sides of a bucket boundary can still overlap.
        const merged = [];
        const previousByKind = new Map();
        for (const group of [...groups.values()].sort((a, b) => a.position - b.position)) {
            const previous = previousByKind.get(group.kind);
            if (previous && group.position - previous.position < bucketSize) previous.items.push(...group.items);
            else {
                merged.push(group);
                previousByKind.set(group.kind, group);
            }
        }
        return merged;
    }

    renderExecutionMap() {
        const state = this.executionMapState;
        const scope = this.getExecutionScope();
        const e = this.mapElements;
        if (!scope || !e) return;
        const summary = `${scope.model.hasClock ? this.formatExecutionDuration(scope.end - scope.start) : 'Timing unavailable'} · ${scope.spans.length.toLocaleString()} calls · ${scope.counts.debug.toLocaleString()} debug`;
        e.summary.textContent = summary;
        e.summary.title = summary;
        e.panel.classList.toggle('is-collapsed', state.collapsed);
        e.panel.setAttribute('aria-expanded', String(!state.collapsed));
        e.toggle.setAttribute('aria-expanded', String(!state.collapsed));
        e.toggle.setAttribute('aria-label', state.collapsed ? 'Expand execution flow' : 'Collapse execution flow');
        e.toggle.title = e.toggle.getAttribute('aria-label');
        e.content.hidden = state.collapsed;
        e.resize.hidden = state.collapsed;
        this.updateExecutionHeight();
        e.back.disabled = !scope.selected;
        e['zoom-label'].textContent = `${state.zoom}×`;
        document.getElementById('execution-zoom-out').disabled = state.zoom <= 1 || !scope.model.hasClock;
        document.getElementById('execution-zoom-in').disabled = state.zoom >= 16 || !scope.model.hasClock;
        e['previous-issue'].disabled = e['next-issue'].disabled = !scope.issues.length;
        e['next-issue'].textContent = scope.issues.length ? `${scope.issues.length} issue${scope.issues.length === 1 ? '' : 's'} ↓` : 'No issues';
        e['next-issue'].setAttribute('aria-label', `Next issue (${scope.issues.length} in this scope)`);
        e['next-issue'].title = `${scope.counts.fatal} fatal · ${scope.counts.error} Flow errors · ${scope.counts.exception} exceptions · ${scope.counts.fault} Flow fault paths. Click to navigate.`;
        e.breadcrumb.replaceChildren();
        for (const id of [null, ...state.viewStack]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'execution-crumb';
            button.textContent = id === null ? 'Full execution' : scope.model.spans[id].label;
            button.title = button.textContent;
            button.setAttribute('aria-current', String(id === (scope.selected?.id ?? null)));
            button.onclick = () => this.setExecutionScope(id === null ? [] : state.viewStack.slice(0, state.viewStack.indexOf(id) + 1));
            e.breadcrumb.appendChild(button);
        }
        e.breadcrumb.scrollLeft = e.breadcrumb.scrollWidth;
        for (const button of e.legend.children) {
            const kind = button.dataset.kind;
            button.textContent = `${EXECUTION_TYPES[kind]} ${scope.kinds[kind]}`;
            button.setAttribute('aria-pressed', String(!state.hiddenKinds.has(kind)));
            button.disabled = !scope.kinds[kind];
        }
        this.renderExecutionTimeline();
        this.updateExecutionSelection();
    }

    renderExecutionTimeline() {
        const state = this.executionMapState;
        const e = this.mapElements;
        const scope = this.getExecutionScope();
        if (!scope || !e || state.collapsed || !e.scroll.clientWidth) return;
        const width = Math.max(1, Math.round(e.scroll.clientWidth * state.zoom));
        const visible = scope.spans.filter(span => !state.hiddenKinds.has(span.kind));
        const maxDepth = visible.reduce((depth, span) => Math.max(depth, span.depth - scope.baseDepth), 0);
        const height = Math.max(e.scroll.clientHeight, 78 + (maxDepth + 1) * 26);
        e.timeline.style.width = `${width}px`;
        e.timeline.style.height = `${height}px`;
        e.scroll.scrollLeft = Math.max(0, state.scrollLeft);
        e.scroll.scrollTop = Math.max(0, state.scrollTop);
        state.scrollLeft = e.scroll.scrollLeft;
        state.scrollTop = e.scroll.scrollTop;
        const focusKey = e.timeline.contains(document.activeElement) ? document.activeElement.dataset.group : null;
        e.axis.replaceChildren();
        e.blocks.replaceChildren();
        e['debug-markers'].replaceChildren();
        e['error-markers'].replaceChildren();
        e.lanes.replaceChildren();
        e.empty.hidden = scope.model.hasClock && (visible.length > 0 || scope.markers.length > 0);
        e.empty.textContent = !this.virtualState.allRows.length ? 'This log is empty.'
            : !scope.model.hasClock ? 'Timing is unavailable: this log has no elapsed timestamps.'
            : scope.spans.length ? 'Enable an operation type above to see its calls.' : 'No timed calls or debug events in this log.';
        if (!scope.model.hasClock) return;
        // Absolute offsets from full execution keep time labels meaningful when focused.
        const tickCount = Math.max(2, Math.floor(e.scroll.clientWidth / 130));
        const step = scope.duration / state.zoom / tickCount;
        const leftTime = scope.start + state.scrollLeft / width * scope.duration;
        const firstTick = Math.max(0, Math.floor((leftTime - scope.start) / step));
        for (let i = firstTick; i <= firstTick + tickCount + 1; i++) {
            const offset = Math.min(scope.duration, i * step);
            const tick = document.createElement('span');
            tick.className = 'execution-tick';
            tick.style.left = `${offset / scope.duration * width}px`;
            tick.textContent = this.formatExecutionDuration(scope.start - scope.model.startTime + offset);
            e.axis.appendChild(tick);
            if (offset === scope.duration) { tick.style.transform = 'translateX(-100%)'; break; }
        }
        const addLane = (label, top, className = '') => {
            const element = document.createElement('span');
            element.className = `execution-lane-label ${className}`;
            element.textContent = label;
            element.style.top = `${top - state.scrollTop}px`;
            e.lanes.appendChild(element);
        };
        addLane('Debug', 28, 'debug-lane');
        addLane('Issues', 48, 'issue-lane');
        const top = state.scrollTop;
        const bottom = top + e.scroll.clientHeight;
        for (let depth = Math.max(0, Math.floor((top - 72) / 26)); depth <= maxDepth && 72 + depth * 26 < bottom; depth++) {
            addLane(`L${depth + scope.baseDepth + 1}`, 76 + depth * 26);
        }
        const timeLeft = scope.start + state.scrollLeft / width * scope.duration;
        const timeRight = scope.start + (state.scrollLeft + e.scroll.clientWidth) / width * scope.duration;
        const candidates = visible.filter(span => {
            const y = 72 + (span.depth - scope.baseDepth) * 26;
            return y + 24 >= top && y <= bottom && span.endTime >= timeLeft && span.startTime <= timeRight;
        });
        const blockKind = span => span.duration / scope.duration * width >= 10 ? `span-${span.id}` : `${span.depth}-${span.kind}`;
        for (const group of this.groupTimelineItems(candidates, scope.start, scope.duration, width, span => span.startTime, blockKind)) {
            const selected = group.items.find(span => span.id === state.selectedSpanId);
            const span = selected || group.items[0];
            const end = group.items.reduce((latest, item) => Math.max(latest, item.endTime), span.endTime);
            const blockWidth = Math.min(width - group.position, Math.max(8, (end - group.items[0].startTime) / scope.duration * width));
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'execution-block';
            button.dataset.kind = span.kind;
            button.dataset.group = `span:${group.key}`;
            button.dataset.spanId = String(span.id);
            button.executionSpans = group.items;
            button.style.left = `${group.position}px`;
            button.style.top = `${72 + (span.depth - scope.baseDepth) * 26}px`;
            button.style.width = `${blockWidth}px`;
            if (blockWidth >= 64) {
                // Keep labels readable when panning across a long parent call.
                button.style.paddingLeft = `${Math.min(blockWidth - 12, Math.max(5, state.scrollLeft - group.position + 5))}px`;
                button.style.paddingRight = '5px';
            }
            button.classList.toggle('is-incomplete', group.items.some(item => item.incomplete));
            const label = group.items.length > 1 ? `${group.items.length} ${EXECUTION_TYPES[span.kind].toLowerCase()} calls; click to cycle, then Focus to inspect a call`
                : `${span.label} · ${this.formatExecutionDuration(span.duration)} · log line ${span.startIndex + 1}${span.incomplete ? ' · incomplete' : ''}. Double-click to focus.`;
            button.title = label;
            button.setAttribute('aria-label', label);
            button.textContent = blockWidth >= 64 ? (group.items.length > 1 ? `${group.items.length} calls` : `${span.label}  ${this.formatExecutionDuration(span.duration)}`) : '';
            button.onclick = () => {
                const next = (group.items.findIndex(item => item.id === state.selectedSpanId) + 1) % group.items.length;
                this.selectExecutionSpan(group.items[next].id);
            };
            button.ondblclick = () => this.focusExecutionSpan(state.selectedSpanId);
            e.blocks.appendChild(button);
        }
        // Debug and issues have separate lanes. Mixed issue clusters retain all
        // severities instead of drawing overlapping, unreachable buttons.
        const markers = scope.markers.filter(marker => marker.time >= timeLeft && marker.time <= timeRight);
        for (const group of this.groupTimelineItems(markers, scope.start, scope.duration, width, marker => marker.time, marker => marker.kind === 'debug' ? 'debug' : 'issue', 28)) {
            const priority = { debug: 0, fault: 1, exception: 2, error: 3, fatal: 4 };
            const marker = group.items.reduce((worst, item) => priority[item.kind] > priority[worst.kind] ? item : worst);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'execution-marker';
            button.dataset.severity = marker.kind;
            button.dataset.group = `marker:${group.key}`;
            button.executionMarkers = group.items;
            button.style.left = `${group.position}px`;
            button.style.top = marker.kind === 'debug' ? '28px' : '48px';
            button.textContent = group.items.length > 1 ? String(group.items.length) : (marker.kind === 'debug' ? '•' : '!');
            const label = group.items.length > 1 ? `${group.items.length} events; click to cycle through log lines` : `${marker.eventType}: ${marker.label} · log line ${marker.index + 1}`;
            button.title = label;
            button.setAttribute('aria-label', label);
            button.onclick = () => {
                const next = (group.items.findIndex(item => item.index === state.selectedMarkerIndex) + 1) % group.items.length;
                this.selectExecutionMarker(group.items[next]);
                button.title = `${label}\nSelected ${next + 1}/${group.items.length}: ${group.items[next].eventType}`;
            };
            (marker.kind === 'debug' ? e['debug-markers'] : e['error-markers']).appendChild(button);
        }
        this.updateExecutionSelection();
        if (focusKey) [...e.timeline.querySelectorAll('button')].find(button => button.dataset.group === focusKey)?.focus({ preventScroll: true });
    }

    updateExecutionSelection() {
        const state = this.executionMapState;
        const e = this.mapElements;
        const scope = this.getExecutionScope();
        if (!scope || !e) return;
        const span = state.model.spans[state.selectedSpanId];
        const marker = state.selectedMarkerIndex === null ? null : state.model.markers.find(item => item.index === state.selectedMarkerIndex);
        for (const button of e.blocks.children) {
            const selected = button.executionSpans?.find(item => item.id === state.selectedSpanId);
            button.classList.toggle('is-selected', !!selected);
            button.setAttribute('aria-pressed', String(!!selected));
            if (selected) button.dataset.spanId = String(selected.id);
        }
        for (const button of [...e['debug-markers'].children, ...e['error-markers'].children]) {
            const selected = button.executionMarkers?.some(item => item.index === state.selectedMarkerIndex);
            button.classList.toggle('is-selected', !!selected);
            button.setAttribute('aria-pressed', String(!!selected));
        }
        e.focus.disabled = !span;
        e['go-start'].disabled = !span && !marker;
        e['go-end'].disabled = !span || span.endIndex === null || span.incomplete;
        e['go-end'].title = span?.incomplete ? 'The matching end event is missing from this log' : 'Go to the matching end event';
        e['selection-title'].textContent = span ? span.label : marker ? `${marker.eventType} · ${marker.label}` : 'Select an operation or event';
        e['selection-title'].title = span ? this.virtualState.allRows[span.startIndex]?.details || span.label : marker?.label || '';
        const timing = scope.model.hasClock;
        e['selection-meta'].textContent = span
            ? `${span.incomplete ? 'Incomplete · observed' : 'Total'} ${timing ? this.formatExecutionDuration(span.duration) : '—'} · Self ${timing ? this.formatExecutionDuration(span.selfDuration) : '—'} · ${timing ? `${(Math.min(1, span.duration / scope.duration) * 100).toFixed(1)}% of scope · ` : ''}Log ${span.startIndex + 1}${span.endIndex === null || span.incomplete ? ' → ?' : `–${span.endIndex + 1}`}`
            : marker ? `${timing ? `${this.formatExecutionDuration(marker.time - scope.model.startTime)} from start · ` : ''}Log line ${marker.index + 1}`
                : 'Inspect timing and jump to the original log line. Filters are preserved.';
        e['selection-meta'].title = 'Total and Self are elapsed time. Self excludes nested calls; neither value represents CPU time.';
    }

    formatExecutionDuration(nanoseconds) {
        if (!Number.isFinite(nanoseconds)) return '—';
        const value = Math.max(0, nanoseconds);
        if (value >= 1000000000) return `${(value / 1000000000).toFixed(2)}s`;
        if (value >= 1000000) return `${(value / 1000000).toFixed(1)}ms`;
        if (value >= 1000) return `${(value / 1000).toFixed(1)}μs`;
        return `${Math.round(value)}ns`;
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { ApexLogDetails };
else new ApexLogDetails();
