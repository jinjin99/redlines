// Shoots each state a config lists: opens the page, answers the requests the config mocks, does the
// state's steps (click, fill, …), waits for it to settle, then writes the page tree and a full-page
// screenshot. Run it once against the code before a change and once against the code after.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Browser, BrowserContext, Page, Request, Route } from 'playwright-core';

import { LOGIN, storedAuth } from './auth.js';
import { launch } from './browser.js';
import { configProblems } from './config.js';
import { handlersFor, loadMsw, type MswSource, mswAnswer } from './msw.js';
import { loadRecording, Recorder, type Recording, replay } from './recording.js';
import { freeze } from './page/freeze.js';
import { snapshot } from './page/snapshot.js';
import type { Config, Manifest, MockAnswer, PageTree, Step } from './types.js';

const CONFIG_NAMES = ['redlines.config.mjs', 'redlines.config.js', 'redlines.config.json'];

/** The config: a file path, or the first redlines.config.* in `dir`. */
export async function loadConfig(file?: string, dir = process.cwd()): Promise<Config> {
    const found = file ? path.resolve(file) : CONFIG_NAMES.map(n => path.join(dir, n)).find(f => fs.existsSync(f));
    if (!found || !fs.existsSync(found)) throw new Error(`No config: write redlines.config.mjs (see README), or pass --config <file>`);
    const config = found.endsWith('.json') ? JSON.parse(fs.readFileSync(found, 'utf8')) : (await import(pathToFileURL(found).href)).default;
    if (!config || typeof config !== 'object') throw new Error(`${found}: export the config object (export default { states: { … } })`);
    const problems = configProblems(config);
    if (problems.length) throw new Error(`${found}:\n  ${problems.join('\n  ')}`);
    return { ...config, file: found };
}

