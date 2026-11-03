// The tools, defined once: their names, what they do, their inputs (zod), and what they run. The MCP
// server (src/mcp.js) and the command line (bin/redlines.js) are both made from this list, so an agent
// sees the same names and inputs whichever way it calls them. Every path is inside the project folder.
import path from 'node:path';

import { z } from 'zod';

import { captureStates, loadConfig, viewPage } from './capture.js';
import { formatChanges } from './diff.js';
import { exportDesign } from './export.js';
import { outline } from './outline.js';
import { findChanges, writeReport } from './report.js';

export const INSTRUCTIONS = `redlines shows what a UI change does to the pages, state by state.

Use it whenever you change UI code:
1. See your work. After changing a page, call view_page on it (the running app's URL) before you say it is done. Read the screenshot and the outline: is the change there, does anything look broken, are there page errors? Use steps to reach dialogs, menus and filled-in forms, and mocks for data states (an empty list, an error).
2. Show the change to people (designers, PMs, reviewers):
   - list_states tells you which states the project lists in redlines.config.mjs, or how to write one. Make sure every screen and state your change touches is listed (dialogs via steps, data states via mocks); edit the config file yourself.
   - You need the app running twice: before the change (usually the main branch: a second checkout, e.g. git worktree add, with its own dev server on another port) and after it (your working copy). If you don't know how to run the app, ask the user for the two URLs.
   - capture_states with the before URL into one folder and with the after URL into another (same config), then find_changes between them. Check the list matches what you meant to change: anything you did not intend is worth telling the user about.
   - create_review writes a review page (before and after side by side, each change boxed and numbered). Give the user its path.
   - export_design gives editable design files of the states (format "dc": a Claude Design canvas; "html": standalone pages).
Folders default to .redlines/ in the project. Paths must stay inside the project.`;

/** A path inside the project (relative paths are from the project); anything else is refused. */
export function inProject(root, p, fallback) {
    const full = path.resolve(root, p ?? fallback);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`${p} is outside the project (${root})`);
    return full;
}

