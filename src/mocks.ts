// A config's mocks, answered the same way where the browser asks (capture.ts) and where the app's
// server asks (the data proxy, for server-rendered pages): matched by method and path, and a function
// answer told what the recording would have answered and how many writes came before.
import type { MockAnswer } from './types.js';

/** What a mock function gets: Playwright's Request has these, and the data proxy gives the same. */
export interface MockRequest { method(): string; url(): string; headers(): Record<string, string>; postData(): string | null }

/** What a mock function is told besides the request: what MSW or the recording would answer (JSON, else undefined), and how many writes the config's mocks answered before it (POST, PUT, PATCH, DELETE). */
export interface MockContext { recorded: unknown; writes: number }

export interface MockReply { status: number; headers?: Record<string, string>; contentType?: string; body: string }

/** POST, PUT, PATCH, DELETE: a request that changes data. */
export const isWrite = (method: string) => !/^(GET|HEAD|OPTIONS)$/.test(method);

/** "GET /api/items" or "/api/items*" against a request. Paths are matched from the start, `*` is any run of characters. */
function matcher(pattern: string): (request: MockRequest) => boolean {
    const [method, route] = /^[A-Z]+\s/.test(pattern) ? pattern.split(/\s+/, 2) : ['*', pattern];
    const re = new RegExp(`^${route.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return request => (method === '*' || request.method() === method) && re.test(new URL(request.url()).pathname);
}

/** The mocks as a lookup: the first whose pattern matches the request, its answer. */
export function mockTable(mocks: Record<string, MockAnswer>): (request: MockRequest) => MockAnswer | undefined {
    const table = Object.entries(mocks).map(([p, answer]) => [matcher(p), answer] as const);
    return request => table.find(([test]) => test(request))?.[1];
}

/** The recorded body as JSON, for a mock function; not JSON: undefined. */
export function recordedJson(body: Buffer | string | undefined): unknown {
    if (body === undefined) return undefined;
    try { return JSON.parse(body.toString()); } catch { return undefined; }
}

/** A mock's answer: an object or array is JSON; { status, json | body, headers } says more; a function gets the request and the context. */
export async function mockReply(answer: MockAnswer, request: MockRequest, context: () => Promise<MockContext>): Promise<MockReply> {
    const value: unknown = typeof answer === 'function' ? await answer(request, await context()) : answer;
    const full = (value && typeof value === 'object' && ('json' in value || 'body' in value || 'status' in value) ? value : { json: value }) as { status?: number; json?: unknown; body?: string; headers?: Record<string, string>; contentType?: string };
    return {
        status: full.status ?? 200,
        headers: full.headers,
        contentType: full.json !== undefined ? 'application/json' : full.contentType,
        body: full.json !== undefined ? JSON.stringify(full.json) : full.body ?? '',
    };
}
