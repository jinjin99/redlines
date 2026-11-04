// What changed between two page trees (src/page/snapshot.js), element by element: each tree is read
// into a sequence of tokens (an element opening, closing, a text), the two sequences are aligned, and
// each run that was added, removed or rewritten becomes a change: where it is (the named elements
// it is in, the text just before it), what it holds now and held before, and the boxes it covers on
// each page. Runs of one shape in one place (a cell added to every row) fold into one change.

import type { Box, Change, ChangeKind, PageTree, StyleChange, TreeNode } from './types.js';

/** One step of a page read in order: an element opening, its closing, or a text. */
export interface Token {
    kind: 'open' | 'close' | 'text';
    /** An element's `<Badge tone="info">` or `<div>`, a text's words; '' for a closing. */
    label: string;
    /** What a person calls an element (to say where a change is); not compared. */
    name?: string | null;
    /** An element's compared attributes and own styles, as JSON. */
    look?: string;
    tag?: string;
    box: Box;
}

/** An alignment run: tokens a0..a1 of the first sequence against b0..b1 of the second. */
export interface Run {
    op: 'equal' | 'insert' | 'delete' | 'replace';
    a0: number;
    a1: number;
    b0: number;
    b1: number;
}

// Inherited styles count once, where they are set, not again on every element that inherits them.
const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-transform']);
const DEFAULTS: Record<string, string> = { 'background-color': 'rgba(0, 0, 0, 0)', 'background-image': 'none', 'box-shadow': 'none', opacity: '1', 'border-radius': '0px', gap: 'normal', 'text-decoration-line': 'none' };

/**
 * A tree as tokens: { kind: 'open'|'close'|'text', label, name, look, box }. `label` is what an element
 * is (`<Button variant="primary">` for a component, `<div>` otherwise) or the text; `look` is its
 * compared attributes and own styles; `name` is what a person calls it, used to say where a change is.
 */
export function tokensOf(tree: PageTree): Token[] {
    const out: Token[] = [];
    const visit = (n: TreeNode, parentStyle: Record<string, string>): void => {
        if ('text' in n) { out.push({ kind: 'text', label: n.text, box: n.box }); return; }
        const style: Record<string, string> = {};
        for (const [k, v] of Object.entries(n.style ?? {})) {
            if (INHERITED.has(k) ? parentStyle[k] === v : DEFAULTS[k] === v) continue;
            if (/^(border-\w+-width)$/.test(k) && v === '0px') continue;
            if (k === 'border-top-style' && v === 'none') continue;
            if (k === 'border-top-color' && !(n.style['border-top-width'] && n.style['border-top-width'] !== '0px')) continue;
            if (/^(margin|padding)-/.test(k) && v === '0px') continue;
            if (/^(flex-direction|justify-content|align-items)$/.test(k) && !/flex/.test(n.style.display ?? '')) continue;
            if (k === 'grid-template-columns' && (v === 'none' || !/grid/.test(n.style.display ?? ''))) continue;
            style[k] = v;
        }
        const c = n.component;
        const props = c ? Object.entries(c.props ?? {}).map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join('') : '';
        const label = c ? `<${c.name}${props}>` : `<${n.tag}>`;
        const look = JSON.stringify({ attrs: n.attrs ?? {}, style });
        out.push({ kind: 'open', label, name: n.name ?? null, look, box: n.box, tag: n.tag });
        const inherit = { ...parentStyle, ...Object.fromEntries(Object.entries(n.style ?? {}).filter(([k]) => INHERITED.has(k))) };
        for (const child of n.children ?? []) visit(child, inherit);
        out.push({ kind: 'close', label: '', box: n.box });
    };
    visit(tree.root, {});
    return out;
}

const key = (t: Token) => (t.kind === 'text' ? `t${t.label}` : t.kind === 'close' ? 'c' : `o${t.label}${t.look}`);
const opens = (k: string) => k[0] === 'o';
const closes = (k: string) => k === 'c';

