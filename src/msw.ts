// A project's own MSW handlers answering the page's requests: the module the config names is
// imported, and each request is handed to MSW's getResponse (from the same MSW the handlers were
// made with, found from the handlers file). Nothing runs in the app: no service worker, no code.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Request as PlaywrightRequest } from 'playwright-core';

/** `msw` in the config: the handlers module, and which of its exports is the default set (`handlers`). */
export type MswConfig = string | { file: string; export?: string };

type GetResponse = (handlers: unknown[], request: Request) => Promise<Response | undefined>;

export interface MswSource {
    file: string;
    /** The handler sets the module exports, by name. */
    sets: Record<string, unknown[]>;
    defaultSet: string;
    getResponse: GetResponse;
}

/** Imports the handlers module (relative to the config file's folder). */
export async function loadMsw(spec: MswConfig, configDir: string): Promise<MswSource> {
    const { file: rel, export: name = 'handlers' } = typeof spec === 'string' ? { file: spec } : spec;
    const file = path.resolve(configDir, rel);
    if (/\.(c|m)?ts$/.test(file) && !(process.features as { typescript?: unknown }).typescript) {
        throw new Error(`msw: ${rel} is TypeScript, which this Node (${process.version}) can't load by itself; use Node 22.18 or later, or point msw at the handlers compiled to JavaScript`);
    }
    let mod: Record<string, unknown>;
    try {
        mod = await import(pathToFileURL(file).href);
    } catch (error) {
        throw new Error(`msw: could not load ${rel}: ${(error as Error).message.split('\n')[0]}`, { cause: error });
    }
    const sets: Record<string, unknown[]> = {};
    for (const [key, value] of Object.entries(mod)) if (Array.isArray(value)) sets[key] = value;
    const defaultSet = sets[name] ? name : Array.isArray(mod.default) ? 'default' : '';
    if (!defaultSet) throw new Error(`msw: ${rel} exports no handler list "${name}" (it exports ${Object.keys(sets).join(', ') || 'no lists'})`);
    // The MSW the handlers were made with: resolved from where they are.
    let getResponse: GetResponse | undefined;
    try {
        const msw = await import(pathToFileURL(createRequire(file).resolve('msw')).href);
        getResponse = msw.getResponse ?? msw.default?.getResponse;
    } catch (error) {
        throw new Error(`msw: no msw package installed where ${rel} is`, { cause: error });
    }
    if (typeof getResponse !== 'function') throw new Error('msw: this MSW has no getResponse (MSW 2.4 or later is needed)');
    return { file, sets, defaultSet, getResponse };
}

/** The handlers a state uses: its own set (`msw: '<export>'` on the state) before the default set. */
export function handlersFor(source: MswSource, scenario?: string): unknown[] {
    if (scenario && !source.sets[scenario]) throw new Error(`msw: ${path.basename(source.file)} has no handler list "${scenario}" (it has ${Object.keys(source.sets).join(', ')})`);
    return [...(scenario ? source.sets[scenario] : []), ...source.sets[source.defaultSet]];
}

/** MSW's answer to a page's request, or undefined when no handler takes it. */
export async function mswAnswer(source: MswSource, handlers: unknown[], request: PlaywrightRequest): Promise<{ status: number; headers: Record<string, string>; body: Buffer } | undefined> {
    const method = request.method();
    const data = method === 'GET' || method === 'HEAD' ? null : request.postDataBuffer();
    const body = data ? new Uint8Array(data) : undefined;
    const response = await source.getResponse(handlers, new Request(request.url(), { method, headers: request.headers(), body }));
    if (!response) return undefined;
    return { status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) };
}
