// Recorded data: the app's own API answers (fetch and XHR only, never scripts or styles, which must
// come from the version being captured), taken once from a real backend and replayed on later
// captures. Kept as HAR, without request headers (cookies, tokens) and with only the response's
// content type. It is the backend's real data: keep it out of public repositories.
import fs from 'node:fs';
import path from 'node:path';

import type { Page, Request as PlaywrightRequest, Response } from 'playwright-core';

import { workDir } from './package.js';

export interface Entry {
    request: { method: string; url: string; postData?: { mimeType: string; text: string } };
    response: { status: number; content: { mimeType: string; text: string; encoding?: 'base64' } };
}

/** Collects API answers as they arrive: a page's (watch), or any others (add). */
export class Recorder {
    private entries: Entry[] = [];
    private pending: Promise<void>[] = [];

    /** An answer seen elsewhere (the data proxy's). */
    push(entry: Entry) {
        this.entries.push(entry);
    }

    get size() {
        return this.entries.length;
    }

    watch(page: Page) {
        page.on('response', response => {
            const type = response.request().resourceType();
            if (type === 'xhr' || type === 'fetch') this.pending.push(this.add(response));
        });
    }

    private async add(response: Response) {
        const request = response.request();
        let body: Buffer;
        try {
            body = await response.body();
        } catch {
            return; // a redirect, or the page went away first: nothing to replay
        }
        const mimeType = response.headers()['content-type'] ?? 'application/octet-stream';
        const text = /json|text|xml|javascript|graphql/.test(mimeType) ? { text: body.toString('utf8') } : { text: body.toString('base64'), encoding: 'base64' as const };
        const post = request.postData();
        this.entries.push({
            request: { method: request.method(), url: request.url(), ...(post ? { postData: { mimeType: request.headers()['content-type'] ?? '', text: post } } : {}) },
            response: { status: response.status(), content: { mimeType, ...text } },
        });
    }

    /** Waits for the bodies of the answers seen so far (before their page closes, after which they can't be read). */
    async flush() {
        await Promise.all(this.pending);
    }

    /** Waits for every body, then writes the HAR (adding to what `file` already has, newer answers first). */
    async save(file: string): Promise<number> {
        await Promise.all(this.pending);
        const old: Entry[] = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).log?.entries ?? []) : [];
        const keys = new Set(this.entries.map(keyOf));
        const entries = [...this.entries, ...old.filter(e => !keys.has(keyOf(e)))];
        // A recording is real backend data: under a .redlines/ folder, that folder keeps it out of git.
        const at = file.split(path.sep).lastIndexOf('.redlines');
        if (at > 0) workDir(file.split(path.sep).slice(0, at).join(path.sep) || path.sep);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Written whole, then moved into place: the browser's recording and the proxy's may share the file.
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ log: { version: '1.2', creator: { name: 'redlines', version: '1' }, entries } }, null, 1));
        fs.renameSync(tmp, file);
        return this.entries.length;
    }
}

const keyOf = (e: Entry) => `${e.request.method} ${e.request.url} ${e.request.postData?.text ?? ''}`;
const pathOf = (url: string) => { const u = new URL(url); return u.pathname + u.search; };

export interface Recording {
    file: string;
    entries: Entry[];
    /** For a page's request: its API requests (fetch, XHR) only. */
    lookup: (request: PlaywrightRequest) => Entry | undefined;
    /** For any request (the data proxy's). */
    find: (method: string, url: string, body?: string) => Entry | undefined;
}

/**
 * A HAR to answer from. A request is matched by method, path and query (any host: the dev server's
 * port may differ from where it was recorded) and, for a request with a body, the body; else by
 * method and path alone.
 */
export function loadRecording(file: string): Recording {
    if (!fs.existsSync(file)) throw new Error(`No recording at ${file}: record one first (record_data)`);
    const entries: Entry[] = JSON.parse(fs.readFileSync(file, 'utf8')).log?.entries ?? [];
    const exact = new Map<string, Entry>(), loose = new Map<string, Entry>();
    // A request recorded more than once answers with its first successful answer: a 401 recorded just
    // before the app refreshed its token is not what the page should be given.
    const keep = (map: Map<string, Entry>, k: string, e: Entry) => { const had = map.get(k); if (!had || (had.response.status >= 400 && e.response.status < 400)) map.set(k, e); };
    for (const e of entries) {
        keep(exact, `${e.request.method} ${pathOf(e.request.url)} ${e.request.postData?.text ?? ''}`, e);
        keep(loose, `${e.request.method} ${new URL(e.request.url).pathname}`, e);
    }
    const find = (method: string, url: string, body?: string) => exact.get(`${method} ${pathOf(url)} ${body ?? ''}`) ?? loose.get(`${method} ${new URL(url).pathname}`);
    return {
        file,
        entries,
        find,
        lookup: request => {
            const type = request.resourceType();
            return type === 'xhr' || type === 'fetch' ? find(request.method(), request.url(), request.postData() ?? undefined) : undefined;
        },
    };
}

/** The recorded answer as Playwright fulfils it. */
export function replay(entry: Entry): { status: number; contentType: string; body: Buffer } {
    const c = entry.response.content;
    return { status: entry.response.status, contentType: c.mimeType, body: Buffer.from(c.text, c.encoding === 'base64' ? 'base64' : 'utf8') };
}
