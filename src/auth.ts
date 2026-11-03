// Logging in, for apps behind a login: a real browser window opens on the app, the person logs in
// there themselves, and the browser's state (cookies, local storage) is kept for later captures of
// the same app. redlines never sees a password. The state is a credential: it lives in
// .redlines/auth/ (with its own .gitignore, readable only by its owner) and is never printed.
import fs from 'node:fs';
import path from 'node:path';

import type { Page } from 'playwright-core';

import { launch } from './browser.js';
import { workDir } from './package.js';

/** Where the login state for an app (by its origin) is kept. */
export function authFile(root: string, url: string): string {
    const { host } = new URL(url);
    return path.join(root, '.redlines', 'auth', `${host.replace(/[^\w.-]+/g, '_')}.json`);
}

/** The kept login state for this app, if there is one. */
export function storedAuth(root: string, url: string): string | undefined {
    const file = authFile(root, url);
    return fs.existsSync(file) ? file : undefined;
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
export async function logIn({ root, url, until, timeoutMinutes = 5, headless = false, person }: {
    root: string;
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
        workDir(root);
        const file = authFile(root, url);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Kept out of git even where .redlines/ is not ignored.
        fs.writeFileSync(path.join(path.dirname(file), '.gitignore'), '*\n');
        await context.storageState({ path: file });
        fs.chmodSync(file, 0o600);
        return file;
    } finally {
        await browser.close();
    }
}
