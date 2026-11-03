// An app behind a login, for the tests: every page but /login needs the session cookie; /login sets
// it when the form is sent with the right password.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export function loginApp(password: string): Promise<{ base: string; close: () => void }> {
    const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>${body}</body></html>`;
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://x');
            const loggedIn = /(^|;\s*)session=ok/.test(req.headers.cookie ?? '');
            if (url.pathname === '/login' && req.method === 'POST') {
                let body = '';
                req.on('data', c => (body += c));
                req.on('end', () => {
                    const ok = new URLSearchParams(body).get('password') === password;
                    res.writeHead(303, { location: ok ? '/' : '/login', ...(ok ? { 'set-cookie': 'session=ok; Path=/; HttpOnly' } : {}) });
                    res.end();
                });
                return;
            }
            if (url.pathname === '/login') {
                res.writeHead(200, { 'content-type': 'text/html' });
                res.end(page('<form method="post"><input name="password" type="password" aria-label="Password"><button>Log in</button></form>'));
                return;
            }
            if (!loggedIn) { res.writeHead(302, { location: '/login' }); res.end(); return; }
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end(page('<main><h1>Dashboard</h1><p>Only for people who logged in.</p></main>'));
        });
        server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }));
    });
}
