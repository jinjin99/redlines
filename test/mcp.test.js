import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/mcp.js';
import { FIXTURES, serve } from './helpers.js';

/** A client talking to the server as an agent would, the project being a copy of the fixtures. */
async function connect(root) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer({ root }).connect(a);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(b);
    return client;
}
const textOf = r => r.content.filter(c => c.type === 'text').map(c => c.text).join('\n');

test('mcp: the tools and how to use them', async () => {
    const client = await connect(FIXTURES);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['compare', 'config', 'export', 'look', 'report', 'shoot']);
    assert.match(client.getInstructions(), /call `look` on it/);
});

test('mcp: look, config, shoot, compare, report, export', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(path.join(FIXTURES, '..', '..')), '.redlines-mcp-'));
    fs.copyFileSync(path.join(FIXTURES, 'redlines.config.mjs'), path.join(root, 'redlines.config.mjs'));
    const client = await connect(root);
    const before = await serve(path.join(FIXTURES, 'before'));
    const after = await serve(path.join(FIXTURES, 'after'));
    try {
        const looked = await client.callTool({ name: 'look', arguments: { url: `${after.base}/index.html`, mocks: { 'GET /api/orders': [{ id: '#7', customer: 'Kim', status: 'Paid', total: '$1.00' }] } } });
        assert.equal(looked.content[0].type, 'image');
        assert.match(textOf(looked), /<button\.button> "Refund"/);
        assert.match(textOf(looked), /"Kim"/);

        assert.match(textOf(await client.callTool({ name: 'config', arguments: {} })), /details: Order details dialog — \/index\.html, 1 step/);
        for (const [side, server] of [['before', before], ['after', after]]) {
            const shot = await client.callTool({ name: 'shoot', arguments: { base: server.base, out: `.redlines/${side}` } });
            assert.ok(!shot.isError, textOf(shot));
        }
        assert.match(textOf(await client.callTool({ name: 'compare', arguments: { before: '.redlines/before', after: '.redlines/after' } })), /column "Refund"/);
        assert.match(textOf(await client.callTool({ name: 'report', arguments: { before: '.redlines/before', after: '.redlines/after' } })), /\.redlines\/report\/index\.html/);
        assert.match(textOf(await client.callTool({ name: 'export', arguments: { shots: '.redlines/after' } })), /project\/list\.dc\.html/);

        const outside = await client.callTool({ name: 'report', arguments: { before: '.redlines/before', after: '.redlines/after', out: '../../elsewhere' } });
        assert.ok(outside.isError);
        assert.match(textOf(outside), /outside the project/);
    } finally {
        before.close(); after.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('mcp: no config says how to write one', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(path.join(FIXTURES, '..', '..')), '.redlines-mcp-'));
    try {
        const client = await connect(root);
        assert.match(textOf(await client.callTool({ name: 'config', arguments: {} })), /Write redlines\.config\.mjs/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
