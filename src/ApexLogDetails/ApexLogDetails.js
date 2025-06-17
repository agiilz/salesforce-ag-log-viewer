(function() {
    const vscode = acquireVsCodeApi();
    let logLines = [];
    // Constants
    const BUFFER_SIZE = 100;
    const ROW_HEIGHT = 22;
    const COLUMN_WIDTHS = ['17px', '60px', '150px', '30px', 'auto'];

    let virtualState = {
        allRows: [],
        collapsedBlocks: new Set(),
        lastScrollTop: 0
    };

    let searchText = '';

    function parseLogLines(logLines, hideHeapAllocate, onlyUserDebug) {
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

            // Apply filters
            if (hideHeapAllocate && eventType === 'HEAP_ALLOCATE') continue;
            if (onlyUserDebug && eventType !== 'USER_DEBUG') continue;

            // Add row without method block tracking when in debug-only mode
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

            // Handle method blocks only when not in debug-only mode
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

    function renderTable(hideHeapAllocate, onlyUserDebug) {
        const container = document.getElementById('log-table-container');
        const viewport = document.getElementById('virtual-viewport');
        if (!container || !viewport) return;

        // Parse data
        const { rows } = parseLogLines(logLines, hideHeapAllocate, onlyUserDebug);
        virtualState.allRows = rows;

        // Set header widths
        const headers = document.querySelectorAll('#log-table-header th');
        headers.forEach((header, i) => {
            header.style.width = COLUMN_WIDTHS[i];
            header.style.minWidth = COLUMN_WIDTHS[i];
        });

        // Clear content
        const contentContainer = document.getElementById('content-container');
        contentContainer.innerHTML = '';
        
        // Set container height
        contentContainer.style.height = `${rows.length * ROW_HEIGHT}px`;

        // Initial render
        renderVisibleRows();

        // Setup scroll handling if not already set
        viewport.removeEventListener('scroll', handleScroll);
        viewport.addEventListener('scroll', handleScroll, { passive: true });

        // Actualizar searchText si hay input
        const searchInput = document.getElementById('log-search-input');
        if (searchInput) searchText = searchInput.value.trim().toLowerCase();
    }

    function renderVisibleRows() {
        const viewport = document.getElementById('virtual-viewport');
        const container = document.getElementById('content-container');
        if (!viewport || !container) return;

        const scrollTop = viewport.scrollTop;
        const viewportHeight = viewport.clientHeight;

        // Filtrar solo las filas visibles (sin huecos)
        let filteredRows = virtualState.allRows;
        if (searchText) {
            filteredRows = filteredRows.filter(row => {
                return (
                    (row.timestamp && row.timestamp.toLowerCase().includes(searchText)) ||
                    (row.eventType && row.eventType.toLowerCase().includes(searchText)) ||
                    (row.lineNumber && row.lineNumber.toLowerCase().includes(searchText)) ||
                    (row.details && row.details.toLowerCase().includes(searchText))
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
            if (row.type === 'entry' && virtualState.collapsedBlocks.has(row.blockId)) {
                // Comenzar a colapsar este bloque
                visibleRows.push(row);
                collapseDepth = 1;
                collapsedBlockId = row.blockId;
                continue;
            }
            visibleRows.push(row);
        }
        const totalRows = visibleRows.length;

        // Calcular el rango visible para el virtual scroll
        const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - BUFFER_SIZE);
        const endIndex = Math.min(
            totalRows,
            Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + BUFFER_SIZE
        );

        // Limpiar contenido
        container.innerHTML = '';
        // Ajustar la altura del contenedor al número real de filas visibles
        container.style.height = `${totalRows * ROW_HEIGHT}px`;

        // Crear fragmento para mejor rendimiento
        const fragment = document.createDocumentFragment();

        // Renderizar solo las filas visibles
        for (let i = startIndex; i < endIndex; i++) {
            const row = visibleRows[i];
            if (!row) continue;

            const rowElement = document.createElement('div');
            rowElement.className = `log-row ${row.type}`;
            rowElement.style.top = `${i * ROW_HEIGHT}px`;

            // Collapse button cell
            const collapseCell = document.createElement('div');
            collapseCell.className = 'log-cell';
            collapseCell.style.width = COLUMN_WIDTHS[0];
            if (row.type === 'entry') {
                const button = document.createElement('button');
                button.className = 'collapse-btn';
                button.textContent = virtualState.collapsedBlocks.has(row.blockId) ? '►' : '▼';
                button.onclick = (e) => {
                    e.stopPropagation();
                    toggleCollapse(row.blockId);
                };
                collapseCell.appendChild(button);
            }
            rowElement.appendChild(collapseCell);

            // Data cells
            [row.timestamp, row.eventType, row.lineNumber, row.details].forEach((text, i) => {
                const cell = document.createElement('div');
                cell.className = 'log-cell';
                cell.textContent = text || '';
                cell.style.width = COLUMN_WIDTHS[i + 1];
                if (i === 3) cell.style.flex = '1'; // Make details column flexible
                rowElement.appendChild(cell);
            });

            fragment.appendChild(rowElement);
        }

        container.appendChild(fragment);
    }

    function toggleCollapse(blockId) {
        if (virtualState.collapsedBlocks.has(blockId)) {
            virtualState.collapsedBlocks.delete(blockId);
        } else {
            virtualState.collapsedBlocks.add(blockId);
        }
        renderVisibleRows();
    }

    function handleScroll() {
        requestAnimationFrame(renderVisibleRows);
    }

    // Event handlers
    window.addEventListener('message', event => {
        const data = event.data;
        if (!data.logContent) return;
        
        logLines = data.logContent.split(/\r?\n/).filter(l => l.trim().length > 0);
        renderTable(
            document.getElementById('hide-heap-allocate').checked,
            document.getElementById('only-user-debug').checked
        );
    });

    document.addEventListener('DOMContentLoaded', () => {
        vscode.postMessage({ type: 'ready' });
        ['hide-heap-allocate', 'only-user-debug'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => {
                renderTable(
                    document.getElementById('hide-heap-allocate').checked,
                    document.getElementById('only-user-debug').checked
                );
            });
        });
        const searchInput = document.getElementById('log-search-input');
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                searchText = searchInput.value.trim().toLowerCase();
                renderVisibleRows();
            });
        }
    });
})();
