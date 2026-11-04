// Logging in, for apps behind a login: a real browser window opens on the app, the person logs in
// there themselves, and the browser's state (cookies, local storage) is kept for later captures of
// the same app. redlines never sees a password. The state is a credential: it is kept once per machine
// and host (~/.redlines/auth/<host>.json, or REDLINES_AUTH_DIR; readable only by its owner) and never
// printed. Every project, worktree and port on that host shares it, as the browser's cookies do; and
// every run writes back what the app refreshed (a rotated token), so a login lasts as long as the app
// lets a session live, not as long as its first token.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BrowserContext, Page } from 'playwright-core';

import { launch } from './browser.js';

type State = Awaited<ReturnType<BrowserContext['storageState']>>;

const authDir = () => process.env.REDLINES_AUTH_DIR ? path.resolve(process.env.REDLINES_AUTH_DIR) : path.join(os.homedir(), '.redlines', 'auth');

/** Where the login state for an app (by its host: every port of it) is kept. */
export function authFile(url: string): string {
    return path.join(authDir(), `${new URL(url).hostname.replace(/[^\w.-]+/g, '_')}.json`);
}

/**
 * The kept login state for this app, if there is one. A login an older redlines kept in the project
 * (`<root>/.redlines/auth/<host_port>.json`) moves to the shared place first.
 */
export function storedAuth(root: string, url: string): string | undefined {
    const file = authFile(url);
    const old = path.join(root, '.redlines', 'auth', `${new URL(url).host.replace(/[^\w.-]+/g, '_')}.json`);
    if (!fs.existsSync(file) && fs.existsSync(old)) write(file, JSON.parse(fs.readFileSync(old, 'utf8')) as State);
    return fs.existsSync(file) ? file : undefined;
}

/** Writes a login state: whole, then moved into place, readable only by its owner. */
function write(file: string, state: State) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // Kept out of git even if the folder ends up inside a repository.
    if (!fs.existsSync(path.join(path.dirname(file), '.gitignore'))) fs.writeFileSync(path.join(path.dirname(file), '.gitignore'), '*\n');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
}

/**
 * Keeps what a logged-in browser holds now (cookies the app refreshed, its local storage) in `file`,
 * over what was there: the other ports' local storage stays.
 */
export async function keepAuth(file: string, context: BrowserContext): Promise<void> {
    const now = await context.storageState();
    let before: State = { cookies: [], origins: [] };
    try { before = JSON.parse(fs.readFileSync(file, 'utf8')) as State; } catch { /* nothing kept yet */ }
    const origins = new Set(now.origins.map(o => o.origin));
    write(file, { cookies: now.cookies, origins: [...now.origins, ...before.origins.filter(o => !origins.has(o.origin))] });
}

// A page that is still part of logging in.
export const LOGIN = /login|log-in|signin|sign-in|sso|oauth|auth|account/i;

/**
 * Opens a browser window on `url` for the person to log in, and waits until they have. Done when:
 * they press the "Logged in" button the window shows on the app's pages; or `until` (a selector)
 * shows; or the window went to a login page and has come back to the app, settled, for three
 * seconds. (An app may sit on its own address a moment before it sends a visitor to its login, so
 * being on the app alone says nothing.) Saves the browser's state to authFile and returns its path.
 */
export async function logIn({ url, until, timeoutMinutes = 5, headless = false, person }: {
    /** Unused: logins are kept per machine. */
    root?: string;
    url: string;
    until?: string;
    timeoutMinutes?: number;
    /** Tests only: no window, and `person` does the logging in. */
    headless?: boolean;
    person?: (page: Page) => Promise<void>;
}): Promise<string> {
    const origin = new URL(url).origin;
    const browser = await launch({ headless });
    try {
        const context = await browser.newContext({ viewport: null });
        let pressed = false;
        await context.exposeBinding('__redlinesLoggedIn', () => { pressed = true; });
        // The button, on the app's own pages only (not on a login page someone else runs).
        await context.addInitScript(({ app, label }) => {
            if (location.origin !== app) return;
            const add = () => {
                if (document.getElementById('__redlines-done')) return;
                const b = document.createElement('button');
                b.id = '__redlines-done';
                b.textContent = label;
                b.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 16px;border:0;border-radius:8px;background:#1f6feb;color:#fff;font:600 14px system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.3);cursor:pointer';
                b.onclick = () => (window as unknown as { __redlinesLoggedIn: () => void }).__redlinesLoggedIn();
                document.documentElement.appendChild(b);
            };
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add);
            else add();
            setInterval(add, 1000); // an app that rewrites the whole document
        }, { app: origin, label: 'Logged in — save for redlines' });
        const page = await context.newPage();
        // Shown is enough: a dev server's page can keep some request hanging and never fire load.
        await page.goto(url, { waitUntil: 'commit', timeout: 60_000 });
        void person?.(page);
        const deadline = Date.now() + timeoutMinutes * 60_000;
        let sawLogin = false, since = 0, last = '';
        for (;;) {
            if (page.isClosed()) throw new Error('The window was closed before logging in finished');
            if (Date.now() > deadline) throw new Error(`Not logged in after ${timeoutMinutes} minutes`);
            const now = new URL(page.url());
            const atLogin = now.origin !== origin || LOGIN.test(now.pathname + now.hash);
            if (atLogin) sawLogin = true;
            // Back on the app after a login page, and the address has stopped changing.
            const settled = sawLogin && !atLogin && now.href === last;
            since = settled ? since || Date.now() : 0;
            last = now.href;
            if (pressed) break;
            if (until && (await page.locator(until).first().isVisible().catch(() => false))) break;
            if (!until && settled && Date.now() - since >= 3000) break;
            await page.waitForTimeout(500).catch(() => {});
        }
        // What the app stores once logged in (a token in local storage) lands after its requests.
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        const file = authFile(url);
        await keepAuth(file, context);
        return file;
    } finally {
        await browser.close();
    }
}
