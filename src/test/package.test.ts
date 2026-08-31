import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));

describe('extension package integrity', () => {
    it('keeps package and lock versions aligned', () => {
        expect(packageLock.version).toBe(packageJson.version);
        expect(packageLock.packages[''].version).toBe(packageJson.version);
    });

    it('references runtime assets that exist', () => {
        expect(fs.existsSync(path.join(root, packageJson.icon))).toBe(true);
        for (const grammar of packageJson.contributes.grammars) {
            expect(fs.existsSync(path.join(root, grammar.path))).toBe(true);
        }
    });

    it('does not retain the hard-coded Salesforce API version', () => {
        const sourceFiles = ['src/commands.ts', 'src/ApexLogDataProvider.ts', 'src/ApexLogWrapper.ts'];
        for (const sourceFile of sourceFiles) {
            expect(fs.readFileSync(path.join(root, sourceFile), 'utf8')).not.toContain('/services/data/v58.0');
        }
    });
});