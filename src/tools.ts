// The tools, defined once: their names, what they do, their inputs (zod), and what they run. The MCP
// server (src/mcp.js) and the command line (bin/redlines.js) are both made from this list, so an agent
// sees the same names and inputs whichever way it calls them. Every path is inside the project folder.
import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { logIn, storedAuth } from './auth.js';
import { workDir } from './package.js';
import { proxyEnv, proxyStatus, startProxy, stopProxy } from './proxy.js';
import { captureStates, loadConfig, recordData, viewPage } from './capture.js';
import type { Config, Manifest } from './types.js';
import { formatChanges } from './diff.js';
import { findDesignEdits } from './edits.js';
import { exportDesign } from './export.js';
import { outline } from './outline.js';
import { affectedStates, baseCommit, formatAffected } from './affected.js';
import { baseCheckout, fingerprint, freePort, headOf, startApp } from './app.js';
import { buildPrototype, checkPrototype } from './prototype.js';
import { findChanges, writeReport } from './report.js';

/** What a tool gives back: text, a screenshot for view_page, and whether it failed part way. */
export interface ToolResult { text: string; image?: Buffer; isError?: boolean }

export interface ToolContext { root: string; log?: (line: string) => void }

export interface Tool {
    name: string;
    title: string;
    description: string;
    input: z.ZodRawShape;
    annotations?: { readOnlyHint?: boolean; openWorldHint?: boolean };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each tool's args are its own input, checked by zod before run.
    run(args: any, context: ToolContext): Promise<ToolResult>;
}

export const INSTRUCTIONS = `redlines shows what a UI change does to the pages, state by state.

Use it whenever you change UI code:
0. Apps behind a login: when a tool says the app sent a page to a login page, call log_in with the app's URL and tell the user to log in in the browser window that opens (they type their own password; you never ask for it). The login is kept once per machine and host (every project, worktree and port share it) and refreshed by every run, so log in again only when a tool says the login has expired.
1. See your work. After changing a page, call view_page on it (the running app's URL) before you say it is done. Read the screenshot and the outline: is the change there, does anything look broken, are there page errors? Use steps to reach dialogs, menus and filled-in forms, and mocks for data states (an empty list, an error).
2. Show the change to people (designers, PMs, reviewers):
   - list_states tells you which states the project lists in redlines.config.mjs, or how to write one. Make sure every screen and state your change touches is listed (dialogs via steps, data states via mocks); edit the config file yourself.
   - Both versions must show the same data. If the project has MSW handlers, set msw in the config; if the app needs a real backend, call record_data once against it (logged in) and set recording in the config to the file it writes. Otherwise write mocks for the endpoints the states use.
   - If the config has app (how to build and start it), call capture_change instead of the next three steps: it runs both versions itself, captures them, lists the changes and which states your code change reaches. Changed code no state ran needs a state that shows it (add one to the config) or a question to the user about what should happen there.
   - You need the app running twice: before the change (usually the main branch: a second checkout, e.g. git worktree add, with its own dev server on another port) and after it (your working copy). If you don't know how to run the app, ask the user for the two URLs.
   - capture_states with the before URL into one folder and with the after URL into another (same config), then find_changes between them. Check the list matches what you meant to change: anything you did not intend is worth telling the user about.
   - create_review writes a review page (before and after side by side, each change boxed and numbered). Give the user its path.
   - export_design gives editable design files of the states (format "dc": a Claude Design canvas; "html": standalone pages). States link to each other where a click leads (a state whose steps continue another's, and a state's links in the config), so the pages can be clicked through, or played on the canvas.
3. A clickable prototype (the app itself, for people who can't run it): build_prototype walks the states and writes a folder for a static host; give the user the folder and the address to open (<host>/p/<id>/).
4. Work with a designer: the draft_design prompt walks it (a requirement drafted in code, exported as a canvas they edit and play through). When they have edited the canvas, read its artboards back into a folder and call find_design_edits against the export: carry each edit into the code, then capture and export again.
Folders default to .redlines/ in the project. Paths must stay inside the project.`;

