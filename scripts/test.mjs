// npm test runs this after the build: the compiled tests, listed here so it works the same in every
// shell (Windows' cmd does not expand globs) and on every Node version.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const dir = path.join('dist', 'test');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).map(f => path.join(dir, f));
const run = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(run.status ?? 1);
