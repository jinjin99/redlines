// Which states a code change reaches: the lines it changed (git diff against the base) set against the
// lines each state ran (<state>.coverage.json, from capture_states). A state whose lines were changed
// shows the change, or runs it; changed lines no state ran are code no listed state reaches yet.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Coverage } from './coverage.js';

/** A file's changed lines: on the new side (added or edited) and on the old side (removed or edited). */
export interface FileChange { file: string; added: [number, number][]; removed: [number, number][]; created: boolean }

const git = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

/** The commit where the working copy left `ref` (git merge-base), so the base is what the change started from. */
export function baseCommit(dir: string, ref?: string): string {
    const target = ref ?? defaultBranch(dir);
    return git(dir, ['merge-base', 'HEAD', target]).trim();
}

/** A remote's default branch (<remote>/HEAD, origin's first), else its main or master, else the local one. */
export function defaultBranch(dir: string): string {
    const remotes = git(dir, ['remote']).split('\n').filter(Boolean).sort((a, b) => Number(b === 'origin') - Number(a === 'origin'));
    for (const r of remotes) {
        try { return git(dir, ['rev-parse', '--abbrev-ref', `${r}/HEAD`]).trim(); } catch { /* not set */ }
    }
    for (const b of [...remotes.flatMap(r => [`${r}/main`, `${r}/master`]), 'main', 'master']) {
        try { git(dir, ['rev-parse', '--verify', '--quiet', b]); return b; } catch { /* next */ }
    }
    throw new Error(`No base branch found in ${dir}: set app.base in the config (e.g. origin/main)`);
}

/** The changes in the working copy (committed or not, new files included) since `base`, line by line. */
export function changedLines(dir: string, base: string): FileChange[] {
    const out = new Map<string, FileChange>();
    const diff = git(dir, ['diff', '-U0', '--no-color', '--no-ext-diff', '--find-renames', base, '--']);
    let current: FileChange | null = null;
    for (const line of diff.split('\n')) {
        if (line.startsWith('diff --git')) { current = null; continue; }
        const plus = /^\+\+\+ (?:b\/(.*)|\/dev\/null)$/.exec(line);
        if (plus) {
            if (plus[1]) { current = { file: plus[1], added: [], removed: [], created: false }; out.set(plus[1], current); }
            continue;
        }
        if (line.startsWith('new file mode') && current) current.created = true;
        const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk && current) {
            const [oldStart, oldCount, newStart, newCount] = [Number(hunk[1]), hunk[2] === undefined ? 1 : Number(hunk[2]), Number(hunk[3]), hunk[4] === undefined ? 1 : Number(hunk[4])];
            if (oldCount) current.removed.push([oldStart, oldStart + oldCount - 1]);
            if (newCount) current.added.push([newStart, newStart + newCount - 1]);
        }
    }
    // Files not yet added to git.
    for (const file of git(dir, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
        const full = path.join(dir, file);
        if (!fs.statSync(full).isFile()) continue;
        const n = fs.readFileSync(full, 'utf8').split('\n').length;
        out.set(file, { file, added: [[1, n]], removed: [], created: true });
    }
    return [...out.values()];
}

/** A covered source (as its source map names it) → the repository file it is, by the longest common ending of their paths. */
function matcher(files: string[]): (source: string) => string | undefined {
    const byName = new Map<string, string[]>();
    for (const f of files) (byName.get(path.basename(f)) ?? byName.set(path.basename(f), []).get(path.basename(f))!).push(f);
    const cache = new Map<string, string | undefined>();
    return source => {
        if (cache.has(source)) return cache.get(source);
        const candidates = byName.get(path.basename(source)) ?? [];
        const parts = source.split('/').filter(Boolean);
        let best: string | undefined, bestScore = 0;
        for (const c of candidates) {
            const cp = c.split('/');
            let k = 0;
            while (k < cp.length && k < parts.length && cp[cp.length - 1 - k] === parts[parts.length - 1 - k]) k++;
            // The whole of one path is the end of the other (src/x.tsx and /abs/app/src/x.tsx), or most of it.
            if (k > bestScore && (k === cp.length || k === parts.length || k >= 2)) { best = c; bestScore = k; }
        }
        cache.set(source, best);
        return best;
    };
}

const overlaps = (a: [number, number][], b: [number, number][]): [number, number][] => {
    const out: [number, number][] = [];
    for (const [x1, x2] of a) for (const [y1, y2] of b) { const lo = Math.max(x1, y1), hi = Math.min(x2, y2); if (lo <= hi) out.push([lo, hi]); }
    return out;
};

