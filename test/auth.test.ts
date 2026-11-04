import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { authFile, logIn } from '../src/auth.js';
import { captureStates } from '../src/capture.js';
import type { Config } from '../src/types.js';
import { loginApp } from './fixtures/login/server.js';

// Logins are kept per machine: the tests keep theirs in a folder of their own.
process.env.REDLINES_AUTH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-auth-dir-'));

test('log in once, then capture pages behind the login', async () => {
    const app = await loginApp('s3cret');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-auth-'));
    const config: Config = { file: 'inline', states: { home: { path: '/', title: 'Dashboard' } } };
    try {
        // Not logged in: the page goes to the login, and the tool says so instead of recording it.
        const [before] = await captureStates({ config, base: app.base, out: path.join(root, 'out1'), root, log: () => {} });
        assert.equal(before.ok, false);
        assert.match(before.error ?? '', /sent \/ to a login page .*log in first \(log_in --url http:\/\/127\.0\.0\.1:\d+\)/);

        // The person logs in in the window (here, a script standing in for them).
        const file = await logIn({ root, url: app.base, headless: true, person: async page => {
            await page.getByLabel('Password').fill('s3cret');
            await page.getByRole('button', { name: 'Log in' }).click();
        } });
        assert.equal(file, authFile(app.base));
        assert.ok(file.startsWith(process.env.REDLINES_AUTH_DIR!));
        // Windows has no Unix file modes.
        if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        assert.equal(fs.readFileSync(path.join(path.dirname(file), '.gitignore'), 'utf8'), '*\n');

        // Logged in: the page itself.
        const [after] = await captureStates({ config, base: app.base, out: path.join(root, 'out2'), root, log: () => {} });
        assert.ok(after.ok, after.error);
        assert.match(fs.readFileSync(path.join(root, 'out2/home.json'), 'utf8'), /Only for people who logged in/);
        // What the app refreshed on that visit (its token cookie: 1 at login, 2 now) is kept for next time.
        assert.match(fs.readFileSync(file, 'utf8'), /"name":"refreshed","value":"2"/);

        // Another project, and the same app on another port: the same login.
        const other = await loginApp('s3cret');
        try {
            const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-auth-other-'));
            const [again] = await captureStates({ config, base: other.base, out: path.join(elsewhere, 'out'), root: elsewhere, log: () => {} });
            assert.ok(again.ok, again.error);
        } finally { other.close(); }
    } finally {
        app.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('log in by the button, for an app that never leaves its own pages', async () => {
    const app = await loginApp('unused');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-button-'));
    try {
        // /login is the app's own page here: no redirect to watch for, so only the button can say it is done.
        const file = await logIn({ root, url: `${app.base}/login`, headless: true, timeoutMinutes: 1, person: async page => {
            await page.locator('#__redlines-done').click();
        } });
        assert.ok(fs.existsSync(file));
    } finally {
        app.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a step can fill in a value from the environment, never shown', async () => {
    const app = await loginApp('from-env');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-env-'));
    process.env.REDLINES_TEST_PASSWORD = 'from-env';
    try {
        const config: Config = { file: 'inline', states: {
            home: { path: '/login', steps: [{ fill: ['role=textbox[name="Password"] >> nth=0', { env: 'REDLINES_TEST_PASSWORD' }] }, { click: 'text=Log in' }, { waitFor: 'text=Dashboard' }] },
            unset: { path: '/login', steps: [{ fill: ['input[name=password]', { env: 'REDLINES_TEST_UNSET' }] }] },
        } };
        const results = await captureStates({ config, base: app.base, out: path.join(root, 'out'), root, log: () => {} });
        assert.ok(results.find(r => r.name === 'home')?.ok);
        const unset = results.find(r => r.name === 'unset');
        assert.match(unset?.error ?? '', /the environment variable REDLINES_TEST_UNSET is not set/);
        assert.doesNotMatch(JSON.stringify(results), /from-env/);
    } finally {
        delete process.env.REDLINES_TEST_PASSWORD;
        app.close();
        fs.rmSync(root, { recursive: true, force: true });
    }
});