/** Longest-common-subsequence alignment as runs: { op: 'equal'|'insert'|'delete'|'replace', a0, a1, b0, b1 }. */
export function align(a: string[], b: string[]): Run[] {
    const n = a.length, m = b.length;
    // The common head and tail first: an edit is usually small next to a page.
    let head = 0;
    while (head < n && head < m && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < n - head && tail < m - head && a[n - 1 - tail] === b[m - 1 - tail]) tail++;
    const A = a.slice(head, n - tail), B = b.slice(head, m - tail);
    if (A.length * B.length > 4e7) throw new Error(`Too different to align (${A.length} × ${B.length} tokens): compare smaller pages, or the same page`);
    const dp = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
    for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const runs: Run[] = [];
    const push = (op: Run['op'], a0: number, a1: number, b0: number, b1: number) => {
        const last = runs[runs.length - 1];
        if (last && last.op !== 'equal' && op !== 'equal' && last.a1 === a0 && last.b1 === b0) {
            last.a1 = a1; last.b1 = b1;
            last.op = last.a0 === last.a1 ? 'insert' : last.b0 === last.b1 ? 'delete' : 'replace';
            return;
        }
        if (last && last.op === op && op === 'equal') { last.a1 = a1; last.b1 = b1; return; }
        runs.push({ op, a0, a1, b0, b1 });
    };
    if (head) push('equal', 0, head, 0, head);
    let i = 0, j = 0;
    while (i < A.length || j < B.length) {
        if (i < A.length && j < B.length && A[i] === B[j]) { push('equal', head + i, head + i + 1, head + j, head + j + 1); i++; j++; }
        else if (j < B.length && (i === A.length || dp[i][j + 1] >= dp[i + 1][j])) { push('insert', head + i, head + i, head + j, head + j + 1); j++; }
        else { push('delete', head + i, head + i + 1, head + j, head + j); i++; }
    }
    if (tail) push('equal', n - tail, n, m - tail, m);
    const depthOf = (seq: string[]) => seq.reduce((d, x) => d + (opens(x) ? 1 : closes(x) ? -1 : 0), 0);
    const whole = (seq: string[]) => {
        let d = 0;
        for (const x of seq) if ((d += opens(x) ? 1 : closes(x) ? -1 : 0) < 0) return false;
        return d === 0;
    };
    // An insert next to a copy of itself can sit in either place: take the earliest where it is whole
    // elements, where a person would say it went. Same for a delete.
    for (let k = 1; k < runs.length; k++) {
        const r = runs[k], prev = runs[k - 1];
        if (prev.op !== 'equal' || (r.op !== 'insert' && r.op !== 'delete')) continue;
        const [seq, s0, s1] = r.op === 'insert' ? [b, r.b0, r.b1] : [a, r.a0, r.a1];
        const next = runs[k + 1];
        const floor = r.op === 'insert' ? prev.b0 : prev.a0;
        const ceil = next?.op === 'equal' ? (r.op === 'insert' ? next.b1 : next.a1) : s1;
        let by = whole(seq.slice(s0, s1)) ? 0 : null;
        for (let d = 1; s1 + d <= ceil && seq[s0 + d - 1] === seq[s1 + d - 1]; d++) if (by === null && whole(seq.slice(s0 + d, s1 + d))) by = -d;
        for (let d = 1; s0 - d >= floor && seq[s0 - d] === seq[s1 - d]; d++) if (whole(seq.slice(s0 - d, s1 - d))) by = d;
        by ??= 0;
        r.a0 -= by; r.a1 -= by; r.b0 -= by; r.b1 -= by; prev.a1 -= by; prev.b1 -= by;
        if (next?.op === 'equal') { next.a0 = r.a1; next.b0 = r.b1; }
    }
    // One added element can come apart in two: its start, then (past a run of equal tokens) the closing
    // tags it is short of, matched with closing tags that were there before. Join them when the tokens
    // between still match once moved over.
    for (let k = 0; k + 2 < runs.length; k++) {
        const r = runs[k], e = runs[k + 1], r2 = runs[k + 2];
        if (e.op !== 'equal' || r2.op !== r.op || (r.op !== 'insert' && r.op !== 'delete')) continue;
        const [seq, other, s0, s1, t0, t1] = r.op === 'insert' ? [b, a, r.b0, r.b1, r2.b0, r2.b1] : [a, b, r.a0, r.a1, r2.a0, r2.a1];
        const d = t1 - t0;
        if (depthOf(seq.slice(s0, s1)) !== d || !seq.slice(t0, t1).every(closes) || !seq.slice(s1, s1 + d).every(closes)) continue;
        const [e0, e1, o0] = r.op === 'insert' ? [e.b0, e.b1, e.a0] : [e.a0, e.a1, e.b0];
        let same = true;
        for (let i2 = 0; i2 < e1 - e0 && same; i2++) same = seq[e0 + d + i2] === other[o0 + i2];
        if (!same) continue;
        if (r.op === 'insert') { r.b1 += d; e.b0 += d; e.b1 += d; } else { r.a1 += d; e.a0 += d; e.a1 += d; }
        runs.splice(k + 2, 1);
    }
    // Content wrapped in something new: the wrapper's start, what it holds and its end come apart as
    // runs; they are one change. Same for a wrapper taken off.
    for (let k = 0; k < runs.length; k++) {
        const r = runs[k];
        if (r.op !== 'insert' && r.op !== 'delete') continue;
        const ins = r.op === 'insert';
        const part = (x: Run) => (ins ? b.slice(x.b0, x.b1) : a.slice(x.a0, x.a1));
        let depth = depthOf(part(r));
        if (depth <= 0 || !part(r).every(opens)) continue;
        let end = -1;
        for (let j2 = k + 1; j2 < runs.length && j2 <= k + 8; j2++) {
            if (runs[j2].op === 'equal') continue;
            if (runs[j2].op !== r.op) break;
            depth += depthOf(part(runs[j2]));
            if (depth <= 0) { end = depth === 0 ? j2 : -1; break; }
        }
        if (end < 0) continue;
        runs.splice(k, end - k + 1, { op: 'replace', a0: r.a0, a1: runs[end].a1, b0: r.b0, b1: runs[end].b1 });
    }
    // Edits a few tokens apart in one place (a button restyled, wrapped and given a neighbour) read
    // as one change to that place, not three pieces of it.
    for (let k = 0; k + 2 < runs.length; k++) {
        const r = runs[k], e = runs[k + 1], r2 = runs[k + 2];
        if (r.op === 'equal' || e.op !== 'equal' || r2.op === 'equal' || e.a1 - e.a0 > 3) continue;
        runs.splice(k, 3, { op: 'replace', a0: r.a0, a1: r2.a1, b0: r.b0, b1: r2.b1 });
        k--;
    }
    return runs.filter(r => r.a1 > r.a0 || r.b1 > r.b0);
}

