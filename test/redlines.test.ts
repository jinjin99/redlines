import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { align, diffTrees, formatChanges } from '../src/diff.js';
import { findChanges, writeReport } from '../src/report.js';
import type { Box, Config, PageTree, TreeElement, TreeNode, TreeText } from '../src/types.js';
import { fixtureShots } from './helpers.js';

const tree = (...children: TreeNode[]): PageTree => ({ version: 1, url: 'about:blank', title: '', viewport: { width: 100, height: 100 }, size: { width: 100, height: 100 }, root: { tag: 'body', style: {}, box: [0, 0, 100, 100], children } });
const el = (tag: string, extra: Partial<TreeElement> = {}, ...children: TreeNode[]): TreeElement => ({ tag, style: {}, box: [0, 0, 10, 10], ...extra, children });
const text = (t: string): TreeText => ({ text: t, box: [0, 0, 10, 10] });

test('align: equal sequences are one equal run', () => {
    assert.deepEqual(align(['a', 'b'], ['a', 'b']), [{ op: 'equal', a0: 0, a1: 2, b0: 0, b1: 2 }]);
});

test('diff: a changed text is one change with what it was', () => {
    const list = diffTrees(tree(el('p', { name: 'note' }, text('Old copy'))), tree(el('p', { name: 'note' }, text('New copy'))));
    assert.equal(list.length, 1);
    assert.equal(list[0].kind, 'changed');
    assert.deepEqual(list[0].now, ['"New copy"']);
    assert.deepEqual(list[0].was, ['"Old copy"']);
});

test('diff: a component whose props changed says so', () => {
    const badge = (tone: string) => el('span', { component: { name: 'Badge', props: { tone } } }, text('Paid'));
    const [c] = diffTrees(tree(badge('info')), tree(badge('success')));
    assert.equal(c.kind, 'changed');
    assert.match(c.now[0], /<Badge tone="success">/);
});

test('diff: a style change is listed property by property', () => {
    const btn = (color: string): TreeElement => ({ ...el('button', { name: 'save' }, text('Save')), style: { 'background-color': color } });
    const [c] = diffTrees(tree(btn('rgb(0, 0, 255)')), tree(btn('rgb(0, 128, 0)')));
    assert.deepEqual(c.styles, [{ who: 'save', property: 'background-color', was: 'rgb(0, 0, 255)', now: 'rgb(0, 128, 0)' }]);
});

test('diff: inherited styles count where they are set, not on every child', () => {
    const page = (color: string): TreeElement => ({ ...el('div', { name: 'card' }, el('p', {}, text('a')), el('p', {}, text('b'))), style: { color } });
    const withChildren = (color: string) => { const p = page(color); p.children!.forEach(c => ((c as TreeElement).style = { color })); return p; };
    const list = diffTrees(tree(withChildren('rgb(0, 0, 0)')), tree(withChildren('rgb(255, 0, 0)')));
    assert.equal(list.length, 1);
});

test('capture → find changes: the fixture app, before and after', async () => {
    const { before, after } = await fixtureShots();
    const states = findChanges(before, after);
    const list = states.find(s => s.name === 'list');
    assert.ok(list);
    assert.equal(list.status, 'changed');
    const text = formatChanges(list.changes);
    // The header: Export restyled and a New order button beside it, as one change.
    assert.match(text, /changed in page › page-header.*"Export".*"New order"/);
    // The new column: its heading and a cell in every row, one change.
    const column = list.changes.find(c => /column "Refund"/.test(c.where));
    assert.ok(column);
    assert.equal(column.kind, 'added');
    assert.equal(column.count, 4);
    // The badge: restyled in every paid row.
    const badge = list.changes.find(c => /column "Status"/.test(c.where));
    assert.ok(badge?.styles);
    assert.equal(badge.count, 2);
    assert.ok(badge.styles.some(s => s.property === 'font-weight' && s.now === '600'));
    // Screen-reader text is not on screen, so not in the tree.
    assert.doesNotMatch(fs.readFileSync(path.join(before, 'list.json'), 'utf8'), /"text":"Order list"/);
    // The dialog state, reached by a click: its copy changed.
    const details = states.find(s => s.name === 'details');
    assert.ok(details);
    assert.match(formatChanges(details.changes), /Order details.*"Shipped with express delivery\." {2}\(was: "Shipped with standard delivery\."\)/);
    // Boxes: an added change is boxed on the page after, inside the page.
    for (const b of column.boxes.after) assert.ok(b[0] >= 0 && b[1] >= 0 && b[0] + b[2] <= 1024);
});

test('report: index.html, screenshots and changes.json', async () => {
    const { before, after, out } = await fixtureShots();
    const dir = path.join(out, 'report');
    const file = writeReport(findChanges(before, after), dir, { title: 'Orders <test>' });
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, /<title>Orders &lt;test&gt;<\/title>/);
    assert.ok(fs.existsSync(path.join(dir, 'images/after-list.png')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'changes.json'), 'utf8')).length, 2);
});

test('report: a manifest naming files outside its folder is refused', async () => {
    const { before, after, out } = await fixtureShots();
    const bad = path.join(out, 'bad');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'manifest.json'), JSON.stringify({ states: [{ name: 'list', tree: '../before/list.json', image: 'list.png' }] }));
    assert.throws(() => findChanges(bad, after), /unexpected state entry/);
    assert.ok(before);
});

