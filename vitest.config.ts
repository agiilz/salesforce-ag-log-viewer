import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
    resolve: {
        alias: {
            vscode: path.resolve(__dirname, 'src/test/mocks/vscode.ts'),
        },
    },
    test: {
        environment: 'node',
        include: ['src/test/**/*.test.ts'],
        clearMocks: true,
        restoreMocks: true,
        maxWorkers: 1,
        fileParallelism: false,
        testTimeout: 10000,
    },
});