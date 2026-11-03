import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { captureStates } from '../src/capture.js';
import { proxyEnv, startProxy, stopProxy } from '../src/proxy.js';
import type { Config } from '../src/types.js';

// Node's own fetch follows proxy variables from 22.21 / 24.5 on (NODE_USE_ENV_PROXY).
const [major, minor] = process.versions.node.split('.').map(Number);
const envProxy = major > 24 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21) || major === 23;

const freePort = () => new Promise<number>(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => resolve(port)); }); });

/** The backend: one endpoint, whose answer the test changes. */
function backend() {
    const state = { customer: 'Recorded customer' };
    const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ customer: state.customer })); });
    return new Promise<{ url: string; state: typeof state; close: () => void }>(resolve => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state, close: () => server.close() })));
}

/** A server-rendering app: it fetches the backend on the server and puts the answer in its HTML. */
async function ssrApp(api: string, env: Record<string, string>): Promise<{ base: string; child: ChildProcess }> {
    const port = await freePort();
    const code = `require('node:http').createServer(async (q, r) => { const d = await (await fetch(${JSON.stringify(`${api}/api/orders`)})).json(); r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><html><body><p>Customer: ' + d.customer + '</p></body></html>'); }).listen(${port}, '127.0.0.1', () => console.log('ready'));`;
    // The backend is on 127.0.0.1 here, which the proxy variables leave out by default: send it through too.
    const child = spawn(process.execPath, ['-e', code], { env: { ...process.env, ...env, NO_PROXY: '', no_proxy: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>(resolve => child.stdout!.once('data', () => resolve()));
    return { base: `http://127.0.0.1:${port}`, child };
}

test('data proxy: record what a server-rendering app fetches on the server, then replay it', { skip: !envProxy && 'this Node does not send fetch through proxy variables' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-proxy-'));
    const file = path.join(root, '.redlines', 'recording.har');
    const config: Config = { file: path.join(root, 'redlines.config.mjs'), states: { page: { path: '/' } } };
    const api = await backend();
    let app: { base: string; child: ChildProcess } | undefined;
    try {
        // Record: the app's server-side request goes through the proxy to the backend, and is kept.
        let proxy = await startProxy({ root, mode: 'record', file, port: await freePort() });
        app = await ssrApp(api.url, proxyEnv(proxy));
        await captureStates({ config, base: app.base, out: path.join(root, 'live'), root, log: () => {} });
        app.child.kill();
        await stopProxy(root);
        const urls = JSON.parse(fs.readFileSync(file, 'utf8')).log.entries.map((e: { request: { url: string } }) => new URL(e.request.url).pathname);
        assert.deepEqual(urls, ['/api/orders']);

        // The backend changes; replayed, the app still renders what was recorded.
        api.state.customer = 'Live customer';
        proxy = await startProxy({ root, mode: 'replay', file, port: await freePort() });
        app = await ssrApp(api.url, proxyEnv(proxy));
        // Two pages, so two server-side requests: every one is answered from the recording, not just the first.
        await captureStates({ config: { ...config, states: { page: { path: '/' }, again: { path: '/' } } }, base: app.base, out: path.join(root, 'replayed'), root, log: () => {} });
        const tree = fs.readFileSync(path.join(root, 'replayed/page.json'), 'utf8');
        assert.match(tree, /Customer: Recorded customer/);
        assert.doesNotMatch(tree, /Live customer/);
        app.child.kill();
        const stopped = await stopProxy(root);
        assert.match(stopped?.said ?? '', /2 answered from the recording, 0 passed on to the backend/);
        // Its own certificate authority, the key readable only by its owner, out of git.
        if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(root, '.redlines/proxy-ca/key.pem')).mode & 0o777, 0o600);
    } finally {
        app?.child.kill();
        await stopProxy(root);
        api.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
