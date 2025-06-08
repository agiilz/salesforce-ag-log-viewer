(function() {
    const vscode = acquireVsCodeApi();
    let logLines = [];
    let fileName = '';

    // --- Parsing and Row Construction ---
    function parseLogLines(logLines, hideHeapAllocate, onlyUserDebug) {
        let methodBlockId = 0;
        let methodStack = [];
        let blockMap = {};
        const rows = [];
        for (let idx = 0; idx < logLines.length; idx++) {
            const line = logLines[idx];
            if (/Execute Anonymous:/i.test(line)) continue;
            const parts = line.split('|');
            let timestamp = '', eventType = '', details = '', lineNumber = '';
            if (parts.length === 1) {
                details = parts[0];
            } else if (parts.length === 2) {
                timestamp = parts[0];
                eventType = parts[1];
            } else {
                timestamp = parts[0];
                eventType = parts[1];
                details = parts.slice(2).join(' | ');
            }
            // Format timestamp to HH:mm:ss (remove .ms if present)
            timestamp = timestamp.trim();
            // Remove milliseconds if present (e.g., 00:25:13.1 or 00:25:13.123 -> 00:25:13)
            if (/^\d{2}:\d{2}:\d{2}\.\d+/.test(timestamp)) {
                timestamp = timestamp.split('.')[0];
            }
            // Remove any trailing parenthesis (e.g., 00:25:13 (123) -> 00:25:13)
            timestamp = timestamp.replace(/\s*\(\d+\)$/, '');
            details = details.replace(/\s*\|\s*DEBUG\s*\|\s*/g, ' | ');
            // Extract [number] at start of details for any row
            const match = details.match(/^\s*\[(\d+)\]/);
            if (match) {
                lineNumber = `[${match[1]}]`;
            }
            // Remove [number] at start of details for any row
            details = details.replace(/^\s*\[\d+\]\s*\|?\s*/, '');
            if (hideHeapAllocate && eventType === 'HEAP_ALLOCATE') continue;
            if (onlyUserDebug && eventType !== 'USER_DEBUG') continue;
            if (!lineNumber && eventType === 'USER_DEBUG') lineNumber = '';
            // Block map logic
            if (eventType === 'METHOD_ENTRY') {
                methodBlockId++;
                methodStack.push({ id: methodBlockId, start: idx });
                rows.push({ idx, timestamp, eventType, details, blockId: methodBlockId, type: 'entry', lineNumber });
            } else if (eventType === 'METHOD_EXIT' && methodStack.length > 0) {
                const block = methodStack.pop();
                if (block) {
                    blockMap[block.start] = { id: block.id, start: block.start, end: idx };
                    rows.push({ idx, timestamp, eventType, details, blockId: block.id, type: 'exit', lineNumber });
                } else {
                    rows.push({ idx, timestamp, eventType, details, blockId: null, type: 'exit', lineNumber });
                }
            } else {
                let parentBlock = methodStack.length > 0 ? methodStack[methodStack.length - 1].id : null;
                rows.push({ idx, timestamp, eventType, details, blockId: parentBlock, type: parentBlock ? 'inner' : 'normal', lineNumber });
            }
        }
        return { rows, blockMap };
    }

    // --- Column Widths For Shows Debug logs---
    function setColumnWidths(isFixed) {
        const table = document.getElementById('log-table');
        if (!table) return;
        // Remove all inline widths first
        const ths = table.querySelectorAll('th');
        const trs = table.querySelectorAll('tr');
        for (let th of ths) {
            th.style.width = '';
            th.style.minWidth = '';
            th.style.maxWidth = '';
        }
        for (let tr of trs) {
            let tds = tr.querySelectorAll('td');
            for (let td of tds) {
                td.style.width = '';
                td.style.minWidth = '';
                td.style.maxWidth = '';
            }
        }
        if (isFixed) {
            // Set fixed widths for columns when filtering USER_DEBUG
            const widths = ['17px', '60px', '80px', '30px', 'auto'];
            ths.forEach((th, i) => {
                th.style.width = widths[i];
                th.style.minWidth = widths[i];
                th.style.maxWidth = widths[i];
            });
            // Set for all rows, not just first row
            for (let tr of trs) {
                let tds = tr.querySelectorAll('td');
                tds.forEach((td, i) => {
                    if (widths[i]) {
                        td.style.width = widths[i];
                        td.style.minWidth = widths[i];
                        td.style.maxWidth = widths[i];
                    }
                });
            }
            // Force table-layout: fixed for consistent column widths
            table.style.tableLayout = 'fixed';
        } else {
            table.style.tableLayout = 'auto';
        }
    }

    // --- Table Rendering ---
    function renderTable(hideHeapAllocate, onlyUserDebug) {
        setColumnWidths(onlyUserDebug);
        const tbody = document.querySelector('#log-table tbody');
        tbody.innerHTML = '';
        const { rows, blockMap } = parseLogLines(logLines, hideHeapAllocate, onlyUserDebug);
        const fragment = document.createDocumentFragment();
        const rowIndexMap = new Map();
        const collapseCellTemplate = document.getElementById('collapse-cell-template');
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            let tr = document.createElement('tr');
            tr.dataset.rowIndex = row.idx;
            let collapseCell = document.createElement('td');
            if (row.type === 'entry' && blockMap[row.idx]) {
                tr.classList.add('method-entry');
                tr.dataset.methodBlockId = row.blockId;
                // Use template for collapse cell
                if (collapseCellTemplate && collapseCellTemplate.content) {
                    const cell = collapseCellTemplate.content.firstElementChild.cloneNode(true);
                    const btn = cell.querySelector('button');
                    btn.setAttribute('data-block', row.blockId);
                    collapseCell = cell;
                }
            } else if (row.type === 'exit' && row.blockId) {
                tr.classList.add('method-exit');
                tr.dataset.methodBlockId = row.blockId;
            } else if (row.type === 'inner' && row.blockId) {
                tr.classList.add('method-inner');
                tr.dataset.methodBlockId = row.blockId;
            }
            // Columns: [collapse][time][event][line][details]
            tr.appendChild(collapseCell);
            tr.insertAdjacentHTML('beforeend', `<td>${row.timestamp}</td><td>${row.eventType}</td><td>${row.lineNumber || ''}</td><td>${row.details}</td>`);
            fragment.appendChild(tr);
            rowIndexMap.set(row.idx, tr);
        }
        tbody.appendChild(fragment);
        setupCollapseEvent(tbody, blockMap, rowIndexMap);
    }

    // --- Collapse/Expand Logic ---
    function setupCollapseEvent(tbody, blockMap, rowIndexMap) {
        tbody.onclick = function(e) {
            const target = e.target;
            if (target && target.classList.contains('collapse-btn')) {
                const blockId = target.getAttribute('data-block');
                const block = Object.values(blockMap).find(b => b.id == blockId);
                if (!block) return;
                let collapsed = target.classList.toggle('collapsed');
                target.textContent = collapsed ? '▸' : '▾';
                for (let i = block.start + 1; i < block.end; i++) {
                    const row = rowIndexMap.get(i);
                    if (row) {
                        row.style.display = collapsed ? 'none' : '';
                    }
                }
            }
        };
    }

    // --- Webview Message/Event Handlers ---
    function handleWebviewMessage(event) {
        const data = event.data;
        logLines = data.logContent.split(/\r?\n/).filter(l => l.trim().length > 0);
        const hideHeap = document.getElementById('hide-heap-allocate').checked;
        const onlyUserDebug = document.getElementById('only-user-debug').checked;
        renderTable(hideHeap, onlyUserDebug);
    }

    function handleDOMContentLoaded() {
        vscode.postMessage({ type: 'ready' });
        const heapCheckbox = document.getElementById('hide-heap-allocate');
        const debugCheckbox = document.getElementById('only-user-debug');
        function update() {
            renderTable(heapCheckbox.checked, debugCheckbox.checked);
        }
        heapCheckbox.addEventListener('change', update);
        debugCheckbox.addEventListener('change', update);
    }

    // --- Event Listeners ---
    window.addEventListener('message', handleWebviewMessage);
    document.addEventListener('DOMContentLoaded', handleDOMContentLoaded);
})();
