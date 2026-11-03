// Exports a captured folder's states (their frozen HTML) as editable design files. Formats:
//   html  each state as a standalone .html (what capture_states already writes), copied into one folder
//   dc    a Claude Design canvas: project/<state>.dc.html artboards in a row and project/canvas.json
import fs from 'node:fs';
import path from 'node:path';

function statesOf(dir) {
    const file = path.join(dir, 'manifest.json');
    if (!fs.existsSync(file)) throw new Error(`${dir} has no manifest.json: capture into it first`);
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const states = (m.states ?? []).filter(s => s.html);
    for (const s of states) if (!/^[\w-]+$/.test(s.name) || s.html !== `${s.name}.html`) throw new Error(`${file}: unexpected state entry ${JSON.stringify(s)}`);
    if (!states.length) throw new Error(`${dir} has no frozen HTML: capture without "html: false" in the config`);
    return states;
}

/** The parts of a frozen page: <html> attributes, the stylesheet links, the <style> text, <body> attributes and markup. */
function partsOf(html) {
    const pick = re => html.match(re)?.[1] ?? '';
    return {
        htmlAttrs: pick(/<html([^>]*)>/),
        links: [...html.matchAll(/<link rel="stylesheet" href="[^"]*">/g)].map(m => m[0]),
        css: pick(/<style>\n?([\s\S]*?)<\/style>\s*<\/head>/),
        bodyAttrs: pick(/<body([^>]*)>/),
        body: pick(/<body[^>]*>\n?([\s\S]*)<\/body>\s*<\/html>\s*$/),
    };
}

const attr = (attrs, name) => attrs.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? '';

/** One Claude Design artboard: the page's markup in <x-dc>, its styles in <helmet>, the page's size as the preview. */
function artboard({ title, parts, width, height }) {
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
${body}
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
export function exportDesign(dir, out, { format = 'html', title } = {}) {
    const states = statesOf(dir);
    const written = [], notes = [];
    if (format === 'html') {
        fs.mkdirSync(out, { recursive: true });
        for (const s of states) { fs.copyFileSync(path.join(dir, s.html), path.join(out, s.html)); written.push(s.html); }
        return { files: written, notes };
    }
    if (format !== 'dc') throw new Error(`Unknown format ${format}: html or dc`);
    const project = path.join(out, 'project');
    fs.mkdirSync(project, { recursive: true });
    const boards = {}, order = [];
    let x = 0;
    for (const s of states) {
        const tree = JSON.parse(fs.readFileSync(path.join(dir, `${s.name}.json`), 'utf8'));
        const width = tree.viewport.width, height = Math.max(tree.viewport.height, tree.size.height);
        const file = `${s.name}.dc.html`;
        const parts = partsOf(fs.readFileSync(path.join(dir, s.html), 'utf8'));
        const inline = (parts.body.match(/src="data:/g) ?? []).length + (parts.css.match(/url\("data:/g) ?? []).length;
        if (inline) notes.push(`${file}: ${inline} inline image${inline === 1 ? '' : 's'}; Claude Design wants images uploaded as canvas assets`);
        fs.writeFileSync(path.join(project, file), artboard({ title: s.title, parts, width, height }));
        boards[file] = { x, y: 0, w: width, h: height, title: s.title };
        order.push(file);
        written.push(`project/${file}`);
        x += width + 80;
    }
    const index = { v: 3, createdOnFiles: { v: 1, at: new Date().toISOString() }, title: title ?? 'redlines', launch: { view: 'canvas' }, pages: [], boards, order, notes: {} };
    fs.writeFileSync(path.join(project, 'canvas.json'), JSON.stringify(index, null, 2));
    written.unshift('project/canvas.json');
    return { files: written, notes };
}