const subtract = (a: [number, number][], b: [number, number][]): [number, number][] => {
    let rest = a;
    for (const [y1, y2] of b) rest = rest.flatMap(([x1, x2]): [number, number][] => (y2 < x1 || y1 > x2 ? [[x1, x2]] : [...(x1 < y1 ? [[x1, y1 - 1] as [number, number]] : []), ...(x2 > y2 ? [[y2 + 1, x2] as [number, number]] : [])]));
    return rest;
};

/** Ranges sorted and joined where they touch. */
const merge = (r: [number, number][]): [number, number][] => {
    const out: [number, number][] = [];
    for (const [a, b] of [...r].sort((x, y) => x[0] - y[0])) { const last = out[out.length - 1]; if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b); else out.push([a, b]); }
    return out;
};

export interface AffectedState { state: string; files: { file: string; lines: [number, number][]; side: 'new' | 'old' }[] }

export interface Affected {
    base: string;
    changed: FileChange[];
    /** States whose ran lines the change touched. */
    states: AffectedState[];
    /** States the change does not reach. */
    untouched: string[];
    /** Changed lines in the app's code that no state ran (new code a state should show; or code that only runs on the server). */
    unreached: { file: string; lines: [number, number][]; loaded: boolean }[];
    /** Changed files that are not code the browser runs (styles, config, server code, tests), listed apart. */
    other: string[];
    /** Changed generated files, left out. */
    generated: string[];
    /** States captured without coverage (an older capture, or coverage off). */
    noCoverage: string[];
}

/** Reads <state>.coverage.json of each state in `folder` (a capture). */
function coverageOf(folder: string): Map<string, Coverage> {
    const out = new Map<string, Coverage>();
    if (!fs.existsSync(folder)) return out;
    for (const f of fs.readdirSync(folder)) if (f.endsWith('.coverage.json')) out.set(f.slice(0, -'.coverage.json'.length), JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8')) as Coverage);
    return out;
}

const CODE = /\.(m?[jt]sx?|vue|svelte)$/;

// A statement that is no code to run: an import, a re-export, a type declaration.
const DECLARATION = /^(import\b|export\s+(type\s+)?\{|export\s+\*|(export\s+)?(declare\s+)?(interface|type)\s+\w|declare\s)/;

/**
 * The lines of a script that hold no code to run: imports, re-exports, type declarations, comments and
 * blank lines. For a file no state loaded, where coverage cannot say which lines are code.
 */
/** `ranges` without the lines of `file` that hold no code to run (the file unreadable: all of them). */
function withoutDeclarations(ranges: [number, number][], file: string): [number, number][] {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return ranges; }
    const skip = declarationLines(text);
    const out: [number, number][] = [];
    for (const [a, b] of ranges) for (let l = a; l <= b; l++) if (!skip.has(l)) out.push([l, l]);
    return merge(out);
}

export function declarationLines(text: string): Set<number> {
    const out = new Set<number>();
    const lines = text.split('\n');
    let open = false, depth = 0, comment = false;
    lines.forEach((line, i) => {
        const t = line.trim();
        if (comment || t.startsWith('/*')) {
            out.add(i + 1);
            comment = !t.includes('*/');
            return;
        }
        if (!open && (!t || t.startsWith('//'))) { out.add(i + 1); return; }
        if (!open && !DECLARATION.test(t)) return;
        open = true;
        out.add(i + 1);
        depth += (t.match(/[{(<]/g) ?? []).length - (t.match(/[})>]/g) ?? []).length + (t.match(/=>/g) ?? []).length;
        // Ends where its brackets close and the statement does: a semicolon, a closing brace, a from clause; or no semicolons, and the next line goes on to something else.
        const next = lines[i + 1]?.trim() ?? '';
        if (depth <= 0 && (/[;}]$|\bfrom\s+['"][^'"]+['"]/.test(t) || !/^[|&=.?:]/.test(next))) { open = false; depth = 0; }
    });
    return out;
}
/** Generated files (a router's route tree, API clients): every state runs them, so they say nothing about where a change shows. */
const GENERATED = /\.gen\.|\.generated\.|(^|\/)(__generated__|generated)\//;

/**
 * The states `changes` reaches. New-side lines are matched against the `after` capture's coverage,
 * removed lines against the `before` capture's (either may be missing).
 */
