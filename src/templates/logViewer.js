(function() {
    const vscode = acquireVsCodeApi();
    let lastData = [];
    let columnWidths = new Map();
    let resizingColumn = null;
    let startX = 0;
    let startWidth = 0;
    let sortConfig = { field: null, ascending: true };
    let activeResizeHandle = null;

    // Initialize state
    try {
        const state = vscode.getState() || {};
        lastData = state.data || [];
        columnWidths = new Map(state.columnWidths || []);
        sortConfig = state.sortConfig || { field: null, ascending: true };
    } catch (e) {
        console.error('Failed to get state:', e);
    }

    function saveState() {
        try {
            vscode.setState({
                data: lastData,
                columnWidths: Array.from(columnWidths.entries()),
                sortConfig
            });
        } catch (e) {
            console.error('Failed to save state:', e);
        }
    }

    function initializeResizeHandles() {
        const headerCells = document.querySelectorAll('#grid-header .grid-cell');
        headerCells.forEach(cell => {
            // Remove existing handlers and resize handles
            const existingHandle = cell.querySelector('.resize-handle');
            if (existingHandle) {
                existingHandle.remove();
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
        const [hours, minutes, seconds] = timeStr.split(':').map(Number);
        // For chronological sorting, we need to handle the day boundary
        // If we see times like 01:xx and 00:xx together with 23:xx,
        // we assume 01:xx and 00:xx are more recent (from current day)
        // and 23:xx is from previous day
        let adjustedHours;
        if (hours >= 20) { // Late hours (20:xx-23:xx)
            adjustedHours = hours - 24; // Make them negative to sort before early hours
        } else {
            adjustedHours = hours; // Early hours (00:xx-19:xx) stay as is
        }
        return adjustedHours * 3600 + minutes * 60 + seconds;
    }

    function sortData(data, field, ascending) {
        return [...data].sort((a, b) => {
            let aVal = a[field];
            let bVal = b[field];

            // Special handling for time column
            if (field === 'time') {
                aVal = timeToComparableValue(aVal);
                bVal = timeToComparableValue(bVal);
                // For time, descending means newest first
                return ascending ? bVal - aVal : aVal - bVal;
            }

            // Special handling for size and duration columns
            if (field === 'size' || field === 'duration') {
                aVal = parseFloat(aVal) || 0;
                bVal = parseFloat(bVal) || 0;
                return ascending ? aVal - bVal : bVal - aVal;
            }

            // Default string comparison
            aVal = String(aVal || '').toLowerCase();
            bVal = String(bVal || '').toLowerCase();
            return ascending ? 
                aVal.localeCompare(bVal) : 
                bVal.localeCompare(aVal);
        });
    }

    function sortByColumn(field) {
        console.log('Sorting by column:', field, 'Current config:', sortConfig);
        
        // Toggle ascending/descending or set initial sort
        if (sortConfig.field === field) {
            sortConfig.ascending = !sortConfig.ascending;
        } else {
            sortConfig.field = field;
            sortConfig.ascending = true;
        }

        console.log('New sort config:', sortConfig);

        // Apply the sort
        const sortedData = sortData(lastData, field, sortConfig.ascending);
        updateGrid(sortedData);

        // Update sort indicators
        document.querySelectorAll('#grid-header .grid-cell').forEach(cell => {
            updateSortIndicator(cell);
        });

        // Save the state
        saveState();
    }

    function updateSortIndicator(cell) {
        // Remove existing indicator
        const existingIndicator = cell.querySelector('.sort-indicator');
        if (existingIndicator) {
            existingIndicator.remove();
        }

        const field = cell.dataset.field;
        if (sortConfig.field === field) {
            const indicator = document.createElement('span');
            indicator.className = 'sort-indicator';
            indicator.textContent = sortConfig.ascending ? ' ↑' : ' ↓';
            cell.appendChild(indicator);
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
        
        // Update header cell width
        resizingColumn.style.width = `${width}px`;
        resizingColumn.style.flex = `0 0 ${width}px`;
        
        // Update all body cells in this column and check for truncation
        const bodyCells = document.querySelectorAll(`#grid-body .grid-cell[data-field="${field}"]`);
        bodyCells.forEach(cell => {
            cell.style.width = `${width}px`;
            cell.style.flex = `0 0 ${width}px`;
            
            // Reset truncation state
            delete cell.dataset.truncated;
            cell.removeAttribute('title');
            
            // Check if content would be truncated with new width
            const content = cell.textContent;
            const tempSpan = document.createElement('span');
            tempSpan.style.visibility = 'hidden';
            tempSpan.style.position = 'absolute';
            tempSpan.style.whiteSpace = 'nowrap';
            tempSpan.textContent = content;
            document.body.appendChild(tempSpan);
            
            const contentWidth = tempSpan.offsetWidth;
            document.body.removeChild(tempSpan);
            
            // Account for padding in the cell
            const availableWidth = width - 12; // 6px padding on each side
            
            if (contentWidth > availableWidth) {
                cell.dataset.truncated = 'true';
                cell.title = content;
            }
        });
        
        // Store the new width
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
    }    function updateGrid(data) {
        lastData = data;
        const gridBody = document.getElementById('grid-body');
        if (!gridBody) {
            console.error('Grid body element not found');
            return;
        }

        // Store current scroll position and selected log ID
        const scrollTop = gridBody.scrollTop;
        const selectedRow = document.querySelector('.grid-row.selected');
        const selectedLogId = selectedRow ? selectedRow.querySelector('[data-log-id]')?.dataset.logId : null;

        // Keep track of existing rows by their log ID
        const existingRows = new Map();
        gridBody.querySelectorAll('.grid-row').forEach(row => {
            const logId = row.querySelector('[data-log-id]')?.dataset.logId;
            if (logId) {
                existingRows.set(logId, row);
            }
        });

        // Temp container for new rows
        const fragment = document.createDocumentFragment();
        const newRows = new Map();

        // Apply current sort if we have one
        if (sortConfig.field) {
            data = sortData(data, sortConfig.field, sortConfig.ascending);
        }

        data.forEach(row => {
            let existingRow = existingRows.get(row.id);

            if (existingRow) {
                // Update existing row content if needed
                updateRowContent(existingRow, row);
                newRows.set(row.id, existingRow);
                existingRows.delete(row.id);
            } else {
                // Create new row
                const rowDiv = createRow(row);
                newRows.set(row.id, rowDiv);
                fragment.appendChild(rowDiv);
            }
        });

        // Remove rows that are no longer in the data set
        existingRows.forEach(row => {
            row.style.opacity = '0';
            row.addEventListener('transitionend', () => row.remove(), { once: true });
        });

        // Update DOM efficiently
        if (fragment.children.length > 0) {
            gridBody.append(fragment);
        }

        // Move existing rows to correct positions
        newRows.forEach((rowDiv, id) => {
            gridBody.appendChild(rowDiv);
        });

        // Restore scroll position and selection
        gridBody.scrollTop = scrollTop;
        if (selectedLogId) {
            const rowToSelect = document.querySelector(`[data-log-id="${selectedLogId}"]`)?.parentElement;
            if (rowToSelect) {
                rowToSelect.classList.add('selected');
            }
        }
    }

    function updateRowContent(rowDiv, data) {
        // Only update cell contents if they've changed
        rowDiv.querySelectorAll('.grid-cell').forEach(cell => {
            const field = cell.dataset.field;
            if (field && data[field] !== cell.textContent) {
                cell.textContent = data[field];
                
                // Update truncation if needed
                if (cell.dataset.truncated) {
                    const width = parseInt(cell.style.width);
                    const tempSpan = document.createElement('span');
                    tempSpan.style.visibility = 'hidden';
                    tempSpan.style.position = 'absolute';
                    tempSpan.style.whiteSpace = 'nowrap';
                    tempSpan.textContent = data[field];
                    document.body.appendChild(tempSpan);
                    
                    const contentWidth = tempSpan.offsetWidth;
                    document.body.removeChild(tempSpan);
                    
                    const availableWidth = width - 12;
                    if (contentWidth > availableWidth) {
                        cell.dataset.truncated = 'true';
                        cell.title = data[field];
                    } else {
                        delete cell.dataset.truncated;
                        cell.removeAttribute('title');
                    }
                }
            }
        });
    }    function createRow(rowData) {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'grid-row';
        rowDiv.dataset.read = 'false'; // Mark as unread by default

        // Add data-log-id attribute for selection tracking
        const idCell = document.createElement('div');
        idCell.style.display = 'none';
        idCell.dataset.logId = rowData.id;
        rowDiv.appendChild(idCell);
        
        // Handle click event
        rowDiv.onclick = () => {
            // Remove selected class from any previously selected row
            document.querySelectorAll('.grid-row.selected').forEach(row => {
                if (row !== rowDiv) {
                    row.classList.remove('selected');
                }
            });
              // Add selected class to clicked row and mark as read
            rowDiv.classList.add('selected');
            rowDiv.dataset.read = 'true';
            
            vscode.postMessage({
                command: 'openLog',
                log: { id: rowData.id }
            });
        };
        
        const fields = ['user', 'time', 'status', 'size', 'operation', 'duration'];
        fields.forEach(field => {
            const cell = document.createElement('div');
            cell.className = 'grid-cell';
            cell.dataset.field = field;
            cell.textContent = rowData[field];
            
            const width = columnWidths.get(field);
            if (width) {
                cell.style.width = `${width}px`;
                cell.style.flex = `0 0 ${width}px`;
                
                const tempSpan = document.createElement('span');
                tempSpan.style.visibility = 'hidden';
                tempSpan.style.position = 'absolute';
                tempSpan.style.whiteSpace = 'nowrap';
                tempSpan.textContent = rowData[field];
                document.body.appendChild(tempSpan);
                
                const contentWidth = tempSpan.offsetWidth;
                document.body.removeChild(tempSpan);
                
                const availableWidth = width - 12;
                if (contentWidth > availableWidth) {
                    cell.dataset.truncated = 'true';
                    cell.title = rowData[field];
                }
            }
            
            rowDiv.appendChild(cell);
        });
        
        return rowDiv;
    }

    // Initialize column widths from the header
    function initializeColumnWidths() {
        const headerCells = document.querySelectorAll('#grid-header .grid-cell');
        headerCells.forEach(cell => {
            const field = cell.dataset.field;
            const width = columnWidths.get(field) || parseInt(cell.style.width) || cell.offsetWidth;
            columnWidths.set(field, width);
            cell.style.width = `${width}px`;
            cell.style.flex = `0 0 ${width}px`;
        });
        
        // Apply initial widths to body cells
        document.querySelectorAll('#grid-body .grid-cell').forEach(cell => {
            const width = columnWidths.get(cell.dataset.field);
            if (width) {
                cell.style.width = `${width}px`;
                cell.style.flex = `0 0 ${width}px`;
            }
        });
    }

    // Handle messages from the extension
    window.addEventListener('message', event => {
        const message = event.data;
        
        if (message.type === 'updateData') {
            updateGrid(message.data);
            initializeResizeHandles(); // Reinitialize handles after update
        }
    });

    // Initial setup
    document.addEventListener('DOMContentLoaded', () => {
        // Signal that we're ready to receive data
        vscode.postMessage({ command: 'ready' });
        
        // Initialize column widths
        initializeColumnWidths();
        
        // If we have last known data, show it
        if (lastData.length > 0) {
            updateGrid(lastData);
        }
        
        // Initialize the resize handles
        initializeResizeHandles();

        // Set up scroll synchronization
        const gridBody = document.getElementById('grid-body');
        const gridHeader = document.getElementById('grid-header');

        gridBody.addEventListener('scroll', () => {
            gridHeader.style.transform = `translateX(-${gridBody.scrollLeft}px)`;
        });
    });
})();