/** What a run holds, for a person: its components and texts in order, or "(layout only)". */
// Components, and the elements a person acts on or sees as things (a button, a link, an image), name what a run holds.
const THING = /^<(button|a|input|select|textarea|img|svg)>$/;
const describe = (toks: Token[]) => toks.filter(t => t.kind === 'text' || (t.kind === 'open' && (/^<[A-Z]/.test(t.label) || THING.test(t.label)))).map(t => (t.kind === 'text' ? `"${t.label}"` : t.label)).join(' ') || '(layout only)';
const shape = (toks: Token[]) => toks.filter(t => t.kind !== 'text').map(t => (t.kind === 'open' ? t.label.replace(/ .*/, '>') : '/')).join('');

/** Where token i is: the named elements it is in (the nearest three), and the text just before it inside the nearest. */
function where(toks: Token[], i: number) {
    const names: string[] = [];
    let inner = -1;
    for (let k = i - 1, depth = 0; k >= 0 && names.length < 3; k--) {
        const t = toks[k];
        if (t.kind === 'close') depth++;
        else if (t.kind === 'open' && depth) depth--;
        else if (t.kind === 'open' && t.name && t.name !== names[0]) {
            names.unshift(t.name);
            if (inner < 0) inner = k;
        }
    }
    let after = names.length ? 'at its start' : 'at the top';
    for (let k = i - 1; k > inner; k--) if (toks[k].kind === 'text') { after = `after "${toks[k].label}"`; break; }
    return { region: names.join(' › '), text: `${names.length ? `in ${names.join(' › ')}, ` : ''}${after}`, inside: names };
}

