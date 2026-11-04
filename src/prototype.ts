// A clickable prototype of the running app that needs no server: each state's walk is recorded
// (everything the browser is given: the documents, scripts, styles, fonts, the API's answers and the
// config's mocks), and a service worker answers the pages from that recording. The folder goes on any
// static host, served from the root of its own (sub)domain: sw.js at the root, the prototype under
// p/<id>/, several prototypes side by side. The worker only answers pages opened from a prototype's
// entry; anything else the host serves is left alone.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { keepAuth, storedAuth } from './auth.js';
import { launch } from './browser.js';
import { openState, step } from './capture.js';
import { handlersFor, loadMsw } from './msw.js';
import { loadRecording } from './recording.js';
import type { Config, Step } from './types.js';

/** Analytics, ads and chat widgets: not the product, and they only make the prototype bigger. */
const TRACKERS = /googletagmanager|google-analytics|doubleclick|googleadservices|googlesyndication|connect\.facebook|facebook\.net|hotjar|clarity\.ms|segment\.(io|com)|mixpanel|amplitude|pendo\.io|intercom|hs-scripts|hs-banner|hs-analytics|hsadspixel|hubspot|licdn|sentry\.io|datadoghq|newrelic|fullstory|logrocket/;

/** A recorded answer as the worker gives it: `writes` is how many of the walk's writes came before it; `body` the request body's hash, for requests that have one. */
export interface Answer { status: number; headers: Record<string, string>; file: string | null; writes: number; body?: string }

/** What the worker reads: where the app was recorded, where the prototype starts, the answers by request, and which requests are writes. */
export interface PrototypeIndex { origin: string; start: string; answers: Record<string, Answer[]>; writes: string[] }

/**
 * The answer for a request, given how many writes the viewer has made: the latest one recorded after
 * no more writes than that (the claim as it was before "Reopen", and as it is after), else the first.
 */
export function chooseAnswer(list: Answer[], writes: number): Answer {
    let pick = list[0];
    for (const a of list) if (a.writes <= writes && a.writes >= pick.writes) pick = a;
    return pick;
}

/** A request body that only reads (a GraphQL query, not a mutation): sending it changes nothing. */
export function readsOnly(body: string): boolean {
    const isQuery = (q: unknown) => typeof q === 'string' && /^\s*(query\b|\{)/.test(q);
    let sent: unknown;
    try {
        sent = JSON.parse(body);
    } catch {
        // Not JSON: a query sent as GraphQL text.
        return isQuery(body);
    }
    const all = Array.isArray(sent) ? sent : [sent];
    return all.length > 0 && all.every(op => !!op && typeof op === 'object' && isQuery((op as { query?: unknown }).query));
}

/** The short hash a request body is matched by (the same in the worker, which uses the browser's crypto). */
const bodyHash = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The secrets a recorded page or answer may carry: token, session and key values, and JWT signatures. */
const SECRET_KEY = String.raw`[\w-]*(?:token|secret|password|session_state|api[_-]?key)[\w-]*`;
const SECRET_VALUE = new RegExp(String.raw`(["']?${SECRET_KEY}["']?\s*:\s*)(["'])([^"'\\]{8,})\2`, 'gi');
const JWT = /(eyJ[\w-]{10,}\.[\w-]{10,}\.)[\w-]{10,}/g;
const IS_JWT = /^eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}$/;

/** `text` without its login secrets: a JWT keeps what it says (a page may read it) but not its signature; other values become "redacted". */
export function scrub(text: string): { text: string; count: number } {
    let count = 0;
    const out = text
        .replace(SECRET_VALUE, (all, key: string, q: string, value: string) => (IS_JWT.test(value) ? all : (count++, `${key}${q}redacted${q}`)))
        .replace(JWT, (_, body: string) => (count++, `${body}unsigned`));
    return { text: out, count };
}

interface HarEntry {
    request: { method: string; url: string; postData?: { text?: string } };
    response: { status: number; headers: { name: string; value: string }[]; content: { text?: string; encoding?: string; mimeType?: string } };
}

/** A walk: a state's own steps, or a state's steps and then a click on one of its links. */
interface Walk { name: string; path: string; steps: Step[] }