test('React: components are named, with their props', async () => {
    const { serve, FIXTURES } = await import('./helpers.js');
    const os = await import('node:os');
    const { captureStates } = await import('../src/capture.js');
    // The fixture page with React beside it (the UMD builds from node_modules).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-react-'));
    for (const f of ['before.html', 'after.html', 'app.js']) fs.copyFileSync(path.join(FIXTURES, 'react', f), path.join(dir, f));
    fs.copyFileSync(path.join(FIXTURES, '../../node_modules/react/umd/react.production.min.js'), path.join(dir, 'react.js'));
    fs.copyFileSync(path.join(FIXTURES, '../../node_modules/react-dom/umd/react-dom.production.min.js'), path.join(dir, 'react-dom.js'));
    const server = await serve(dir);
    try {
        const config: Config = { file: 'inline', states: { before: { path: '/before.html' }, after: { path: '/after.html' }, missing: { path: '/after.html', steps: [{ click: 'text=Upgrade' }, { click: 'text=No such button' }], stepTimeout: 500 } } };
        const results = await captureStates({ config, base: server.base, out: path.join(dir, 'shots'), log: () => {} });
        // A step that finds nothing says which step, and gives up quickly.
        assert.equal(results.find(r => r.name === 'missing')?.error, 'step 2 of 2, {"click":"text=No such button"}: nothing on the page matched within 500 ms');
    } finally { server.close(); }
    const read = (n: string) => JSON.parse(fs.readFileSync(path.join(dir, 'shots', `${n}.json`), 'utf8')) as PageTree;
    const text = formatChanges(diffTrees(read('before'), read('after')));
    assert.match(text, /<Badge tone="success"> "Active"/);
    assert.match(text, /was: <Badge tone="info"> "Trial"/);
    assert.match(text, /added in App › Card › actions, after "Upgrade": <Button> "Cancel plan"/);
    // A minified component name (Xq) is no name: it neither shows nor makes builds differ.
    assert.doesNotMatch(text, /Xq/);
    // Nor does an id made up on each render.
    assert.doesNotMatch(text, /labelId|react-aria/);
});

test('shoot: each state frozen as standalone HTML that renders like the page', async () => {
    const { after } = await fixtureShots();
    const manifest = JSON.parse(fs.readFileSync(path.join(after, 'manifest.json'), 'utf8'));
    for (const s of manifest.states) {
        assert.ok(s.fidelity > 0.999, `${s.name}: ${s.fidelity}`);
        const html = fs.readFileSync(path.join(after, s.html), 'utf8');
        assert.doesNotMatch(html, /<script/);
        assert.match(html, /Refund/);
    }
    // The dialog state keeps the dialog open.
    assert.match(fs.readFileSync(path.join(after, 'details.html'), 'utf8'), /class="dialog open"/);
});

test('export: a Claude Design canvas, one artboard per state', async () => {
    const { exportDesign } = await import('../src/export.js');
    const { after, out } = await fixtureShots();
    const dir = path.join(out, 'dc');
    const { files } = await exportDesign(after, dir, { format: 'dc', title: 'Orders' });
    assert.deepEqual(files, ['project/canvas.json', 'project/list.dc.html', 'project/details.dc.html']);
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'project/canvas.json'), 'utf8'));
    assert.deepEqual(index.order, ['list.dc.html', 'details.dc.html']);
    assert.ok(index.boards['details.dc.html'].x > index.boards['list.dc.html'].x);
    const board = fs.readFileSync(path.join(dir, 'project/list.dc.html'), 'utf8');
    assert.match(board, /<script src="\.\/support\.js"><\/script>/);
    assert.match(board, /<x-dc>[\s\S]*<helmet>[\s\S]*<\/helmet>[\s\S]*Refund[\s\S]*<\/x-dc>/);
    assert.match(board, /class Component extends DCLogic/);
});

test('now: pages see the same time on every run', async () => {
    const { serve } = await import('./helpers.js');
    const os = await import('node:os');
    const { captureStates } = await import('../src/capture.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-now-'));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><body><p id="d"></p><script>document.getElementById("d").textContent = "Today is " + new Date().toISOString().slice(0, 10);</script></body></html>');
    const server = await serve(dir);
    try {
        const config: Config = { file: 'inline', now: '2030-01-02T03:04:05Z', states: { page: { path: '/index.html' } } };
        await captureStates({ config, base: server.base, out: path.join(dir, 'shots'), log: () => {} });
        assert.match(fs.readFileSync(path.join(dir, 'shots/page.json'), 'utf8'), /Today is 2030-01-02/);
    } finally {
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('config: a key it does not know is an error, with the key meant', async () => {
    const { loadConfig } = await import('../src/capture.js');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-config-'));
    try {
        fs.writeFileSync(path.join(dir, 'redlines.config.json'), JSON.stringify({
            viewprot: { width: 800, height: 600 },
            states: { list: { path: '/', step: [{ click: 'text=Go' }] }, 'bad name': { path: '/' }, wrong: { path: '/', steps: [{ clik: 'x' }] } },
            now: 'yesterday',
        }));
        await assert.rejects(loadConfig(undefined, dir), (error: Error) => {
            assert.match(error.message, /viewprot: unknown key \(did you mean viewport\?\)/);
            assert.match(error.message, /states\.list\.step: unknown key \(did you mean steps\?\)/);
            assert.match(error.message, /states\.bad name: letters, digits/);
            assert.match(error.message, /states\.wrong\.steps\.0: a step is \{ click \}/);
            assert.match(error.message, /now: a date/);
            return true;
        });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('diff: elements nobody can see (no size, no text) coming and going are not changes', () => {
    const el = (children: TreeElement[] = [], box: Box = [0, 0, 100, 20]): TreeElement => ({ tag: 'div', style: {}, box, children });
    const page = (root: TreeElement): PageTree => ({ version: 1, url: '', title: '', viewport: { width: 100, height: 100 }, size: { width: 100, height: 100 }, root });
    assert.deepEqual(diffTrees(page(el([el()])), page(el([el([], [0, 90, 100, 0]), el()]))), []);
});
