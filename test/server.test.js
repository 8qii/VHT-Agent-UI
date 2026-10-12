import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, targets } from '../server.js';

test('local proxy forwards auth, streams incrementally and rejects cross-origin writes', async () => {
  const calls = [];
  const backend = http.createServer((req, res) => {
    calls.push({ path: req.url, user: req.headers['x-demo-user'], auth: req.headers.authorization });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();
    res.write(': heartbeat\n\n'); setTimeout(() => res.end('event: snapshot\ndata: {}\n\n'), 100);
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const before = targets.goose; targets.goose = `http://127.0.0.1:${backend.address().port}`;
  const ui = createServer(); await new Promise(resolve => ui.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${ui.address().port}`;
  try {
    const response = await fetch(base + '/backend/goose/api/chat/runs/r/events', { headers: { 'X-Demo-User': 'fixture-owner', Authorization: 'Bearer fixture-token' } });
    const reader = response.body.getReader(); const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), ': heartbeat\n\n');
    assert.equal(calls[0].user, 'fixture-owner'); assert.equal(calls[0].auth, 'Bearer fixture-token'); assert.equal(calls[0].path, '/api/chat/runs/r/events'); await reader.cancel();
    const denied = await fetch(base + '/backend/goose/api/chat/sessions', { method: 'POST', headers: { Origin: 'https://other.test' }, body: '{}' });
    assert.equal(denied.status, 403); assert.equal(calls.length, 1);
    assert.equal((await fetch(base + '/backend/goose/internal/config')).status, 404);
    const html = await fetch(base); assert.equal(html.status, 200); assert(html.headers.get('content-security-policy').includes("object-src 'none'"));
  } finally { targets.goose = before; ui.closeAllConnections(); backend.closeAllConnections(); await Promise.all([new Promise(resolve => ui.close(resolve)), new Promise(resolve => backend.close(resolve))]); }
});