function walksOf(config: Config, names: string[]): Walk[] {
    const walks: Walk[] = [];
    for (const name of names) {
        const state = config.states[name];
        const steps = state.steps ?? [];
        walks.push({ name, path: state.path ?? '/', steps });
        // Explicit links lead somewhere the states' own steps do not (a link continued by a state's steps is walked by that state).
        for (const [selector, to] of Object.entries(state.links ?? {})) walks.push({ name: `${name} → ${to}`, path: state.path ?? '/', steps: [...steps, { click: selector }, { wait: 1000 }] });
    }
    return walks;
}

const ENTRY = (id: string, start: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Prototype</title>
<style>body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#303030;background:#f1f1f1;display:grid;place-items:center;min-height:100vh}main{width:min(360px,80vw)}progress{width:100%}</style></head>
<body><main><p id="m">Preparing the prototype…</p><progress id="bar" max="1" value="0"></progress></main><script>
const START = ${JSON.stringify(start).replace(/</g, '\\u003c')}, ID = ${JSON.stringify(id)};
const m = document.getElementById('m'), bar = document.getElementById('bar');
if (!navigator.serviceWorker) m.textContent = 'This prototype needs a browser with service workers, on https (or localhost).';
else navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready).then(() => {
  if (!navigator.serviceWorker.controller) return location.reload();
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data.id !== ID) return;
    if (e.data.type === 'progress') { bar.max = e.data.total; bar.value = e.data.done; m.textContent = 'Preparing the prototype… ' + e.data.done + ' / ' + e.data.total; }
    if (e.data.type === 'ready') location.replace(START + (START.includes('?') ? '&' : '?') + '__prototype=' + ID);
  });
  navigator.serviceWorker.controller.postMessage({ type: 'prepare', id: ID });
}).catch(e => { m.textContent = 'The prototype could not start: ' + e; });
</script></body></html>
`;

/**
 * The service worker, written out as sw.js. It runs in the viewer's browser, so it uses nothing from
 * this module but `chooseAnswer`, which is written out beside it.
 */
interface WorkerEvent { waitUntil(p: Promise<unknown>): void }
interface FetchEventLike extends WorkerEvent { request: Request; clientId: string; resultingClientId: string; respondWith(r: Promise<Response>): void }
interface MessageEventLike extends WorkerEvent { data: unknown; source: { postMessage(message: unknown): void } | null }
interface WorkerScope { skipWaiting(): Promise<void>; clients: { claim(): Promise<void> }; addEventListener(type: string, listener: (e: never) => void): void }

function worker() {
    const sw = self as unknown as WorkerScope;
    const CLIENTS = 'redlines-prototype-clients';
    const indexes: Record<string, Promise<PrototypeIndex>> = {};
    const writes: Record<string, number> = {};
    const index = (id: string) => (indexes[id] ??= fetch(`/p/${id}/r/index.json`).then(r => r.json() as Promise<PrototypeIndex>));
    const files = (id: string) => caches.open(`redlines-prototype-${id}`);
    const remember = async (client: string, id: string) => client && (await caches.open(CLIENTS)).put(`/__prototype_client/${client}`, new Response(id));
    const prototypeOf = async (client: string) => (client ? (await (await caches.open(CLIENTS)).match(`/__prototype_client/${client}`))?.text() : undefined);
    // The viewer's writes so far (kept, as the browser may stop the worker between two clicks).
    const writesOf = async (id: string) => (writes[id] ??= Number((await (await caches.open(CLIENTS)).match(`/__prototype_writes/${id}`))?.text() ?? 0));
    const setWrites = async (id: string, n: number) => { writes[id] = n; await (await caches.open(CLIENTS)).put(`/__prototype_writes/${id}`, new Response(String(n))); };

    sw.addEventListener('install', () => sw.skipWaiting());
    sw.addEventListener('activate', (e: WorkerEvent) => e.waitUntil(sw.clients.claim()));
    // The entry page asks for a prototype's files ahead of time and starts it over: answers then come
    // from the cache, not one network round trip each (hundreds of them hold the page back for seconds).
    sw.addEventListener('message', (e: MessageEventLike) => {
        const { type, id } = (e.data ?? {}) as { type?: string; id?: string };
        if (type !== 'prepare' || !id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) return;
        const source = e.source;
        e.waitUntil((async () => {
            await setWrites(id, 0);
            const { answers } = await index(id);
            const cache = await files(id);
            const all = [...new Set(Object.values(answers).flat().map(a => a.file).filter((f): f is string => !!f))];
            const have = new Set((await cache.keys()).map(r => r.url.split('/').pop()));
            const todo = all.filter(f => !have.has(f));
            let done = all.length - todo.length;
            const report = () => source?.postMessage({ type: 'progress', id, done, total: all.length });
            report();
            const next = async () => {
                for (let f = todo.shift(); f; f = todo.shift()) {
                    const url = `/p/${id}/r/${f}`;
                    for (let i = 0; i < 3; i++) {
                        const r = await fetch(url).catch(() => null);
                        if (r?.ok) { await cache.put(url, r); break; }
                    }
                    if (++done % 20 === 0) report();
                }
            };
            await Promise.all(Array.from({ length: 24 }, next));
            report();
            source?.postMessage({ type: 'ready', id });
        })());
    });
    sw.addEventListener('fetch', (e: FetchEventLike) => {
        const url = new URL(e.request.url);
        if (url.origin === location.origin && (url.pathname.startsWith('/p/') || url.pathname === '/sw.js')) return;
        const id = e.request.mode === 'navigate' ? url.searchParams.get('__prototype') : null;
        // A page not opened from a prototype's entry: the host's own.
        if (e.request.mode === 'navigate' && !id) return;
        e.respondWith((async () => {
            const proto = id ?? (await prototypeOf(e.clientId));
            if (!proto) return fetch(e.request);
            if (id) await remember(e.resultingClientId, id);
            return answer(proto, e.request, url);
        })());
    });

    async function answer(id: string, request: Request, url: URL): Promise<Response> {
        const { origin, answers, writes: writeKeys } = await index(id);
        if (request.mode === 'navigate') url.searchParams.delete('__prototype');
        // The prototype's own address stands for where the app was recorded.
        const href = url.origin === location.origin ? origin + url.pathname + url.search : url.href;
        const key = `${request.method} ${href}`;
        const bare = (s: string) => s.split('?')[0];
        let list = answers[key];
        // The same address with another query (a cache-buster, a timestamp).
        list ??= answers[Object.keys(answers).find(k => k.startsWith(`${request.method} `) && bare(k.slice(request.method.length + 1)) === bare(href)) ?? ''];
        if (!list && request.method === 'GET') {
            // A build file under another content hash (a CDN that changed versions while recording): the recorded one of that name.
            const unhashed = (s: string) => bare(s).replace(/\.[0-9a-f]{8,}(?=\.\w+$)/, '.*');
            const want = unhashed(href);
            if (want.includes('.*')) list = answers[Object.keys(answers).find(k => k.startsWith('GET ') && unhashed(k.slice(4)) === want) ?? ''];
        }
        if (!list) return new Response('', { status: request.method === 'GET' ? 404 : 204 });
        // A request with a body (GraphQL sends every query to one address): the answers to this body, if recorded.
        const sent = ['GET', 'HEAD'].includes(request.method) ? '' : await request.clone().text();
        if (sent) {
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sent));
            const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
            const same = list.filter(a => a.body === hash);
            if (same.length) list = same;
        }
        const made = await writesOf(id);
        const hit = chooseAnswer(list, made);
        if (writeKeys.includes(`${request.method} ${bare(href)}`) && !readsOnly(sent)) await setWrites(id, made + 1);
        const file = hit.file ? `/p/${id}/r/${hit.file}` : null;
        const body = file ? await ((await (await files(id)).match(file)) ?? (await fetch(file))).arrayBuffer() : null;
        return new Response([204, 304].includes(hit.status) ? null : body, { status: hit.status === 304 ? 200 : hit.status, headers: hit.headers });
    }
}

export interface PrototypeResult {
    walks: { name: string; ok: boolean; error?: string }[];
    files: number;
    bytes: number;
    secrets: number;
    entry: string;
}

/**
 * Walks the states at `base` (logged in, with the config's data) and writes the prototype `id` into
 * `out`: out/sw.js and out/p/<id>/. It starts at the state `start` (default: the first one walked).
 */
export async function buildPrototype({ config, base, out, id, start, only, skip, root = process.cwd(), log = console.log }: { config: Config; base?: string; out: string; id: string; start?: string; only?: string[]; skip?: string; root?: string; log?: (line: string) => void }): Promise<PrototypeResult> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error(`The prototype's id is a short name in lowercase letters, digits and dashes, not ${JSON.stringify(id)}`);
    const baseURL = base ?? config.baseURL;
    if (!baseURL) throw new Error('No base URL: pass --base <url> or set baseURL in the config');
    const names = only?.length ? only : Object.keys(config.states);
    for (const n of [...names, ...(start ? [start] : [])]) if (!config.states[n]) throw new Error(`No state "${n}"; the config has ${Object.keys(config.states).join(', ')}`);
    const skipped = skip ? new RegExp(skip) : null;
    const storageState = storedAuth(root, baseURL);
    const configDir = config.file && path.isAbsolute(config.file) ? path.dirname(config.file) : root;
    const mswSource = config.msw ? await loadMsw(config.msw, configDir) : undefined;
    const recording = config.recording ? loadRecording(path.resolve(configDir, config.recording)) : undefined;
    const origin = new URL(baseURL).origin;

    // Each walk's HAR holds the request headers (cookies): kept in a private folder and removed after.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redlines-prototype-'));
    const walks = walksOf(config, names);
    const results: PrototypeResult['walks'] = [];
    const recorded: { walk: Walk; entries: HarEntry[] }[] = [];
    try {
        const browser = await launch();
        try {
            for (const [i, walk] of walks.entries()) {
                const state = config.states[walk.name.split(' → ')[0]];
                const har = path.join(tmp, `${i}.har`);
                try {
                    const { context } = await openState(browser, {
                        url: new URL(walk.path, baseURL).href,
                        steps: walk.steps,
                        mocks: { ...(config.mocks ?? {}), ...(state.mocks ?? {}) },
                        viewport: state.viewport ?? config.viewport,
                        settle: state.settle ?? config.settle,
                        stepTimeout: state.stepTimeout ?? config.stepTimeout,
                        storageState,
                        msw: mswSource && { source: mswSource, handlers: handlersFor(mswSource, state.msw) },
                        recording,
                        locale: config.locale,
                        timezone: config.timezone,
                        har,
                    });
                    if (storageState) await keepAuth(storageState, context).catch(() => {});
                    await context.close();
                    recorded.push({ walk, entries: JSON.parse(fs.readFileSync(har, 'utf8')).log.entries });
                    results.push({ name: walk.name, ok: true });
                    log(`ok   ${walk.name}`);
                } catch (error) {
                    const message = (error as Error).message.split('\n')[0];
                    results.push({ name: walk.name, ok: false, error: message });
                    log(`FAIL ${walk.name}: ${message}`);
                }
            }
        } finally {
            await browser.close();
        }
        if (!recorded.length) throw new Error('No walk could be recorded, so there is no prototype');

        // The writes: requests that change the data the pages show, so a viewer's click gets the answers
        // recorded after it. Those the config's data answers (its mocks, or the recording) when it can
        // tell; with MSW handlers, any request but a read that is not to a tracker.
        const patterns = Object.keys({ ...(config.mocks ?? {}), ...Object.assign({}, ...Object.values(config.states).map(s => s.mocks ?? {})) }).map(p => {
            const [method, route] = /^[A-Z]+\s/.test(p) ? p.split(/\s+/, 2) : ['*', p];
            const re = new RegExp(`^${route.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
            return (m: string, url: string) => (method === '*' || method === m) && re.test(new URL(url).pathname);
        });
        const isWrite = (e: HarEntry) => {
            const { method, url } = e.request;
            if (['GET', 'HEAD', 'OPTIONS'].includes(method) || TRACKERS.test(url) || skipped?.test(url) || readsOnly(e.request.postData?.text ?? '')) return false;
            return !!mswSource || patterns.some(test => test(method, url)) || !!recording?.find(method, url);
        };
        const dir = path.join(out, 'p', id);
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(path.join(dir, 'r'), { recursive: true });
        const answers: Record<string, Answer[]> = {};
        const writes = new Set<string>();
        let bytes = 0, secrets = 0;
        for (const { entries } of recorded) {
            let made = 0;
            for (const e of entries) {
                const { request: q, response: a } = e;
                if (a.status <= 0 || TRACKERS.test(q.url) || skipped?.test(q.url)) continue;
                const key = `${q.method} ${q.url.split('#')[0]}`;
                const type = a.headers.find(h => h.name.toLowerCase() === 'content-type')?.value ?? a.content.mimeType ?? '';
                let body = a.content.text == null ? Buffer.alloc(0) : Buffer.from(a.content.text, a.content.encoding === 'base64' ? 'base64' : 'utf8');
                // Pages and data may carry the login: not code, which is left as it is.
                if (/html|json/.test(type)) {
                    const clean = scrub(body.toString('utf8'));
                    secrets += clean.count;
                    body = Buffer.from(clean.text, 'utf8');
                }
                let file: string | null = null;
                // An empty answer has no file (a static host may not take an empty one).
                if (body.length) {
                    file = crypto.createHash('sha256').update(body).digest('hex').slice(0, 24);
                    const at = path.join(dir, 'r', file);
                    if (!fs.existsSync(at)) { fs.writeFileSync(at, body); bytes += body.length; }
                }
                const headers: Record<string, string> = {};
                for (const h of a.headers) if (['content-type', 'location'].includes(h.name.toLowerCase())) headers[h.name.toLowerCase()] = h.value;
                const list = (answers[key] ??= []);
                const sent = q.postData?.text ? bodyHash(q.postData.text) : undefined;
                // The same answer to the same request after the same writes is kept once.
                if (!list.some(x => x.file === file && x.status === a.status && x.writes === made && x.body === sent)) list.push({ status: a.status, headers, file, writes: made, ...(sent ? { body: sent } : {}) });
                if (isWrite(e)) { writes.add(`${q.method} ${q.url.split(/[?#]/)[0]}`); made++; }
            }
        }
        const first = start ?? recorded[0].walk.name.split(' → ')[0];
        const index: PrototypeIndex = { origin, start: config.states[first].path ?? '/', answers, writes: [...writes] };
        fs.writeFileSync(path.join(dir, 'r', 'index.json'), JSON.stringify(index));
        fs.writeFileSync(path.join(dir, 'index.html'), ENTRY(id, index.start));
        fs.writeFileSync(path.join(out, 'sw.js'), `// redlines prototypes: answers the pages opened from /p/<id>/ from their recording; anything else goes to the network.\n${chooseAnswer.toString()}\n${readsOnly.toString()}\n(${worker.toString()})();\n`);
        const files = fs.readdirSync(path.join(dir, 'r')).length + 2;
        return { walks: results, files, bytes, secrets, entry: `/p/${id}/` };
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

/** Serves a folder on a local port with the content types a browser needs (a service worker must be JavaScript). */
export function serveFolder(dir: string, port = 0): Promise<{ url: string; close: () => void }> {
    const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            let file = path.join(dir, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
            if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
            if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
            fs.createReadStream(file).pipe(res);
        });
        server.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }));
    });
}

