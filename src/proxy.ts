// The data proxy: for apps that fetch their data on the server (server rendering), where the browser
// never sees those requests. The dev server is started with proxy environment variables, so its
// own requests to the backend go through here: recorded (passed on to the backend and kept) or
// replayed (answered from the recording; anything not in it passes on). It writes the same
// recording file the browser side reads, so one file holds both.
//
// HTTPS is read by acting as the backend towards the dev server, with a certificate from a local
// authority made for this proxy only (.redlines/proxy-ca/, its key readable only by its owner),
// which only the dev server is told to trust (NODE_EXTRA_CA_CERTS). Nothing is installed system-wide.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { PACKAGE_ROOT, workDir } from './package.js';
import { type Entry, loadRecording, Recorder } from './recording.js';

export type ProxyMode = 'record' | 'replay';

interface ProxyState { pid: number; port: number; mode: ProxyMode; file: string; ca: string; log: string }

const stateFile = (root: string) => path.join(root, '.redlines', 'data-proxy.json');
const caDir = (root: string) => path.join(root, '.redlines', 'proxy-ca');
// Bodies bigger than this are passed on, not kept.
const MAX_BODY = 5 * 1024 * 1024;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- an optional dependency, typed where it is used.
async function mockttp(): Promise<any> {
    try {
        return await import('mockttp');
    } catch (error) {
        throw new Error('The data proxy needs mockttp, an optional dependency: npm install mockttp', { cause: error });
    }
}

/** The local certificate authority, made once. */
async function authority(root: string): Promise<{ keyPath: string; certPath: string }> {
    const dir = caDir(root);
    const keyPath = path.join(dir, 'key.pem'), certPath = path.join(dir, 'cert.pem');
    workDir(root);
    if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
        const { generateCACertificate } = await mockttp();
        const { key, cert } = await generateCACertificate({ subject: { commonName: 'redlines local data proxy' } });
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
        fs.writeFileSync(keyPath, key, { mode: 0o600 });
        fs.writeFileSync(certPath, cert);
    }
    return { keyPath, certPath };
}

/** Runs the proxy in this process until it is stopped (SIGTERM or SIGINT), saving the recording as it goes. */
export async function runProxy({ root, mode, file, port, log = console.log }: { root: string; mode: ProxyMode; file: string; port: number; log?: (line: string) => void }): Promise<void> {
    const { getLocal } = await mockttp();
    const server = getLocal({ https: await authority(root) });
    // What it did, said when it stops: answers from the recording, requests passed on to the backend.
    const count = { replayed: 0, passed: 0 };
    await server.on('request', () => { count.passed++; });
    let loadedRecording: ReturnType<typeof loadRecording> | undefined;
    if (mode === 'replay') {
        const recording = loadRecording(file);
        loadedRecording = recording;
        const recorded = async (req: { method: string; url: string; body: { getText(): Promise<string | undefined> } }) => recording.find(req.method, req.url, (await req.body.getText()) || undefined);
        // always(): a rule that a later one also matches is otherwise used once and then left for that one.
        await server.forAnyRequest().always().matching(async (req: Parameters<typeof recorded>[0]) => !!(await recorded(req))).thenCallback(async (req: Parameters<typeof recorded>[0]) => {
            const entry = (await recorded(req))!;
            count.replayed++;
            count.passed--;
            const c = entry.response.content;
            return { statusCode: entry.response.status, headers: { 'content-type': c.mimeType }, rawBody: Buffer.from(c.text, c.encoding === 'base64' ? 'base64' : 'utf8') };
        });
    }
    // Replaying, what the recording lacks is worth knowing (method and path; queries may hold tokens).
    if (mode === 'replay') {
        await server.on('request', (req: { method: string; url: string }) => {
            const u = new URL(req.url);
            if (!loadedRecording?.find(req.method, req.url)) log(`not in the recording, passed on: ${req.method} ${u.host}${u.pathname}`);
        });
    }
    await server.forAnyRequest().always().thenPassThrough();

    const recorder = new Recorder();
    let dirty = false;
    if (mode === 'record') {
        const requests = new Map<string, { method: string; url: string; body?: string; type?: string }>();
        await server.on('request', async (req: { id: string; method: string; url: string; headers: Record<string, string>; body: { getText(): Promise<string | undefined> } }) => {
            requests.set(req.id, { method: req.method, url: req.url, body: (await req.body.getText()) || undefined, type: req.headers['content-type'] });
        });
        await server.on('response', async (res: { id: string; statusCode: number; headers: Record<string, string>; body: { getDecodedBuffer(): Promise<Buffer | undefined> } }) => {
            const req = requests.get(res.id);
            requests.delete(res.id);
            const body = await res.body.getDecodedBuffer().catch(() => undefined);
            if (!req || !body || body.length > MAX_BODY) return;
            const mimeType = String(res.headers['content-type'] ?? 'application/octet-stream');
            const text = /json|text|xml|javascript|graphql/.test(mimeType) ? { text: body.toString('utf8') } : { text: body.toString('base64'), encoding: 'base64' as const };
            const entry: Entry = {
                request: { method: req.method, url: req.url, ...(req.body ? { postData: { mimeType: req.type ?? '', text: req.body } } : {}) },
                response: { status: res.statusCode, content: { mimeType, ...text } },
            };
            recorder.push(entry);
            dirty = true;
        });
    }
    const save = async () => {
        if (!dirty) return;
        dirty = false;
        await recorder.save(file);
    };
    const timer = setInterval(() => void save(), 2000);
    await server.start(port);
    log(`data proxy (${mode}) on 127.0.0.1:${port}, ${mode === 'record' ? 'recording into' : 'replaying'} ${file}`);
    await new Promise<void>(resolve => {
        const stop = () => resolve();
        process.once('SIGTERM', stop);
        process.once('SIGINT', stop);
    });
    clearInterval(timer);
    await save();
    await server.stop();
    log(`data proxy stopped: ${count.replayed} answered from the recording, ${count.passed} passed on to the backend${mode === 'record' ? `, ${recorder.size} answers recorded` : ''}`);
}