/**
 * Where each token sits in a <table>: per token, { table, col, name, heading } or undefined. A column's
 * name is its heading's text; a token that opens a cell, or is inside one, gets that cell's.
 */
interface Cell { table: number; col: number; heading: boolean; headings: string[]; name?: string }
interface Table { id: number; col: number; headings: string[]; cell: { col: number; heading: boolean; depth: number } | null }

function tableCells(toks: Token[]): (Cell | undefined)[] {
    const at: (Cell | undefined)[] = [], tables: Table[] = [], open: (string | undefined)[] = [];
    let count = 0;
    toks.forEach((t, i) => {
        const table = tables[tables.length - 1];
        if (t.kind === 'open') {
            open.push(t.tag);
            if (t.tag === 'table') tables.push({ id: count++, col: -1, headings: [], cell: null });
            else if (table && t.tag === 'tr') table.col = -1;
            else if (table && (t.tag === 'th' || t.tag === 'td')) table.cell = { col: ++table.col, heading: t.tag === 'th', depth: open.length };
        } else if (t.kind === 'close') {
            const tag = open.pop();
            if (tag === 'table') tables.pop();
            else if (table?.cell && open.length < table.cell.depth) table.cell = null;
        } else if (table?.cell?.heading && !table.headings[table.cell.col]) table.headings[table.cell.col] = t.label;
        const now = tables[tables.length - 1];
        if (now?.cell) at[i] = { table: now.id, col: now.cell.col, heading: now.cell.heading, headings: now.headings };
    });
    for (const c of at) if (c) c.name = c.headings[c.col] ?? `#${c.col + 1}`;
    return at;
}

/** Tokens that differ only in how they look: what changed, attribute by attribute and style by style. */
function restyled(was: Token[], now: Token[]): StyleChange[] | null {
    if (was.length !== now.length || was.some((t, i) => t.kind !== now[i].kind || t.label !== now[i].label)) return null;
    const parts: StyleChange[] = [];
    was.forEach((t, i) => {
        if (t.look === now[i].look) return;
        const x = JSON.parse(t.look ?? '{}') as Record<'attrs' | 'style', Record<string, string>>, y = JSON.parse(now[i].look ?? '{}') as Record<'attrs' | 'style', Record<string, string>>;
        const who = t.name ?? t.label;
        for (const group of ['attrs', 'style'] as const) {
            for (const k of new Set([...Object.keys(x[group]), ...Object.keys(y[group])])) {
                if (x[group][k] !== y[group][k]) parts.push({ who, property: k, was: x[group][k] ?? null, now: y[group][k] ?? null });
            }
        }
    });
    return parts;
}

/** The boxes of a run's outermost elements and texts (at most three), else of the element it is in. */
function boxesOf(toks: Token[], a0: number, a1: number): Box[] {
    const boxes: Box[] = [];
    for (let k = a0, depth = 0; k < a1; k++) {
        const t = toks[k];
        if (t.kind === 'open' && depth++ === 0 && t.box[2] * t.box[3] > 0) boxes.push(t.box);
        else if (t.kind === 'close') depth--;
        else if (t.kind === 'text' && depth === 0) boxes.push(t.box);
    }
    if (boxes.length) return boxes.slice(0, 3);
    for (let k = a0 - 1, depth = 0; k >= 0; k--) {
        if (toks[k].kind === 'close') depth++;
        else if (toks[k].kind === 'open' && depth) depth--;
        else if (toks[k].kind === 'open') return [toks[k].box];
    }
    return [];
}