export function affectedStates({ dir, base, after, before, states }: { dir: string; base: string; after?: string; before?: string; states?: string[] }): Affected {
    const changed = changedLines(dir, base);
    const files = git(dir, ['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(Boolean);
    const toFile = matcher(files);
    const covAfter = after ? coverageOf(after) : new Map<string, Coverage>();
    const covBefore = before ? coverageOf(before) : new Map<string, Coverage>();
    const names = states ?? [...new Set([...covAfter.keys(), ...covBefore.keys(), ...(after && fs.existsSync(path.join(after, 'manifest.json')) ? (JSON.parse(fs.readFileSync(path.join(after, 'manifest.json'), 'utf8')) as { states: { name: string }[] }).states.map(s => s.name) : [])])];
    // Ran lines by repository file, per state and side.
    const byFile = (lines: Coverage['ran'] | undefined) => {
        const out = new Map<string, [number, number][]>();
        for (const [source, l] of Object.entries(lines ?? {})) { const f = toFile(source); if (f) out.set(f, [...(out.get(f) ?? []), ...l]); }
        return out;
    };
    const ran = (cov: Coverage | undefined) => byFile(cov?.ran);
    const result: AffectedState[] = [];
    const reachedNew = new Map<string, [number, number][]>();
    for (const state of names) {
        const now = ran(covAfter.get(state)), was = ran(covBefore.get(state));
        const hits: AffectedState['files'] = [];
        for (const c of changed.filter(x => !GENERATED.test(x.file))) {
            const a = merge(overlaps(c.added, now.get(c.file) ?? []));
            if (a.length) { hits.push({ file: c.file, lines: a, side: 'new' }); reachedNew.set(c.file, [...(reachedNew.get(c.file) ?? []), ...a]); }
            const r = merge(overlaps(c.removed, was.get(c.file) ?? []));
            if (r.length) hits.push({ file: c.file, lines: r, side: 'old' });
        }
        if (hits.length) result.push({ state, files: hits });
    }
    const code = changed.filter(c => CODE.test(c.file) && !GENERATED.test(c.file) && !/(^|\/)(__tests__|test|tests|e2e)\/|\.(test|spec|stories)\.[jt]sx?$|(^|\/)[\w.-]+\.config\.[mc]?[jt]s$/.test(c.file));
    // A file the states' coverage knows at all is the browser's code; one it never saw may be server-only or not loaded.
    // The lines of code the new version's loaded scripts hold (not imports, types or comments), by file.
    const executable = new Map<string, [number, number][]>();
    for (const cov of covAfter.values()) for (const [f, l] of byFile(cov.code)) executable.set(f, [...(executable.get(f) ?? []), ...l]);
    const unreached = code
        .map(c => {
            const loaded = executable.has(c.file);
            // A loaded file: only its changed lines of code count; one no state loaded, all but its imports, types and comments.
            const lines = subtract(loaded ? overlaps(c.added, executable.get(c.file)!) : withoutDeclarations(c.added, path.join(dir, c.file)), reachedNew.get(c.file) ?? []);
            return { file: c.file, lines: merge(lines), loaded };
        })
        .filter(u => u.lines.length);
    return {
        base,
        changed,
        states: result,
        untouched: names.filter(n => !result.some(r => r.state === n)),
        unreached,
        other: changed.filter(c => !code.includes(c) && !GENERATED.test(c.file)).map(c => c.file),
        generated: changed.filter(c => GENERATED.test(c.file)).map(c => c.file),
        noCoverage: names.filter(n => !covAfter.has(n) && !covBefore.has(n)),
    };
}

/** The result as lines to read. */
export function formatAffected(a: Affected): string {
    const range = (l: [number, number][]) => l.map(([x, y]) => (x === y ? `${x}` : `${x}-${y}`)).join(',');
    const lines = [`Changed since ${a.base.slice(0, 10)}: ${a.changed.length} file${a.changed.length === 1 ? '' : 's'}`];
    if (a.states.length) {
        lines.push('', 'States the change reaches:');
        for (const s of a.states) lines.push(`  ${s.state}`, ...s.files.map(f => `    ${f.file}:${range(f.lines)}${f.side === 'old' ? ' (removed lines it ran before)' : ''}`));
    } else lines.push('', 'No listed state runs the changed lines.');
    if (a.untouched.length) lines.push('', `Not reached: ${a.untouched.join(', ')}`);
    if (a.unreached.length) {
        lines.push('', 'Changed code no state ran (add a state that shows it, or ask what should happen there; it may also be server-only code):');
        for (const u of a.unreached) lines.push(`  ${u.file}:${range(u.lines)}${u.loaded ? '' : '  (no state loads this file: server code, or a page none of them opens)'}`);
    }
    if (a.other.length) lines.push('', `Other changed files (not browser code): ${a.other.join(', ')}`);
    if (a.generated.length) lines.push('', `Generated files, left out: ${a.generated.join(', ')}`);
    if (a.noCoverage.length) lines.push('', `No coverage for: ${a.noCoverage.join(', ')} (capture them again with app or coverage: true in the config)`);
    return lines.join('\n');
}
