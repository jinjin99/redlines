// Running the app itself (config.app): each version is started, waited for, captured and stopped by
// redlines. The version before a change is a git worktree of the base commit beside the project
// (.redlines/base/<commit>), sharing the working copy's installed dependencies.
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import type { AppConfig } from './types.js';

const git = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A short fingerprint of files' contents (missing ones count as missing), to tell whether a capture is still current. */
export function fingerprint(files: string[]): string {
    const hash = crypto.createHash('sha256');
    for (const f of files) hash.update(f).update(fs.existsSync(f) ? fs.readFileSync(f) : 'missing');
    return hash.digest('hex').slice(0, 16);
}

/** The working copy's commit, and whether it has changes not committed. */
export function headOf(dir: string): { commit: string; dirty: boolean } {
    return { commit: git(dir, ['rev-parse', 'HEAD']), dirty: git(dir, ['status', '--porcelain']).length > 0 };
}

/** The installed dependency folders of a checkout (node_modules, also a workspace's packages'), relative to it. */
function dependencyFolders(dir: string): string[] {
    const out: string[] = [];
    const walk = (rel: string, depth: number) => {
        for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
            if (!e.isDirectory() || e.name === '.git' || e.name.startsWith('.redlines')) continue;
            const child = path.join(rel, e.name);
            if (e.name === 'node_modules') out.push(child);
            else if (depth < 3) walk(child, depth + 1);
        }
    };
    walk('.', 0);
    return out;
}

/**
 * A checkout of `commit` of the repository at `dir`, in `root`/.redlines/base/<commit>: made once and
 * kept, its dependencies linked to the working copy's (the base is usually close enough to share them).
 */
export function baseCheckout(root: string, dir: string, commit: string): string {
    const at = path.join(root, '.redlines', 'base', commit.slice(0, 12));
    if (fs.existsSync(at)) {
        try { if (git(at, ['rev-parse', 'HEAD']) === commit) return at; } catch { /* broken: made again */ }
        try { git(dir, ['worktree', 'remove', '--force', at]); } catch { fs.rmSync(at, { recursive: true, force: true }); }
    }
    fs.mkdirSync(path.dirname(at), { recursive: true });
    git(dir, ['worktree', 'prune']);
    git(dir, ['worktree', 'add', '--detach', at, commit]);
    for (const rel of dependencyFolders(dir)) if (fs.existsSync(path.dirname(path.join(at, rel)))) shareDependencies(path.join(dir, rel), path.join(at, rel), dir, at);
    return at;
}

/**
 * `to` as a folder of links into the working copy's dependency folder `from`, except the links to the
 * repository's own packages (a monorepo's workspaces: node_modules/app → ../packages/app), which point
 * at the checkout's own copy: else the base would run the working copy's code for them.
 */
function shareDependencies(from: string, to: string, dir: string, at: string) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) {
        const source = path.join(from, name), target = path.join(to, name);
        if (fs.existsSync(target) || fs.lstatSync(target, { throwIfNoEntry: false })) continue;
        // A scope (@org/…) holds packages one level down.
        if (name.startsWith('@') && !fs.lstatSync(source).isSymbolicLink()) { shareDependencies(source, target, dir, at); continue; }
        if (fs.lstatSync(source).isSymbolicLink()) {
            const real = path.resolve(path.dirname(source), fs.readlinkSync(source));
            const inRepo = real.startsWith(dir + path.sep) && !real.split(path.sep).includes('node_modules');
            if (inRepo) { fs.symlinkSync(path.join(at, path.relative(dir, real)), target, 'dir'); continue; }
        }
        fs.symlinkSync(source, target);
    }
}

/** A port nothing listens on. */
export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => { const { port } = server.address() as net.AddressInfo; server.close(() => resolve(port)); });
    });
}

/** Whether something answers at `url` (any HTTP answer below 500, a redirect included). */
async function answers(url: string): Promise<boolean> {
    try {
        const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        await r.body?.cancel();
        return r.status < 500;
    } catch {
        return false;
    }
}

export interface Running { url: string; stop: () => Promise<void>; log: string }

/** The app's address. */
export const appUrl = (app: AppConfig) => app.url ?? `http://localhost:${app.port ?? 3000}/`;

/**
 * Builds (if the config says how) and starts the app in `cwd`, and waits until it answers. Its output
 * goes to `log`. `stop` ends it with everything it started.
 */
export async function startApp(app: AppConfig, { cwd, env = {}, log }: { cwd: string; env?: Record<string, string>; log: string }): Promise<Running> {
    const url = appUrl(app);
    if (await answers(url)) throw new Error(`Something already answers at ${url}: stop it first, so the version redlines starts is the one captured`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const out = fs.openSync(log, 'w');
    const vars = { ...process.env, ...env, ...(app.env ?? {}), PORT: String(app.port ?? (Number(new URL(url).port) || 3000)) };
    if (app.build) {
        const built = spawnSync(app.build, { cwd, env: vars, shell: true, stdio: ['ignore', out, out] });
        if (built.status !== 0) throw new Error(`The build failed (${app.build}, in ${cwd}); its output is in ${log}`);
    }
    const child: ChildProcess = spawn(app.start, { cwd, env: vars, shell: true, stdio: ['ignore', out, out], detached: true });
    let exited: number | null = null;
    child.on('exit', code => { exited = code ?? -1; });
    const stop = async () => {
        if (exited !== null || child.pid === undefined) return;
        // The whole group: a package manager starts the server as its own child.
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
        for (let i = 0; i < 50 && exited === null; i++) await new Promise(r => setTimeout(r, 200));
        if (exited === null) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
        fs.closeSync(out);
    };
    const end = Date.now() + (app.timeout ?? 300) * 1000;
    while (Date.now() < end) {
        if (exited !== null) {
            const tail = fs.readFileSync(log, 'utf8').split('\n').slice(-15).join('\n');
            throw new Error(`The app stopped before it answered (${app.start}, in ${cwd}, exit ${exited}):\n${tail}`);
        }
        if (await answers(url)) return { url, stop, log };
        await new Promise(r => setTimeout(r, 1000));
    }
    await stop();
    throw new Error(`The app did not answer at ${url} within ${app.timeout ?? 300} s; its output is in ${log}`);
}
