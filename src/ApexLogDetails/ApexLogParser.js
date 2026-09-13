/* Shared by the webview, its parsing worker, and the regression tests. */
const VARIABLE_FRAME_STARTS = { CODE_UNIT_STARTED: 'unit', METHOD_ENTRY: 'method', CONSTRUCTOR_ENTRY: 'constructor',
    SYSTEM_METHOD_ENTRY: 'system', SYSTEM_CONSTRUCTOR_ENTRY: 'systemConstructor' };
const VARIABLE_FRAME_ENDS = { CODE_UNIT_FINISHED: 'unit', METHOD_EXIT: 'method', CONSTRUCTOR_EXIT: 'constructor',
    SYSTEM_METHOD_EXIT: 'system', SYSTEM_CONSTRUCTOR_EXIT: 'systemConstructor' };
class ApexLogParser {
    constructor() {
        this.rows = [];
        this.methods = [];
        this.nextBlockId = 0;
        this.previousEvent = null;
        this.fallbackTime = 0;
        this.executionMap = this.createExecutionMapModel();
        this.variableFrames = [{ family: 'root', declarations: new Map(), values: new Map() }];
    }

    static parse(content) {
        const parser = new ApexLogParser();
        const lines = content === '' ? [] : content.split(/\r?\n/);
        lines.forEach((line, idx) => parser.consumeLine(line, idx));
        return parser.finish();
    }

    static async parseAsync(content) {
        const parser = new ApexLogParser();
        const lines = content === '' ? [] : content.split(/\r?\n/);
        for (let idx = 0; idx < lines.length; idx++) {
            parser.consumeLine(lines[idx], idx);
            if (idx % 2000 === 1999) await new Promise(resolve => setTimeout(resolve, 0));
        }
        return parser.finish();
    }

    static severity(eventType) {
        if (eventType === 'FATAL_ERROR') return 'fatal';
        if (eventType === 'EXCEPTION_THROWN') return 'exception';
        if (eventType === 'FLOW_ELEMENT_FAULT') return 'fault';
        if (['FLOW_ELEMENT_ERROR', 'FLOW_CREATE_INTERVIEW_ERROR', 'FLOW_START_INTERVIEWS_ERROR'].includes(eventType)) return 'error';
        return null;
    }

