import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { freePort } from '../src/app.js';
import { TOOLS } from '../src/tools.js';

const SERVER = `import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const dir = path.dirname(new URL(import.meta.url).pathname);
http.createServer((req, res) => {
    const file = path.join(dir, new URL(req.url, 'http://x').pathname === '/' ? 'index.html' : new URL(req.url, 'http://x').pathname);
    if (!file.startsWith(dir) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' });
    res.end(fs.readFileSync(file));
}).listen(Number(process.env.PORT));
`;

const PAGE = '<!doctype html><html><body><h1>Orders</h1><ul id="rows"></ul><div id="details" hidden><p id="note"></p></div><script src="/app.js"></script></body></html>';

const APP = `fetch('/api/orders').then(r => r.json()).then(orders => {
    document.getElementById('rows').innerHTML = orders.map(o => '<li><a href="#" class="order">' + o.id + '</a></li>').join('');
    document.querySelectorAll('.order').forEach(a => a.onclick = e => {
        e.preventDefault();
        document.getElementById('details').hidden = false;
        document.getElementById('note').textContent = 'Shipped with express delivery.';
    });
});
`;

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

test('capture_change: runs both versions itself, keeps the one before, and names the states the code change reaches', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-change-'));
    const app = path.join(root, 'app');
    fs.mkdirSync(app);
    fs.writeFileSync(path.join(app, 'serve.mjs'), SERVER);
    fs.writeFileSync(path.join(app, 'index.html'), PAGE);
    fs.writeFileSync(path.join(app, 'app.js'), APP);
    git(app, 'init', '-q', '-b', 'main');
    git(app, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git(app, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    git(app, 'checkout', '-qb', 'change');
    // The change: the details' copy (only after a click), and a function nothing calls yet.
    fs.writeFileSync(path.join(app, 'app.js'), APP.replace('Shipped with express delivery.', 'Ships express, arrives Friday.') + 'function retry() {\n    return fetch(\'/api/orders\');\n}\n');
    const port = await freePort();
    fs.writeFileSync(path.join(root, 'redlines.config.mjs'), `export default {
        app: { dir: './app', start: 'node serve.mjs', port: ${port}, base: 'main', timeout: 30 },
        mocks: { 'GET /api/orders': [{ id: '#1001' }] },
        states: {
            list: { path: '/', title: 'Orders' },
            details: { path: '/', title: 'Order details', steps: [{ click: 'text=#1001' }] },
        },
    };`);

    const tool = TOOLS.find(t => t.name === 'capture_change')!;
    const lines: string[] = [];
    const first = await tool.run({}, { root, log: l => lines.push(l) });
    assert.ok(!first.isError, first.text);
    assert.match(first.text, /Ships express, arrives Friday\./);
    assert.match(first.text, /States the change reaches:\n {2}details\n {4}app\.js:6/);
    assert.match(first.text, /Not reached: list/);
    assert.match(first.text, /Changed code no state ran[^\n]*\n {2}app\.js:9-11/);
    // The base was checked out beside the project, and the app stopped after each version.
    assert.ok(fs.existsSync(path.join(root, '.redlines', 'before', 'details.coverage.json')));
    await assert.rejects(fetch(`http://localhost:${port}/`));

    const second = await tool.run({}, { root, log: l => lines.push(l) });
    assert.ok(!second.isError, second.text);
    assert.match(second.text, /before: kept/);
});

test('coverage goes back through a source map to the lines of each original file that ran', async () => {
    const { mapCoverage } = await import('../src/coverage.js');
    // A bundle of two files, line for line: a.ts lines 1-3, then b.ts lines 1-3; b.ts's second line is a function nothing called.
    const bundle = ['const a1 = 1;', 'const a2 = 2;', 'const a3 = 3;', 'const b1 = 1;', 'function never() { return 0; }', 'const b3 = 3;'].join('\n');
    const vlq = (n: number) => {
        const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
        let v = n < 0 ? (-n << 1) | 1 : n << 1, out = '';
        do { let digit = v & 31; v >>>= 5; if (v) digit |= 32; out += B64[digit]; } while (v);
        return out;
    };
    // Generated line i → [source, original line]; fields are deltas from the previous segment.
    const at: [number, number][] = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]];
    let src = 0, line = 0;
    const mappings = at.map(([s, l]) => { const seg = vlq(0) + vlq(s - src) + vlq(l - line) + vlq(0); src = s; line = l; return seg; }).join(';');
    const map = { version: 3, sources: ['webpack://app/./src/a.ts', '../src/b.ts'], mappings };
    const source = `${bundle}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`;
    const start = bundle.indexOf('function never'), end = bundle.indexOf('\nconst b3');
    const coverage = await mapCoverage([{ url: 'http://app.test/bundle.js', source, functions: [{ ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }, { ranges: [{ startOffset: start, endOffset: end, count: 0 }] }] }], { origin: 'http://app.test', fetchText: async () => null });
    assert.deepEqual(coverage, { ran: { 'src/a.ts': [[1, 3]], 'src/b.ts': [[1, 1], [3, 3]] }, code: { 'src/a.ts': [[1, 3]], 'src/b.ts': [[1, 3]] } });
});

