// A static server per fixture folder, and the fixture app shot before and after its change.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureStates, loadConfig } from '../src/capture.js';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function serve(dir) {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
            if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
            fs.createReadStream(file).pipe(res);
        });
        server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
    });
}

let shots;
/** Both versions of the fixture app shot once for all tests: { before, after } folders. */
export async function fixtureShots() {
    shots ??= (async () => {
        const config = await loadConfig(path.join(FIXTURES, 'redlines.config.mjs'));
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-test-'));
        const dirs = {};
        for (const side of ['before', 'after']) {
            const server = await serve(path.join(FIXTURES, side));
            dirs[side] = path.join(out, side);
            try { await captureStates({ config, base: server.base, out: dirs[side], log: () => {} }); } finally { server.close(); }
        }
        return { ...dirs, out };
    })();
    return shots;
}
