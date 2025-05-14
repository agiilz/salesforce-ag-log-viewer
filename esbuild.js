const esbuild = require('esbuild');

const baseConfig = {
    bundle: true,
    external: ['vscode'],  // Don't bundle vscode API
    format: 'cjs',
    loader: { '.ts': 'ts' },
    logLevel: 'info',
    minify: true,
    outdir: 'out',
    platform: 'node',
    sourcemap: true,
    target: 'node14',  // Match your engine.node version
};

// Build the extension
esbuild.buildSync({
    ...baseConfig,
    entryPoints: ['./src/extension.ts'],
});

// We don't bundle test files in production
if (process.argv.includes('--dev')) {
    esbuild.buildSync({
        ...baseConfig,
        entryPoints: ['./src/test/**/*.ts'],
        outdir: 'out/test',
    });
}
