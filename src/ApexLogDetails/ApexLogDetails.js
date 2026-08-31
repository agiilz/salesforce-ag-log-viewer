class ApexLogDetails {
    constructor() {
        this.vscode = acquireVsCodeApi();
        this.logLines = [];
        this.BUFFER_SIZE = 100;
        // Keep this in sync with --row-height in ApexLogDetails.css. The old
        // value (22px) made virtual scrolling drift from the rendered rows.
        this.ROW_HEIGHT = 24;
        this.COLUMN_WIDTHS = ['17px', '60px', '150px', '30px', 'auto'];
        this.MAP_MIN_WIDTH = 760;
        this.MAP_MAX_ZOOM = 4;
        this.MAP_MIN_ZOOM = 0.5;
        this.virtualState = {
            allRows: [],
            collapsedBlocks: new Set(),
            lastScrollTop: 0
        };
        this.searchText = '';
        this.selectedLogIndex = null;
        this.executionMapState = {
            model: null,
            collapsed: false,
            zoom: 1,
            viewStack: [],
            scrollLeft: 0,
            elements: null
        };
        this.init();
    }

    /*
     * Parse a Salesforce log once. The rows retain the existing table model,
     * while the same pass also builds a small span model for the execution
     * map. Map data is deliberately collected before table filters are
     * applied, so Debug only never changes the execution context.
     */
    parseLogLines(logLines, hideHeapAllocate, onlyUserDebug) {
        let methodBlockId = 0;
        const methodStack = [];
        const rows = [];
        const executionMap = this.createExecutionMapModel();
        let fallbackTime = 0;

        for (let idx = 0; idx < logLines.length; idx++) {
            const line = logLines[idx];
            if (/Execute Anonymous:/i.test(line)) continue;

            const parts = line.split('|');
            let timestampRaw = '';
            let eventType = '';
            let details = '';

            if (parts.length === 1) {
                details = parts[0];
            } else if (parts.length === 2) {
                timestampRaw = parts[0];
                eventType = parts[1];
            } else {
                timestampRaw = parts[0];
                eventType = parts[1];
                details = parts.slice(2).join(' | ');
            }

            timestampRaw = timestampRaw.trim();
            eventType = eventType.trim();
            details = details.trim();

            const elapsedMatch = timestampRaw.match(/\((\d+)\)\s*$/);
            const parsedElapsed = elapsedMatch ? Number(elapsedMatch[1]) : NaN;
            // Salesforce's parenthesized elapsed value is measured in
            // nanoseconds from the start of the request.
            const elapsedNanoseconds = Number.isFinite(parsedElapsed) ? parsedElapsed : fallbackTime;
            if (Number.isFinite(parsedElapsed)) {
                fallbackTime = parsedElapsed;
                executionMap.hasClock = true;
            } else {
                fallbackTime += 1;
            }

            let timestamp = timestampRaw
                .replace(/\.\d+/, '')
                .replace(/\s*\(\d+\)$/, '')
                .trim();
            if (!timestamp && timestampRaw) timestamp = timestampRaw;

            details = details.replace(/\s*\|\s*DEBUG\s*\|\s*/g, ' | ');
            const lineMatch = details.match(/^\s*\[(\d+)\]/);
            let lineNumber = '';
            if (lineMatch) {
                lineNumber = `[${lineMatch[1]}]`;
                details = details.replace(/^\s*\[\d+\]\s*\|?\s*/, '');
            }

            const event = {
                idx,
                timestamp,
                elapsedNanoseconds,
                eventType,
                details,
                lineNumber
            };
            this.consumeExecutionEvent(executionMap, event);

            // Preserve the existing table filters exactly. The execution map
            // above intentionally remains complete when either filter is on.
            if (hideHeapAllocate && eventType === 'HEAP_ALLOCATE') continue;
            if (onlyUserDebug && eventType !== 'USER_DEBUG') continue;

            // In Debug only mode method folding is not added, matching the
            // previous behavior while keeping the map available as context.
            if (onlyUserDebug) {
                rows.push({
                    idx,
                    timestamp,
                    eventType,
                    details,
                    blockId: null,
                    type: 'normal',
                    lineNumber
                });
                continue;
            }

            if (eventType === 'METHOD_ENTRY') {
                const depth = methodStack.length;
                methodBlockId++;
                methodStack.push({ id: methodBlockId, start: idx });
                rows.push({ idx, timestamp, eventType, details, blockId: methodBlockId, type: 'entry', lineNumber, depth });
            } else if (eventType === 'METHOD_EXIT' && methodStack.length > 0) {
                const block = methodStack.pop();
                const depth = methodStack.length;
                if (block) {
                    rows.push({ idx, timestamp, eventType, details, blockId: block.id, type: 'exit', lineNumber, depth });
                }
            } else {
                const parentBlock = methodStack.length > 0 ? methodStack[methodStack.length - 1].id : null;
                const depth = methodStack.length;
                rows.push({ idx, timestamp, eventType, details, blockId: parentBlock, type: parentBlock ? 'inner' : 'normal', lineNumber, depth });
            }
        }

        this.finishExecutionMapModel(executionMap, fallbackTime, logLines.length);
        return { rows, executionMap };
    }

    createExecutionMapModel() {
        return {
            spans: [],
            rootIds: [],
            openSpans: [],
            openByFamily: Object.create(null),
            markers: [],
            startTime: null,
            endTime: 0,
            hasClock: false
        };
    }

    getExecutionStartDescriptor(eventType, details) {
        if (eventType === 'CODE_UNIT_STARTED') {
            return { family: 'codeUnit', kind: 'unit', label: this.executionLabel(details, eventType) };
        }
        if (eventType === 'METHOD_ENTRY') {
            return { family: 'method', kind: 'method', label: this.executionLabel(details, eventType) };
        }
        if (eventType === 'SYSTEM_METHOD_ENTRY') {
            return { family: 'systemMethod', kind: 'system', label: this.executionLabel(details, eventType) };
        }
        if (eventType === 'CONSTRUCTOR_ENTRY') {
            return { family: 'constructor', kind: 'method', label: this.executionLabel(details, eventType) };
        }
        if (eventType === 'SOQL_EXECUTE_BEGIN') {
            return { family: 'soql', kind: 'soql', label: this.executionLabel(details, eventType) };
        }
        if (eventType === 'SOSL_EXECUTE_BEGIN') {
            return { family: 'sosl', kind: 'soql', label: this.executionLabel(details, eventType) };
        }
        if (eventType === 'DML_BEGIN') {
            return { family: 'dml', kind: 'dml', label: this.executionLabel(details, eventType) };
        }
        if (eventType === 'FLOW_START_INTERVIEW' || eventType === 'FLOW_START_INTERVIEW_BEGIN') {
            return { family: 'flow', kind: 'flow', label: this.executionLabel(details, eventType) };
        }
        if (eventType === 'FLOW_ELEMENT_BEGIN') {
            return { family: 'flowElement', kind: 'flow', label: this.executionLabel(details, eventType) };
        }
        return null;
    }

    getExecutionEndFamily(eventType) {
        if (eventType === 'CODE_UNIT_FINISHED') return 'codeUnit';
        if (eventType === 'METHOD_EXIT') return 'method';
        if (eventType === 'SYSTEM_METHOD_EXIT') return 'systemMethod';
        if (eventType === 'CONSTRUCTOR_EXIT') return 'constructor';
        if (eventType === 'SOQL_EXECUTE_END') return 'soql';
        if (eventType === 'SOSL_EXECUTE_END') return 'sosl';
        if (eventType === 'DML_END') return 'dml';
        if (eventType === 'FLOW_INTERVIEW_FINISHED' || eventType === 'FLOW_START_INTERVIEW_END') return 'flow';
        if (eventType === 'FLOW_ELEMENT_END') return 'flowElement';
        return null;
    }

    consumeExecutionEvent(model, event) {
        const eventTime = Number.isFinite(event.elapsedNanoseconds) ? event.elapsedNanoseconds : 0;
        if (model.startTime === null || eventTime < model.startTime) model.startTime = eventTime;
        if (eventTime > model.endTime) model.endTime = eventTime;

        if (event.eventType === 'EXCEPTION_THROWN' || event.eventType === 'FATAL_ERROR') {
            model.markers.push({
                kind: 'error',
                index: event.idx,
                time: eventTime,
                label: event.details || event.eventType,
                eventType: event.eventType
            });
        } else if (event.eventType === 'USER_DEBUG') {
            model.markers.push({
                kind: 'debug',
                index: event.idx,
                time: eventTime,
                label: event.details || 'USER_DEBUG',
                eventType: event.eventType
            });
        }

        const start = this.getExecutionStartDescriptor(event.eventType, event.details);
        if (start) {
            const parent = model.openSpans.length > 0 ? model.openSpans[model.openSpans.length - 1] : null;
            const span = {
                id: model.spans.length,
                family: start.family,
                kind: start.kind,
                label: start.label || event.eventType,
                eventType: event.eventType,
                startTime: eventTime,
                endTime: null,
                startIndex: event.idx,
                endIndex: null,
                incomplete: false,
                parentId: parent ? parent.id : null,
                children: []
            };
            model.spans.push(span);
            if (parent) parent.children.push(span.id);
            else model.rootIds.push(span.id);
            model.openSpans.push(span);
            if (!model.openByFamily[start.family]) model.openByFamily[start.family] = [];
            model.openByFamily[start.family].push(span);
            return;
        }

        const endFamily = this.getExecutionEndFamily(event.eventType);
        if (endFamily) this.closeExecutionSpan(model, endFamily, eventTime, event.idx);
    }

    closeExecutionSpan(model, family, endTime, endIndex) {
        const familyStack = model.openByFamily[family];
        if (!familyStack || familyStack.length === 0) return;

        const span = familyStack[familyStack.length - 1];
        const openIndex = model.openSpans.lastIndexOf(span);
        if (openIndex < 0) {
            familyStack.pop();
            return;
        }

        // Close malformed/nested spans that are still open above the matching
        // span. This keeps later blocks attached to the correct parent.
        const toClose = model.openSpans.slice(openIndex).reverse();
        toClose.forEach(openSpan => {
            openSpan.endTime = Math.max(openSpan.startTime, endTime);
            openSpan.endIndex = endIndex;
            openSpan.incomplete = openSpan !== span;
            const stack = model.openByFamily[openSpan.family];
            if (stack) {
                const stackIndex = stack.lastIndexOf(openSpan);
                if (stackIndex >= 0) stack.splice(stackIndex, 1);
            }
        });
        model.openSpans.splice(openIndex);
    }

    finishExecutionMapModel(model, fallbackTime, endIndex) {
        const finalTime = Math.max(
            Number.isFinite(model.endTime) ? model.endTime : 0,
            Number.isFinite(fallbackTime) ? fallbackTime : 0
        );
        while (model.openSpans.length > 0) {
            const span = model.openSpans.pop();
            span.endTime = Math.max(span.startTime, finalTime);
            // A log can be truncated before its matching *_FINISHED/EXIT
            // event. Use the last timestamp for drawing, but retain that it
            // has no real end row so the UI never presents it as complete.
            span.endIndex = null;
            span.incomplete = true;
            const familyStack = model.openByFamily[span.family];
            if (familyStack) {
                const stackIndex = familyStack.lastIndexOf(span);
                if (stackIndex >= 0) familyStack.splice(stackIndex, 1);
            }
        }
        if (model.startTime === null) model.startTime = 0;
        model.endTime = Math.max(model.startTime, finalTime);
        model.spans.forEach(span => {
            if (span.endTime === null) span.endTime = model.endTime;
            span.duration = Math.max(0, span.endTime - span.startTime);
        });
    }

    executionLabel(details, eventType) {
        const value = String(details || '').trim();
        const pieces = value.split('|').map(piece => piece.trim()).filter(Boolean);
        const withoutLine = pieces.filter(piece => !/^\[?\d+\]?$/.test(piece));

        if (eventType === 'SOQL_EXECUTE_BEGIN' || eventType === 'SOSL_EXECUTE_BEGIN') {
            const query = withoutLine.find(piece => /\b(SELECT|FIND)\b/i.test(piece));
            const prefix = eventType === 'SOSL_EXECUTE_BEGIN' ? 'SOSL' : 'SOQL';
            return query ? `${prefix} · ${this.truncateLabel(query.replace(/^.*?(?=(SELECT|FIND)\b)/i, ''), 88)}` : `${prefix} query`;
        }
        if (eventType === 'DML_BEGIN') {
            const operation = withoutLine.find(piece => /^Op\s*:/i.test(piece));
            const objectType = withoutLine.find(piece => /^Type\s*:/i.test(piece));
            const operationText = operation ? operation.replace(/^Op\s*:\s*/i, '') : 'operation';
            const objectText = objectType ? objectType.replace(/^Type\s*:\s*/i, '') : '';
            return `DML · ${operationText}${objectText ? ` ${objectText}` : ''}`;
        }
        if (eventType.indexOf('FLOW') === 0) {
            const candidate = withoutLine[withoutLine.length - 1];
            return candidate ? `Flow · ${this.truncateLabel(candidate, 76)}` : 'Flow';
        }

        // Salesforce often puts the durable id before the readable class or
        // trigger name. The last meaningful segment is the useful label.
        const candidate = withoutLine[withoutLine.length - 1] || value;
        return this.truncateLabel(candidate || eventType, 88);
    }

    truncateLabel(value, maxLength) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        if (text.length <= maxLength) return text;
        return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
    }

    renderTable(hideHeapAllocate, onlyUserDebug) {
        const container = document.getElementById('log-table-container');
        const viewport = document.getElementById('virtual-viewport');
        if (!container || !viewport) return;

        const parsed = this.parseLogLines(this.logLines, hideHeapAllocate, onlyUserDebug);
        this.virtualState.allRows = parsed.rows;
        this.executionMapState.model = parsed.executionMap;

        this.ensureExecutionMap();
        this.renderExecutionMap(parsed.executionMap);

        // Establish search state before the first virtual render so reopening
        // the view does not briefly show unfiltered rows.
        const searchInput = document.getElementById('log-search-input');
        if (searchInput) this.searchText = searchInput.value.trim().toLowerCase();

        const headers = document.querySelectorAll('#log-table-header th');
        headers.forEach((header, i) => {
            header.style.width = this.COLUMN_WIDTHS[i];
            header.style.minWidth = this.COLUMN_WIDTHS[i];
        });

        const contentContainer = document.getElementById('content-container');
        contentContainer.innerHTML = '';
        contentContainer.style.height = `${parsed.rows.length * this.ROW_HEIGHT}px`;
        this.renderVisibleRows();

        viewport.removeEventListener('scroll', this.handleScrollBound);
        this.handleScrollBound = this.handleScroll.bind(this);
        viewport.addEventListener('scroll', this.handleScrollBound, { passive: true });
    }

    getVisibleRows() {
        let filteredRows = this.virtualState.allRows;
        if (this.searchText) {
            filteredRows = filteredRows.filter(row => {
                return (
                    (row.timestamp && row.timestamp.toLowerCase().includes(this.searchText)) ||
                    (row.eventType && row.eventType.toLowerCase().includes(this.searchText)) ||
                    (row.lineNumber && row.lineNumber.toLowerCase().includes(this.searchText)) ||
                    (row.details && row.details.toLowerCase().includes(this.searchText))
                );
            });
        }

        const visibleRows = [];
        let collapseDepth = 0;
        let collapsedBlockId = null;
        for (const row of filteredRows) {
            if (collapseDepth > 0) {
                if (row.type === 'entry' && row.blockId === collapsedBlockId) {
                    visibleRows.push(row);
                    collapseDepth++;
                    continue;
                }
                if (row.type === 'exit' && row.blockId === collapsedBlockId) {
                    visibleRows.push(row);
                    collapseDepth--;
                    if (collapseDepth === 0) collapsedBlockId = null;
                    continue;
                }
                if (row.type === 'entry') {
                    collapseDepth++;
                    continue;
                }
                if (row.type === 'exit') {
                    collapseDepth--;
                    continue;
                }
                continue;
            }
            if (row.type === 'entry' && this.virtualState.collapsedBlocks.has(row.blockId)) {
                visibleRows.push(row);
                collapseDepth = 1;
                collapsedBlockId = row.blockId;
                continue;
            }
            visibleRows.push(row);
        }
        return visibleRows;
    }

    renderVisibleRows() {
        const viewport = document.getElementById('virtual-viewport');
        const container = document.getElementById('content-container');
        if (!viewport || !container) return;

        const visibleRows = this.getVisibleRows();
        const totalRows = visibleRows.length;
        const scrollTop = viewport.scrollTop;
        const viewportHeight = viewport.clientHeight;
        const startIndex = Math.max(0, Math.floor(scrollTop / this.ROW_HEIGHT) - this.BUFFER_SIZE);
        const endIndex = Math.min(
            totalRows,
            Math.ceil((scrollTop + viewportHeight) / this.ROW_HEIGHT) + this.BUFFER_SIZE
        );

        container.innerHTML = '';
        container.style.height = `${totalRows * this.ROW_HEIGHT}px`;
        const fragment = document.createDocumentFragment();

        for (let i = startIndex; i < endIndex; i++) {
            const row = visibleRows[i];
            if (!row) continue;

            const rowElement = document.createElement('div');
            rowElement.className = `log-row ${row.type} ${row.eventType}`;
            rowElement.style.top = `${i * this.ROW_HEIGHT}px`;
            rowElement.dataset.logIndex = String(row.idx);
            rowElement.dataset.depth = String(row.depth || 0);
            if (row.idx === this.selectedLogIndex) {
                rowElement.style.backgroundColor = 'var(--vscode-list-activeSelectionBackground)';
            }

            const collapseCell = document.createElement('div');
            collapseCell.className = 'log-cell';
            collapseCell.style.width = this.COLUMN_WIDTHS[0];
            if (row.type === 'entry') {
                const button = document.createElement('button');
                button.className = 'collapse-btn';
                button.type = 'button';
                button.textContent = this.virtualState.collapsedBlocks.has(row.blockId) ? '▶' : '▼';
                button.setAttribute('aria-label', this.virtualState.collapsedBlocks.has(row.blockId) ? 'Expand method' : 'Collapse method');
                button.onclick = (e) => {
                    e.stopPropagation();
                    this.toggleCollapse(row.blockId);
                };
                collapseCell.appendChild(button);
            }
            rowElement.appendChild(collapseCell);

            [row.timestamp, row.eventType, row.lineNumber, row.details].forEach((text, colIndex) => {
                const cell = document.createElement('div');
                cell.className = 'log-cell';
                cell.textContent = text || '';
                cell.style.width = this.COLUMN_WIDTHS[colIndex + 1];
                if (colIndex === 3) {
                    cell.style.flex = '1';
                    if (row.depth > 0) cell.style.paddingLeft = `${row.depth * 12 + 8}px`;
                }
                rowElement.appendChild(cell);
            });
            fragment.appendChild(rowElement);
        }
        container.appendChild(fragment);
    }

    toggleCollapse(blockId) {
        if (this.virtualState.collapsedBlocks.has(blockId)) {
            this.virtualState.collapsedBlocks.delete(blockId);
        } else {
            this.virtualState.collapsedBlocks.add(blockId);
        }
        this.renderVisibleRows();
    }

    handleScroll() {
        requestAnimationFrame(() => this.renderVisibleRows());
    }

    ensureExecutionMap() {
        const panel = document.getElementById('execution-panel');
        const toggle = document.getElementById('execution-toggle');
        const summary = document.getElementById('execution-summary');
        const breadcrumb = document.getElementById('execution-breadcrumb');
        const breadcrumbCurrent = breadcrumb ? breadcrumb.querySelector('.execution-breadcrumb-current') : null;
        const back = document.getElementById('execution-back');
        const zoomOut = document.getElementById('execution-zoom-out');
        const zoomIn = document.getElementById('execution-zoom-in');
        const fit = document.getElementById('execution-fit');
        const content = document.getElementById('execution-content');
        const scroll = document.getElementById('execution-scroll');
        const timeline = document.getElementById('execution-timeline');
        const axis = document.getElementById('execution-axis');
        const blocks = document.getElementById('execution-blocks');
        const debugMarkers = document.getElementById('execution-debug-markers');
        const errorMarkers = document.getElementById('execution-error-markers');
        const empty = document.getElementById('execution-empty');
        if (!panel || !toggle || !summary || !back || !content || !scroll || !timeline || !axis || !blocks || !debugMarkers || !errorMarkers || !empty) {
            return null;
        }
        if (this.executionMapState.elements) return panel;

        toggle.onclick = () => {
            this.executionMapState.collapsed = !this.executionMapState.collapsed;
            this.renderExecutionMap(this.executionMapState.model);
        };
        back.onclick = () => {
            if (this.executionMapState.viewStack.length > 0) {
                this.executionMapState.viewStack.pop();
                this.executionMapState.scrollLeft = 0;
                this.renderExecutionMap(this.executionMapState.model);
            }
        };
        if (zoomOut) zoomOut.onclick = () => this.changeExecutionMapZoom(-0.5);
        if (zoomIn) zoomIn.onclick = () => this.changeExecutionMapZoom(0.5);
        if (fit) fit.onclick = () => {
            this.executionMapState.zoom = 1;
            this.executionMapState.scrollLeft = 0;
            this.renderExecutionMap(this.executionMapState.model);
        };
        scroll.addEventListener('scroll', () => {
            this.executionMapState.scrollLeft = scroll.scrollLeft;
        }, { passive: true });

        this.executionMapState.elements = {
            panel,
            toggle,
            summary,
            breadcrumb,
            breadcrumbCurrent,
            back,
            content,
            scroll,
            timeline,
            axis,
            blocks,
            debugMarkers,
            errorMarkers,
            empty,
            fit
        };
        return panel;
    }

    changeExecutionMapZoom(delta) {
        const state = this.executionMapState;
        state.zoom = Math.max(this.MAP_MIN_ZOOM, Math.min(this.MAP_MAX_ZOOM, state.zoom + delta));
        this.renderExecutionMap(state.model);
    }

    getCurrentExecutionSpan(model) {
        const stack = this.executionMapState.viewStack;
        while (stack.length > 0) {
            const id = stack[stack.length - 1];
            const span = model && model.spans ? model.spans[id] : null;
            if (span) return span;
            stack.pop();
        }
        return null;
    }

    getExecutionBlocks(model, selectedSpan) {
        if (!model) return [];
        let ids;
        if (selectedSpan) {
            ids = selectedSpan.children.length > 0 ? selectedSpan.children.slice() : [selectedSpan.id];
        } else {
            ids = model.rootIds.slice();
            if (ids.length === 0) ids = model.spans.map(span => span.id).filter(id => model.spans[id].parentId === null);
        }
        return ids
            .map(id => model.spans[id])
            .filter(Boolean)
            .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
    }

    renderExecutionMap(model) {
        const state = this.executionMapState;
        if (!model) return;
        const elements = state.elements;
        if (!elements) return;

        const selectedSpan = this.getCurrentExecutionSpan(model);
        const blocks = this.getExecutionBlocks(model, selectedSpan);
        const rangeStart = selectedSpan ? selectedSpan.startTime : model.startTime;
        let rangeEnd = selectedSpan ? selectedSpan.endTime : model.endTime;
        if (!Number.isFinite(rangeEnd) || rangeEnd <= rangeStart) rangeEnd = rangeStart + 1;
        const rangeDuration = Math.max(1, rangeEnd - rangeStart);

        const availableWidth = Math.max(
            this.MAP_MIN_WIDTH,
            (elements.scroll.clientWidth || document.documentElement.clientWidth || 800) - 16
        );
        const canvasWidth = Math.round(availableWidth * state.zoom);
        const errorCount = model.markers.filter(marker => marker.kind === 'error').length;
        const debugCount = model.markers.filter(marker => marker.kind === 'debug').length;

        elements.panel.classList.toggle('is-collapsed', state.collapsed);
        elements.panel.setAttribute('aria-expanded', String(!state.collapsed));
        elements.toggle.setAttribute('aria-expanded', String(!state.collapsed));
        elements.toggle.setAttribute('aria-label', state.collapsed ? 'Expand execution flow' : 'Collapse execution flow');
        elements.toggle.setAttribute('title', state.collapsed ? 'Expand execution flow' : 'Collapse execution flow');
        elements.content.hidden = state.collapsed;
        elements.back.hidden = !selectedSpan;
        if (elements.breadcrumbCurrent) elements.breadcrumbCurrent.textContent = selectedSpan ? selectedSpan.label : 'Full execution';
        elements.summary.textContent = `${this.formatExecutionDuration(model.endTime - model.startTime)} · ${blocks.length} block${blocks.length === 1 ? '' : 's'}${errorCount ? ` · ◆ ${errorCount}` : ''}${debugCount ? ` · • ${debugCount}` : ''}`;

        if (state.collapsed) return;

        const scrollLeft = state.scrollLeft;
        elements.timeline.style.width = `${canvasWidth}px`;
        elements.timeline.style.minWidth = `${canvasWidth}px`;
        elements.axis.innerHTML = '';
        elements.blocks.innerHTML = '';
        elements.debugMarkers.innerHTML = '';
        elements.errorMarkers.innerHTML = '';
        elements.empty.hidden = blocks.length > 0;

        [0, 0.25, 0.5, 0.75, 1].forEach(ratio => {
            const tick = document.createElement('span');
            tick.style.position = 'absolute';
            tick.style.left = `${ratio * 100}%`;
            tick.style.transform = ratio === 0 ? 'none' : (ratio === 1 ? 'translateX(-100%)' : 'translateX(-50%)');
            tick.style.padding = '0 3px';
            tick.textContent = this.formatExecutionDuration(rangeDuration * ratio);
            elements.axis.appendChild(tick);
        });

        blocks.forEach(block => {
            const startRatio = Math.max(0, Math.min(1, (block.startTime - rangeStart) / rangeDuration));
            const endRatio = Math.max(startRatio, Math.min(1, (block.endTime - rangeStart) / rangeDuration));
            const left = startRatio * canvasWidth;
            const width = Math.max(3, (endRatio - startRatio) * canvasWidth);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'execution-block';
            button.dataset.kind = this.executionBlockKind(block);
            button.style.left = `${left}px`;
            button.style.width = `${width}px`;
            button.title = `${block.label} · ${this.formatExecutionDuration(block.duration)} · log line ${block.startIndex + 1}${block.incomplete ? ' · incomplete log' : ''}`;
            button.setAttribute('aria-label', `${block.label}, ${this.formatExecutionDuration(block.duration)}`);
            button.setAttribute('aria-current', String(selectedSpan && selectedSpan.id === block.id));
            const label = document.createElement('span');
            label.className = 'execution-block-label';
            label.textContent = width >= 72 ? this.truncateLabel(block.label, Math.max(12, Math.floor(width / 7))) : '';
            button.appendChild(label);
            button.onclick = () => this.openExecutionSpan(block.id);
            elements.blocks.appendChild(button);
        });

        const visibleMarkers = model.markers
            .filter(marker => marker.time >= rangeStart && marker.time <= rangeEnd)
            .sort((a, b) => a.time - b.time || a.index - b.index);
        visibleMarkers.forEach(marker => {
            const ratio = Math.max(0, Math.min(1, (marker.time - rangeStart) / rangeDuration));
            const markerButton = document.createElement('button');
            markerButton.type = 'button';
            markerButton.className = marker.kind === 'error' ? 'execution-error-marker' : 'execution-debug-marker';
            markerButton.style.left = `${ratio * 100}%`;
            markerButton.title = `${marker.eventType}: ${marker.label} · log line ${marker.index + 1}`;
            markerButton.setAttribute('aria-label', `${marker.eventType} at log line ${marker.index + 1}`);
            markerButton.onclick = (event) => {
                event.stopPropagation();
                this.scrollToLogIndex(marker.index);
            };
            (marker.kind === 'error' ? elements.errorMarkers : elements.debugMarkers).appendChild(markerButton);
        });
        elements.scroll.scrollLeft = Math.min(scrollLeft, Math.max(0, elements.scroll.scrollWidth - elements.scroll.clientWidth));
    }

    executionBlockKind(block) {
        if (block.kind === 'soql' || block.kind === 'dml' || block.kind === 'system') return block.kind;
        if (block.kind === 'flow') return 'flow';
        if (block.kind === 'unit' && /trigger/i.test(block.label)) return 'trigger';
        return 'class';
    }

    openExecutionSpan(spanId) {
        const model = this.executionMapState.model;
        const span = model && model.spans ? model.spans[spanId] : null;
        if (!span) return;
        this.scrollToLogIndex(span.startIndex);
        if (span.children && span.children.length > 0) {
            this.executionMapState.viewStack.push(span.id);
            this.executionMapState.scrollLeft = 0;
            this.renderExecutionMap(model);
        }
    }

    scrollToLogIndex(logIndex) {
        const viewport = document.getElementById('virtual-viewport');
        if (!viewport) return;
        this.selectedLogIndex = logIndex;

        let visibleRows = this.getVisibleRows();
        let visibleIndex = visibleRows.findIndex(row => row.idx === logIndex);
        if (visibleIndex < 0) {
            const searchInput = document.getElementById('log-search-input');
            const debugOnly = document.getElementById('only-user-debug');
            const hideHeap = document.getElementById('hide-heap-allocate');
            if (searchInput) searchInput.value = '';
            this.searchText = '';
            this.virtualState.collapsedBlocks.clear();

            if (debugOnly && debugOnly.checked) {
                debugOnly.checked = false;
                this.renderTable(Boolean(hideHeap && hideHeap.checked), false);
            }
            visibleRows = this.getVisibleRows();
            visibleIndex = visibleRows.findIndex(row => row.idx === logIndex);
        }

        if (visibleIndex >= 0) viewport.scrollTop = visibleIndex * this.ROW_HEIGHT;
        this.renderVisibleRows();
        requestAnimationFrame(() => {
            const selected = document.querySelector(`#content-container .log-row[data-log-index="${String(logIndex).replace(/"/g, '\\"')}"]`);
            if (selected) selected.style.backgroundColor = 'var(--vscode-list-activeSelectionBackground)';
        });
    }

    formatExecutionDuration(nanoseconds) {
        if (!Number.isFinite(nanoseconds)) return '—';
        const value = Math.max(0, nanoseconds);
        if (value >= 1000000000) return `${(value / 1000000000).toFixed(2)}s`;
        if (value >= 1000000) return `${(value / 1000000).toFixed(1)}ms`;
        if (value >= 1000) return `${(value / 1000).toFixed(1)}μs`;
        return `${Math.round(value)}ns`;
    }

    handleMessage(event) {
        const data = event.data;
        if (!data.logContent) return;
        this.logLines = data.logContent.split(/\r?\n/).filter(line => line.trim().length > 0);
        this.executionMapState.viewStack = [];
        this.executionMapState.scrollLeft = 0;
        this.selectedLogIndex = null;
        this.renderTable(
            document.getElementById('hide-heap-allocate').checked,
            document.getElementById('only-user-debug').checked
        );
    }

    handleDOMContentLoaded() {
        this.vscode.postMessage({ type: 'ready' });
        ['hide-heap-allocate', 'only-user-debug'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => {
                this.renderTable(
                    document.getElementById('hide-heap-allocate').checked,
                    document.getElementById('only-user-debug').checked
                );
            });
        });
        const searchInput = document.getElementById('log-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                this.searchText = searchInput.value.trim().toLowerCase();
                this.renderVisibleRows();
            });
        }
    }

    init() {
        window.addEventListener('message', this.handleMessage.bind(this));
        document.addEventListener('DOMContentLoaded', this.handleDOMContentLoaded.bind(this));
    }
}

// Inicializar visor
new ApexLogDetails();