const step = z.union([
    z.object({ click: z.string() }),
    z.object({ fill: z.tuple([z.string(), z.string()]) }),
    z.object({ press: z.string() }),
    z.object({ hover: z.string() }),
    z.object({ select: z.tuple([z.string(), z.string()]) }),
    z.object({ waitFor: z.string() }),
    z.object({ wait: z.number().int().min(0).max(30000) }),
]);
const httpUrl = z.string().url().refine(u => /^https?:\/\//.test(u), 'an http(s) URL');

const CONFIG_EXAMPLE = `export default {
    viewport: { width: 1280, height: 800 },
    // API answers every state gets, so both versions show the same data.
    mocks: { 'GET /api/orders': [{ id: '#1001', customer: 'Ada Lovelace', status: 'Paid' }] },
    states: {
        list: { path: '/orders', title: 'Order list' },
        details: { path: '/orders', title: 'Order details', steps: [{ click: 'text=#1001' }] },
        empty: { path: '/orders', title: 'No orders', mocks: { 'GET /api/orders': [] } },
    },
};`;

/**
 * Each tool: { name, title, description, input (zod shape), annotations, run(args, { root }) }. `run`
 * returns { text, image?: PNG buffer, isError? } and throws on bad input or a failure.
 */
export const TOOLS = [
    {
        name: 'view_page',
        title: 'View a page',
        description: 'Open a page of the running app (optionally doing steps first: click, fill, press, hover, select, waitFor, wait) and return a screenshot, an outline of what is on screen (components, buttons, links, text) and any page errors. Writes nothing.',
        input: {
            url: httpUrl.describe('The page, e.g. http://localhost:3000/orders'),
            steps: z.array(step).optional().describe('Done in order after the page loads. Selectors are Playwright selectors: text=Save, role=button[name="Save"], CSS.'),
            mocks: z.record(z.any()).optional().describe('"GET /api/orders": <JSON answer> (or { status, json | body }). Paths match from the start; * matches anything.'),
            width: z.number().int().min(320).max(3840).optional(),
            height: z.number().int().min(320).max(4000).optional(),
            fullPage: z.boolean().optional().describe('Screenshot the whole page instead of the first screen.'),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
        async run({ url, steps, mocks, width, height, fullPage }) {
            const { tree, screenshot, errors } = await viewPage({ url, steps, mocks, viewport: { width: width ?? 1280, height: height ?? 800 }, fullPage });
            return { image: screenshot, text: `${tree.title || '(no title)'} — ${tree.url}\npage size ${tree.size.width}×${tree.size.height}${errors.length ? `\npage errors:\n  ${errors.join('\n  ')}` : ''}\n\n${outline(tree)}` };
        },
    },
    {
        name: 'list_states',
        title: 'List the states to capture',
        description: "Read the project's redlines config (redlines.config.mjs/.js/.json in the project folder): its file, base URL and states. Without one, returns how to write it.",
        input: { config: z.string().optional().describe('A config file in the project, if not the default name.') },
        annotations: { readOnlyHint: true },
        async run({ config: file }, { root }) {
            let config;
            try {
                config = await loadConfig(file ? inProject(root, file) : undefined, root);
            } catch (e) {
                if (!/No config/.test(e.message)) throw e;
                return { text: `No redlines config in ${root}. Write redlines.config.mjs there, for example:\n\n${CONFIG_EXAMPLE}\n\nState names are letters, digits, - and _. Steps: click, fill [selector, text], press, hover, select [selector, value], waitFor, wait (ms). List every screen and state the change touches, including dialogs and empty or error states.` };
            }
            const states = Object.entries(config.states).map(([name, s]) => `  ${name}: ${s.title ?? name} — ${s.path ?? '/'}${s.steps?.length ? `, ${s.steps.length} step${s.steps.length === 1 ? '' : 's'}` : ''}${s.mocks ? `, mocks ${Object.keys(s.mocks).join(', ')}` : ''}`);
            return { text: `${path.relative(root, config.file)}\nbaseURL: ${config.baseURL ?? '(none: pass base to capture_states)'}\nglobal mocks: ${Object.keys(config.mocks ?? {}).join(', ') || 'none'}\nstates:\n${states.join('\n')}` };
        },
    },
    {
        name: 'capture_states',
        title: 'Capture one version of the app',
        description: 'Open each state in the config at `base` (one running version of the app) and save its page tree, screenshot and standalone HTML into `out`. Capture the version before the change and the one after it into two folders, then call find_changes.',
        input: {
            base: httpUrl.describe('Where this version runs, e.g. http://localhost:3000'),
            out: z.string().describe('Folder in the project, e.g. .redlines/before or .redlines/after'),
            states: z.array(z.string()).optional().describe('Only these states (default: all).'),
            config: z.string().optional().describe('A config file in the project, if not the default name.'),
        },
        annotations: { openWorldHint: true },
        async run({ base, out, states, config: file }, { root, log }) {
            const config = await loadConfig(file ? inProject(root, file) : undefined, root);
            const dir = inProject(root, out);
            const results = await captureStates({ config, base, out: dir, only: states, log: log ?? (() => {}) });
            const lines = results.map(r => (r.ok ? `ok   ${r.name}${r.fidelity != null ? ` (html ${(r.fidelity * 100).toFixed(1)}% like the page)` : ''}${r.errors.length ? `; page errors: ${r.errors.join(' | ')}` : ''}` : `FAIL ${r.name}: ${r.error}`));
            return { text: `${path.relative(root, dir)}:\n${lines.join('\n')}`, isError: results.some(r => !r.ok) };
        },
    },
    {
        name: 'find_changes',
        title: 'Find what changed',
        description: 'Compare two captured folders (before, after) and list, per state, each change: added, removed or changed, where on the page, what it holds now and before, style changes property by property.',
        input: { before: z.string().describe('Folder captured before the change'), after: z.string().describe('Folder captured after it'), json: z.boolean().optional().describe('The list as JSON, with each change\'s boxes on the page.') },
        annotations: { readOnlyHint: true },
        async run({ before, after, json }, { root }) {
            const states = findChanges(inProject(root, before), inProject(root, after));
            if (json) return { text: JSON.stringify(states.map(({ name, title, status, changes }) => ({ name, title, status, changes })), null, 2) };
            const parts = states.filter(s => s.status !== 'same').map(s => `### ${s.title} (${s.name})\n${s.status === 'changed' ? formatChanges(s.changes) : s.status === 'added' ? 'a new state (not captured before)' : 'captured before, not after'}`);
            const same = states.filter(s => s.status === 'same').map(s => s.name);
            return { text: `${parts.join('\n\n') || 'no changes'}${same.length ? `\n\nno changes: ${same.join(', ')}` : ''}` };
        },
    },
    {
        name: 'create_review',
        title: 'Create the review page',
        description: 'Write a review page for two captured folders: each state before and after side by side, every change boxed and numbered, and the list of changes. Returns the path of its index.html.',
        input: { before: z.string(), after: z.string(), out: z.string().optional().describe('Default .redlines/review'), title: z.string().max(200).optional() },
        async run({ before, after, out, title }, { root }) {
            const states = findChanges(inProject(root, before), inProject(root, after));
            const file = writeReport(states, inProject(root, out, '.redlines/review'), { title });
            const total = states.reduce((n, s) => n + s.changes.length, 0);
            return { text: `${file}\n${total} change${total === 1 ? '' : 's'} in ${states.filter(s => s.status !== 'same').length} of ${states.length} states. Open it in a browser, or put the folder on any static host.` };
        },
    },
    {
        name: 'export_design',
        title: 'Export editable designs',
        description: 'Export the states of a captured folder as editable design files: "dc" writes a Claude Design canvas (project/canvas.json and one artboard per state) to publish; "html" copies the standalone pages.',
        input: { from: z.string().describe('A captured folder'), out: z.string().optional().describe('Default .redlines/design'), format: z.enum(['dc', 'html']).optional(), title: z.string().max(200).optional() },
        async run({ from, out, format, title }, { root }) {
            const dir = inProject(root, out, '.redlines/design');
            const { files, notes } = exportDesign(inProject(root, from), dir, { format: format ?? 'dc', title });
            return { text: `${dir}\n  ${files.join('\n  ')}${notes.length ? `\nto finish by hand:\n  ${notes.join('\n  ')}` : ''}` };
        },
    },
];
