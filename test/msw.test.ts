import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { captureStates } from '../src/capture.js';
import type { Config, PageTree } from '../src/types.js';
import { FIXTURES, serve } from './helpers.js';

const texts = (file: string) => JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')) as PageTree);

test("msw: the project's handlers answer the page, and a state can pick a scenario", async () => {
    const server = await serve(path.join(FIXTURES, 'after'));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-msw-'));
    try {
        const config: Config = {
            file: path.join(FIXTURES, 'redlines.config.mjs'),
            msw: './msw/handlers.mjs',
            states: {
                list: { path: '/index.html' },
                empty: { path: '/index.html', msw: 'empty' },
                // A config mock still comes first.
                mocked: { path: '/index.html', mocks: { 'GET /api/orders': [{ id: '#9', customer: 'From the config', status: 'Paid', total: '$1' }] } },
                typo: { path: '/index.html', msw: 'emtpy' },
            },
        };
        const results = await captureStates({ config, base: server.base, out, log: () => {} });
        assert.match(texts(path.join(out, 'list.json')), /Edsger Dijkstra/);
        assert.doesNotMatch(texts(path.join(out, 'empty.json')), /Edsger Dijkstra|Barbara Liskov/);
        assert.match(texts(path.join(out, 'mocked.json')), /From the config/);
        assert.match(results.find(r => r.name === 'typo')?.error ?? '', /no handler list "emtpy" \(it has (handlers, empty|empty, handlers)\)/);
    } finally {
        server.close();
        fs.rmSync(out, { recursive: true, force: true });
    }
});

test('msw: handlers written in TypeScript', { skip: !(process.features as { typescript?: unknown }).typescript && 'this Node does not load TypeScript' }, async () => {
    const server = await serve(path.join(FIXTURES, 'after'));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-msw-ts-'));
    try {
        const config: Config = { file: path.join(FIXTURES, 'redlines.config.mjs'), msw: './msw/handlers.ts', states: { list: { path: '/index.html' } } };
        await captureStates({ config, base: server.base, out, log: () => {} });
        assert.match(texts(path.join(out, 'list.json')), /Frances Allen/);
    } finally {
        server.close();
        fs.rmSync(out, { recursive: true, force: true });
    }
});
