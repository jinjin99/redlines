// The review page: for each state, the page before and after side by side, each change boxed and
// numbered on both, and the list of changes beside them. A folder with index.html, the screenshots
// and changes.json; open it in a browser or put it on any static host.
import fs from 'node:fs';
import path from 'node:path';

import { diffTrees } from './diff.js';

import type { Change, Manifest, PageTree } from './types.js';

const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

/** One side of a state: its screenshot and the page's size. */
export interface Side { image: string; size: PageTree['size'] }

/** A state of the two folders, compared. */
export interface ComparedState {
    name: string;
    title: string;
    status: 'changed' | 'same' | 'added' | 'removed';
    changes: Change[];
    before?: Side;
    after?: Side;
}

/** The two captured folders' states compared: [{ name, title, status: 'changed'|'same'|'added'|'removed', changes, before?, after? }]. */
export function findChanges(beforeDir: string, afterDir: string): ComparedState[] {
    const manifest = (dir: string): Manifest => {
        const file = path.join(dir, 'manifest.json');
        if (!fs.existsSync(file)) throw new Error(`${dir} has no manifest.json: capture into it first (redlines capture_states)`);
        const m = readJson<Manifest>(file);
        // Files are named after their state, in the folder itself: nothing else is read.
        for (const s of m.states ?? []) if (!/^[\w-]+$/.test(s.name) || s.tree !== `${s.name}.json` || s.image !== `${s.name}.png` || (s.html && s.html !== `${s.name}.html`)) throw new Error(`${file}: unexpected state entry ${JSON.stringify(s)}`);
        return m;
    };
    const a = manifest(beforeDir), b = manifest(afterDir);
    const byName = new Map(a.states.map(s => [s.name, s]));
    const out: ComparedState[] = [];
    for (const s of b.states) {
        const was = byName.get(s.name);
        const after = readJson<PageTree>(path.join(afterDir, s.tree));
        if (!was) { out.push({ name: s.name, title: s.title, status: 'added', changes: [], after: { image: path.join(afterDir, s.image), size: after.size } }); continue; }
        const before = readJson<PageTree>(path.join(beforeDir, was.tree));
        const changes = diffTrees(before, after);
        out.push({ name: s.name, title: s.title, status: changes.length ? 'changed' : 'same', changes, before: { image: path.join(beforeDir, was.image), size: before.size }, after: { image: path.join(afterDir, s.image), size: after.size } });
    }
    for (const s of a.states) if (!b.states.some(x => x.name === s.name)) out.push({ name: s.name, title: s.title, status: 'removed', changes: [], before: { image: path.join(beforeDir, s.image), size: readJson<PageTree>(path.join(beforeDir, s.tree)).size } });
    return out;
}

