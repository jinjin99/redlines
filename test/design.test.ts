import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { launch } from '../src/browser.js';
import { linksFrom, loadConfig } from '../src/capture.js';
import { findDesignEdits } from '../src/edits.js';
import { formatChanges } from '../src/diff.js';
import { exportDesign } from '../src/export.js';
import { FIXTURES, fixtureShots } from './helpers.js';

test('links: a state continuing another\'s steps is linked from it; the config adds the way back', async () => {
    const config = await loadConfig(path.join(FIXTURES, 'redlines.config.mjs'));
    assert.deepEqual(linksFrom(config, 'list'), [{ selector: 'text=#1001', to: 'details' }]);
    assert.deepEqual(linksFrom(config, 'details'), [{ selector: '#close', to: 'list' }]);
    // A state continuing two is linked from the one it continues furthest.
    const deeper = { ...config, states: { ...config.states, confirm: { path: '/index.html', steps: [{ click: 'text=#1001' }, { fill: ['#note', 'x'] as [string, string] }, { click: '#ok' }] } } };
    assert.deepEqual(linksFrom(deeper, 'details').map(l => l.to), ['list', 'confirm']);
    assert.ok(!linksFrom(deeper, 'list').some(l => l.to === 'confirm'));
});

test('export: the pages click through, and the canvas plays', async () => {
    const { after, out } = await fixtureShots();
    const manifest = JSON.parse(fs.readFileSync(path.join(after, 'manifest.json'), 'utf8'));
    const list = manifest.states.find((s: { name: string }) => s.name === 'list');
    assert.equal(list.links[0].to, 'details');
    assert.ok(list.links[0].box[2] > 0);

    const html = path.join(out, 'html-links');
    assert.deepEqual(exportDesign(after, html, { format: 'html' }).links, ['list → details (text=#1001)', 'details → list (#close)']);
    const browser = await launch();
    try {
        const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
        await page.goto(pathToFileURL(path.join(html, 'list.html')).href);
        const [x, y, w, h] = list.links[0].box;
        await page.mouse.click(x + w / 2, y + h / 2);
        await page.waitForURL(/details\.html$/);
        await page.click('[data-redlines-link="list"]');
        await page.waitForURL(/list\.html$/);
    } finally {
        await browser.close();
    }

    const dc = path.join(out, 'dc-links');
    exportDesign(after, dc, { format: 'dc' });
    const board = fs.readFileSync(path.join(dc, 'project/list.dc.html'), 'utf8');
    assert.match(board, /<a href="details\.dc\.html" data-redlines-link="details" aria-label="Order details dialog" style="position: absolute; left: \d+px/);
    const canvas = JSON.parse(fs.readFileSync(path.join(dc, 'project/canvas.json'), 'utf8'));
    assert.equal(canvas.boards['list.dc.html'].is_interactive, true);
});

test('find_design_edits: a designer\'s edits on the canvas, as changes', async () => {
    const { after, out } = await fixtureShots();
    const exported = path.join(out, 'design');
    exportDesign(after, exported, { format: 'dc' });
    const edited = path.join(out, 'design-edited');
    fs.cpSync(exported, edited, { recursive: true });
    // As the canvas saves them: copy retyped, a padding changed in the properties panel, the links moved about, an artboard added.
    const file = path.join(edited, 'project/details.dc.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Shipped with express delivery.', 'Ships express, arrives Friday.').replace(/(<div class="dialog-panel"[^>]*?)( style="[^"]*")?>/, '$1 style="padding: 32px;">').replace(/left: \d+px; top: \d+px/, 'left: 1px; top: 2px'));
    const list = path.join(edited, 'project/list.dc.html');
    fs.writeFileSync(list, fs.readFileSync(list, 'utf8').replace('Ada Lovelace', 'Ada King'));
    fs.writeFileSync(path.join(edited, 'project/Empty.dc.html'), fs.readFileSync(path.join(exported, 'project/list.dc.html'), 'utf8').replace(/<table>[\s\S]*<\/table>/, '<p>No orders yet</p>'));

    const boards = await findDesignEdits(exported, edited);
    const details = boards.find(b => b.file === 'details.dc.html')!;
    assert.equal(details.status, 'changed');
    assert.ok(details.changes.some(c => c.now.join(' ').includes('Ships express, arrives Friday.') && c.was.join(' ').includes('Shipped with express delivery.')), JSON.stringify(details.changes));
    assert.ok(details.changes.some(c => c.styles?.some(s => s.property === 'padding-top' && s.now === '32px')), JSON.stringify(details.changes));
    // The dialog's copy is the code's; the customer's name is the orders' data.
    assert.ok(details.changes.every(c => !c.data));
    const name = boards.find(b => b.file === 'list.dc.html')!.changes[0];
    assert.deepEqual(name.data, [{ text: 'Ada Lovelace', from: 'GET /api/orders', key: '[0].customer', whole: true }]);
    assert.match(formatChanges([name]), /! not code: "Ada Lovelace" is data from GET \/api\/orders → \[0\]\.customer/);
    const added = boards.find(b => b.file === 'Empty.dc.html')!;
    assert.equal(added.status, 'added');
    assert.match(added.outline!, /No orders yet/);
});

test('export: inline images become files beside the artboards (a plain DOCTYPE dropped)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-img-'));
    const svg = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>';
    const html = `<!doctype html><html><head><style>\n.a{background:url("data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}")}</style></head><body><img src="data:image/svg+xml,${encodeURIComponent(svg)}"></body></html>`;
    fs.writeFileSync(path.join(dir, 'home.html'), html);
    fs.writeFileSync(path.join(dir, 'home.json'), JSON.stringify({ viewport: { width: 400, height: 300 }, size: { width: 400, height: 300 } }));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ tool: 'redlines', version: 1, states: [{ name: 'home', title: 'Home', tree: 'home.json', image: 'home.png', html: 'home.html' }] }));
    const out = path.join(dir, 'design');
    const { files, notes } = exportDesign(dir, out, { format: 'dc' });
    const assets = files.filter(f => f.startsWith('project/assets/'));
    assert.equal(assets.length, 1);
    assert.deepEqual(notes, []);
    const board = fs.readFileSync(path.join(out, 'project/home.dc.html'), 'utf8');
    assert.ok(!board.includes('data:image'));
    assert.ok(board.includes(`src="${assets[0].slice('project/'.length)}"`));
    assert.ok(!fs.readFileSync(path.join(out, assets[0]), 'utf8').includes('DOCTYPE'));
});