/** A path inside the project (relative paths are from the project); anything else is refused. */
export function inProject(root: string, p?: string, fallback?: string): string {
    if (p === undefined && fallback === undefined) throw new Error('A path is needed');
    const full = path.resolve(root, (p ?? fallback)!);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`${p} is outside the project (${root})`);
    return full;
}

const step = z.union([
    z.object({ click: z.string() }),
    z.object({ fill: z.tuple([z.string(), z.union([z.string(), z.object({ env: z.string() })])]) }),
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
    // Or the project's own MSW handlers (relative to this file): msw: './src/mocks/handlers.ts',
    states: {
        list: { path: '/orders', title: 'Order list' },
        details: { path: '/orders', title: 'Order details', steps: [{ click: 'text=#1001' }] },
        empty: { path: '/orders', title: 'No orders', mocks: { 'GET /api/orders': [] } },
    },
};`;


/** The change as text: find_changes' list. */
function changesText(before: string, after: string): string {
    const states = findChanges(before, after);
    const parts = states.filter(s => s.status !== 'same').map(s => `### ${s.title} (${s.name})\n${s.status === 'changed' ? formatChanges(s.changes) : s.status === 'added' ? 'a new state (not captured before)' : 'captured before, not after'}`);
    const same = states.filter(s => s.status === 'same').map(s => s.name);
    return `${parts.join('\n\n') || 'no changes'}${same.length ? `\n\nno changes: ${same.join(', ')}` : ''}`;
}

/** The app's checkout: `override` (from the project), else config.app.dir (relative to the config). */
function appDir(config: Config, root?: string, override?: string): string {
    if (!config.app) throw new Error('The config has no app: say how to start it (app: { dir, start, port }) so redlines can run each version itself');
    const dir = override ? path.resolve(root ?? process.cwd(), override) : path.resolve(path.dirname(config.file), config.app.dir);
    if (!fs.existsSync(path.join(dir, '.git'))) throw new Error(`app.dir is not a git checkout: ${dir}`);
    return dir;
}

/**
 * Captures the version before the change (the base commit, checked out beside the project) and the
 * one after it (the working copy), starting each with config.app. A before capture of the same base,
 * config and data is kept.
 */
async function captureChange({ config, root, dir, only, fresh, log }: { config: Config; root: string; dir: string; only?: string[]; fresh?: boolean; log: (line: string) => void }) {
    const app = config.app!;
    const base = baseCommit(dir, app.base);
    const recording = config.recording ? path.resolve(path.dirname(config.file), config.recording) : undefined;
    const inputs = fingerprint([config.file, ...(recording ? [recording] : [])]);
    const before = path.join(workDir(root), 'before'), after = path.join(root, '.redlines', 'after');
    let env: Record<string, string> = {};
    let proxied = false;
    try {
        if (app.dataProxy) {
            if (!recording) throw new Error('app.dataProxy replays the recording: set recording in the config (record it with data_proxy and record_data)');
            if (proxyStatus(root)) throw new Error('A data proxy is already running for this project: stop it first (data_proxy --action stop)');
            env = proxyEnv(await startProxy({ root, mode: 'replay', file: recording, port: await freePort(), config: config.file }));
            proxied = true;
        }
        const version = async (side: 'before' | 'after', cwd: string, source: NonNullable<Manifest['source']>) => {
            log(`${side}: starting ${app.start} in ${cwd}`);
            const running = await startApp(app, { cwd, env, log: path.join(root, '.redlines', `app-${side}.log`) });
            try {
                // A dev server builds each page the first time it is asked for: ask once, unhurried, before capturing.
                for (const p of new Set(Object.entries(config.states).filter(([n]) => !only?.length || only.includes(n)).map(([, s]) => s.path ?? '/'))) {
                    await fetch(new URL(p, running.url), { signal: AbortSignal.timeout((app.timeout ?? 300) * 1000) }).then(r => r.body?.cancel()).catch(() => {});
                }
                const results = await captureStates({ config, base: running.url, out: side === 'before' ? before : after, only, root, log, source });
                return results;
            } finally {
                await running.stop();
            }
        };
        const kept = fs.existsSync(path.join(before, 'manifest.json')) ? (JSON.parse(fs.readFileSync(path.join(before, 'manifest.json'), 'utf8')) as Manifest) : undefined;
        const wanted = only?.length ? only : Object.keys(config.states);
        const current = !fresh && kept?.source?.commit === base && kept.source.inputs === inputs && wanted.every(n => kept.states.some(s => s.name === n));
        const results: { side: string; name: string; ok: boolean; error?: string; errors?: string[] }[] = [];
        if (current) log(`before: kept (base ${base.slice(0, 10)}, same config and data)`);
        else for (const r of await version('before', baseCheckout(root, dir, base), { commit: base, inputs })) results.push({ side: 'before', ...r });
        const head = headOf(dir);
        for (const r of await version('after', dir, { commit: head.commit, dirty: head.dirty, inputs })) results.push({ side: 'after', ...r });
        return { base, dir, before, after, results, kept: current };
    } finally {
        if (proxied) await stopProxy(root);
    }
}

