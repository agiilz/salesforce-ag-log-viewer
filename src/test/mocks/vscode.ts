export const outputLines: string[] = [];

export const window = {
    createOutputChannel: () => ({
        appendLine: (line: string) => outputLines.push(line),
        show: () => undefined,
        dispose: () => undefined,
    }),
    showErrorMessage: () => Promise.resolve(undefined),
};

export const workspace = {
    workspaceFolders: [{ uri: { fsPath: 'C:\\workspace' } }],
    getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
    }),
};