class ApexLogDetails {
    constructor() {
        this.vscode = acquireVsCodeApi();
        this.logLines = [];
        this.BUFFER_SIZE = 100;
        this.ROW_HEIGHT = 22;
        this.COLUMN_WIDTHS = ['17px', '60px', '150px', '30px', 'auto'];
        this.virtualState = {
            allRows: [],
            collapsedBlocks: new Set(),
            lastScrollTop: 0
        };
        this.searchText = '';
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
                methodBlockId++;
                methodStack.push({ id: methodBlockId, start: idx });
                rows.push({ idx, timestamp, eventType, details, blockId: methodBlockId, type: 'entry', lineNumber });
            } else if (eventType === 'METHOD_EXIT' && methodStack.length > 0) {
                const block = methodStack.pop();
                if (block) {
                    rows.push({ idx, timestamp, eventType, details, blockId: block.id, type: 'exit', lineNumber });
                }
            } else {
                const parentBlock = methodStack.length > 0 ? methodStack[methodStack.length - 1].id : null;
                rows.push({ idx, timestamp, eventType, details, blockId: parentBlock, type: parentBlock ? 'inner' : 'normal', lineNumber });
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
        contentContainer.style.height = `${rows.length * this.ROW_HEIGHT}px`;

        // Renderizado inicial
        this.renderVisibleRows();

        // Configurar el scroll solo si no está ya configurado
        viewport.removeEventListener('scroll', this.handleScrollBound);
        this.handleScrollBound = this.handleScroll.bind(this);
        viewport.addEventListener('scroll', this.handleScrollBound, { passive: true });

        // Actualizar searchText si hay input
        const searchInput = document.getElementById('log-search-input');
        if (searchInput) this.searchText = searchInput.value.trim().toLowerCase();
    }

    renderVisibleRows() {
        const viewport = document.getElementById('virtual-viewport');
        const container = document.getElementById('content-container');
        if (!viewport || !container) return;

        const scrollTop = viewport.scrollTop;
        const viewportHeight = viewport.clientHeight;

        // Filtrar solo las filas visibles (sin huecos)
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
            rowElement.className = `log-row ${row.type}`;
            rowElement.style.top = `${i * this.ROW_HEIGHT}px`;

            // Celda del botón de colapso
            const collapseCell = document.createElement('div');
            collapseCell.className = 'log-cell';
            collapseCell.style.width = this.COLUMN_WIDTHS[0];
            if (row.type === 'entry') {
                const button = document.createElement('button');
                button.className = 'collapse-btn';
                button.textContent = this.virtualState.collapsedBlocks.has(row.blockId) ? '►' : '▼';
                button.onclick = (e) => {
                    e.stopPropagation();
                    this.toggleCollapse(row.blockId);
                };
                collapseCell.appendChild(button);
            }
            rowElement.appendChild(collapseCell);

            // Celdas de datos
            [row.timestamp, row.eventType, row.lineNumber, row.details].forEach((text, i) => {
                const cell = document.createElement('div');
                cell.className = 'log-cell';
                cell.textContent = text || '';
                cell.style.width = this.COLUMN_WIDTHS[i + 1];
                if (i === 3) cell.style.flex = '1'; // Hacer la columna de detalles flexible
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