test('the base checkout shares installed dependencies, but a monorepo\'s own packages are its own', async () => {
    const { baseCheckout } = await import('../src/app.js');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-mono-'));
    fs.mkdirSync(path.join(repo, 'packages/ui'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'packages/ui/index.js'), 'export const label = "before";\n');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
    const base = git(repo, 'rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(repo, 'packages/ui/index.js'), 'export const label = "after";\n');
    // Installed: a dependency, a scoped one, and the workspace package linked in.
    fs.mkdirSync(path.join(repo, 'node_modules/left-pad'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'node_modules/@org/kit'), { recursive: true });
    fs.symlinkSync('../packages/ui', path.join(repo, 'node_modules/ui'));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-mono-root-'));
    const at = baseCheckout(root, repo, base);
    assert.equal(fs.realpathSync(path.join(at, 'node_modules/left-pad')), fs.realpathSync(path.join(repo, 'node_modules/left-pad')));
    assert.equal(fs.realpathSync(path.join(at, 'node_modules/@org/kit')), fs.realpathSync(path.join(repo, 'node_modules/@org/kit')));
    assert.match(fs.readFileSync(path.join(at, 'node_modules/ui/index.js'), 'utf8'), /before/);
});

test('in a file no state loaded, imports, re-exports, types and comments are not changes to see', async () => {
    const { declarationLines } = await import('../src/affected.js');
    const source = ['import a from "x";', 'import {', '  b,', '} from "y";', 'export type T =', '  | "a"', '  | "b";', 'const x = 1;', 'interface I {', '  f: (a: string) => void;', '}', '// why', 'function g() {', '  return 2;', '}', 'export { g };', 'export const h = () => 3;'].join('\n');
    const skipped = declarationLines(source);
    const code = source.split('\n').map((_, i) => i + 1).filter(l => !skipped.has(l));
    assert.deepEqual(code, [8, 13, 14, 15, 17]);
});

test('the build runs without the data proxy\'s variables; the app gets them', async () => {
    const { startApp } = await import('../src/app.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-env-'));
    fs.writeFileSync(path.join(dir, 'build.mjs'), "import fs from 'node:fs'; fs.writeFileSync('built.txt', String(process.env.HTTPS_PROXY ?? 'none') + ' ' + process.env.MODE);");
    fs.writeFileSync(path.join(dir, 'serve.mjs'), "import http from 'node:http'; http.createServer((_q, r) => r.end(String(process.env.HTTPS_PROXY ?? 'none') + ' ' + process.env.MODE)).listen(Number(process.env.PORT));");
    const port = await freePort();
    const app = await startApp({ dir, build: 'node build.mjs', start: 'node serve.mjs', port, env: { MODE: 'test' } }, { cwd: dir, env: { HTTPS_PROXY: 'http://127.0.0.1:1' }, log: path.join(dir, 'app.log') });
    try {
        assert.equal(fs.readFileSync(path.join(dir, 'built.txt'), 'utf8'), 'none test');
        assert.equal(await (await fetch(`http://localhost:${port}/`)).text(), 'http://127.0.0.1:1 test');
    } finally { await app.stop(); }
});

test('a failed build says why', async () => {
    const { startApp } = await import('../src/app.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-build-'));
    await assert.rejects(startApp({ dir, build: 'echo "schema fetch failed: 403" && exit 3', start: 'true', port: await freePort() }, { cwd: dir, log: path.join(dir, 'app.log') }), /exit 3[\s\S]*schema fetch failed: 403/);
});