/**
 * Each tool: { name, title, description, input (zod shape), annotations, run(args, { root }) }. `run`
 * returns { text, image?: PNG buffer, isError? } and throws on bad input or a failure.
 */
export const TOOLS: Tool[] = [
    {
        name: 'log_in',
        title: 'Log in to the app',
        description: 'For an app behind a login: open a browser window on the app for the user to log in themselves, wait until they have, and keep the login (cookies, local storage) for later view_page, capture_states and record_data on the same host, from any project. Tell the user to log in in the window that opens, and that if it does not close by itself once they are in, to press the "Logged in — save for redlines" button at the bottom right. Never ask for their password.',
        input: {
            url: httpUrl.describe('The app, e.g. http://localhost:3000 (it may send the window on to its login page)'),
            until: z.string().optional().describe('A selector that shows only once logged in, when coming back to the app is not enough to tell.'),
            timeoutMinutes: z.number().int().min(1).max(30).optional(),
        },
        annotations: { openWorldHint: true },
        async run({ url, until, timeoutMinutes }) {
            const file = await logIn({ url, until, timeoutMinutes });
            return { text: `Logged in to ${new URL(url).hostname}. The login is kept in ${file} (readable only by you, outside every project) and used by view_page, capture_states and record_data for every project and port on this host; each run keeps what the app refreshes, so it lasts until the app ends the session.` };
        },
    },
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
        async run({ url, steps, mocks, width, height, fullPage }, { root }) {
            const { tree, screenshot, errors } = await viewPage({ url, steps, mocks, viewport: { width: width ?? 1280, height: height ?? 800 }, fullPage, storageState: storedAuth(root, url) });
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
                if (!/No config/.test((e as Error).message)) throw e;
                return { text: `No redlines config in ${root}. Write redlines.config.mjs there, for example:\n\n${CONFIG_EXAMPLE}\n\nIf the project already has MSW handlers, use them (msw) rather than writing mocks again; a state can pick another exported list with msw: '<export>'. State names are letters, digits, - and _. Steps: click, fill [selector, text], press, hover, select [selector, value], waitFor, wait (ms). List every screen and state the change touches, including dialogs and empty or error states.` };
            }
            const states = Object.entries(config.states).map(([name, s]) => `  ${name}: ${s.title ?? name} — ${s.path ?? '/'}${s.steps?.length ? `, ${s.steps.length} step${s.steps.length === 1 ? '' : 's'}` : ''}${s.mocks ? `, mocks ${Object.keys(s.mocks).join(', ')}` : ''}${s.msw ? `, MSW scenario ${s.msw}` : ''}`);
            const msw = config.msw ? (typeof config.msw === 'string' ? config.msw : `${config.msw.file} (export ${config.msw.export ?? 'handlers'})`) : 'none';
            return { text: `${path.relative(root, config.file)}\nbaseURL: ${config.baseURL ?? '(none: pass base to capture_states)'}\nglobal mocks: ${Object.keys(config.mocks ?? {}).join(', ') || 'none'}\nMSW handlers: ${msw}\nstates:\n${states.join('\n')}` };
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
            if (dir.startsWith(path.join(root, '.redlines'))) workDir(root);
            const results = await captureStates({ config, base, out: dir, only: states, root, log: log ?? (() => {}) });
            const lines = results.map(r => (r.ok ? `ok   ${r.name}${r.fidelity != null ? ` (html ${(r.fidelity * 100).toFixed(1)}% like the page)` : ''}${r.errors.length ? `; page errors: ${r.errors.join(' | ')}` : ''}` : `FAIL ${r.name}: ${r.error}`));
            return { text: `${path.relative(root, dir)}:\n${lines.join('\n')}`, isError: results.some(r => !r.ok) };
        },
    },
    {
        name: 'capture_change',
        title: 'Capture what a change does',
        description: 'Run both versions of the app and capture every state in each: the version before the change (where the working copy left the base branch, checked out beside the project, sharing its installed dependencies) and the working copy, each started, waited for and stopped by redlines with config.app (dir, start, build, port, dataProxy). The before capture is kept while the base, config and data stay the same. Then lists what changed (find_changes) and which states the code change reaches (affected_states). Needs app in the config, and nothing else running on its port.',
        input: {
            states: z.array(z.string()).optional().describe('Only these states (default: all).'),
            fresh: z.boolean().optional().describe('Capture the version before again even if the kept one is current.'),
            app: z.string().optional().describe('The app checkout to capture, if not config.app.dir (a worktree of it, where the change is)'),
            config: z.string().optional().describe('A config file in the project, if not the default name.'),
        },
        annotations: { openWorldHint: true },
        async run({ states, fresh, app, config: file }, { root, log }) {
            const config = await loadConfig(file ? inProject(root, file) : undefined, root);
            const done = await captureChange({ config, root, dir: appDir(config, root, app), only: states, fresh, log: log ?? (() => {}) });
            const failed = done.results.filter(r => !r.ok);
            // A page whose requests came back 401 shows a login or an error, not the state.
            const denied = done.results.filter(r => r.ok && r.errors?.some(e => /\b401\b/.test(e))).map(r => `${r.side} ${r.name}`);
            const parts = [
                ...(denied.length ? [`! The app was refused (401) on ${denied.join(', ')}: the login has probably expired, so those pages may show an error or a login instead of the state. Log in again (log_in) and run this again with fresh.`, ''] : []),
                `before: ${done.kept ? 'kept' : 'captured'} (${done.base.slice(0, 10)}) → ${path.relative(root, done.before)}; after: the working copy → ${path.relative(root, done.after)}`,
                ...failed.map(r => `FAIL ${r.side} ${r.name}: ${r.error}`),
                '', '## What changed', changesText(done.before, done.after),
                '', '## Which states the code change reaches', formatAffected(affectedStates({ dir: done.dir, base: done.base, after: done.after, before: done.before, states })),
            ];
            return { text: parts.join('\n'), isError: failed.length > 0 || denied.length > 0 };
        },
    },
    {
        name: 'affected_states',
        title: 'Which states a code change reaches',
        description: 'Set the lines the change touched (git diff of the app\'s checkout against the base) against the source lines each captured state ran (<state>.coverage.json, kept by capture_states when the config has app or coverage: true). Lists the states the change reaches (with file:lines), the states it does not, and changed code no state ran: new code that needs a state to show it (a dialog, an error, an empty list) or a question to ask about it.',
        input: {
            after: z.string().optional().describe('The capture of the changed version (default .redlines/after)'),
            before: z.string().optional().describe('The capture before it, for removed lines (default .redlines/before, if there)'),
            base: z.string().optional().describe('The git ref to compare with (default: where the working copy left app.base or the remote default branch)'),
            app: z.string().optional().describe('The app checkout, if not config.app.dir'),
            config: z.string().optional().describe('A config file in the project, if not the default name.'),
        },
        annotations: { readOnlyHint: true },
        async run({ after, before, base, app, config: file }, { root }) {
            const config = await loadConfig(file ? inProject(root, file) : undefined, root);
            const dir = config.app ? appDir(config, root, app) : root;
            const a = inProject(root, after, '.redlines/after'), b = inProject(root, before, '.redlines/before');
            return { text: formatAffected(affectedStates({ dir, base: baseCommit(dir, base ?? config.app?.base), after: a, before: fs.existsSync(b) ? b : undefined })) };
        },
    },
    {
        name: 'record_data',
        title: 'Record the app\'s data',
        description: 'Open each state at `base` against a real backend (logged in, no mocks) and record the API answers the pages fetch (fetch and XHR only, never scripts or styles; no request headers kept) into a HAR file. Set `recording` in the config to that file and capture_states answers from it, so the versions before and after a change show the same data. The file holds real backend data: keep it out of public repositories.',
        input: {
            base: httpUrl.describe('Where the app runs against a real backend, e.g. http://localhost:3000'),
            out: z.string().optional().describe('The HAR file in the project (default .redlines/recording.har); answers already in it are kept'),
            states: z.array(z.string()).optional().describe('Only these states (default: all).'),
            config: z.string().optional().describe('A config file in the project, if not the default name.'),
        },
        annotations: { openWorldHint: true },
        async run({ base, out, states, config: file }, { root, log }) {
            const config = await loadConfig(file ? inProject(root, file) : undefined, root);
            const har = inProject(root, out, '.redlines/recording.har');
            const { results, answers } = await recordData({ config, base, file: har, only: states, root, log: log ?? (() => {}) });
            const lines = results.map(r => (r.ok ? `ok   ${r.name}` : `FAIL ${r.name}: ${r.error}`));
            return { text: `${lines.join('\n')}\n${answers} answers recorded into ${path.relative(root, har)}. Set recording: '${path.relative(path.dirname(config.file), har)}' in the config to capture from it.`, isError: results.some(r => !r.ok) };
        },
    },
    {
        name: 'data_proxy',
        title: 'Record or replay the server\'s own requests',
        description: 'For an app that fetches data on the server (server rendering), which browser-side mocks and recordings never see. start runs a local proxy in the background and returns the environment variables to start the dev server with, so its requests to the backend go through the proxy: mode "record" passes them on and keeps the answers in the recording file (the same file record_data writes, and capture_states replays with `recording` in the config); mode "replay" answers from it. stop ends it (saving the recording); status says whether one runs. Restart the dev server with the variables after start, and without them after stop.',
        input: {
            action: z.enum(['start', 'stop', 'status']),
            mode: z.enum(['record', 'replay']).optional().describe('For start (default record).'),
            out: z.string().optional().describe('The recording file in the project (default .redlines/recording.har).'),
            port: z.number().int().min(1024).max(65535).optional().describe('For start (default 8899).'),
        },
        annotations: { openWorldHint: true },
        async run({ action, mode, out, port }, { root }) {
            if (action === 'status') {
                const state = proxyStatus(root);
                return { text: state ? `running: ${state.mode}, port ${state.port}, ${path.relative(root, state.file)} (pid ${state.pid}, log ${path.relative(root, state.log)})` : 'not running' };
            }
            if (action === 'stop') {
                const state = await stopProxy(root);
                return { text: state ? `${state.said ?? `stopped the ${state.mode} proxy`}${state.mode === 'record' ? `; the recording is ${path.relative(root, state.file)}` : ''}. Restart the dev server without the proxy variables.` : 'no data proxy was running' };
            }
            const state = await startProxy({ root, mode: mode ?? 'record', file: inProject(root, out, '.redlines/recording.har'), port });
            const env = Object.entries(proxyEnv(state)).map(([k, v]) => `${k}=${v}`).join(' ');
            return { text: `data proxy (${state.mode}) running on port ${state.port}.\nStart (or restart) the dev server with these variables, e.g.:\n  ${env} npm run dev\nThen ${state.mode === 'record' ? 'run record_data (the browser side) and capture as usual; data_proxy stop saves the recording' : 'capture_states as usual, with recording set in the config'}. Node 22.21+/24.5+ sends its fetch through the proxy with NODE_USE_ENV_PROXY; clients like axios read HTTP(S)_PROXY themselves. The certificate in NODE_EXTRA_CA_CERTS is this proxy's own, trusted by that dev server only.` };
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
        name: 'find_design_edits',
        title: 'Find what a designer changed',
        description: 'Compare an exported canvas (export_design\'s folder) with the same artboards after a designer edited them (read back into another folder in the project, same file names), and list each edit like find_changes does: where, what it holds now and before, styles property by property; artboards they added come with an outline. Carry the edits into the code, then capture and export again.',
        input: { exported: z.string().optional().describe('The folder export_design wrote (default .redlines/design)'), edited: z.string().describe('The edited artboards, read back into a folder in the project, e.g. .redlines/design-edited'), json: z.boolean().optional() },
        annotations: { readOnlyHint: true },
        async run({ exported, edited, json }, { root }) {
            const boards = await findDesignEdits(inProject(root, exported, '.redlines/design'), inProject(root, edited));
            if (json) return { text: JSON.stringify(boards, null, 2) };
            const parts = boards.filter(b => b.status !== 'same').map(b => `### ${b.title || b.file} (${b.file})\n${b.status === 'changed' ? formatChanges(b.changes) : b.status === 'added' ? `a new artboard on the canvas:\n${b.outline}` : 'removed from the canvas'}`);
            const same = boards.filter(b => b.status === 'same').map(b => b.file);
            return { text: `${parts.join('\n\n') || 'no edits'}${same.length ? `\n\nnot edited: ${same.join(', ')}` : ''}` };
        },
    },
    {
        name: 'build_prototype',
        title: 'Build a clickable prototype',
        description: 'Walk the states at `base` (logged in, with the config\'s data: mocks, MSW or the recording) and keep everything the browser is given, so the app runs again with no server: a folder with sw.js at its root and the prototype under p/<id>/. Put the whole folder on a static host at the root of its own (sub)domain, served over https (several prototypes share one host, each under its own p/<id>/; the worker leaves the host\'s other pages alone), and share <host>/p/<id>/. What viewers can click is what the walks did: each state\'s steps, and each of its links in the config; requests to change data answer as they did while walking, and the pages show what was recorded after them. Login secrets in the pages and answers are blanked, but the folder holds the app\'s code and its data: keep it on hosts only your team can reach. Then each walk is played on the folder with the network cut off (skipCheck to skip it).',
        input: {
            base: httpUrl.describe('Where the app runs (the version to prototype), e.g. http://localhost:3000'),
            id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).describe('The prototype\'s name in its address, e.g. claim-reopen (lowercase letters, digits, dashes)'),
            out: z.string().optional().describe('The folder to upload (default .redlines/prototype); other prototypes in it are kept'),
            start: z.string().optional().describe('The state it opens on (default: the first walked)'),
            states: z.array(z.string()).optional().describe('Only these states (default: all).'),
            skip: z.string().max(500).optional().describe('A regular expression of addresses to leave out (more analytics or widgets; common ones are left out already)'),
            skipCheck: z.boolean().optional().describe('Do not play the walks on the built folder afterwards'),
            config: z.string().optional().describe('A config file in the project, if not the default name.'),
        },
        annotations: { openWorldHint: true },
        async run({ base, id, out, start, states, skip, skipCheck, config: file }, { root, log }) {
            const config = await loadConfig(file ? inProject(root, file) : undefined, root);
            const dir = inProject(root, out, '.redlines/prototype');
            if (dir.startsWith(path.join(root, '.redlines'))) workDir(root);
            const built = await buildPrototype({ config, base, out: dir, id, start, only: states, skip, root, log: log ?? (() => {}) });
            const lines = [`${path.relative(root, dir)}: ${built.files} files, ${(built.bytes / 1e6).toFixed(1)} MB; ${built.secrets} login secrets blanked`, ...built.walks.map(w => (w.ok ? `recorded ${w.name}` : `FAIL     ${w.name}: ${w.error}`))];
            let failed = built.walks.some(w => !w.ok);
            if (!skipCheck) {
                const played = await checkPrototype({ config, out: dir, id, only: states });
                lines.push('played offline:', ...played.walks.map(w => (w.ok ? `  ok   ${w.name}` : `  FAIL ${w.name}: ${w.error}`)));
                if (played.offline.length) lines.push(`  asked for and not in the recording (cut off): ${played.offline.join(', ')}`);
                failed ||= played.walks.some(w => !w.ok);
            }
            lines.push(`Upload the whole folder to the root of a static host on its own (sub)domain, over https, and open <host>${built.entry}. To click through it here first: redlines serve ${path.relative(root, dir)}.`);
            return { text: lines.join('\n'), isError: failed };
        },
    },
    {
        name: 'export_design',
        title: 'Export editable designs',
        description: 'Export the states of a captured folder as editable design files: "dc" writes a Claude Design canvas (project/canvas.json and one artboard per state) to publish; "html" copies the standalone pages.',
        input: { from: z.string().describe('A captured folder'), out: z.string().optional().describe('Default .redlines/design'), format: z.enum(['dc', 'html']).optional(), title: z.string().max(200).optional() },
        async run({ from, out, format, title }, { root }) {
            const dir = inProject(root, out, '.redlines/design');
            const { files, notes, links } = exportDesign(inProject(root, from), dir, { format: format ?? 'dc', title });
            const flow = links.length ? `\nlinks (click through the pages, or Play on the canvas):\n  ${links.join('\n  ')}` : '\nno links: states that continue another\'s steps, or a state\'s links in the config, join them into a flow';
            return { text: `${dir}\n  ${files.join('\n  ')}${flow}${notes.length ? `\nto finish by hand:\n  ${notes.join('\n  ')}` : ''}` };
        },
    },
];

