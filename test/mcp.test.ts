import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/mcp.js';
import { PACKAGE_ROOT } from '../src/package.js';
import { FIXTURES, serve } from './helpers.js';

/** A client talking to the server as an agent would, the project being a copy of the fixtures. */
async function connect(root: string) {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer({ root }).connect(a);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(b);
    return client;
}
type Content = { type: string; text?: string };
const contentOf = (r: unknown) => (r as { content: Content[] }).content;
const textOf = (r: unknown) => contentOf(r).filter(c => c.type === 'text').map(c => c.text).join('\n');

test('mcp: the tools and how to use them', async () => {
    const client = await connect(FIXTURES);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(t => t.name).sort(), ['capture_states', 'create_review', 'export_design', 'find_changes', 'list_states', 'log_in', 'view_page']);
    assert.match(client.getInstructions() ?? '', /call view_page on it/);
});

test('mcp: view_page, list_states, capture_states, find_changes, create_review, export_design', async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(path.join(FIXTURES, '..', '..')), '.redlines-mcp-'));
    fs.copyFileSync(path.join(FIXTURES, 'redlines.config.mjs'), path.join(root, 'redlines.config.mjs'));
    const client = await connect(root);
    const before = await serve(path.join(FIXTURES, 'before'));
    const after = await serve(path.join(FIXTURES, 'after'));
    try {
        const looked = await client.callTool({ name: 'view_page', arguments: { url: `${after.base}/index.html`, mocks: { 'GET /api/orders': [{ id: '#7', customer: 'Kim', status: 'Paid', total: '$1.00' }] } } });
        assert.equal(contentOf(looked)[0].type, 'image');
        assert.match(textOf(looked), /<button\.button> "Refund"/);
        assert.match(textOf(looked), /"Kim"/);

        assert.match(textOf(await client.callTool({ name: 'list_states', arguments: {} })), /details: Order details dialog — \/index\.html, 1 step/);
        for (const [side, server] of [['before', before], ['after', after]] as const) {
            const shot = await client.callTool({ name: 'capture_states', arguments: { base: server.base, out: `.redlines/${side}` } });
            assert.ok(!shot.isError, textOf(shot));
        }
        assert.match(textOf(await client.callTool({ name: 'find_changes', arguments: { before: '.redlines/before', after: '.redlines/after' } })), /column "Refund"/);
        assert.match(textOf(await client.callTool({ name: 'create_review', arguments: { before: '.redlines/before', after: '.redlines/after' } })), /\.redlines\/review\/index\.html/);
        assert.match(textOf(await client.callTool({ name: 'export_design', arguments: { from: '.redlines/after' } })), /project\/list\.dc\.html/);

        const outside = await client.callTool({ name: 'create_review', arguments: { before: '.redlines/before', after: '.redlines/after', out: '../../elsewhere' } });
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
        assert.match(textOf(await client.callTool({ name: 'list_states', arguments: {} })), /Write redlines\.config\.mjs/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('cli: the same tools, by the same names', async () => {
    const { execFileSync } = await import('node:child_process');
    const { TOOLS } = await import('../src/tools.js');
    const bin = path.join(PACKAGE_ROOT, 'dist/bin/redlines.js');
    const helpText = execFileSync('node', [bin, 'help'], { encoding: 'utf8' });
    for (const t of TOOLS) assert.match(helpText, new RegExp(`^  ${t.name} `, 'm'));
    const listed = execFileSync('node', [bin, 'list_states'], { cwd: FIXTURES, encoding: 'utf8' });
    assert.match(listed, /details: Order details dialog/);
    // Inputs are checked as the MCP server checks them.
    assert.throws(() => execFileSync('node', [bin, 'capture_states', '--base', 'not a url', '--out', 'x'], { cwd: FIXTURES, stdio: 'pipe' }), /--base: Invalid url/);
    assert.throws(() => execFileSync('node', [bin, 'find_changes', '--nope', 'x'], { cwd: FIXTURES, stdio: 'pipe' }), /has no input --nope/);
});
