import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { launch } from '../src/browser.js';
import { linksFrom, loadConfig } from '../src/capture.js';
import { findDesignEdits } from '../src/edits.js';
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
    fs.writeFileSync(path.join(edited, 'project/Empty.dc.html'), fs.readFileSync(path.join(exported, 'project/list.dc.html'), 'utf8').replace(/<table>[\s\S]*<\/table>/, '<p>No orders yet</p>'));

    const boards = await findDesignEdits(exported, edited);
    const details = boards.find(b => b.file === 'details.dc.html')!;
    assert.equal(details.status, 'changed');
    assert.ok(details.changes.some(c => c.now.join(' ').includes('Ships express, arrives Friday.') && c.was.join(' ').includes('Shipped with express delivery.')), JSON.stringify(details.changes));
    assert.ok(details.changes.some(c => c.styles?.some(s => s.property === 'padding-top' && s.now === '32px')), JSON.stringify(details.changes));
    assert.equal(boards.find(b => b.file === 'list.dc.html')!.status, 'same');
    const added = boards.find(b => b.file === 'Empty.dc.html')!;
    assert.equal(added.status, 'added');
    assert.match(added.outline!, /No orders yet/);
});