/**
 * Plays the walks on the built prototype, served from `out` on a local port with every other address
 * cut off: each walk opens its page from the prototype and does its steps.
 */
export async function checkPrototype({ config, out, id, only }: { config: Config; out: string; id: string; only?: string[] }): Promise<{ walks: { name: string; ok: boolean; error?: string }[]; offline: string[] }> {
    const served = await serveFolder(path.resolve(out));
    const browser = await launch();
    const offline = new Set<string>();
    try {
        const context = await browser.newContext({ viewport: config.viewport ?? { width: 1280, height: 800 }, serviceWorkers: 'allow' });
        // Nothing but the folder: the prototype must not need anything else.
        await context.route('**/*', route => {
            const url = route.request().url();
            if (url.startsWith(served.url)) return route.fallback();
            offline.add(new URL(url).host);
            return route.abort();
        });
        const page = await context.newPage();
        const results: { name: string; ok: boolean; error?: string }[] = [];
        for (const walk of walksOf(config, only?.length ? only : Object.keys(config.states))) {
            try {
                // From the entry (starts the prototype over), then to this walk's page.
                await page.goto(`${served.url}/p/${id}/`);
                await page.waitForURL(/__prototype=/, { timeout: 120_000 });
                const url = new URL(walk.path, served.url);
                url.searchParams.set('__prototype', id);
                await page.goto(url.href);
                await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
                page.setDefaultTimeout(config.stepTimeout ?? 15_000);
                for (const s of walk.steps) await step(page, s);
                results.push({ name: walk.name, ok: true });
            } catch (error) {
                results.push({ name: walk.name, ok: false, error: (error as Error).message.split('\n')[0] });
            }
        }
        return { walks: results, offline: [...offline] };
    } finally {
        await browser.close();
        served.close();
    }
}
