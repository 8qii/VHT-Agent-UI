import test from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser, consumeSse, initialRun, reduceRun, statusName, isTerminal, ChatApi, observeRun, artifactPath, allowedAction, randomId } from '../public/core.js';
test('HTTP-origin UUID fallback uses secure random bytes and correct v4 bits', () => {
  const ids = new Set();
  const provider = { getRandomValues: bytes => crypto.getRandomValues(bytes) };
  for (let i = 0; i < 100; i++) { const id = randomId(provider); assert.match(id, /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/); ids.add(id); }
  assert.equal(ids.size, 100);
});

test('SSE framing tolerates CR/LF/CRLF split anywhere, multiline data and heartbeats', () => {
  const frames = [], parser = createSseParser(frame => frames.push(frame));
  const wire = ': heartbeat\r\nevent: snapshot\r\ndata: {"a":1,\r\ndata: "b":2}\r\n\r\nevent: assistant.text\ndata: second\n\n';
  for (const char of wire) parser.feed(char);
  assert.deepEqual(frames, [{ name: 'snapshot', data: '{"a":1,\n"b":2}' }, { name: 'assistant.text', data: 'second' }]);
});
test('UTF-8 is decoded incrementally, including Vietnamese split at byte boundaries', async () => {
  const bytes = new TextEncoder().encode('event: assistant.text\ndata: {"kind":"assistant.text","text":"Thiết bị đã kết nối 🌐"}\n\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const events = [];
  await consumeSse(new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), event => events.push(event));
  assert.equal(events[0].text, 'Thiết bị đã kết nối 🌐');
});
test('reducer resets snapshot, appends/replaces generations and preserves nullable status', () => {
  let state = initialRun('session', 'run');
  const event = (kind, sequence, fields = {}) => ({ version: 2, sessionId: 'session', runId: 'run', kind, sequence, ...fields });
  state = reduceRun(state, event('snapshot', 1, { text: 'persisted', status: 'Running' }));
  state = reduceRun(state, event('assistant.text', 2, { operation: 'replace', text: 'A', provisional: true, status: null }));
  state = reduceRun(state, event('assistant.text', 3, { operation: 'append', text: 'B', provisional: true }));
  assert.equal(state.text, 'AB'); assert.equal(state.status, 'Running');
  state = reduceRun(state, event('agent.progress', 4, { activity: 'running', activityState: 'completed', label: '<script>safe label</script>' }));
  assert.equal(state.text, 'AB'); assert.equal(state.progress[0].state, 'completed');
  state = reduceRun(state, event('assistant.text', 5, { operation: 'replace', text: 'canonical', provisional: false }));
  assert.equal(state.text, 'canonical'); assert.equal(state.provisional, false);
  state = reduceRun({ ...state, sequence: 0 }, event('snapshot', 1, { text: null, status: 'WaitingConfirmation' }));
  assert.equal(state.text, ''); assert.equal(state.terminal, false);
});
test('reducer rejects cross-run events, duplicate sequence and unknown wire versions', () => {
  const state = initialRun('s', 'r'), event = { version: 2, sessionId: 's', runId: 'r', kind: 'snapshot', sequence: 1 };
  assert.throws(() => reduceRun(state, { ...event, runId: 'other' }), /MISMATCHED/);
  assert.throws(() => reduceRun(state, { ...event, version: 3 }), /UNSUPPORTED/);
  assert.throws(() => reduceRun({ ...state, sequence: 1 }, event), /SEQUENCE/);
});
test('REST lifecycle names are normalized and uncertain/waiting/executing remain nonterminal', () => {
  assert.equal(statusName(6), 'Completed'); assert.equal(statusName(10), 'Interrupted');
  for (const status of [0, 1, 2, 3, 5, 'Uncertain', 'WaitingConfirmation', 'Executing']) assert.equal(isTerminal(status), false);
  for (const status of [4, 6, 7, 8, 9, 10]) assert.equal(isTerminal(status), true);
});
test('a submission retry preserves exact text/key/owner and sends no capability selection', async () => {
  const requests = []; const client = new ChatApi('/backend/goose', { 'X-Demo-User': 'owner' }, async (url, options) => {
    requests.push({ url, ...options }); return new Response(JSON.stringify({ id: 'run', sessionId: 'session' }), { status: 202 });
  });
  const pending = { text: 'What is BGP?', key: 'stable-key' };
  assert.equal((await client.submit('session', pending)).id, 'run'); await client.submit('session', pending);
  assert.equal(requests[0].body, requests[1].body);
  assert.deepEqual(JSON.parse(requests[0].body), { text: pending.text, idempotencyKey: 'stable-key' });
  assert.equal(requests[0].headers['X-Demo-User'], 'owner'); assert(!requests[0].url.includes('owner'));
});
test('artifact and action paths only accept the documented endpoint for the current run', () => {
  const id = '00000000-0000-0000-0000-000000000001';
  assert.equal(artifactPath(`/api/chat/artifacts/${id}/download`), `/api/chat/artifacts/${id}/download`);
  for (const url of ['https://evil.test/report', '//evil.test', '/internal/export', 'javascript:alert(1)']) assert.equal(artifactPath(url), null);
  assert(allowedAction({ id: 'approve', method: 'POST', url: '/api/chat/runs/r/approve' }, 'r'));
  assert(!allowedAction({ id: 'approve', method: 'POST', url: '/api/chat/runs/other/approve' }, 'r'));
  assert(!allowedAction({ id: 'apply', method: 'POST', url: '/internal/config/apply' }, 'r'));
});
test('terminal snapshot hydrates canonical text and run authority without POST or provenance', async () => {
  const methods = [], states = []; let calls = 0;
  const client = new ChatApi('/backend/dsh', { Authorization: 'Bearer fake' }, async (url, options) => {
    methods.push([url, options.method]);
    if (url.endsWith('/events')) return new Response('event: snapshot\ndata: {"version":2,"kind":"snapshot","sessionId":"s","runId":"r","sequence":1,"terminal":true,"status":"Completed","text":"draft"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    if (url.endsWith('/response')) return new Response(JSON.stringify({ text: 'canonical', presentationBlocks: [{ kind: 'future', version: 99 }], provenance: { private: true } }));
    return new Response(JSON.stringify({ status: calls++ ? 6 : 1 }));
  });
  await observeRun(client, initialRun('s', 'r'), state => states.push(state), new AbortController().signal);
  assert.equal(states.at(-1).text, 'canonical'); assert.equal(states.at(-1).status, 'Completed'); assert.equal(states.at(-1).hydrated, true);
  assert(methods.every(([url, method]) => method === 'GET' && !url.includes('provenance')));
});
test('401 stops recovery instead of retrying an unauthorized stream', async () => {
  let calls = 0; const client = new ChatApi('/backend/goose', {}, async () => { calls++; return new Response('{}', { status: 401 }); });
  let last;
  await observeRun(client, initialRun('s', 'r'), state => { last = state; }, new AbortController().signal);
  assert.equal(calls, 1); assert.equal(last.connection, 'error'); assert.equal(last.status, 'Pending');
});
test('event journal bounds public text/count and excludes unknown private fields across connections', () => {
  let state = { ...initialRun('s', 'r'), connectionIndex: 1 };
  for (let i = 1; i <= 220; i++) state = reduceRun(state, { version: 2, sessionId: 's', runId: 'r', sequence: i, kind: 'assistant.text', operation: 'replace', text: 'x'.repeat(2000), provisional: true, arguments: 'PRIVATE_EVENT_SECRET', claims: [{ raw: 'PRIVATE_CLAIMS' }] });
  assert.equal(state.events.length, 200); assert.equal(state.eventCount, 220); assert.equal(state.events[0].sequence, 21);
  assert.equal(state.events.at(-1).text.length, 1000); assert.equal(state.events.at(-1).textCharacters, 2000); assert.equal(state.events.at(-1).textTruncated, true);
  assert(!JSON.stringify(state.events).includes('PRIVATE'));
  state = reduceRun({ ...state, sequence: 0, connectionIndex: 2 }, { version: 2, sessionId: 's', runId: 'r', sequence: 1, kind: 'snapshot', text: null, status: 'Running' });
  assert.equal(state.eventCount, 221); assert.equal(state.events.at(-1).connection, 2); assert.equal(state.events.at(-1).sequence, 1);
});
test('explicit stream read of completed run captures snapshot without resubmitting', async () => {
  const calls = []; let final;
  const client = new ChatApi('/backend/goose', {}, async (url, options) => {
    calls.push([url, options.method]);
    if (url.endsWith('/events')) return new Response('event: snapshot\ndata: {"version":2,"kind":"snapshot","sessionId":"s","runId":"r","sequence":1,"status":"Completed","terminal":true,"text":"persisted"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify(url.endsWith('/response') ? { text: 'canonical' } : { status: 6 }));
  });
  await observeRun(client, { ...initialRun('s', 'r'), status: 'Completed' }, state => { final = state; }, new AbortController().signal, { streamFirst: true });
  assert(calls[0][0].endsWith('/events')); assert(calls.every(([, method]) => method === 'GET'));
  assert.equal(final.events[0].kind, 'snapshot'); assert.equal(final.eventCount, 1); assert.equal(final.text, 'canonical'); assert.equal(final.connection, 'closed');
});