export interface Prompt {
    name: string;
    title: string;
    description: string;
    args: z.ZodRawShape;
    text(args: Record<string, string | undefined>): string;
}

/** Workflows an agent is walked through: the MCP server's prompts, and `redlines prompt <name>`. */
export const PROMPTS: Prompt[] = [
    {
        name: 'draft_design',
        title: 'Draft a design from a requirement',
        description: 'A requirement drafted in the real code, shown as a canvas a designer edits and plays through, and their edits carried back into the code.',
        args: { requirement: z.string().describe('What to design, in the words of whoever asked') },
        text: ({ requirement }) => `Draft a design for this requirement, in the project's real code, for a designer to edit:

<requirement>
${requirement ?? '(ask the user for it)'}
</requirement>

1. Understand it. Find the screens and components it touches. Note what it leaves open; don't stop to ask, decide and say what you assumed.
2. The current version. list_states shows the config (write one if there is none). Capture the app as it is now: capture_states into .redlines/before.
3. Draft in code, on a new branch (e.g. design/<short-name>). Use the project's own components and tokens, the way the surrounding code does. Copy that isn't settled reads as a visible placeholder like [Reason shown to the shopper]. Change nothing the requirement doesn't need.
4. List every state the draft has in the config: each new screen, dialog, menu, filled form, empty and error state. A state reached by clicking from another keeps that state's steps and adds its own (it is then linked from it, so the flow plays through); a way back or to another page goes in the state's links ({ '<selector>': '<state>' }).
5. Check it. view_page what you changed; capture_states into .redlines/after; find_changes against .redlines/before: nothing should change that you didn't mean to. create_review for the developers.
6. Hand it over. export_design from .redlines/after (format dc publishes as a Claude Design canvas; html gives pages to click through). Tell the designer: what each artboard shows, the flow to play, what you assumed and what is still open.
7. When they say they've edited it: read the canvas's artboards back into .redlines/design-edited (same file names) and read their comments. find_design_edits (exported .redlines/design, edited .redlines/design-edited) lists their edits. Carry each into the code, through the components and tokens rather than raw values; text that comes from data is a data or config change, say so. Answer the comments. Then capture and export again: the canvas then shows the code, edits included. If an edit can't be made the same in code, say which and why, before the new export replaces it.`,
    },
];
