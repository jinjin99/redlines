// What a designer changed on an exported canvas: the artboards as exported (export_design's folder) and
// as they are now (the same files read back from the canvas into another folder), each opened in a
// browser as a plain page and compared like two captures, so the edits read as the same list of changes
// find_changes gives, ready to carry into the code. The links export adds are left out of both.
import fs from 'node:fs';
import path from 'node:path';

import { launch } from './browser.js';
import { type DataMap, dataSources } from './data.js';
import { diffTrees } from './diff.js';
import { outline } from './outline.js';
import { snapshot } from './page/snapshot.js';
import type { Change, PageTree } from './types.js';

/** An artboard compared: 'changed' (with its changes), 'same', 'added' on the canvas (with its outline) or 'removed'. */
export interface EditedBoard {
    file: string;
    title: string;
    status: 'changed' | 'same' | 'added' | 'removed';
    changes: Change[];
    outline?: string;
}

const ARTBOARD = /^[\w][\w.-]*\.dc\.html$/;

/** The artboards in a canvas folder (its project/, or the folder itself if it holds them). */
function artboards(dir: string): Map<string, string> {
    const project = fs.existsSync(path.join(dir, 'project')) ? path.join(dir, 'project') : dir;
    if (!fs.existsSync(project)) throw new Error(`${dir} does not exist`);
    // Artboards only, by name, in the folder itself: nothing else is read.
    return new Map(fs.readdirSync(project).filter(f => ARTBOARD.test(f)).map(f => [f, path.join(project, f)]));
}

/** An artboard as a plain page: the head's stylesheets, the <helmet> styles, the <x-dc> markup; its width. */
export function plainPage(source: string): { html: string; width: number; height: number; title: string } {
    const xdc = source.match(/<x-dc>([\s\S]*)<\/x-dc>/)?.[1] ?? '';
    const helmet = xdc.match(/<helmet>([\s\S]*?)<\/helmet>/)?.[1] ?? '';
    const body = xdc.replace(/<helmet>[\s\S]*?<\/helmet>/, '');
    const head = source.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? '';
    const sheets = [...head.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>/g)].map(m => m[0]);
    const props = source.match(/data-props='([^']*)'/)?.[1] ?? '{}';
    let preview: { width?: number; height?: number } = {};
    try { preview = (JSON.parse(props.replace(/&#39;/g, "'").replace(/&amp;/g, '&')) as { $preview?: typeof preview }).$preview ?? {}; } catch { /* no size: the default */ }
    const title = source.match(/<title>([\s\S]*?)<\/title>/)?.[1].replace(/&lt;/g, '<').replace(/&amp;/g, '&') ?? '';
    return { html: `<!doctype html><html><head><meta charset="utf-8">${sheets.join('')}${helmet}</head><body>${body}</body></html>`, width: preview.width ?? 1280, height: preview.height ?? 800, title };
}

/** Each artboard of `exported` against the same file in `edited`. */
export async function findDesignEdits(exported: string, edited: string): Promise<EditedBoard[]> {
    const was = artboards(exported), now = artboards(edited);
    if (!was.size) throw new Error(`${exported} has no artboards (*.dc.html): export_design writes them`);
    const browser = await launch();
    const trees = async (file: string): Promise<{ tree: PageTree; title: string }> => {
        const page = plainPage(fs.readFileSync(file, 'utf8'));
        const context = await browser.newContext({ viewport: { width: page.width, height: page.height }, deviceScaleFactor: 1 });
        try {
            const tab = await context.newPage();
            // Stylesheets and fonts load (the page looks as it did); nothing else is fetched.
            await tab.route('**/*', route => (['stylesheet', 'font'].includes(route.request().resourceType()) ? route.continue() : route.abort()));
            await tab.setContent(page.html, { waitUntil: 'load', timeout: 20_000 }).catch(() => {});
            return { tree: await tab.evaluate(snapshot, { ignore: '[data-redlines-link]' }), title: page.title };
        } finally {
            await context.close();
        }
    };
    const out: EditedBoard[] = [];
    try {
        for (const [file, at] of was) {
            const there = now.get(file);
            const before = await trees(at);
            if (!there) { out.push({ file, title: before.title, status: 'removed', changes: [] }); continue; }
            const changes = diffTrees(before.tree, (await trees(there)).tree);
            // Text that came from the page's data (export_design keeps it beside the canvas).
            const dataFile = path.join(exported, 'data', `${file.replace(/\.dc\.html$/, '')}.json`);
            if (fs.existsSync(dataFile)) {
                const data = JSON.parse(fs.readFileSync(dataFile, 'utf8')) as DataMap;
                for (const c of changes) { const d = dataSources(c, data); if (d.length) c.data = d; }
            }
            out.push({ file, title: before.title, status: changes.length ? 'changed' : 'same', changes });
        }
        for (const [file, at] of now) {
            if (was.has(file)) continue;
            const { tree, title } = await trees(at);
            out.push({ file, title, status: 'added', changes: [], outline: outline(tree, { max: 80 }) });
        }
    } finally {
        await browser.close();
    }
    return out;
}