const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Writes the review page for `states` (findChanges) into `out`. Returns the index.html path. */
export function writeReport(states: ComparedState[], out: string, { title = 'UI changes' }: { title?: string } = {}): string {
    fs.mkdirSync(path.join(out, 'images'), { recursive: true });
    const data = states.map(s => {
        const copy = (side: 'before' | 'after', img?: Side) => {
            if (!img) return null;
            const rel = `images/${side}-${s.name}.png`;
            fs.copyFileSync(img.image, path.join(out, rel));
            return { image: rel, size: img.size };
        };
        return { name: s.name, title: s.title, status: s.status, changes: s.changes, before: copy('before', s.before), after: copy('after', s.after) };
    });
    fs.writeFileSync(path.join(out, 'changes.json'), JSON.stringify(data.map(({ name, title, status, changes }) => ({ name, title, status, changes })), null, 2));
    const total = data.reduce((n, s) => n + s.changes.length, 0);
    const changed = data.filter(s => s.status !== 'same').length;
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --bg: #f6f7f8; --panel: #ffffff; --fg: #1d2125; --dim: #626a73; --line: #e1e4e8; --accent: #2f6fde;
  --added: #1a7f37; --changed: #c4520a; --removed: #c42b1c; --shade: rgba(0,0,0,.04); color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #16181b; --panel: #1f2226; --fg: #e8eaed; --dim: #9aa1a9; --line: #33373c; --accent: #7aa7f5;
  --added: #4ac26b; --changed: #f0883e; --removed: #f47067; --shade: rgba(255,255,255,.04); color-scheme: dark; } }
:root[data-theme="dark"] { --bg: #16181b; --panel: #1f2226; --fg: #e8eaed; --dim: #9aa1a9; --line: #33373c; --accent: #7aa7f5;
  --added: #4ac26b; --changed: #f0883e; --removed: #f47067; --shade: rgba(255,255,255,.04); color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
header.top { position: sticky; top: 0; z-index: 5; background: var(--panel); border-bottom: 1px solid var(--line); padding: 12px 24px; display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: center; }
header.top h1 { font-size: 16px; margin: 0; }
header.top .sum { color: var(--dim); }
header.top label { margin-left: auto; color: var(--dim); display: flex; gap: 6px; align-items: center; cursor: pointer; }
nav.states { display: flex; gap: 6px; flex-wrap: wrap; padding: 12px 24px 0; }
nav.states a { text-decoration: none; color: var(--fg); background: var(--panel); border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; font-size: 13px; }
nav.states a .n { color: var(--dim); margin-left: 4px; }
section.state { margin: 16px 24px 32px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
section.state > h2 { margin: 0; padding: 12px 16px; font-size: 15px; border-bottom: 1px solid var(--line); display: flex; gap: 10px; align-items: baseline; }
section.state > h2 small { color: var(--dim); font-weight: 400; }
.body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 320px; }
.side { padding: 12px; min-width: 0; }
.side + .side { border-left: 1px solid var(--line); }
.side h3 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--dim); }
.shot { position: relative; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: var(--shade); }
.shot img { display: block; width: 100%; height: auto; cursor: zoom-in; }
.box { position: absolute; border: 2px dashed; border-radius: 4px; pointer-events: none; transition: box-shadow .15s; }
.box b { position: absolute; left: -2px; top: -22px; min-width: 20px; height: 20px; padding: 0 4px; border-radius: 10px; color: #fff; font: 600 11px/20px sans-serif; text-align: center; }
.box.hot { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 35%, transparent); }
body.nomarks .box { display: none; }
ol.changes { list-style: none; margin: 0; padding: 12px; border-left: 1px solid var(--line); display: flex; flex-direction: column; gap: 8px; max-height: 90vh; overflow: auto; }
ol.changes li { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; cursor: default; }
ol.changes li:hover, ol.changes li.hot { border-color: var(--accent); }
.tag { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; }
.dot { min-width: 18px; height: 18px; border-radius: 9px; color: #fff; display: inline-grid; place-items: center; font-size: 11px; padding: 0 4px; }
.where { color: var(--dim); font-size: 12px; margin-top: 2px; overflow-wrap: anywhere; }
.what { margin-top: 4px; overflow-wrap: anywhere; }
.was { margin-top: 2px; color: var(--dim); overflow-wrap: anywhere; }
.empty { padding: 16px; color: var(--dim); }
@media (max-width: 1100px) { .body { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } ol.changes { grid-column: 1 / -1; border-left: 0; border-top: 1px solid var(--line); max-height: none; } }
@media (max-width: 700px) { .body { grid-template-columns: minmax(0, 1fr); } .side + .side { border-left: 0; border-top: 1px solid var(--line); } header.top, nav.states { padding-left: 16px; padding-right: 16px; } section.state { margin: 12px 16px 24px; } }
</style>
</head>
<body>
<header class="top">
  <h1>${esc(title)}</h1>
  <span class="sum">${total} change${total === 1 ? '' : 's'} in ${changed} of ${data.length} state${data.length === 1 ? '' : 's'}</span>
  <label><input type="checkbox" id="marks" checked> Show marks</label>
</header>
<nav class="states" id="nav"></nav>
<main id="main"></main>
<script>
var DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
var COLOR = { added: 'var(--added)', changed: 'var(--changed)', removed: 'var(--removed)' };
var STATUS = { changed: '', same: 'no changes', added: 'new state', removed: 'state removed' };
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
document.getElementById('marks').onchange = function (e) { document.body.classList.toggle('nomarks', !e.target.checked); };
var nav = document.getElementById('nav'), main = document.getElementById('main');
DATA.forEach(function (s) {
  var a = el('a', null, s.title); a.href = '#' + s.name; a.appendChild(el('span', 'n', s.status === 'changed' ? String(s.changes.length) : STATUS[s.status])); nav.appendChild(a);
  var sec = el('section', 'state'); sec.id = s.name;
  var h = el('h2', null, s.title); h.appendChild(el('small', null, s.status === 'changed' ? s.changes.length + ' change' + (s.changes.length === 1 ? '' : 's') : STATUS[s.status])); sec.appendChild(h);
  var body = el('div', 'body');
  function side(label, shot, which) {
    var d = el('div', 'side'); d.appendChild(el('h3', null, label));
    if (!shot) { d.appendChild(el('div', 'empty', which === 'before' ? 'Not there before' : 'Not there after')); return d; }
    var box = el('div', 'shot'); var img = el('img'); img.src = shot.image; img.alt = label + ': ' + s.title; img.loading = 'lazy'; img.title = 'Open full size'; img.onclick = function () { window.open(shot.image, '_blank', 'noopener'); }; box.appendChild(img);
    s.changes.forEach(function (c, i) {
      var list = c.boxes[which] || [];
      if (c.kind === 'added' && which === 'before') return;
      if (c.kind === 'removed' && which === 'after') return;
      list.forEach(function (b) {
        var m = el('div', 'box'); m.dataset.n = i + 1;
        m.style.left = (b[0] / shot.size.width * 100) + '%'; m.style.top = (b[1] / shot.size.height * 100) + '%';
        m.style.width = (b[2] / shot.size.width * 100) + '%'; m.style.height = (b[3] / shot.size.height * 100) + '%';
        m.style.borderColor = COLOR[c.kind];
        var n = el('b', null, String(i + 1)); n.style.background = COLOR[c.kind]; m.appendChild(n);
        box.appendChild(m);
      });
    });
    d.appendChild(box); return d;
  }
  body.appendChild(side('Before', s.before, 'before'));
  body.appendChild(side('After', s.after, 'after'));
  var ol = el('ol', 'changes');
  if (!s.changes.length) ol.appendChild(el('li', 'empty', STATUS[s.status] || 'No changes'));
  s.changes.forEach(function (c, i) {
    var li = el('li'); li.dataset.n = i + 1;
    var t = el('div', 'tag'); var dot = el('span', 'dot', String(i + 1)); dot.style.background = COLOR[c.kind]; t.appendChild(dot); t.appendChild(el('span', null, c.kind + (c.count > 1 ? ' ×' + c.count : ''))); li.appendChild(t);
    li.appendChild(el('div', 'where', c.where));
    if (c.now.length) li.appendChild(el('div', 'what', c.now.join(' | ')));
    if (c.was.length) li.appendChild(el('div', 'was', 'was: ' + c.was.join(' | ')));
    function hot(on) { sec.querySelectorAll('.box[data-n="' + (i + 1) + '"]').forEach(function (b) { b.classList.toggle('hot', on); }); }
    li.onmouseenter = function () { hot(true); }; li.onmouseleave = function () { hot(false); };
    ol.appendChild(li);
  });
  body.appendChild(ol); sec.appendChild(body); main.appendChild(sec);
});
</script>
</body>
</html>
`;
    const file = path.join(out, 'index.html');
    fs.writeFileSync(file, html);
    return file;
}
