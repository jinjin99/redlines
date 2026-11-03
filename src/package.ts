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

/**
 * The project's .redlines/ folder, made if need be with a .gitignore of its own: what redlines keeps
 * there (captures, recordings of real backend data, logins) stays out of git unless a project opts in.
 */
export function workDir(root: string): string {
    const dir = path.join(root, '.redlines');
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '# Made by redlines: captures, recordings and logins stay out of git. Delete this file to keep some.\n*\n');
    return dir;
}
