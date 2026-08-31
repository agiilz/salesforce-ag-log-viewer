class ApexLogDetails {
    constructor() {
        this.vscode = acquireVsCodeApi();
        this.logLines = [];
        this.BUFFER_SIZE = 100;
        this.ROW_HEIGHT = 24;
        this.COLUMN_WIDTHS = ['17px', '60px', '150px', '30px', 'auto'];
        this.virtualState = {
            allRows: [],
            visibleRows: [],
            collapsedBlocks: new Set(),
            lastScrollTop: 0
        };
        this.searchText = '';
        this.summary = {};
        this.scrollFrame = null;
        this.init();
    }

    parseLogLines(logLines, hideHeapAllocate, onlyUserDebug) {
        let methodBlockId = 0;
        let methodStack = [];
        const rows = [];

        for (let idx = 0; idx < logLines.length; idx++) {
            const line = logLines[idx];
            if (/Execute Anonymous:/i.test(line)) continue;

            const parts = line.split('|');
            let timestamp = '', eventType = '', details = '', lineNumber = '';

            if (parts.length === 1) {
                details = parts[0];
            } else if (parts.length === 2) {
                [timestamp, eventType] = parts;
            } else {
                [timestamp, eventType, ...details] = parts;
                details = details.join(' | ');
            }

            timestamp = timestamp.trim()
                .replace(/\.\d+/, '')
                .replace(/\s*\(\d+\)$/, '');

            details = details.replace(/\s*\|\s*DEBUG\s*\|\s*/g, ' | ');
            const lineMatch = details.match(/^\s*\[(\d+)\]/);
            if (lineMatch) {
                lineNumber = `[${lineMatch[1]}]`;
                details = details.replace(/^\s*\[\d+\]\s*\|?\s*/, '');
            }

            // Aplicar filtros
            if (hideHeapAllocate && eventType === 'HEAP_ALLOCATE') continue;
            if (onlyUserDebug && eventType !== 'USER_DEBUG') continue;

            // Añadir fila sin seguimiento de bloques de método en modo solo debug
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

            // Manejar bloques de método solo cuando no es modo debug
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

        return { rows };
    }

    renderTable(hideHeapAllocate, onlyUserDebug) {
        const container = document.getElementById('log-table-container');
        const viewport = document.getElementById('virtual-viewport');
        if (!container || !viewport) return;

        // Parsear datos
        const { rows } = this.parseLogLines(this.logLines, hideHeapAllocate, onlyUserDebug);
        this.virtualState.allRows = rows;
        this.rebuildVisibleRows();
        this.updateSummary(rows);

        // Establecer anchos de cabecera
        const headers = document.querySelectorAll('#log-table-header th');
        headers.forEach((header, i) => {
            header.style.width = this.COLUMN_WIDTHS[i];
            header.style.minWidth = this.COLUMN_WIDTHS[i];
        });

        // Limpiar contenido
        const contentContainer = document.getElementById('content-container');
        contentContainer.innerHTML = '';

        // Establecer altura del contenedor
        contentContainer.style.height = `${this.virtualState.visibleRows.length * this.ROW_HEIGHT}px`;

        // Renderizado inicial
        this.renderVisibleRows();

        // Configurar el scroll solo si no está ya configurado
        viewport.removeEventListener('scroll', this.handleScrollBound);
        this.handleScrollBound = this.handleScroll.bind(this);
        viewport.addEventListener('scroll', this.handleScrollBound, { passive: true });

        this.syncHeaderScroll();
    }

    renderVisibleRows() {
        const viewport = document.getElementById('virtual-viewport');
        const container = document.getElementById('content-container');
        if (!viewport || !container) return;

        const scrollTop = viewport.scrollTop;
        const viewportHeight = viewport.clientHeight;

        const visibleRows = this.virtualState.visibleRows;
        const totalRows = visibleRows.length;

        // Calcular el rango visible para el scroll virtual
        const startIndex = Math.max(0, Math.floor(scrollTop / this.ROW_HEIGHT) - this.BUFFER_SIZE);
        const endIndex = Math.min(
            totalRows,
            Math.ceil((scrollTop + viewportHeight) / this.ROW_HEIGHT) + this.BUFFER_SIZE
        );

        // Limpiar contenido
        container.innerHTML = '';
        // Ajustar la altura del contenedor al número real de filas visibles
        container.style.height = `${totalRows * this.ROW_HEIGHT}px`;

        // Crear fragmento para mejor rendimiento
        const fragment = document.createDocumentFragment();

        // Renderizar solo las filas visibles
        for (let i = startIndex; i < endIndex; i++) {
            const row = visibleRows[i];
            if (!row) continue;

            const rowElement = document.createElement('div');
            // Add eventType to classList for color coding
            rowElement.className = `log-row ${row.type} ${row.eventType}`;
            rowElement.style.top = `${i * this.ROW_HEIGHT}px`;
            rowElement.setAttribute('role', 'row');

            // Celda del botón de colapso
            const collapseCell = document.createElement('div');
            collapseCell.className = 'log-cell';
            collapseCell.style.width = this.COLUMN_WIDTHS[0];
            collapseCell.setAttribute('role', 'gridcell');
            if (row.type === 'entry') {
                const button = document.createElement('button');
                button.className = 'collapse-btn';
                const collapsed = this.virtualState.collapsedBlocks.has(row.blockId);
                button.textContent = collapsed ? '▶' : '▼';
                button.setAttribute('aria-expanded', (!collapsed).toString());
                button.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} method block`);
                button.onclick = (e) => {
                    e.stopPropagation();
                    this.toggleCollapse(row.blockId);
                };
                collapseCell.appendChild(button);
            }
            rowElement.appendChild(collapseCell);

            // Celdas de datos
            [row.timestamp, row.eventType, row.lineNumber, row.details].forEach((text, colIndex) => {
                const cell = document.createElement('div');
                cell.className = 'log-cell';
                cell.textContent = text || '';
                cell.style.width = this.COLUMN_WIDTHS[colIndex + 1];
                cell.setAttribute('role', 'gridcell');

                if (colIndex === 3) {
                    cell.style.flex = '1';
                    if (row.depth > 0) {
                        cell.style.paddingLeft = `${row.depth * 12 + 8}px`;
                    }
                }

                rowElement.appendChild(cell);
            });

            fragment.appendChild(rowElement);
        }

        container.appendChild(fragment);
    }

    rebuildVisibleRows() {
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
                // Si estamos dentro de un bloque colapsado
                if (row.type === 'entry' && row.blockId === collapsedBlockId) {
                    // Mostrar solo el ENTRY del bloque colapsado más externo
                    visibleRows.push(row);
                    collapseDepth++;
                    continue;
                }
                if (row.type === 'exit' && row.blockId === collapsedBlockId) {
                    // Mostrar solo el EXIT del bloque colapsado más externo
                    visibleRows.push(row);
                    collapseDepth--;
                    if (collapseDepth === 0) collapsedBlockId = null;
                    continue;
                }
                if (row.type === 'entry') {
                    // Entramos en un hijo anidado, aumentar profundidad
                    collapseDepth++;
                    continue;
                }
                if (row.type === 'exit') {
                    // Salimos de un hijo anidado, disminuir profundidad
                    collapseDepth--;
                    continue;
                }
                // Ocultar todo lo demás dentro del bloque colapsado
                continue;
            }
            if (row.type === 'entry' && this.virtualState.collapsedBlocks.has(row.blockId)) {
                // Comenzar a colapsar este bloque
                visibleRows.push(row);
                collapseDepth = 1;
                collapsedBlockId = row.blockId;
                continue;
            }
            visibleRows.push(row);
        }
        this.virtualState.visibleRows = visibleRows;
    }

    toggleCollapse(blockId) {
        if (this.virtualState.collapsedBlocks.has(blockId)) {
            this.virtualState.collapsedBlocks.delete(blockId);
        } else {
            this.virtualState.collapsedBlocks.add(blockId);
        }
        this.rebuildVisibleRows();
        this.renderVisibleRows();
    }

    handleScroll() {
        this.syncHeaderScroll();
        if (this.scrollFrame !== null) return;
        this.scrollFrame = requestAnimationFrame(() => {
            this.scrollFrame = null;
            this.renderVisibleRows();
        });
    }

    syncHeaderScroll() {
        const viewport = document.getElementById('virtual-viewport');
        const header = document.getElementById('log-table-header');
        if (viewport && header) {
            header.style.transform = `translateX(-${viewport.scrollLeft}px)`;
        }
    }

    handleMessage(event) {
        const data = event.data;
        if (!data.logContent) return;
        this.logLines = data.logContent.split(/\r?\n/).filter(l => l.trim().length > 0);
        this.renderTable(
            document.getElementById('hide-heap-allocate').checked,
            document.getElementById('only-user-debug').checked
        );
    }

    handleDOMContentLoaded() {
        const rowHeight = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-height'));
        if (Number.isFinite(rowHeight) && rowHeight > 0) {
            this.ROW_HEIGHT = rowHeight;
        }
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
                this.rebuildVisibleRows();
                this.renderVisibleRows();
            });
        }
        document.getElementById('export-raw')?.addEventListener('click', () => {
            this.vscode.postMessage({ type: 'export', format: 'raw' });
        });
        document.getElementById('export-summary')?.addEventListener('click', () => {
            this.vscode.postMessage({ type: 'export', format: 'summary-json', summary: this.summary });
        });
    }

    updateSummary(rows) {
        const eventCounts = rows.reduce((counts, row) => {
            counts[row.eventType] = (counts[row.eventType] || 0) + 1;
            return counts;
        }, {});
        this.summary = {
            totalLines: this.logLines.length,
            parsedEvents: rows.length,
            userDebug: eventCounts.USER_DEBUG || 0,
            soql: (eventCounts.SOQL_EXECUTE_BEGIN || 0) + (eventCounts.SOQL_EXECUTE || 0),
            dml: eventCounts.DML_BEGIN || 0,
            exceptions: (eventCounts.EXCEPTION_THROWN || 0) + (eventCounts.FATAL_ERROR || 0),
            methods: eventCounts.METHOD_ENTRY || 0
        };
        const strip = document.getElementById('summary-strip');
        if (strip) {
            strip.textContent = `${this.summary.parsedEvents} events · ${this.summary.userDebug} debug · ${this.summary.soql} SOQL · ${this.summary.dml} DML · ${this.summary.exceptions} exceptions`;
        }
    }

    init() {
        window.addEventListener('message', this.handleMessage.bind(this));
        document.addEventListener('DOMContentLoaded', this.handleDOMContentLoaded.bind(this));
    }
}

// Inicializar visor
new ApexLogDetails();