/**
 * The changes from one page tree to another: [{ kind: 'added'|'removed'|'changed', where, inside,
 * now, was, styles?, count, boxes: { before, after } }], in page order.
 */
export function diffTrees(before: PageTree, after: PageTree): Change[] {
    const a = tokensOf(before), b = tokensOf(after);
    const cellsA = tableCells(a), cellsB = tableCells(b);
    const groups = new Map<string, Change & { styles: StyleChange[] }>();
    for (const r of align(a.map(key), b.map(key))) {
        if (r.op === 'equal') continue;
        const was = a.slice(r.a0, r.a1), now = b.slice(r.b0, r.b1);
        const kind = ({ insert: 'added', delete: 'removed', replace: 'changed' } as const)[r.op as 'insert' | 'delete' | 'replace'] satisfies ChangeKind;
        const at = now.length ? where(b, r.b0) : where(a, r.a0);
        // In a table, by column: a column added is its heading and a cell in every row, one change.
        const [cells, seq, s0] = now.length ? [cellsB, now, r.b0] as const : [cellsA, was, r.a0] as const;
        const first = Math.max(0, seq.findIndex(t => t.kind === 'open'));
        const col = cells[s0 + first] ?? cells[s0 + first + 1];
        const place = col ? `${col.heading ? 'heading of' : 'in'} column "${col.name}"${col.col > 0 ? ` (after "${col.headings[col.col - 1] ?? `#${col.col}`}")` : ''}` : null;
        const g = col ? `${kind}|table${col.table}|${col.name}` : `${kind}|${at.region}|${shape(was)}|${shape(now)}`;
        if (!groups.has(g)) groups.set(g, { kind, where: place ? `${at.region ? `in ${at.region}, ` : ''}${place}` : kind === 'changed' ? at.text.replace(/, at its start$/, '') : at.text, inside: at.inside, now: [], was: [], styles: [], count: 0, boxes: { before: [], after: [] } });
        const entry = groups.get(g)!;
        entry.count++;
        const styles = kind === 'changed' ? restyled(was, now) : null;
        if (styles) {
            entry.styles.push(...styles);
            // What the restyled element shows, so the change says which one it is.
            const text = b.slice(r.b1).find(t => t.kind === 'text');
            entry.now.push(`${describe(now) === '(layout only)' && text ? `"${text.label}"` : describe(now)}: ${styles.map(s => `${s.property} ${s.was ?? '(none)'} → ${s.now ?? '(none)'}`).join(', ')}`);
        } else {
            if (now.length) entry.now.push(describe(now));
            if (was.length) entry.was.push(describe(was));
        }
        if (entry.boxes.after.length < 3) entry.boxes.after.push(...boxesOf(b, r.b0, r.b1).slice(0, 3 - entry.boxes.after.length));
        if (entry.boxes.before.length < 3) entry.boxes.before.push(...boxesOf(a, r.a0, r.a1).slice(0, 3 - entry.boxes.before.length));
    }
    return [...groups.values()].map(g => ({ ...g, now: [...new Set(g.now)], was: [...new Set(g.was)], styles: g.styles.length ? g.styles : undefined }));
}

/** The change list as text, one numbered entry per change. */
export function formatChanges(list: Change[]): string {
    if (!list.length) return 'no changes';
    return list
        .map((c, i) => {
            const now = c.now.length ? `: ${c.now.join(' | ')}` : '';
            const was = c.was.length ? `  (was: ${c.was.join(' | ')})` : '';
            const data = (c.data ?? []).map(d => `\n   ! not code: "${d.text}" is ${d.whole ? '' : 'part of the text, '}data from ${d.from} → ${d.key}; change the data or configuration behind it`).join('');
            return `${i + 1}. ${c.kind}${c.count > 1 ? ` ×${c.count}` : ''} ${c.where}${now}${was}${data}`;
        })
        .join('\n');
}