    consumeLine(raw, idx) {
        // Only a timestamped event starts a record. Pipes in payloads and
        // continuation lines are content, not additional log fields.
        const match = raw.match(/^(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:\s*\(\d+\))?)\|([A-Z][A-Z0-9_]*)(?:\|(.*))?$/);
        let row;
        if (!match) {
            const parent = this.methods[this.methods.length - 1];
            row = { idx, raw, timestamp: '', eventType: '', lineNumber: '', level: '',
                details: raw, filterEventType: this.previousEvent?.eventType || '',
                severity: this.previousEvent?.severity || null,
                ownerIndex: this.previousEvent?.idx ?? idx,
                blockId: parent?.blockId ?? null, depth: this.methods.length,
                type: parent ? 'inner' : 'normal' };
        } else {
            const timestampRaw = match[1];
            const eventType = match[2];
            let details = match[3] || '';
            let lineNumber = '';
            let level = '';
            const lineMatch = details.match(/^(\[(?:\d+|EXTERNAL)\])(?:\||$)/);
            if (lineMatch) {
                lineNumber = lineMatch[1];
                details = details.slice(lineMatch[0].length);
            }
            if (eventType === 'USER_DEBUG') {
                const levelMatch = details.match(/^(NONE|ERROR|WARN|INFO|DEBUG|FINE|FINER|FINEST)\|/);
                if (levelMatch) {
                    level = levelMatch[1];
                    details = details.slice(levelMatch[0].length);
                }
            }
            const clock = timestampRaw.match(/\((\d+)\)$/);
            if (clock) {
                this.fallbackTime = Number(clock[1]);
                this.executionMap.hasClock = true;
            }
            const parent = this.methods[this.methods.length - 1];
            row = { idx, raw, timestamp: timestampRaw.replace(/\s*\(\d+\)$/, ''),
                elapsedNanoseconds: this.fallbackTime, eventType, filterEventType: eventType,
                details, lineNumber, level, severity: ApexLogParser.severity(eventType),
                ownerIndex: idx, blockId: parent?.blockId ?? null,
                depth: this.methods.length, type: parent ? 'inner' : 'normal' };
            this.consumeExecutionEvent(this.executionMap, row);
            this.consumeVariableEvent(row);
            if (eventType === 'METHOD_ENTRY') {
                row.type = 'entry';
                row.blockId = ++this.nextBlockId;
                this.methods.push(row);
            } else if (eventType === 'METHOD_EXIT' && parent) {
                this.methods.pop();
                row.type = 'exit';
                row.depth = this.methods.length;
                parent.endIndex = idx;
            }
            this.previousEvent = row;
        }
        row.searchText = [row.timestamp, row.filterEventType, row.lineNumber, row.level, row.details].join('\n').toLowerCase();
        if (row.variable) row.searchText += `\n${row.variable.type || ''}\n${row.variable.declaration ? 'variable declared' : 'variable assigned'}`.toLowerCase();
        this.rows.push(row);
    }

    consumeVariableEvent(row) {
        if (row.eventType === 'EXECUTION_STARTED' || row.eventType === 'EXECUTION_FINISHED') {
            this.variableFrames = [{ family: 'root', declarations: new Map(), values: new Map() }];
            return;
        }
        if (VARIABLE_FRAME_STARTS[row.eventType]) {
            this.variableFrames.push({ family: VARIABLE_FRAME_STARTS[row.eventType], declarations: new Map(), values: new Map() });
            return;
        }
        if (VARIABLE_FRAME_ENDS[row.eventType]) {
            const index = this.variableFrames.map(frame => frame.family).lastIndexOf(VARIABLE_FRAME_ENDS[row.eventType]);
            if (index > 0) this.variableFrames.length = index;
            return;
        }
        const frame = this.variableFrames[this.variableFrames.length - 1];
        if (row.eventType === 'VARIABLE_SCOPE_END') {
            // This event has no variable name. Forget the frame's bindings
            // rather than attribute a later assignment to an expired scope.
            frame.declarations.clear();
            frame.values.clear();
        } else if (row.eventType === 'VARIABLE_SCOPE_BEGIN') {
            const match = row.details.match(/^([^|]+)\|([^|]+)\|(true|false)\|(true|false)$/);
            if (!match) {
                frame.declarations.clear();
                frame.values.clear();
                return;
            }
            row.variable = { name: match[1], type: match[2], reference: match[3] === 'true',
                static: match[4] === 'true', declaration: true };
            frame.declarations.set(match[1], row.variable);
            frame.values.delete(match[1]);
        } else if (row.eventType === 'VARIABLE_ASSIGNMENT') {
            const separator = row.details.indexOf('|');
            if (separator < 1) return;
            const name = row.details.slice(0, separator);
            let value = row.details.slice(separator + 1);
            const address = value.match(/\|(0x[\da-f]+|null)$/i);
            if (address) value = value.slice(0, -address[0].length);
            if (!value) return;
            const declaration = frame.declarations.get(name);
            const previous = frame.values.get(name);
            const variable = { ...declaration, name, declaration: false, value,
                address: address && /^0x/i.test(address[1]) ? address[1].toLowerCase() : null, kind: ApexLogParser.valueKind(value),
                partial: /\(\d+ more\)\s*(?:\.\.\.|…)/.test(value) };
            // Qualified fields can refer to different objects during a loop.
            // Only relate them when their recorded object addresses agree.
            const sameBinding = (declaration && (!name.includes('.') || declaration.static)) ||
                (variable.address && variable.address === previous?.address);
            if (previous && sameBinding && !previous.partial && !variable.partial && previous.value !== value) {
                variable.previousIndex = previous.index;
            }
            row.variable = variable;
            frame.values.set(name, { index: row.idx, value, address: variable.address, partial: variable.partial });
        }
    }

    static valueKind(value) {
        if (value === 'null') return 'null';
        if (value === 'true' || value === 'false') return 'boolean';
        if (/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return 'number';
        if (/^0x[\da-f]+$/i.test(value)) return 'reference';
        if (value.startsWith('"')) return 'string';
        if (value.startsWith('{')) return 'object';
        if (value.startsWith('[')) return 'array';
        return 'text';
    }

    finish() {
        for (const row of this.methods) row.endIndex = this.rows.length;
        this.finishExecutionMapModel(this.executionMap, this.fallbackTime, this.rows.length);
        return { rows: this.rows, executionMap: this.executionMap };
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
            hasClock: false,
            counts: { debug: 0, exception: 0, error: 0, fault: 0, fatal: 0 }
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

        const kind = event.severity || (event.eventType === 'USER_DEBUG' ? 'debug' : null);
        if (kind) {
            model.counts[kind]++;
            model.markers.push({ kind, index: event.idx, time: eventTime,
                label: event.details || event.eventType, eventType: event.eventType });
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
                lastIndex: event.idx,
                depth: model.openSpans.length,
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
            openSpan.lastIndex = endIndex;
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
            span.lastIndex = Math.max(span.startIndex, endIndex - 1);
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
        // Self time is elapsed time outside direct children, never CPU time.
        // Merge clipped intervals so malformed/overlapping timestamps cannot
        // subtract the same time twice.
        for (const span of model.spans) {
            let covered = 0;
            let cursor = span.startTime;
            const children = span.children.map(id => model.spans[id]).sort((a, b) => a.startTime - b.startTime);
            for (const child of children) {
                const end = Math.min(span.endTime, child.endTime);
                covered += Math.max(0, end - Math.max(cursor, child.startTime));
                cursor = Math.max(cursor, end);
            }
            span.selfDuration = Math.max(0, span.duration - covered);
        }
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

}

if (typeof module !== 'undefined' && module.exports) module.exports = { ApexLogParser };
