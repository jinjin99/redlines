// Shoots each state a config lists: opens the page, answers the requests the config mocks, does the
// state's steps (click, fill, …), waits for it to settle, then writes the page tree and a full-page
// screenshot. Run it once against the code before a change and once against the code after.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { launch } from './browser.js';
import { snapshot } from './page/snapshot.js';

const CONFIG_NAMES = ['redlines.config.mjs', 'redlines.config.js', 'redlines.config.json'];

/** The config: a file path, or the first redlines.config.* in `dir`. */
export async function loadConfig(file, dir = process.cwd()) {
    const found = file ? path.resolve(file) : CONFIG_NAMES.map(n => path.join(dir, n)).find(f => fs.existsSync(f));
    if (!found || !fs.existsSync(found)) throw new Error(`No config: write redlines.config.mjs (see README), or pass --config <file>`);
    const config = found.endsWith('.json') ? JSON.parse(fs.readFileSync(found, 'utf8')) : (await import(pathToFileURL(found).href)).default;
    if (!config || typeof config.states !== 'object') throw new Error(`${found}: a config has "states": { "<name>": { "path": "/…" } }`);
    for (const name of Object.keys(config.states)) if (!/^[\w-]+$/.test(name)) throw new Error(`${found}: a state's name is letters, digits, - and _ (it names files): ${name}`);
    return { ...config, file: found };
}

/** "GET /api/items" or "/api/items*" against a request. Paths are matched from the start, `*` is any run of characters. */
function matcher(pattern) {
    const [method, route] = /^[A-Z]+\s/.test(pattern) ? pattern.split(/\s+/, 2) : ['*', pattern];
    const re = new RegExp(`^${route.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return request => (method === '*' || request.method() === method) && re.test(new URL(request.url()).pathname);
}

/** A mock's answer: an object or array is JSON; { status, json | body, headers } says more; a function gets the request. */
async function fulfill(route, answer) {
    const value = typeof answer === 'function' ? await answer(route.request()) : answer;
    const full = value && typeof value === 'object' && ('json' in value || 'body' in value || 'status' in value) ? value : { json: value };
    return route.fulfill({ status: full.status ?? 200, headers: full.headers, contentType: full.json !== undefined ? 'application/json' : full.contentType, body: full.json !== undefined ? JSON.stringify(full.json) : full.body ?? '' });
}

async function step(page, s) {
    if (s.click) return page.locator(s.click).first().click();
    if (s.fill) return page.locator(s.fill[0]).first().fill(String(s.fill[1]));
    if (s.press) return page.keyboard.press(s.press);
    if (s.hover) return page.locator(s.hover).first().hover();
    if (s.select) return page.locator(s.select[0]).first().selectOption(s.select[1]);
    if (s.waitFor) return page.locator(s.waitFor).first().waitFor();
    if (typeof s.wait === 'number') return page.waitForTimeout(s.wait);
    if (typeof s === 'function') return s(page);
    throw new Error(`Unknown step ${JSON.stringify(s)}: click, fill, press, hover, select, waitFor, wait, or a function (page) => …`);
}

// Still pictures: no animation, transition or blinking caret between two shots.
const STILL = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';

/** Shoots the config's states (or `only` of them) at `base` into `out`. Returns [{ name, ok, error? }]. */
export async function shoot({ config, base, out, only, log = console.log }) {
    const baseURL = base ?? config.baseURL;
    if (!baseURL) throw new Error('No base URL: pass --base <url> or set baseURL in the config');
    const names = only?.length ? only : Object.keys(config.states);
    for (const n of names) if (!config.states[n]) throw new Error(`No state "${n}"; the config has ${Object.keys(config.states).join(', ')}`);
    fs.mkdirSync(out, { recursive: true });
    const browser = await launch();
    const results = [];
    try {
        for (const name of names) {
            const state = config.states[name];
            const viewport = state.viewport ?? config.viewport ?? { width: 1280, height: 800 };
            const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: 'reduce', locale: config.locale ?? 'en-US', timezoneId: config.timezone ?? 'UTC' });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', e => errors.push(String(e.message).slice(0, 200)));
            const mocks = Object.entries({ ...(config.mocks ?? {}), ...(state.mocks ?? {}) }).map(([p, answer]) => [matcher(p), answer]);
            if (mocks.length) {
                await page.route('**/*', route => {
                    const hit = mocks.find(([test]) => test(route.request()));
                    return hit ? fulfill(route, hit[1]) : route.fallback();
                });
            }
            try {
                await page.goto(new URL(state.path ?? '/', baseURL).href, { waitUntil: 'load' });
                await page.addStyleTag({ content: STILL });
                for (const s of state.steps ?? []) await step(page, s);
                await page.waitForLoadState('networkidle').catch(() => {});
                await page.evaluate(() => document.fonts?.ready);
                await page.waitForTimeout(state.settle ?? config.settle ?? 300);
                const tree = await page.evaluate(snapshot, { ignore: state.ignore ?? config.ignore ?? null });
                tree.state = { name, title: state.title ?? name, path: state.path ?? '/' };
                fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(tree));
                await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
                results.push({ name, ok: true, errors });
                log(`ok   ${name}${errors.length ? `  (the page logged: ${errors.join(' | ')})` : ''}`);
            } catch (error) {
                results.push({ name, ok: false, error: error.message.split('\n')[0] });
                log(`FAIL ${name}: ${error.message.split('\n')[0]}`);
            } finally {
                await context.close();
            }
        }
    } finally {
        await browser.close();
    }
    const manifest = { tool: 'redlines', version: 1, base: baseURL, at: new Date().toISOString(), states: results.filter(r => r.ok).map(r => ({ name: r.name, title: config.states[r.name].title ?? r.name, tree: `${r.name}.json`, image: `${r.name}.png` })) };
    // Shooting some states adds to what the folder had.
    const file = path.join(out, 'manifest.json');
    if (only?.length && fs.existsSync(file)) {
        const old = JSON.parse(fs.readFileSync(file, 'utf8'));
        manifest.states = [...old.states.filter(s => !names.includes(s.name)), ...manifest.states];
    }
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    return results;
}