/** "GET /api/items" or "/api/items*" against a request. Paths are matched from the start, `*` is any run of characters. */
function matcher(pattern: string): (request: Request) => boolean {
    const [method, route] = /^[A-Z]+\s/.test(pattern) ? pattern.split(/\s+/, 2) : ['*', pattern];
    const re = new RegExp(`^${route.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return (request: Request) => (method === '*' || request.method() === method) && re.test(new URL(request.url()).pathname);
}

/** A mock's answer: an object or array is JSON; { status, json | body, headers } says more; a function gets the request. */
interface Answer { status?: number; json?: unknown; body?: string; headers?: Record<string, string>; contentType?: string }

async function fulfill(route: Route, answer: MockAnswer) {
    const value: unknown = typeof answer === 'function' ? await answer(route.request()) : answer;
    const full: Answer = value && typeof value === 'object' && ('json' in value || 'body' in value || 'status' in value) ? (value as Answer) : { json: value };
    return route.fulfill({ status: full.status ?? 200, headers: full.headers, contentType: full.json !== undefined ? 'application/json' : full.contentType, body: full.json !== undefined ? JSON.stringify(full.json) : full.body ?? '' });
}

async function step(page: Page, s: Step): Promise<unknown> {
    if (typeof s === 'function') return s(page);
    if ('click' in s) return page.locator(s.click).first().click();
    if ('fill' in s) {
        const [selector, value] = s.fill;
        // { env: NAME }: a value kept out of the config (a test account's password in CI).
        if (typeof value === 'object') {
            const secret = process.env[value.env];
            if (secret === undefined) throw new Error(`the environment variable ${value.env} is not set`);
            return page.locator(selector).first().fill(secret);
        }
        return page.locator(selector).first().fill(String(value));
    }
    if ('press' in s) return page.keyboard.press(s.press);
    if ('hover' in s) return page.locator(s.hover).first().hover();
    if ('select' in s) return page.locator(s.select[0]).first().selectOption(s.select[1]);
    if ('waitFor' in s) return page.locator(s.waitFor).first().waitFor();
    if ('wait' in s && typeof s.wait === 'number') return page.waitForTimeout(s.wait);
    throw new Error(`Unknown step ${JSON.stringify(s)}: click, fill, press, hover, select, waitFor, wait, or a function (page) => …`);
}

/** Share of pixels that differ between two PNGs (any channel by more than 16), measured in `page`. */
export async function pixelDiff(page: Page, a: Buffer, b: Buffer): Promise<number> {
    return page.evaluate(
        async ([x, y]) => {
            const load = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
            const [p, q] = await Promise.all([load(x), load(y)]);
            const w = Math.max(p.width, q.width), h = Math.max(p.height, q.height);
            const px = (img: HTMLImageElement) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d')!; g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
            const A = px(p), B = px(q);
            let d = 0;
            for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) > 16 || Math.abs(A[i + 1] - B[i + 1]) > 16 || Math.abs(A[i + 2] - B[i + 2]) > 16 || A[i + 3] !== B[i + 3]) d++;
            return d / (w * h);
        },
        [`data:image/png;base64,${a.toString('base64')}`, `data:image/png;base64,${b.toString('base64')}`]
    );
}

// Still pictures: no animation, transition or blinking caret between two shots.
const STILL = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';

/**
 * A state opened in `browser`, ready to record: a context with its viewport, the mocks answering,
 * the page loaded, its steps done, settled. Returns { context, page, errors }; close the context after.
 */
export interface OpenOptions {
    url: string;
    steps?: Step[];
    mocks?: Record<string, MockAnswer>;
    viewport?: { width: number; height: number };
    settle?: number;
    /** How long a step waits for what it acts on (ms). */
    stepTimeout?: number;
    locale?: string;
    timezone?: string;
    /** A login state (log_in) to open the page with. */
    storageState?: string;
    /** The time the page sees as now. */
    now?: string;
    /** MSW handlers answering what `mocks` does not. */
    msw?: { source: MswSource; handlers: unknown[] };
    /** Recorded answers, after `mocks` and MSW. */
    recording?: Recording;
    /** Records the page's API answers (record_data). */
    recorder?: Recorder;
}

/** Waits until the page's address has stayed the same for a second (an app that sends itself on after loading), up to `max` ms. */
async function addressSettled(page: Page, max = 15_000) {
    const end = Date.now() + max;
    let last = page.url(), since = Date.now();
    while (Date.now() < end) {
        await page.waitForTimeout(250);
        if (page.url() !== last) { last = page.url(); since = Date.now(); continue; }
        if (Date.now() - since >= 1000) return;
    }
}

/**
 * page.evaluate that survives the page navigating under it (an app redirecting itself as it starts):
 * waits for the new page to load and settle, and tries again, up to three times.
 */
export async function evaluateSettled<R, A>(page: Page, fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> {
    for (let attempt = 1; ; attempt++) {
        try {
            return (await page.evaluate(fn as (arg: unknown) => R | Promise<R>, arg as unknown)) as R;
        } catch (error) {
            if (attempt >= 3 || !/Execution context was destroyed|navigat/i.test((error as Error).message)) throw error;
            await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
            await addressSettled(page);
            await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        }
    }
}

/** A step as the config says it, for an error message. */
const stepText = (s: Step) => (typeof s === 'function' ? 'a function step' : JSON.stringify(s));

export async function openState(browser: Browser, { url, steps = [], mocks = {}, viewport = { width: 1280, height: 800 }, settle = 300, stepTimeout = 5000, locale = 'en-US', timezone = 'UTC', storageState, now, msw, recording, recorder }: OpenOptions): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce', locale, timezoneId: timezone, storageState });
    const page = await context.newPage();
    if (now) {
        const at = new Date(now);
        if (Number.isNaN(at.getTime())) throw new Error(`now is not a date: ${now}`);
        // The clock stands still at `now`: timers still run, Date always says the same.
        await page.clock.setFixedTime(at);
    }
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
    const table = Object.entries(mocks).map(([p, answer]) => [matcher(p), answer] as const);
    // The page's data, from the first source that has an answer: config mocks, MSW, a recording; else the network.
    if (table.length || msw || recording) {
        await page.route('**/*', async route => {
            const hit = table.find(([test]) => test(route.request()));
            if (hit) return fulfill(route, hit[1]);
            const answer = msw && (await mswAnswer(msw.source, msw.handlers, route.request()));
            if (answer) return route.fulfill(answer);
            const recorded = recording?.lookup(route.request());
            return recorded ? route.fulfill(replay(recorded)) : route.fallback();
        });
    }
    recorder?.watch(page);
    try {
        // Shown first; then load and idle as far as they come (a dev server's page may keep a request
        // hanging, so neither is required).
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
        // Sent to a login page instead: say so, rather than record the login page as the state.
        const asked = new URL(url), landed = new URL(page.url());
        if (LOGIN.test(landed.pathname + landed.hash) && !LOGIN.test(asked.pathname + asked.hash) || (landed.origin !== asked.origin && LOGIN.test(landed.href))) {
            throw new Error(`the app sent ${asked.pathname} to a login page (${landed.origin}${landed.pathname}): log in first (log_in --url ${asked.origin})${storageState ? ', the login kept before has expired' : ''}`);
        }
        await page.addStyleTag({ content: STILL });
        page.setDefaultTimeout(stepTimeout);
        for (const [i, s] of steps.entries()) {
            try {
                await step(page, s);
            } catch (error) {
                const why = (error as Error).message.split('\n')[0].replace(/^\w+\.\w+: /, '');
                throw new Error(`step ${i + 1} of ${steps.length}, ${stepText(s)}: ${/Timeout/.test(why) ? `nothing on the page matched within ${stepTimeout} ms` : why}`, { cause: error });
            }
        }
        // Steps are quick to give up; recording a big page is not hurried.
        page.setDefaultTimeout(30000);
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        await page.evaluate(() => document.fonts?.ready).catch(() => {});
        await addressSettled(page);
        await page.waitForTimeout(settle);
    } catch (error) {
        await context.close();
        throw error;
    }
    return { context, page, errors };
}

/** One page as it is now: { tree, screenshot (PNG buffer), errors }, without writing anything. */
export async function viewPage({ url, steps, mocks, viewport, settle, storageState, fullPage = false }: OpenOptions & { fullPage?: boolean }): Promise<{ tree: PageTree; screenshot: Buffer; errors: string[] }> {
    const browser = await launch();
    try {
        const { context, page, errors } = await openState(browser, { url, steps, mocks, viewport, settle, storageState });
        try {
            const tree = await evaluateSettled(page, snapshot, {});
            return { tree, screenshot: await page.screenshot({ fullPage }), errors };
        } finally {
            await context.close();
        }
    } finally {
        await browser.close();
    }
}

/** Shoots the config's states (or `only` of them) at `base` into `out`. Returns [{ name, ok, error? }]. */
export interface CaptureResult { name: string; ok: boolean; error?: string; errors: string[]; fidelity: number | null }

export async function captureStates({ config, base, out, only, root = process.cwd(), log = console.log }: { config: Config; base?: string; out: string; only?: string[]; root?: string; log?: (line: string) => void }): Promise<CaptureResult[]> {
    const baseURL = base ?? config.baseURL;
    if (!baseURL) throw new Error('No base URL: pass --base <url> or set baseURL in the config');
    // Logged in to this app before (log_in): every state opens logged in.
    const storageState = storedAuth(root, baseURL);
    // The project's MSW handlers, loaded once (relative to the config file).
    const configDir = config.file && path.isAbsolute(config.file) ? path.dirname(config.file) : root;
    const mswSource = config.msw ? await loadMsw(config.msw, configDir) : undefined;
    const recording = config.recording ? loadRecording(path.resolve(configDir, config.recording)) : undefined;
    const names = only?.length ? only : Object.keys(config.states);
    for (const n of names) if (!config.states[n]) throw new Error(`No state "${n}"; the config has ${Object.keys(config.states).join(', ')}`);
    fs.mkdirSync(out, { recursive: true });
    const browser = await launch();
    const results: CaptureResult[] = [];
    try {
        for (const name of names) {
            const state = config.states[name];
            let opened;
            try {
                opened = await openState(browser, {
                    url: new URL(state.path ?? '/', baseURL).href,
                    steps: state.steps,
                    mocks: { ...(config.mocks ?? {}), ...(state.mocks ?? {}) },
                    viewport: state.viewport ?? config.viewport,
                    settle: state.settle ?? config.settle,
                    stepTimeout: state.stepTimeout ?? config.stepTimeout,
                    storageState,
                    now: config.now,
                    msw: mswSource && { source: mswSource, handlers: handlersFor(mswSource, state.msw) },
                    recording,
                    locale: config.locale,
                    timezone: config.timezone,
                });
            } catch (error) {
                const message = (error as Error).message.split('\n')[0];
                results.push({ name, ok: false, error: message, errors: [], fidelity: null });
                log(`FAIL ${name}: ${message}`);
                continue;
            }
            const { context, page, errors } = opened;
            try {
                const tree = await evaluateSettled(page, snapshot, { ignore: state.ignore ?? config.ignore ?? null });
                tree.state = { name, title: state.title ?? name, path: state.path ?? '/' };
                fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(tree));
                const shot = await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
                // The page as one editable HTML file, checked against the screenshot: opened again, how much differs.
                let fidelity: number | null = null;
                if (config.html !== false) {
                    const html = await evaluateSettled(page, freeze, undefined);
                    fs.writeFileSync(path.join(out, `${name}.html`), html);
                    const check = await context.newPage();
                    try {
                        await check.setContent(html, { waitUntil: 'load' });
                        await check.addStyleTag({ content: STILL });
                        await check.evaluate(() => document.fonts?.ready);
                        await check.waitForTimeout(100);
                        fidelity = 1 - (await pixelDiff(check, shot, await check.screenshot({ fullPage: true })));
                    } finally {
                        await check.close();
                    }
                }
                results.push({ name, ok: true, errors, fidelity });
                const same = fidelity === null ? '' : `  html ${(fidelity * 100).toFixed(2)}% the same as the page`;
                log(`ok   ${name}${same}${errors.length ? `  (the page logged: ${errors.join(' | ')})` : ''}`);
            } catch (error) {
                const message = (error as Error).message.split('\n')[0];
                results.push({ name, ok: false, error: message, errors, fidelity: null });
                log(`FAIL ${name}: ${message}`);
            } finally {
                await context.close();
            }
        }
    } finally {
        await browser.close();
    }
    const manifest: Manifest = { tool: 'redlines', version: 1, base: baseURL, at: new Date().toISOString(), states: results.filter(r => r.ok).map(r => ({ name: r.name, title: config.states[r.name].title ?? r.name, tree: `${r.name}.json`, image: `${r.name}.png`, ...(r.fidelity === null ? {} : { html: `${r.name}.html`, fidelity: Number(r.fidelity!.toFixed(4)) }) })) };
    // Capturing some states adds to what the folder had.
    const file = path.join(out, 'manifest.json');
    if (only?.length && fs.existsSync(file)) {
        const old = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
        manifest.states = [...old.states.filter(s => !names.includes(s.name)), ...manifest.states];
    }
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    return results;
}

/**
 * Records the app's API answers from a real backend: opens each state at `base` (logged in, steps
 * done) with no mocks at all, and writes what the page fetched to the HAR `file` (adding to it).
 * Point the config's `recording` at it and later captures answer from it.
 */
export async function recordData({ config, base, file, only, root = process.cwd(), log = console.log }: { config: Config; base?: string; file: string; only?: string[]; root?: string; log?: (line: string) => void }): Promise<{ results: CaptureResult[]; answers: number }> {
    const baseURL = base ?? config.baseURL;
    if (!baseURL) throw new Error('No base URL: pass --base <url> or set baseURL in the config');
    const names = only?.length ? only : Object.keys(config.states);
    for (const n of names) if (!config.states[n]) throw new Error(`No state "${n}"; the config has ${Object.keys(config.states).join(', ')}`);
    const storageState = storedAuth(root, baseURL);
    const recorder = new Recorder();
    const browser = await launch();
    const results: CaptureResult[] = [];
    try {
        for (const name of names) {
            const state = config.states[name];
            try {
                const { context, errors } = await openState(browser, {
                    url: new URL(state.path ?? '/', baseURL).href,
                    steps: state.steps,
                    viewport: state.viewport ?? config.viewport,
                    settle: state.settle ?? config.settle,
                    stepTimeout: state.stepTimeout ?? config.stepTimeout,
                    storageState,
                    now: config.now,
                    recorder,
                });
                await recorder.flush();
                await context.close();
                results.push({ name, ok: true, errors, fidelity: null });
                log(`ok   ${name}`);
            } catch (error) {
                const message = (error as Error).message.split('\n')[0];
                results.push({ name, ok: false, error: message, errors: [], fidelity: null });
                log(`FAIL ${name}: ${message}`);
            }
        }
    } finally {
        await browser.close();
    }
    return { results, answers: await recorder.save(file) };
}
