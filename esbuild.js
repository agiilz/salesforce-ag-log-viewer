const esbuild = require('esbuild');
const fs = require('fs');

const isProduction = process.argv.includes('--production');
const isWatch = process.argv.includes('--watch');

const baseConfig = {
    bundle: true,
    external: ['vscode'],  // Don't bundle vscode API
    format: 'cjs',
    loader: { '.ts': 'ts' },
    logLevel: 'info',
    minify: isProduction,
    outfile: 'out/extension.js',
    platform: 'node',
    sourcemap: !isProduction,
    target: 'node20',
};

async function build() {
    if (!isWatch) {
        fs.rmSync('out', { recursive: true, force: true });
    }

    if (isWatch) {
        const context = await esbuild.context({
            ...baseConfig,
            entryPoints: ['./src/extension.ts'],
        });
        await context.watch();
        console.log('Watching extension sources...');
        return;
    }

    await esbuild.build({
        ...baseConfig,
        entryPoints: ['./src/extension.ts'],
    });
}

build().catch(() => process.exit(1));
