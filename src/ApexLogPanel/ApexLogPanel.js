(function () {
    const vscode = acquireVsCodeApi();
    let lastData = [];
    let columnWidths = new Map();
    let resizingColumn = null;
    let startX = 0;
    let startWidth = 0;
    let sortConfig = { field: null, ascending: true };
    let activeResizeHandle = null;
    let isInitialized = false;
    let readLogIds = new Set(); // Track which logs have been read
    let compareLogIds = new Set();
    let currentMeta = null;
    let debouncedSearch = null;

    // Initialize state
    try {
        const state = vscode.getState() || {};
        columnWidths = new Map(state.columnWidths || []);
        sortConfig = state.sortConfig || { field: null, ascending: true };
        readLogIds = new Set(state.readLogIds || []); // Restore read states
        compareLogIds = new Set(state.compareLogIds || []);
    } catch (e) {
        console.error('Failed to get state:', e);
    }

    function saveState() {
        try {
            vscode.setState({
                version: 2,
                columnWidths: Array.from(columnWidths.entries()),
                sortConfig,
                readLogIds: Array.from(readLogIds),
                compareLogIds: Array.from(compareLogIds)
            });
        } catch (e) {
            console.error('Failed to save state:', e);
        }
    }

    // Initialize column widths from the header and store default values
    function initializeColumnWidths() {
        const defaultWidths = {
            'actions': 64,
            'user': 150,
            'time': 80,
            'status': 80,
            'size': 70,
            'operation': 400,
            'duration': 80
        };

        const headerCells = document.querySelectorAll('#grid-header .grid-cell');
        headerCells.forEach(cell => {
            const field = cell.dataset.field;
            // Use stored width, default width, or actual width in that order
            const width = columnWidths.get(field) || defaultWidths[field] || cell.offsetWidth;
            columnWidths.set(field, width);
            cell.style.width = `${width}px`;
            cell.style.flex = `0 0 ${width}px`;
        });

        saveState();
    }

    function initializeResizeHandles() {
        const headerCells = document.querySelectorAll('#grid-header .grid-cell');
        headerCells.forEach(cell => {
            const field = cell.dataset.field;
            // Remove existing handlers and resize handles
            const existingHandle = cell.querySelector('.resize-handle');
            if (existingHandle) {
                existingHandle.remove();
            }

            if (field === 'actions') {
                return;
            }

            // Create new resize handle
            const handle = document.createElement('div');
            handle.className = 'resize-handle';
            handle.addEventListener('mousedown', startResize);
            cell.appendChild(handle);

            // Remove existing click handlers
            cell.removeEventListener('click', cell.sortHandler);

            // Add new click handler for sorting
            cell.sortHandler = (e) => {
                if (e.target === cell) {
                    const field = cell.dataset.field;
                    sortByColumn(field);
                }
            };
            cell.addEventListener('click', cell.sortHandler);

            // Update sort indicator
            updateSortIndicator(cell);
        });
    }

    function timeToComparableValue(timeStr) {
        // Nuevo formato: 'HH:mm:ss|||HH:mm:ss DD/MM/YYYY|||timestamp'
        if (typeof timeStr === 'string' && timeStr.includes('|||')) {
            const parts = timeStr.split('|||');
            if (parts.length === 3) {
                return parseInt(parts[2], 10);
            }
        }
        // Fallback: intenta parsear como antes
        const [timePart, datePart] = timeStr.split(' ');
        if (!timePart || !datePart) return 0;
        const [hours, minutes, seconds] = timePart.split(':').map(Number);
        const [day, month, year] = datePart.split('/').map(Number);
        return new Date(year, month - 1, day, hours, minutes, seconds).getTime();
    }

    function sortData(data, field, ascending) {
        return [...data].sort((a, b) => {
            let aVal = a[field];
            let bVal = b[field];

            if (field === 'time') {
                aVal = timeToComparableValue(aVal);
                bVal = timeToComparableValue(bVal);

                return ascending ? aVal - bVal : bVal - aVal;
            }

            if (field === 'size') {
                // aVal y bVal son strings tipo '1.2MB' o '900.0KB'
                function parseSize(val) {
                    if (typeof val !== 'string') return 0;
                    if (val.endsWith('MB')) return parseFloat(val) * 1024 * 1024;
                    if (val.endsWith('KB')) return parseFloat(val) * 1024;
                    return parseFloat(val) || 0;
                }
                aVal = parseSize(aVal);
                bVal = parseSize(bVal);
                return ascending ? aVal - bVal : bVal - aVal;
            }

            if (field === 'duration') {
                // aVal y bVal son strings tipo '  1.23 s' o '   900 ms'
                function parseDuration(val) {
                    if (typeof val !== 'string') return 0;
                    val = val.trim();
                    // Extrae el número y la unidad correctamente
                    const match = val.match(/^([\d.,]+)\s*(ms|s)$/);
                    if (!match) return parseFloat(val) || 0;
                    const num = parseFloat(match[1].replace(',', '.'));
                    const unit = match[2];
                    if (unit === 's') return num * 1000;
                    if (unit === 'ms') return num;
                    return num;
                }
                aVal = parseDuration(aVal);
                bVal = parseDuration(bVal);
                return ascending ? aVal - bVal : bVal - aVal;
            }

            aVal = String(aVal || '').toLowerCase();
            bVal = String(bVal || '').toLowerCase();
            return ascending ?
                aVal.localeCompare(bVal) :
                bVal.localeCompare(aVal);
        });
    }

    function sortByColumn(field) {
        if (sortConfig.field === field) {
            sortConfig.ascending = !sortConfig.ascending;
        } else {
            sortConfig.field = field;
            sortConfig.ascending = true;
        }

        const sortedData = sortData(lastData, field, sortConfig.ascending);
        updateGrid(sortedData);

        document.querySelectorAll('#grid-header .grid-cell').forEach(cell => {
            updateSortIndicator(cell);
        });

        saveState();
    }

    function updateSortIndicator(cell) {
        const existingIndicator = cell.querySelector('.sort-indicator');
        if (existingIndicator) {
            existingIndicator.remove();
        }

        const field = cell.dataset.field;
        cell.setAttribute('role', 'columnheader');
        if (sortConfig.field === field) {
            const indicator = document.createElement('span');
            indicator.className = 'sort-indicator';
            indicator.textContent = sortConfig.ascending ? ' ↑' : ' ↓';
            cell.appendChild(indicator);
            cell.setAttribute('aria-sort', sortConfig.ascending ? 'ascending' : 'descending');
        } else {
            cell.setAttribute('aria-sort', 'none');
        }
    }

    function startResize(e) {
        e.preventDefault();
        const handle = e.target;
        const cell = handle.parentElement;
        resizingColumn = cell;
        startX = e.pageX;
        startWidth = cell.offsetWidth;
        activeResizeHandle = handle;

        document.body.classList.add('resizing');
        handle.style.backgroundColor = 'var(--vscode-focusBorder)';

        document.addEventListener('mousemove', resize);
        document.addEventListener('mouseup', stopResize);
    }

    function resize(e) {
        if (!resizingColumn) return;

        const width = Math.max(50, startWidth + (e.pageX - startX));
        const field = resizingColumn.dataset.field;

        resizingColumn.style.width = `${width}px`;
        resizingColumn.style.flex = `0 0 ${width}px`;

        const bodyCells = document.querySelectorAll(`#grid-body .grid-cell[data-field="${field}"]`);
        bodyCells.forEach(cell => {
            cell.style.width = `${width}px`;
            cell.style.flex = `0 0 ${width}px`;

            delete cell.dataset.truncated;
            cell.removeAttribute('title');

            const content = cell.textContent;
            const tempSpan = document.createElement('span');
            tempSpan.style.visibility = 'hidden';
            tempSpan.style.position = 'absolute';
            tempSpan.style.whiteSpace = 'nowrap';
            tempSpan.textContent = content;
            document.body.appendChild(tempSpan);

            const contentWidth = tempSpan.offsetWidth;
            document.body.removeChild(tempSpan);

            const availableWidth = width - 12;

            if (contentWidth > availableWidth) {
                cell.dataset.truncated = 'true';
                cell.title = content;
            }
        });

        columnWidths.set(field, width);
        saveState();
    }

    function stopResize() {
        if (!resizingColumn || !activeResizeHandle) return;

        document.body.classList.remove('resizing');
        activeResizeHandle.style.backgroundColor = '';
        resizingColumn = null;
        activeResizeHandle = null;

        document.removeEventListener('mousemove', resize);
        document.removeEventListener('mouseup', stopResize);

        saveState();
    }

    function updateGrid(data, errorInfo) {
        const gridBody = document.getElementById('grid-body');
        if (!gridBody) {
            console.error('Grid body element not found');
            return;
        }

        // Capture scroll position before clearing
        const scrollTop = gridBody.scrollTop;

        // Store current states before update
        const currentStates = new Map();
        document.querySelectorAll('#grid-body .grid-row').forEach(row => {
            const logId = row.querySelector('[data-log-id]')?.dataset.logId;
            if (logId) {
                currentStates.set(logId, {
                    read: row.dataset.read === 'true',
                    downloading: row.dataset.downloading === 'true',
                    selected: row.classList.contains('selected')
                });
            }
        });

        gridBody.innerHTML = '';
        document.querySelector('.grid')?.setAttribute('aria-busy', 'false');

        if (errorInfo && errorInfo.hasError) {
            // Show error fallback UI
            console.log('Fallback error UI triggered:', errorInfo);
            const errorMsg = document.createElement('div');
            errorMsg.className = 'empty-message';
            errorMsg.style.color = 'var(--vscode-editorError-foreground, #f14c4c)';
            errorMsg.style.fontSize = '1.3em';
            errorMsg.style.fontWeight = 'bold';
            errorMsg.style.background = 'var(--vscode-editor-background, #fff0f0)';
            errorMsg.style.border = '2px solid var(--vscode-editorError-foreground, #f14c4c)';
            errorMsg.style.borderRadius = '8px';
            errorMsg.style.margin = '32px auto';
            errorMsg.style.maxWidth = '500px';
            errorMsg.style.padding = '24px';
            errorMsg.innerHTML = `<b>Something went wrong.</b><br><span style='color:var(--vscode-descriptionForeground);font-size:1em;'>Check the output channel for details.<br>To retry, please click the <b>Refresh</b> button.</span>`;
            gridBody.appendChild(errorMsg);
            return;
        }

        if (!isInitialized) {
            initializeColumnWidths();
            initializeResizeHandles();
            isInitialized = true;
        }

        lastData = data;

        // If no data, show empty message and clear cache
        if (!data || data.length === 0) {
            const emptyMsg = document.createElement('div');
            emptyMsg.className = 'empty-message';
            emptyMsg.textContent = 'No logs found for this org.';
            gridBody.appendChild(emptyMsg);
            lastData = [];
            // Clear cached state
            saveState();
            return;
        }

        if (sortConfig.field) {
            data = sortData(data, sortConfig.field, sortConfig.ascending);
        }

        const fragment = document.createDocumentFragment();

        data.forEach(row => {
            const previousState = currentStates.get(row.id);
            const rowDiv = createRow(row, previousState);
            if (previousState?.selected) {
                rowDiv.classList.add('selected');
            }
            fragment.appendChild(rowDiv);
        });

        gridBody.appendChild(fragment);

        // Restore scroll position
        if (scrollTop > 0) {
            gridBody.scrollTop = scrollTop;
        }

        saveState();
    }

    function createRow(rowData, previousState = null) {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'grid-row';
        rowDiv.setAttribute('role', 'row');
        rowDiv.tabIndex = 0;

        // Set initial states based on previous state, readLogIds, or uiStatus
        let isRead = previousState ? previousState.read : (rowData.uiStatus === 'downloaded' || readLogIds.has(rowData.id));

        // If the log is downloaded, ensure downloading is false and remove any success/green state
        if (rowData.uiStatus === 'downloaded') {
            rowDiv.dataset.downloading = 'false';
            rowDiv.dataset.read = 'true';
            isRead = true;
        } else {
            rowDiv.dataset.downloading = previousState ? previousState.downloading.toString() : 'false';
            rowDiv.dataset.read = isRead.toString();
        }

        const idCell = document.createElement('div');
        idCell.style.display = 'none';
        idCell.dataset.logId = rowData.id;
        rowDiv.appendChild(idCell);

        const actionCell = document.createElement('div');
        actionCell.className = 'grid-cell action-cell';
        actionCell.dataset.field = 'actions';
        actionCell.setAttribute('role', 'gridcell');

        const favoriteButton = document.createElement('button');
        favoriteButton.type = 'button';
        favoriteButton.className = 'row-icon-button favorite-button';
        favoriteButton.textContent = rowData.favorite ? '★' : '☆';
        favoriteButton.title = rowData.favorite ? 'Remove favorite' : 'Add favorite';
        favoriteButton.setAttribute('aria-label', favoriteButton.title);
        favoriteButton.onclick = (event) => {
            event.stopPropagation();
            vscode.postMessage({ command: 'toggleFavorite', logId: rowData.id });
        };
        actionCell.appendChild(favoriteButton);

        const compareCheckbox = document.createElement('input');
        compareCheckbox.type = 'checkbox';
        compareCheckbox.className = 'compare-checkbox';
        compareCheckbox.checked = compareLogIds.has(rowData.id);
        compareCheckbox.title = 'Select for comparison';
        compareCheckbox.setAttribute('aria-label', `Select ${rowData.operation || 'log'} for comparison`);
        compareCheckbox.onclick = event => event.stopPropagation();
        compareCheckbox.onchange = () => {
            if (compareCheckbox.checked && compareLogIds.size >= 2) {
                compareCheckbox.checked = false;
                return;
            }
            if (compareCheckbox.checked) {
                compareLogIds.add(rowData.id);
            } else {
                compareLogIds.delete(rowData.id);
            }
            updateCompareButton();
            saveState();
        };
        actionCell.appendChild(compareCheckbox);
        rowDiv.appendChild(actionCell);

        rowDiv.onclick = () => {
            if (rowDiv.dataset.downloading === 'true') {
                return;
            }
            document.querySelectorAll('.grid-row.selected').forEach(row => {
                if (row !== rowDiv) {
                    row.classList.remove('selected');
                }
            });
            rowDiv.classList.add('selected');
            rowDiv.dataset.downloading = 'true';

            vscode.postMessage({
                command: 'openLog',
                log: { id: rowData.id }
            });
        };
        rowDiv.onkeydown = event => {
            if ((event.key === 'Enter' || event.key === ' ') && event.target === rowDiv) {
                event.preventDefault();
                rowDiv.click();
            }
        };

        const fields = ['user', 'time', 'status', 'size', 'operation', 'duration'];
        fields.forEach(field => {
            const cell = document.createElement('div');
            cell.className = 'grid-cell';
            cell.dataset.field = field;
            cell.setAttribute('role', 'gridcell');
            let timeTooltip = undefined;
            if (field === 'time' && typeof rowData[field] === 'string' && rowData[field].includes('|||')) {
                const [display, tooltip] = rowData[field].split('|||');
                cell.textContent = display;
                cell.title = tooltip;
                timeTooltip = tooltip;
            } else {
                cell.textContent = rowData[field];
            }
            const width = columnWidths.get(field);
            if (width) {
                cell.style.width = `${width}px`;
                cell.style.flex = `0 0 ${width}px`;
                const tempSpan = document.createElement('span');
                tempSpan.style.visibility = 'hidden';
                tempSpan.style.position = 'absolute';
                tempSpan.style.whiteSpace = 'nowrap';
                tempSpan.textContent = (field === 'time' && typeof rowData[field] === 'string' && rowData[field].includes('|||'))
                    ? rowData[field].split('|||')[0]
                    : rowData[field];
                document.body.appendChild(tempSpan);
                const contentWidth = tempSpan.offsetWidth;
                document.body.removeChild(tempSpan);
                const availableWidth = width - 12;
                if (contentWidth > availableWidth) {
                    cell.dataset.truncated = 'true';
                    // For 'time', always use the friendly tooltip, not the raw value
                    if (field === 'time' && timeTooltip) {
                        cell.title = timeTooltip;
                    } else {
                        cell.title = rowData[field];
                    }
                }
            }

            rowDiv.appendChild(cell);
        });

        return rowDiv;
    }

    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'updateData') {
            // Support error fallback
            updateGrid(message.data, message.errorInfo || null);
            if (message.meta) {
                updateMeta(message.meta, message.errorInfo || null);
            }
        } else if (message.type === 'logDownloaded' || message.type === 'logDownloadState') {
            const logId = message.logId;
            const row = document.querySelector(`[data-log-id="${logId}"]`)?.parentElement;
            if (row) {
                const state = message.type === 'logDownloaded' ? 'downloaded' : message.state;
                row.dataset.downloading = (state === 'downloading').toString();
                if (state === 'downloaded') {
                    row.dataset.read = 'true';
                    row.removeAttribute('title');
                    readLogIds.add(logId);
                } else if (state === 'failed') {
                    row.classList.remove('selected');
                    row.title = message.message || 'Failed to open log. Click to retry.';
                }
                saveState();
            }
        } else if (message.type === 'showSearchBox') {
            showInlineSearchBox();
        } else if (message.type === 'clearDownloadedState') {
            readLogIds.clear();
            updateGrid(lastData);
        } else if (message.type === 'orgChanged') {
            // Hide search bar on org change only
            debouncedSearch?.cancel();
            readLogIds.clear();
            compareLogIds.clear();
            updateCompareButton();
            const searchBar = document.getElementById('inline-search-bar');
            if (searchBar && searchBar.style.display === 'flex') {
                searchBar.style.display = 'none';
            }
        }
    });

    //Para la funcion de búsqueda evitar que se llame mientras se esta escribiendo
    function debounce(fn, delay) {
        let timer = null;
        const debounced = function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
        debounced.cancel = () => {
            clearTimeout(timer);
            timer = null;
        };
        return debounced;
    }

    function showInlineSearchBox() {
        const searchBar = document.getElementById('inline-search-bar');
        const input = document.getElementById('inline-search-input');
        if (searchBar && input) {
            if (searchBar.style.display === 'flex') {
                debouncedSearch?.cancel();
                searchBar.style.display = 'none';
                vscode.postMessage({ command: 'inlineSearch', text: '' });
            } else {
                searchBar.style.display = 'flex';
                input.value = '';
                input.focus();
                // Use debounce for search
                debouncedSearch?.cancel();
                debouncedSearch = debounce(() => {
                    vscode.postMessage({ command: 'inlineSearch', text: input.value });
                }, 200);
                input.oninput = debouncedSearch;
                input.onkeydown = (e) => {
                    if (e.key === 'Escape') {
                        debouncedSearch?.cancel();
                        searchBar.style.display = 'none';
                        vscode.postMessage({ command: 'inlineSearch', text: '' });
                    }
                };
            }
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        vscode.postMessage({ command: 'ready' });
        const gridBody = document.getElementById('grid-body');
        const gridHeader = document.getElementById('grid-header');
        if (gridBody && gridHeader) {
            gridBody.addEventListener('scroll', () => {
                gridHeader.style.transform = `translateX(-${gridBody.scrollLeft}px)`;
            });
        }
        document.getElementById('status-filter')?.addEventListener('change', postFilters);
        document.getElementById('user-filter')?.addEventListener('change', postFilters);
        document.getElementById('favorites-filter')?.addEventListener('click', event => {
            const button = event.currentTarget;
            const pressed = button.getAttribute('aria-pressed') !== 'true';
            button.setAttribute('aria-pressed', pressed.toString());
            button.textContent = pressed ? '★' : '☆';
            postFilters();
        });
        document.getElementById('regex-filter')?.addEventListener('click', event => {
            const button = event.currentTarget;
            const pressed = button.getAttribute('aria-pressed') !== 'true';
            button.setAttribute('aria-pressed', pressed.toString());
            postFilters();
        });
        document.getElementById('advanced-filter-toggle')?.addEventListener('click', event => {
            const button = event.currentTarget;
            const panel = document.getElementById('advanced-filters');
            const expanded = button.getAttribute('aria-expanded') !== 'true';
            button.setAttribute('aria-expanded', expanded.toString());
            if (panel) panel.hidden = !expanded;
        });
        ['date-filter', 'duration-filter', 'size-filter', 'exceptions-filter'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', postFilters);
        });
        document.getElementById('clear-advanced-filters')?.addEventListener('click', () => {
            document.getElementById('date-filter').value = '';
            document.getElementById('duration-filter').value = '';
            document.getElementById('size-filter').value = '';
            document.getElementById('exceptions-filter').checked = false;
            postFilters();
        });
        document.getElementById('export-filtered')?.addEventListener('click', () => {
            vscode.postMessage({ command: 'exportFilteredLogs' });
        });
        document.getElementById('load-older')?.addEventListener('click', () => {
            document.querySelector('.grid')?.setAttribute('aria-busy', 'true');
            vscode.postMessage({ command: 'loadOlder' });
        });
        document.getElementById('compare-button')?.addEventListener('click', () => {
            if (compareLogIds.size === 2) {
                vscode.postMessage({ command: 'compareLogs', logIds: Array.from(compareLogIds) });
            }
        });
        updateCompareButton();
    });

    // Listen for Ctrl+F to open the search bar
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            showInlineSearchBox();
        }
    });

    function postFilters() {
        vscode.postMessage({
            command: 'setFilters',
            filters: {
                text: document.getElementById('inline-search-input')?.value || '',
                useRegex: document.getElementById('regex-filter')?.getAttribute('aria-pressed') === 'true',
                status: document.getElementById('status-filter')?.value || '',
                user: document.getElementById('user-filter')?.value || '',
                favoritesOnly: document.getElementById('favorites-filter')?.getAttribute('aria-pressed') === 'true'
                ,dateFrom: document.getElementById('date-filter')?.value || ''
                ,minimumDurationMs: Number(document.getElementById('duration-filter')?.value || 0)
                ,minimumSizeKb: Number(document.getElementById('size-filter')?.value || 0)
                ,exceptionsOnly: Boolean(document.getElementById('exceptions-filter')?.checked)
            }
        });
    }

    function updateCompareButton() {
        const button = document.getElementById('compare-button');
        if (button) {
            button.disabled = compareLogIds.size !== 2;
            button.textContent = compareLogIds.size === 0 ? 'Compare' : `Compare (${compareLogIds.size}/2)`;
        }
    }

    function updateMeta(meta, errorInfo) {
        currentMeta = meta;
        const indicator = document.getElementById('connection-indicator');
        indicator?.classList.toggle('error', Boolean(errorInfo?.hasError));
        indicator?.classList.toggle('refreshing', Boolean(meta.isRefreshing));
        const activeOrg = document.getElementById('active-org');
        if (activeOrg) {
            activeOrg.textContent = errorInfo?.hasError ? 'Connection error' : formatOrg(meta.activeOrg);
            activeOrg.title = meta.activeOrg || '';
        }
        const logCount = document.getElementById('log-count');
        if (logCount) logCount.textContent = `${meta.visibleCount}/${meta.loadedCount} logs`;
        const lastRefresh = document.getElementById('last-refresh');
        if (lastRefresh) {
            lastRefresh.textContent = meta.lastSuccessfulRefresh
                ? `Updated ${new Date(meta.lastSuccessfulRefresh).toLocaleTimeString()}`
                : '';
        }
        updateSelect('status-filter', meta.statuses || [], meta.filters?.status || '', 'All statuses');
        updateSelect('user-filter', meta.users || [], meta.filters?.user || '', 'All users');
        const favoritesButton = document.getElementById('favorites-filter');
        if (favoritesButton) {
            const pressed = Boolean(meta.filters?.favoritesOnly);
            favoritesButton.setAttribute('aria-pressed', pressed.toString());
            favoritesButton.textContent = pressed ? '★' : '☆';
        }
        const regexButton = document.getElementById('regex-filter');
        if (regexButton) {
            regexButton.setAttribute('aria-pressed', Boolean(meta.filters?.useRegex).toString());
        }
        const dateFilter = document.getElementById('date-filter');
        if (dateFilter) dateFilter.value = meta.filters?.dateFrom || '';
        const durationFilter = document.getElementById('duration-filter');
        if (durationFilter) durationFilter.value = meta.filters?.minimumDurationMs || '';
        const sizeFilter = document.getElementById('size-filter');
        if (sizeFilter) sizeFilter.value = meta.filters?.minimumSizeKb || '';
        const exceptionsFilter = document.getElementById('exceptions-filter');
        if (exceptionsFilter) exceptionsFilter.checked = Boolean(meta.filters?.exceptionsOnly);
        const loadOlder = document.getElementById('load-older');
        if (loadOlder) loadOlder.hidden = !meta.hasMore;
    }

    function updateSelect(id, values, selected, emptyLabel) {
        const select = document.getElementById(id);
        if (!select) return;
        select.replaceChildren(new Option(emptyLabel, ''));
        values.forEach(value => select.add(new Option(value, value)));
        select.value = selected;
    }

    function formatOrg(instanceUrl) {
        try {
            return new URL(instanceUrl).hostname;
        } catch {
            return instanceUrl || 'Connected';
        }
    }
})();