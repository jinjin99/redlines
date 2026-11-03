// A static server per fixture folder, and the fixture app captured before and after its change.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { captureStates, loadConfig } from '../src/capture.js';
import { PACKAGE_ROOT } from '../src/package.js';

export const FIXTURES = path.join(PACKAGE_ROOT, 'test/fixtures');

export interface Served { base: string; close: () => void }

export function serve(dir: string): Promise<Served> {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            const file = path.join(dir, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
            if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
            fs.createReadStream(file).pipe(res);
        });
        server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }));
    });
}

let shots: Promise<{ before: string; after: string; out: string }> | undefined;
/** Both versions of the fixture app captured once for all tests: { before, after } folders. */
export function fixtureShots() {
    shots ??= (async () => {
        const config = await loadConfig(path.join(FIXTURES, 'redlines.config.mjs'));
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-test-'));
        const dirs = { before: path.join(out, 'before'), after: path.join(out, 'after') };
        for (const side of ['before', 'after'] as const) {
            const server = await serve(path.join(FIXTURES, side));
            try { await captureStates({ config, base: server.base, out: dirs[side], log: () => {} }); } finally { server.close(); }
        }
        return { ...dirs, out };
    })();
    return shots;
}
