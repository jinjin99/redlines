// Where a page's text comes from: the strings in the API answers a state's page got (mocks, MSW, a
// recording, the network; and a recording's server-side answers too), kept when they show on the page.
// A designer retyping one of them is changing data or configuration, not code: the change says so,
// with the request and the key it came from.
import type { Page } from 'playwright-core';

import type { Entry } from './recording.js';
import type { Change, DataSource, PageTree, TreeNode } from './types.js';

/** Text on the page → where it came from: { from: 'GET /api/orders', key: '[0].customer' }. */
export type DataMap = Record<string, { from: string; key: string }>;

const MAX = 5000;

/** Every string in a JSON value, with its key path ([0].customer.name). */
function strings(value: unknown, key: string, out: [string, string][]) {
    if (out.length >= MAX) return;
    if (typeof value === 'string') {
        const t = value.trim();
        if (t && t.length <= 300) out.push([t, key]);
    } else if (Array.isArray(value)) value.forEach((v, i) => strings(v, `${key}[${i}]`, out));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) strings(v, /^[A-Za-z_$][\w$]*$/.test(k) ? `${key}.${k}` : `${key}[${JSON.stringify(k)}]`, out);
}

const requestName = (method: string, url: string) => { const u = new URL(url); return `${method} ${u.pathname}`; };

/** Collects the strings of the JSON answers a page gets, and those of recorded answers. */
export class DataWatcher {
    private found: [string, { from: string; key: string }][] = [];
    private pending: Promise<void>[] = [];

    watch(page: Page) {
        page.on('response', response => {
            const type = response.request().resourceType();
            if (type !== 'xhr' && type !== 'fetch') return;
            if (!/json/.test(response.headers()['content-type'] ?? '')) return;
            this.pending.push(response.json().then(json => this.add(requestName(response.request().method(), response.url()), json), () => {}));
        });
    }

    add(from: string, json: unknown) {
        const out: [string, string][] = [];
        strings(json, '', out);
        for (const [text, key] of out) this.found.push([text, { from, key: key.replace(/^\./, '') || '(the whole answer)' }]);
    }

    /** A recording's answers (the server's own requests, through the data proxy, among them). */
    addRecording(entries: Entry[]) {
        for (const e of entries) {
            if (!/json/.test(e.response.content.mimeType) || e.response.content.encoding) continue;
            try { this.add(requestName(e.request.method, e.request.url), JSON.parse(e.response.content.text)); } catch { /* not JSON after all */ }
        }
    }

    /** The strings that show on the page (a text of it, or inside one), the first source of each. */
    async on(tree: PageTree): Promise<DataMap> {
        await Promise.all(this.pending);
        const texts: string[] = [];
        const walk = (n: TreeNode) => { if ('text' in n) texts.push(n.text.trim()); else n.children?.forEach(walk); };
        walk(tree.root);
        const exact = new Set(texts), joined = texts.join('\n');
        const map: DataMap = {};
        for (const [text, source] of this.found) {
            if (map[text] || !(exact.has(text) || (text.length >= 6 && joined.includes(text)))) continue;
            map[text] = source;
        }
        return map;
    }
}

/** The quoted texts in a change's descriptions. */
const quoted = (lines: string[]) => lines.flatMap(l => [...l.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]));

/**
 * The data a changed text came from: each text the change replaced (or, for a restyle, shows) that is a
 * string from the data, or holds one (`whole: false`: data inside copy, like "Claim #1042 submitted").
 */
export function dataSources(change: Change, data: DataMap): DataSource[] {
    // Added text is new copy; a restyle is the code's.
    if (change.kind === 'added' || change.styles) return [];
    const texts = quoted(change.was.length ? change.was : change.now);
    const out: DataSource[] = [];
    for (const text of new Set(texts)) {
        if (data[text]) { out.push({ text, ...data[text], whole: true }); continue; }
        const inside = Object.keys(data).filter(d => d.length >= 6 && text.includes(d)).sort((a, b) => b.length - a.length)[0];
        if (inside) out.push({ text: inside, ...data[inside], whole: false });
    }
    return out;
}
