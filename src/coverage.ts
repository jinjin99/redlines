// Which lines of the app's own source a state ran: the browser's JS coverage, mapped back through the
// scripts' source maps (a bundle's, or each module's own in a dev server), so a change in the code can
// be matched to the states that show it, and code no state reaches can be named.
import type { Page } from 'playwright-core';

/** Lines of each source file: path as the source map names it → [first, last] line ranges (1-based). */
export type Lines = Record<string, [number, number][]>;

/** A state's coverage: the lines it ran, and the lines of code the loaded scripts hold at all (ran or not: not imports, types or comments). */
export interface Coverage { ran: Lines; code: Lines }

interface Range { startOffset: number; endOffset: number; count: number }
interface Entry { url: string; source?: string; functions: { ranges: Range[] }[] }

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** A source map's mappings: for each generated line, its segments [column, source, original line] (0-based). */
function decode(mappings: string): [number, number, number][][] {
    const lines: [number, number, number][][] = [];
    let source = 0, origLine = 0;
    for (const line of mappings.split(';')) {
        const segments: [number, number, number][] = [];
        let column = 0;
        for (const seg of line.split(',')) {
            if (!seg) continue;
            const values: number[] = [];
            let value = 0, shift = 0;
            for (const ch of seg) {
                const digit = B64.indexOf(ch);
                if (digit < 0) break;
                value += (digit & 31) << shift;
                if (digit & 32) shift += 5;
                else { values.push(value & 1 ? -(value >>> 1) : value >>> 1); value = 0; shift = 0; }
            }
            column += values[0] ?? 0;
            if (values.length >= 4) {
                source += values[1];
                origLine += values[2];
                segments.push([column, source, origLine]);
            }
        }
        lines.push(segments);
    }
    return lines;
}

/** A source's name as a path: without a bundler's scheme (webpack://app/, webpack-internal:///), query, or leading ./ and ../. */
export function sourcePath(name: string): string {
    return name.replace(/^[a-z-]+:\/\/\/?(_N_E\/|[^/]*\/)?/i, '').replace(/[?#].*$/, '').replace(/^(\.\.?\/)+/, '').replace(/^\/+/, '/');
}

/** For each offset in `offsets` (ascending), whether the code there ran: the innermost coverage range around it says. */
function ran(functions: Entry['functions'], offsets: number[]): boolean[] {
    // V8's ranges nest (a function, its blocks): sorted outer first, the innermost one around an offset is on top of a stack.
    const ranges = functions.flatMap(f => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
    const out: boolean[] = [];
    const stack: Range[] = [];
    let next = 0;
    for (const at of offsets) {
        while (next < ranges.length && ranges[next].startOffset <= at) stack.push(ranges[next++]);
        while (stack.length && stack[stack.length - 1].endOffset <= at) stack.pop();
        // Outside every range: the script's top level, which ran (it is in the coverage at all).
        out.push(stack.length ? stack[stack.length - 1].count > 0 : true);
    }
    return out;
}

function addLine(into: Record<string, Set<number>>, file: string, line: number) {
    (into[file] ??= new Set()).add(line);
}

/** Lines as ranges: [1,2,3,7] → [[1,3],[7,7]]. */
function toRanges(lines: Set<number>): [number, number][] {
    const sorted = [...lines].sort((a, b) => a - b);
    const out: [number, number][] = [];
    for (const l of sorted) {
        const last = out[out.length - 1];
        if (last && l === last[1] + 1) last[1] = l;
        else out.push([l, l]);
    }
    return out;
}

/**
 * The coverage of the scripts `entries` (Playwright's JS coverage), as ran lines per source file. A
 * script's map is read inline, or fetched with `fetchText` (only from the app's own origin); a script
 * without one counts as its own source (a dev server serving each file as it is).
 */
export async function mapCoverage(entries: Entry[], { origin, fetchText }: { origin: string; fetchText: (url: string) => Promise<string | null> }): Promise<Coverage> {
    const lines: Record<string, Set<number>> = {};
    const code: Record<string, Set<number>> = {};
    const maps = new Map<string, Promise<{ sources: string[]; sourceRoot?: string; mappings: string } | null>>();
    for (const entry of entries) {
        const source = entry.source;
        if (!source || !entry.url || /^(chrome|extensions?|devtools):/.test(entry.url)) continue;
        let scriptOrigin: string | null = null;
        try { scriptOrigin = new URL(entry.url).origin; } catch { /* webpack-internal:// and the like: no origin */ }
        // Other sites' scripts (a CDN's, analytics): not the app's code.
        if (scriptOrigin && scriptOrigin !== 'null' && scriptOrigin !== origin) continue;
        const ref = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(source.slice(-100_000))?.[1];
        let map: { sources: string[]; sourceRoot?: string; mappings: string } | null = null;
        if (ref?.startsWith('data:')) {
            try { map = JSON.parse(Buffer.from(ref.slice(ref.indexOf(',') + 1), /;base64,/.test(ref) ? 'base64' : 'utf8').toString('utf8')); } catch { map = null; }
        } else if (ref && scriptOrigin === origin) {
            const url = new URL(ref, entry.url).href;
            if (!maps.has(url)) maps.set(url, fetchText(url).then(t => { try { return t ? JSON.parse(t) : null; } catch { return null; } }));
            map = await maps.get(url)!;
        }
        // Offsets of each generated line's start, to turn a segment's line and column into an offset.
        const starts = [0];
        for (let i = source.indexOf('\n'); i >= 0; i = source.indexOf('\n', i + 1)) starts.push(i + 1);
        if (!map) {
            const file = sourcePath(entry.url.startsWith('webpack-internal') ? entry.url : new URL(entry.url).pathname);
            const ok = ran(entry.functions, starts);
            ok.forEach((r, i) => {
                if (!source.slice(starts[i], starts[i + 1] ?? source.length).trim()) return;
                addLine(code, file, i + 1);
                if (r) addLine(lines, file, i + 1);
            });
            continue;
        }
        const names = map.sources.map(s => sourcePath(`${map!.sourceRoot ?? ''}${s}`));
        const segments = decode(map.mappings).flatMap((segs, line) => segs.map(([col, src, orig]) => ({ at: (starts[line] ?? Infinity) + col, src, orig })));
        segments.sort((a, b) => a.at - b.at);
        const ok = ran(entry.functions, segments.map(s => s.at));
        segments.forEach((s, i) => {
            const name = names[s.src];
            // Only the app's own code: not node_modules, not the bundler's runtime.
            if (!name || /(^|\/)node_modules\/|^\(webpack\)|^webpack\/|^vite\//.test(name)) return;
            addLine(code, name, s.orig + 1);
            if (ok[i]) addLine(lines, name, s.orig + 1);
        });
    }
    const ranges = (m: Record<string, Set<number>>) => Object.fromEntries(Object.entries(m).map(([f, set]) => [f, toRanges(set)]));
    return { ran: ranges(lines), code: ranges(code) };
}

/** Starts collecting the page's JS coverage (Chromium); `stop` maps it to source lines. */
export async function watchCoverage(page: Page, origin: string): Promise<{ stop: () => Promise<Coverage> }> {
    await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
    return {
        stop: async () => {
            const entries = (await page.coverage.stopJSCoverage()) as Entry[];
            return mapCoverage(entries, {
                origin,
                fetchText: async url => {
                    try { const r = await fetch(url, { signal: AbortSignal.timeout(20_000) }); return r.ok ? await r.text() : null; } catch { return null; }
                },
            });
        },
    };
}
