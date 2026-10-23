import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, targets } from '../server.js';

test('proxy forwards library uploads with Idempotency-Key and multipart body', async () => {
  const calls = [];
  const backend = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => { calls.push({ path: req.url, method: req.method, key: req.headers['idempotency-key'], type: req.headers['content-type'], body }); res.writeHead(201, { 'Content-Type': 'application/json', Location: '/api/library/files/x' }); res.end('{"file":{"id":"x"}}'); });
  });
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const before = targets.goose; targets.goose = `http://127.0.0.1:${backend.address().port}`;
  const ui = createServer(); await new Promise(resolve => ui.listen(0, '127.0.0.1', resolve));
  try {
    const form = new FormData(); form.append('file', new File(['hello'], 'a.pdf', { type: 'application/pdf' }));
    const response = await fetch(`http://127.0.0.1:${ui.address().port}/backend/goose/api/library/uploads`, { method: 'POST', headers: { 'Idempotency-Key': 'k-1' }, body: form });
    assert.equal(response.status, 201); assert.equal(response.headers.get('location'), '/api/library/files/x');
    assert.equal(calls[0].path, '/api/library/uploads'); assert.equal(calls[0].key, 'k-1');
    assert.match(calls[0].type, /^multipart\/form-data; boundary=/); assert.match(calls[0].body, /filename="a.pdf"/);
  } finally { targets.goose = before; ui.closeAllConnections(); backend.closeAllConnections(); await Promise.all([new Promise(r => ui.close(r)), new Promise(r => backend.close(r))]); }
});