/** The environment a dev server needs for its own requests to go through the proxy. */
export function proxyEnv(state: { port: number; ca: string }): Record<string, string> {
    const url = `http://127.0.0.1:${state.port}`;
    return {
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
        http_proxy: url,
        https_proxy: url,
        NO_PROXY: 'localhost,127.0.0.1,::1',
        no_proxy: 'localhost,127.0.0.1,::1',
        // Node's own fetch and http use the variables above only when told to (Node 22.21+ / 24.5+).
        NODE_USE_ENV_PROXY: '1',
        NODE_EXTRA_CA_CERTS: state.ca,
    };
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function readState(root: string): ProxyState | undefined {
    const file = stateFile(root);
    if (!fs.existsSync(file)) return undefined;
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as ProxyState;
    if (alive(state.pid)) return state;
    fs.rmSync(file);
    return undefined;
}

const listening = (port: number) => new Promise<boolean>(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => { socket.end(); resolve(true); });
    socket.on('error', () => resolve(false));
});

/** Starts the proxy in the background. Returns its state; one proxy per project at a time. */
export async function startProxy({ root, mode, file, port = 8899 }: { root: string; mode: ProxyMode; file: string; port?: number }): Promise<ProxyState> {
    const running = readState(root);
    if (running) throw new Error(`A data proxy is already running (${running.mode}, port ${running.port}): stop it first`);
    if (mode === 'replay') loadRecording(file); // says so now if there is nothing to replay
    if (await listening(port)) throw new Error(`Port ${port} is taken: pass another port`);
    const { certPath } = await authority(root);
    const log = path.join(root, '.redlines', 'data-proxy.log');
    const out = fs.openSync(log, 'a');
    const child = spawn(process.execPath, [path.join(PACKAGE_ROOT, 'dist', 'bin', 'redlines.js'), '__data_proxy', mode, file, String(port)], { cwd: root, detached: true, stdio: ['ignore', out, out] });
    child.unref();
    const state: ProxyState = { pid: child.pid!, port, mode, file, ca: certPath, log };
    for (let i = 0; i < 60 && !(await listening(port)); i++) {
        if (!alive(state.pid)) throw new Error(`The data proxy did not start: see ${log}`);
        await new Promise(r => setTimeout(r, 250));
    }
    if (!(await listening(port))) throw new Error(`The data proxy did not start within 15 s: see ${log}`);
    fs.writeFileSync(stateFile(root), JSON.stringify(state, null, 1));
    return state;
}

/** Stops the running proxy (it saves its recording first). */
export async function stopProxy(root: string): Promise<(ProxyState & { said?: string }) | undefined> {
    const state = readState(root);
    if (!state) return undefined;
    process.kill(state.pid, 'SIGTERM');
    for (let i = 0; i < 80 && alive(state.pid); i++) await new Promise(r => setTimeout(r, 250));
    if (alive(state.pid)) process.kill(state.pid, 'SIGKILL');
    fs.rmSync(stateFile(root), { force: true });
    // Its last word: how many it answered and passed on.
    const said = fs.existsSync(state.log) ? fs.readFileSync(state.log, 'utf8').trim().split('\n').filter(l => l.startsWith('data proxy stopped')).pop() : undefined;
    return { ...state, said };
}

export const proxyStatus = readState;
