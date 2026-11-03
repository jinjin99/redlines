import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { captureStates, recordData } from '../src/capture.js';
import type { Config } from '../src/types.js';
import { FIXTURES } from './helpers.js';

/** The fixture app with a real backend behind it: its API answers with `customer`, and sets a cookie. */
function app(customer: string): Promise<{ base: string; close: () => void }> {
    const html = fs.readFileSync(path.join(FIXTURES, 'after/index.html'), 'utf8');
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            if (req.url?.startsWith('/api/orders')) {
                res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=secret-value' });
                res.end(JSON.stringify([{ id: '#5001', customer, status: 'Paid', total: '$5.00' }]));
                return;
            }
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(html);
        });
        server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }));
    });
}

test('record the data once, then capture any version from it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-rec-'));
    const har = path.join(dir, 'recording.har');
    const config: Config = { file: path.join(dir, 'redlines.config.mjs'), states: { list: { path: '/index.html' } } };
    const recordedFrom = await app('Recorded customer');
    try {
        const { results, answers } = await recordData({ config, base: recordedFrom.base, file: har, root: dir, log: () => {} });
        assert.ok(results[0].ok, results[0].error);
        assert.equal(answers, 1);
    } finally { recordedFrom.close(); }

    // Only the API answer: no page, no scripts, no headers, no cookies.
    const entries = JSON.parse(fs.readFileSync(har, 'utf8')).log.entries;
    assert.deepEqual(entries.map((e: { request: { url: string } }) => new URL(e.request.url).pathname), ['/api/orders']);
    assert.doesNotMatch(fs.readFileSync(har, 'utf8'), /secret-value|cookie/i);

    // Another version, whose backend now says something else: the page shows what was recorded.
    const later = await app('Live customer');
    try {
        await captureStates({ config: { ...config, recording: 'recording.har' }, base: later.base, out: path.join(dir, 'shots'), root: dir, log: () => {} });
        const tree = fs.readFileSync(path.join(dir, 'shots/list.json'), 'utf8');
        assert.match(tree, /Recorded customer/);
        assert.doesNotMatch(tree, /Live customer/);
    } finally {
        later.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
