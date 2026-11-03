// Where the package is (the folder with its package.json), from wherever this file runs: src/ when
// run from source, dist/src/ when built, node_modules/redlines/dist/src/ when installed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = (() => {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (!fs.existsSync(path.join(dir, 'package.json'))) {
        const up = path.dirname(dir);
        if (up === dir) throw new Error('redlines: no package.json above its own files');
        dir = up;
    }
    return dir;
})();

export const VERSION: string = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version;
