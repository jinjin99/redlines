// Logging in, for apps behind a login: a real browser window opens on the app, the person logs in
// there themselves, and the browser's state (cookies, local storage) is kept for later captures of
// the same app. redlines never sees a password. The state is a credential: it lives in
// .redlines/auth/ (with its own .gitignore, readable only by its owner) and is never printed.
import fs from 'node:fs';
import path from 'node:path';

import type { Page } from 'playwright-core';

import { launch } from './browser.js';

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
 * Opens a browser window on `url` for the person to log in, and waits until they have: until `until`
 * (a selector) shows, or else until the window is back on the app's origin, away from login pages,
 * for two seconds. Saves the browser's state to authFile and returns its path.
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
        const page = await context.newPage();
        await page.goto(url);
        void person?.(page);
        const deadline = Date.now() + timeoutMinutes * 60_000;
        let since = 0;
        for (;;) {
            if (page.isClosed()) throw new Error('The window was closed before logging in finished');
            if (Date.now() > deadline) throw new Error(`Not logged in after ${timeoutMinutes} minutes`);
            let done = false;
            if (until) done = await page.locator(until).first().isVisible().catch(() => false);
            else {
                const now = new URL(page.url());
                const away = now.origin === origin && !LOGIN.test(now.pathname + now.hash);
                since = away ? since || Date.now() : 0;
                done = away && Date.now() - since >= 2000;
            }
            if (done) break;
            await page.waitForTimeout(500).catch(() => {});
        }
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
