import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { launch } from '../src/browser.js';
import { loadConfig } from '../src/capture.js';
import { buildPrototype, checkPrototype, chooseAnswer, readsOnly, scrub, serveFolder } from '../src/prototype.js';
import { FIXTURES, serve } from './helpers.js';

test('build_prototype: the app runs from a static folder, offline, and leaves the host\'s other pages alone', async () => {
    const config = await loadConfig(path.join(FIXTURES, 'redlines.config.mjs'));
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-proto-'));
    const app = await serve(path.join(FIXTURES, 'after'));
    let built;
    try { built = await buildPrototype({ config, base: app.base, out, id: 'orders', log: () => {} }); } finally { app.close(); }
    assert.deepEqual(built.walks.map(w => [w.name, w.ok]), [['list', true], ['details', true], ['details → list', true]]);
    assert.ok(fs.existsSync(path.join(out, 'sw.js')) && fs.existsSync(path.join(out, 'p/orders/index.html')));

    // The app server is gone: every walk plays on the folder alone.
    const played = await checkPrototype({ config, out, id: 'orders' });
    assert.deepEqual(played.walks.map(w => [w.name, w.ok, w.error]), [['list', true, undefined], ['details', true, undefined], ['details → list', true, undefined]]);

    // Someone else's page on the same host, in the same browser, after the prototype.
    fs.writeFileSync(path.join(out, 'other.html'), '<!doctype html><h1>Not the prototype</h1>');
    const host = await serveFolder(out);
    const browser = await launch();
    try {
        const page = await browser.newPage();
        await page.goto(`${host.url}/p/orders/`);
        await page.waitForURL(/__prototype=orders/);
        await page.waitForSelector('text=Grace Hopper');
        await page.click('text=#1001');
        assert.ok(await page.isVisible('text=Shipped with express delivery.'));
        await page.goto(`${host.url}/other.html`);
        assert.equal(await page.textContent('h1'), 'Not the prototype');
        // The app's own address outside the prototype is the host's (here, nothing).
        assert.equal((await page.goto(`${host.url}/index.html`))?.status(), 404);
    } finally {
        await browser.close();
        host.close();
    }
});

test('a prototype answers as recorded after as many writes as the viewer has made', () => {
    const a = (writes: number, file: string) => ({ status: 200, headers: {}, file, writes });
    const claim = [a(0, 'rejected'), a(1, 'under-review')];
    assert.equal(chooseAnswer(claim, 0).file, 'rejected');
    assert.equal(chooseAnswer(claim, 1).file, 'under-review');
    assert.equal(chooseAnswer(claim, 3).file, 'under-review');
    assert.equal(chooseAnswer([a(2, 'later')], 0).file, 'later');
});

test('login secrets are blanked; a JWT keeps what it says but not its signature', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const { text, count } = scrub(`{"access_token":"0123456789abcdef","id_token":"${jwt}"};session:{refresh_token:'abcdefghijklmnop'},title:"Orders"`);
    assert.equal(count, 3);
    assert.ok(!text.includes('0123456789abcdef') && !text.includes('SflKxwRJ') && !text.includes('abcdefghijklmnop'));
    assert.ok(text.includes('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.unsigned') && text.includes('"Orders"'));
});

test('a GraphQL query reads; a mutation, or any other body, may write', () => {
    assert.equal(readsOnly(JSON.stringify({ operationName: 'Claims', variables: { first: 10 }, query: 'query Claims($first: Int) { claims(first: $first) { id } }' })), true);
    assert.equal(readsOnly(JSON.stringify([{ query: '{ me { id } }' }, { query: 'query A { a }' }])), true);
    assert.equal(readsOnly(JSON.stringify({ query: 'mutation Reopen { reopen(id: 1) { id } }' })), false);
    assert.equal(readsOnly(JSON.stringify({ reason: 'new photos' })), false);
    assert.equal(readsOnly(''), false);
});
