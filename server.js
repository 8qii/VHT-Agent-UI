import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(fileURLToPath(new URL('./public/', import.meta.url)));
const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.md': 'text/plain' };
export const targets = {
  goose: process.env.VHT_BACKEND_URL || 'http://127.0.0.1:5062',
  dsh: process.env.VHT_DSH_BACKEND_URL || 'http://127.0.0.1:5062',
};
for (const value of Object.values(targets)) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Backend URL must be an HTTP(S) origin without credentials.');
  }
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (url.pathname === '/ui-config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ targets }));
      return;
    }
    const proxy = url.pathname.match(/^\/backend\/(goose|dsh)(\/api\/chat(?:\/.*)?|\/health\/ready)$/);
    if (proxy) {
      // Browser supplies owner authentication. Never read the workspace's private env.
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
        res.writeHead(403); res.end('Cross-origin proxy access denied'); return;
      }
      const target = new URL(targets[proxy[1]]);
      target.pathname = target.pathname.replace(/\/$/, '') + proxy[2];
      target.search = url.search;
      const headers = {};
      for (const key of ['accept', 'content-type', 'authorization', 'x-demo-user', 'cookie', 'if-none-match']) {
        if (req.headers[key]) headers[key] = req.headers[key];
      }
      const transport = target.protocol === 'https:' ? https : http;
      const upstream = transport.request(target, { method: req.method, headers }, response => {
        const out = {};
        for (const key of ['content-type', 'content-disposition', 'content-length', 'etag', 'retry-after']) {
          if (response.headers[key]) out[key] = response.headers[key];
        }
        res.writeHead(response.statusCode, { ...out, 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
        res.flushHeaders();
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      upstream.on('error', () => {
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Không kết nối được backend. Kiểm tra URL và khởi động stack đã chọn.' }));
      });
      // Closing a browser stream disconnects transport; it does not POST cancellation.
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    try {
      const pathname = decodeURIComponent(url.pathname);
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': mime[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self' http: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404); res.end('Not found');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 5173);
  createServer().listen(port, host, () => console.log(`VHT Agent UI: http://${host}:${port}`));
}
