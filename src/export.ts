// Exports a captured folder's states (their frozen HTML) as editable design files. Formats:
//   html  each state as a standalone .html (what capture_states already writes), copied into one folder
//   dc    a Claude Design canvas: project/<state>.dc.html artboards in a row and project/canvas.json
// Both carry the states' links (capture_states measures where each click goes): a see-through link over
// the element, so clicking through the pages, or Play on the canvas, walks the flow.
import fs from 'node:fs';
import path from 'node:path';

import type { Link, Manifest, ManifestState, PageTree } from './types.js';

type Frozen = ManifestState & { html: string };

function statesOf(dir: string): Frozen[] {
    const file = path.join(dir, 'manifest.json');
    if (!fs.existsSync(file)) throw new Error(`${dir} has no manifest.json: capture into it first`);
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
    const states = (m.states ?? []).filter((s): s is Frozen => !!s.html);
    for (const s of states) if (!/^[\w-]+$/.test(s.name) || s.html !== `${s.name}.html` || (s.data && s.data !== `${s.name}.data.json`)) throw new Error(`${file}: unexpected state entry ${JSON.stringify(s)}`);
    if (!states.length) throw new Error(`${dir} has no frozen HTML: capture without "html: false" in the config`);
    // Links only to states exported with them, with a box of four numbers.
    const names = new Set(states.map(s => s.name));
    for (const s of states) s.links = (s.links ?? []).filter((l): l is Link => names.has(l.to) && l.to !== s.name && Array.isArray(l.box) && l.box.length === 4 && l.box.every(n => Number.isFinite(n)));
    return states;
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** A state's links as see-through anchors over their elements; `file` names the page a link opens. */
function hotspots(links: Link[], titleOf: (name: string) => string, file: (name: string) => string): string {
    return links
        .map(({ to, box: [x, y, w, h] }) => `<a href="${file(to)}" data-redlines-link="${to}" aria-label="${esc(titleOf(to))}" style="position: absolute; left: ${x}px; top: ${y}px; width: ${w}px; height: ${h}px; display: block; z-index: 2147483000;"></a>`)
        .join('\n');
}

// The standalone pages: a link shows where it is on hover, and all of them flash when a click lands elsewhere.
const HTML_LINKS = `<style>[data-redlines-link]:hover,[data-redlines-link].redlines-flash{outline:2px solid #1f6feb;outline-offset:2px;background:rgba(31,111,235,.12)}</style>
<script>addEventListener('click',function(e){if(e.target.closest('[data-redlines-link]'))return;e.preventDefault();document.querySelectorAll('[data-redlines-link]').forEach(function(a){a.classList.add('redlines-flash');setTimeout(function(){a.classList.remove('redlines-flash')},600)})},true)</script>`;

/** The parts of a frozen page: <html> attributes, the stylesheet links, the <style> text, <body> attributes and markup. */
interface Parts { htmlAttrs: string; links: string[]; css: string; bodyAttrs: string; body: string }

function partsOf(html: string): Parts {
    const pick = (re: RegExp) => html.match(re)?.[1] ?? '';
    return {
        htmlAttrs: pick(/<html([^>]*)>/),
        links: [...html.matchAll(/<link rel="stylesheet" href="[^"]*">/g)].map(m => m[0]),
        css: pick(/<style>\n?([\s\S]*?)<\/style>\s*<\/head>/),
        bodyAttrs: pick(/<body([^>]*)>/),
        body: pick(/<body[^>]*>\n?([\s\S]*)<\/body>\s*<\/html>\s*$/),
    };
}

const attr = (attrs: string, name: string) => attrs.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? '';

/** One Claude Design artboard: the page's markup in <x-dc>, its styles in <helmet>, the page's size as the preview. */
function artboard({ title, parts, width, height, links }: { title: string; parts: Parts; width: number; height: number; links: string }): string {
    // `{{` starts a template hole on the canvas: keep the page's text as text.
    const body = parts.body.replace(/\{\{/g, '{&#8203;{');
    const rootClass = [attr(parts.htmlAttrs, 'class'), attr(parts.bodyAttrs, 'class')].filter(Boolean).join(' ');
    const rootStyle = [attr(parts.htmlAttrs, 'style'), attr(parts.bodyAttrs, 'style')].filter(Boolean).join('; ');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>
<script src="./support.js"></script>
${parts.links.join('\n')}
</head>
<body>
<x-dc>
<helmet>
<style>
body{margin:0}
${parts.css}
</style>
</helmet>
<div class="${rootClass}" style="width: ${width}px; min-height: ${height}px; position: relative;${rootStyle ? ` ${rootStyle}` : ''}">
${body}${links ? `\n${links}` : ''}
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":${width},"height":${height}}}'>
class Component extends DCLogic {
  renderVals() {
    return {};
  }
}
</script>
</body>
</html>
`;
}

/**
 * Writes the export; returns { files, notes }: the files written, relative to `out`, and what a person
 * has to finish by hand (a canvas takes no inline images: they are uploaded as its assets).
 */
export function exportDesign(dir: string, out: string, { format = 'html', title }: { format?: 'html' | 'dc'; title?: string } = {}): { files: string[]; notes: string[]; links: string[] } {
    const states = statesOf(dir);
    const written: string[] = [], notes: string[] = [];
    const titleOf = (name: string) => states.find(s => s.name === name)?.title ?? name;
    const links = states.flatMap(s => s.links!.map(l => `${s.name} → ${l.to} (${l.selector})`));
    if (format === 'html') {
        fs.mkdirSync(out, { recursive: true });
        for (const s of states) {
            const html = fs.readFileSync(path.join(dir, s.html), 'utf8');
            const spots = s.links!.length ? `${hotspots(s.links!, titleOf, n => `${n}.html`)}\n${HTML_LINKS}\n` : '';
            fs.writeFileSync(path.join(out, s.html), spots ? html.replace(/<\/body>\s*<\/html>\s*$/, `${spots}</body>\n</html>\n`) : html);
            written.push(s.html);
        }
        return { files: written, notes, links };
    }
    if (format !== 'dc') throw new Error(`Unknown format ${format}: html or dc`);
    const project = path.join(out, 'project');
    fs.mkdirSync(project, { recursive: true });
    const boards: Record<string, { x: number; y: number; w: number; h: number; title: string; is_interactive?: boolean }> = {}, order: string[] = [];
    // In a flow (a link from it or to it): Play on the canvas walks it.
    const inFlow = new Set(states.flatMap(s => (s.links!.length ? [s.name, ...s.links!.map(l => l.to)] : [])));
    let x = 0;
    for (const s of states) {
        const tree = JSON.parse(fs.readFileSync(path.join(dir, `${s.name}.json`), 'utf8')) as PageTree;
        const width = tree.viewport.width, height = Math.max(tree.viewport.height, tree.size.height);
        const file = `${s.name}.dc.html`;
        const parts = partsOf(fs.readFileSync(path.join(dir, s.html), 'utf8'));
        const inline = (parts.body.match(/src="data:/g) ?? []).length + (parts.css.match(/url\("data:/g) ?? []).length;
        if (inline) notes.push(`${file}: ${inline} inline image${inline === 1 ? '' : 's'}; Claude Design wants images uploaded as canvas assets`);
        // Beside the canvas, not in it: the page text that came from data, for find_design_edits.
        if (s.data) { fs.mkdirSync(path.join(out, 'data'), { recursive: true }); fs.copyFileSync(path.join(dir, s.data), path.join(out, 'data', `${s.name}.json`)); }
        fs.writeFileSync(path.join(project, file), artboard({ title: s.title, parts, width, height, links: hotspots(s.links!, titleOf, n => `${n}.dc.html`) }));
        boards[file] = { x, y: 0, w: width, h: height, title: s.title, ...(inFlow.has(s.name) ? { is_interactive: true } : {}) };
        order.push(file);
        written.push(`project/${file}`);
        x += width + 80;
    }
    const index = { v: 3, createdOnFiles: { v: 1, at: new Date().toISOString() }, title: title ?? 'redlines', launch: { view: 'canvas' }, pages: [], boards, order, notes: {} };
    fs.writeFileSync(path.join(project, 'canvas.json'), JSON.stringify(index, null, 2));
    written.unshift('project/canvas.json');
    return { files: written, notes, links };
}
