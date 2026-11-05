import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, ChatApi, initialRun, reduceRun } from '../public/core.js';
import { ConfigReview, historyForStorage, reviewReference } from '../public/config-review.js';

const card = () => ({ kind: 'configProposal', version: 3, workflowId: 'wf', runId: 'r1', proposalId: 'p1',
  revision: 1, reviewVersion: 1, candidateHash: 'hash1', reviewState: 'Ready', executionAllowed: true,
  capabilities: { accept: true, editContent: true, editRollback: true, try: true, reviseByChat: true },
  targets: [7, 8].map(deviceId => ({ deviceId, deviceName: `sw${deviceId}`, deploy: `hostname new${deviceId}\n`,
    rollback: `hostname old${deviceId}\n`, pairHash: `pair${deviceId}`, canTry: true, canEditRollback: true })) });
function harness(handler = () => {}) {
  let current = card(); const calls = [], metadata = [];
  const api = { async request(path, options = {}) {
    calls.push({ path, ...structuredClone(options) });
    if (path.includes('/config-workflows/')) return { workflowId: 'wf', current: structuredClone(current), revisions: [] };
    return handler(path, options);
  }, async getResponse(id) { calls.push({ path: `/api/chat/runs/${id}/response` }); return { text: 'AI giải thích, không tạo revision.' }; } };
  const review = new ConfigReview(api, structuredClone(current), { onChange: m => metadata.push(m) });
  return { review, calls, metadata, setCurrent: value => { current = value; } };
}
const receipt = (kind, extra = {}) => ({ operationId: 'op', workflowId: 'wf', runId: 'r1', kind,
  status: 'Succeeded', ...extra });

test('actual workflow wire omits the polymorphic kind discriminator but retains all review references', async () => {
  const current = card(); delete current.kind;
  const review = new ConfigReview({ async request() { return { workflowId: 'wf', current, revisions: [] }; } }, card());
  await review.refresh();
  assert.equal(review.refreshError, ''); assert(review.canEdit); assert(review.canAccept); assert(review.canTry(7));
  assert.equal(review.card.kind, 'configProposal');
});

test('known workflow DTO type never supplies missing hashes/permissions or accepts an unexpected discriminator', async () => {
  for (const patch of [{ candidateHash: null }, { reviewVersion: null }, { kind: 'artifact' }, { version: 99 }]) {
    const current = { ...card(), ...patch };
    const review = new ConfigReview({ async request() { return { workflowId: 'wf', current }; } }, card());
    await review.refresh(); assert(review.refreshError); assert(!review.canEdit); assert(!review.canAccept);
  }
  const current = card(); delete current.kind; current.capabilities = {};
  const review = new ConfigReview({ async request() { return { workflowId: 'wf', current }; } }, card());
  await review.refresh(); assert(!review.refreshError); assert(!review.canEdit); assert(!review.canTry(7)); assert(!review.canAccept);
});

test('rollback-only save sends exact complete pair and hydrates authoritative revision without an Agent prompt', async () => {
  const h = harness((path, { body }) => {
    assert(path.endsWith('/revisions')); assert.equal(body.mode, 'content');
    assert.deepEqual(body.changes, [{ deviceId: 7, deploy: 'hostname new7\n', rollback: '  hostname cũ 🌐\n\n' }]);
    const updated = card(); Object.assign(updated, { runId: 'r2', proposalId: 'p2', revision: 2, reviewVersion: 2, candidateHash: 'hash2' });
    updated.targets[0].rollback = body.changes[0].rollback; h.setCurrent(updated);
    return receipt('revision', { result: { status: 'Published', proposal: { runId: 'r2', proposalId: 'p2', revision: 2 } } });
  });
  h.review.edit(7, 'rollback', '  hostname cũ 🌐\n\n');
  await h.review.save();
  assert.equal(h.review.card.runId, 'r2'); assert.equal(h.review.card.candidateHash, 'hash2'); assert(!h.review.dirty);
  assert.equal(h.calls.filter(c => c.method === 'POST').length, 1); assert(h.calls.every(c => !/prompts|\/try|\/approve/.test(c.path)));
  assert(!JSON.stringify(h.metadata).includes('hostname')); h.review.dispose();
});

test('Save one target keeps other unsaved pairs on the new confirmed revision; Save all is atomic', async () => {
  const h = harness((path, { body }) => {
    const updated = structuredClone(h.review.card); updated.proposalId = 'p2'; updated.runId = 'r2'; updated.revision++;
    for (const change of body.changes) Object.assign(updated.targets.find(t => t.deviceId === change.deviceId), change);
    h.setCurrent(updated);
    return receipt('revision', { result: { status: 'Published', proposal: { runId: 'r2', proposalId: 'p2', revision: 2 } } });
  });
  h.review.edit(7, 'deploy', 'changed7\n'); h.review.edit(8, 'rollback', 'changed8\n');
  await h.review.save([7]); assert(h.review.drafts.has(8)); assert(!h.review.latest); assert.equal(h.review.card.proposalId, 'p2');
  await h.review.save(); assert(!h.review.dirty);
  assert.deepEqual(h.calls.filter(c => c.method === 'POST').map(c => c.body.changes.map(i => i.deviceId)), [[7], [8]]);
});

test('dirty edits block all Try/Accept; empty rollback remains savable', async () => {
  const h = harness(() => receipt('revision', { result: { status: 'Unchanged', proposal: { runId: 'r1', proposalId: 'p1', revision: 1 } } }));
  h.review.edit(7, 'rollback', ''); await h.review.tryDevices([8]); await h.review.accept();
  assert.equal(h.calls.length, 0); assert.equal(h.review.canAccept, false);
  await h.review.save(); assert.equal(h.calls[0].body.changes[0].rollback, '');
});

test('CRLF-only change is a local no-op; other CLI whitespace stays significant', () => {
  const h = harness(); h.review.edit(7, 'deploy', 'hostname new7\r\n'); assert(!h.review.dirty);
  h.review.edit(7, 'deploy', ' hostname new7\n'); assert(h.review.dirty);
});

for (const status of [400, 409, 413, 429]) test(`HTTP ${status} keeps both editor fields and permits explicit correction`, async () => {
  const h = harness(() => { throw new ApiError('REVIEW_CONFLICT', status); });
  h.review.edit(7, 'deploy', 'user config\n'); h.review.edit(7, 'rollback', 'user rollback\n'); await h.review.save();
  assert.equal(h.review.pair(7).deploy, 'user config\n'); assert.equal(h.review.pair(7).rollback, 'user rollback\n');
  assert(!h.review.attempt); assert(h.review.canEdit); assert.equal(h.calls.length, 1);
});

test('lost Save receipt retries the frozen payload/key only, and double click never starts another request', async () => {
  let count = 0;
  const h = harness(() => { if (!count++) throw new Error('lost receipt'); return receipt('revision', { result: { status: 'Unchanged' } }); });
  h.review.edit(7, 'deploy', 'user\n'); await h.review.save();
  assert(h.review.attempt); const frozen = structuredClone(h.review.attempt);
  await h.review.save(); assert.equal(h.calls.length, 1); h.review.edit(7, 'deploy', 'must not replace in-flight bytes');
  await h.review.retryReceipt();
  assert.deepEqual(h.calls[0].body, h.calls[1].body); assert.deepEqual(h.calls[1].body, frozen.body);
  assert(h.metadata.some(m => m.unconfirmedSave)); assert(!JSON.stringify(h.metadata).includes('user\\n'));
});

test('lost Try receipt survives reload without CLI and replays only on explicit user action', async () => {
  const h = harness(() => { throw new Error('network'); });
  await h.review.tryDevices([7]); const stored = h.review.metadata();
  assert(!JSON.stringify(stored).includes('hostname'));
  const calls = [], r = new ConfigReview({ ...h.review.api, async request(path, opts) {
    calls.push({ path, ...opts }); if (!opts?.method) return { workflowId: 'wf', current: card() };
    return receipt('try');
  } }, card(), { metadata: stored });
  await r.refresh(); assert(calls.every(c => !c.method));
  await r.retryReceipt(); assert.deepEqual(calls.find(c => c.method === 'POST').body, h.calls[0].body);
  r.dispose(); h.review.dispose();
});

test('new head never rebases dirty edits or auto-accepts; user explicitly chooses new head', async () => {
  const h = harness(); h.review.edit(7, 'rollback', 'my draft');
  const updated = card(); updated.proposalId = 'p2'; updated.revision = 2; updated.candidateHash = 'hash2'; h.setCurrent(updated);
  await h.review.refresh(); assert.equal(h.review.card.proposalId, 'p1'); assert.equal(h.review.latest.proposalId, 'p2');
  await h.review.accept(); assert.equal(h.calls.filter(c => c.method).length, 0); assert.equal(h.review.pair(7).rollback, 'my draft');
  h.review.useLatest(); assert.equal(h.review.card.proposalId, 'p2'); assert(!h.review.dirty);
});

test('Try uses only IDs/references; Accept posts one full-batch command and no client CREATE', async () => {
  const h = harness((path) => receipt(path.endsWith('/try') ? 'try' : 'accept'));
  await h.review.tryDevices([8, 7, 7]); await h.review.accept();
  const posts = h.calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body.deviceIds, [8, 7]); assert(!('changes' in posts[0].body));
  assert.deepEqual(Object.keys(posts[1].body).sort(), [...Object.keys(reviewReference(card())), 'idempotencyKey'].sort());
  assert.notEqual(posts[0].body.idempotencyKey, posts[1].body.idempotencyKey);
});

test('known failure permits a new explicit Accept on the same revision with updated reviewVersion and new key', async () => {
  const h = harness(() => receipt('accept', { status: 'Failed', error: { code: 'TRY_VALIDATION_FAILED' } }));
  const updated = card(); updated.reviewVersion = 3; h.setCurrent(updated);
  await h.review.accept(); assert(h.review.canAccept); await h.review.accept();
  const posts = h.calls.filter(c => c.method === 'POST'); assert.equal(posts[1].body.expectedRevision, 1);
  assert.equal(posts[1].body.expectedReviewVersion, 3); assert.notEqual(posts[0].body.idempotencyKey, posts[1].body.idempotencyKey);
});

test('polling exposes per-device diagnostics, and Unknown cannot be replayed or treated as a known failure', async () => {
  const h = harness(() => receipt('try', { status: 'OutcomeUnknown', error: { code: 'TRY_OUTCOME_UNKNOWN' },
    items: [{ deviceId: 7, pairHash: 'pair7', status: 'Unknown', stage: 'TRY' }] }));
  h.review.active = true; h.review.operationId = 'op'; await h.review.poll();
  assert(h.review.unknown); assert.equal(h.review.operation.items[0].status, 'Unknown');
  await h.review.accept(); await h.review.tryDevices([7]); await h.review.reconcile();
  assert(h.calls.every(c => !c.method)); h.review.dispose();
});

test('CREATE Unknown only enables reconcile endpoint, never approve or a second CREATE', async () => {
  const h = harness(() => receipt('accept', { status: 'OutcomeUnknown', error: { code: 'CREATE_OUTCOME_UNKNOWN' } }));
  h.review.active = true; h.review.operationId = 'op'; await h.review.poll(); await h.review.accept(); await h.review.reconcile();
  const posts = h.calls.filter(c => c.method); assert.equal(posts.length, 1); assert(posts[0].path.endsWith('/config-setup/reconcile'));
  h.review.dispose();
});

test('V2 cards stay readable and Accept uses refs; V3-only edits/Try never downgrade', async () => {
  const h = harness(() => receipt('accept')); h.review.card.version = 2;
  h.review.edit(7, 'deploy', 'not allowed'); await h.review.tryDevices([7]); assert(!h.review.dirty); assert.equal(h.calls.length, 0);
  await h.review.accept(); assert.equal(h.calls[0].body.expectedCandidateHash, 'hash1');
  assert.throws(() => reviewReference({ ...card(), reviewVersion: null }));
});

test('optional AI instruction is explicit, exact-parent-bound; NoRevision preserves card and shows the answer', async () => {
  const h = harness(() => receipt('revision', { runId: 'ai-run', result: { status: 'NoRevision' } }));
  await h.review.revise('Giải thích rollback');
  assert.equal(h.calls[0].body.mode, 'instruction'); assert.equal(h.calls[0].body.proposalId, 'p1');
  assert.equal(h.review.card.proposalId, 'p1'); assert.equal(h.review.agentReply, 'AI giải thích, không tạo revision.');
});

test('persisted history excludes saved CLI, prose containing CLI, diff, SSE fragments and local buffers', () => {
  const c = card(), value = { conversations: [{ messages: [{ state: { text: 'PRIVATE_CONFIG_PROSE', blocks: [c], events: [{ text: 'PRIVATE_CONFIG_EVENT' }] } }] }] };
  const encoded = historyForStorage(value); assert(!/hostname|PRIVATE_CONFIG|pair7/.test(encoded));
  const state = JSON.parse(encoded).conversations[0].messages[0].state;
  assert(state.blocks[0].needsHydration); assert.equal(state.blocks[0].workflowId, 'wf'); assert.equal(c.targets.length, 2);
});

test('config.review.updated is a reference-only invalidation and does not replace model text or dispatch a command', () => {
  const state = reduceRun(initialRun('s', 'r'), { version: 2, kind: 'config.review.updated', sequence: 1, sessionId: 's', runId: 'r',
    review: { workflowId: 'wf', reviewVersion: 5, deploy: 'PRIVATE_CLI' } });
  assert.deepEqual(state.reviewUpdate, { workflowId: 'wf', reviewVersion: 5 }); assert(!JSON.stringify(state).includes('PRIVATE_CLI'));
});

test('all new review paths retain owner auth through the existing API client', async () => {
  const calls = [], c = card();
  const api = new ChatApi('/backend/dsh', { 'X-Demo-User': 'owner' }, async (url, options) => {
    calls.push({ url, ...options }); return new Response(JSON.stringify(url.includes('config-workflows')
      ? { workflowId: 'wf', current: c } : receipt('try')));
  });
  const review = new ConfigReview(api, c); await review.tryDevices([7]);
  assert(calls.every(c => c.headers['X-Demo-User'] === 'owner' && c.credentials === 'include'));
});

test('a request racing refresh queues another authoritative GET before enabling mutation', async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; }); let count = 0;
  const r = new ConfigReview({ async request() {
    const c = card(); if (++count === 1) await waiting;
    if (count > 1) c.reviewVersion = 5;
    return { workflowId: 'wf', current: c };
  } }, card());
  const first = r.refresh(), second = r.refresh(); assert(r.loading); release();
  await Promise.all([first, second]); assert.equal(count, 2); assert.equal(r.card.reviewVersion, 5); assert(r.canAccept);
});

test('in-flight chat locks config mutation and stale workflow refresh never enables it', async () => {
  const h = harness(); h.review.externalBusy = true;
  h.review.edit(7, 'rollback', 'no'); await h.review.save(); await h.review.tryDevices([7]); await h.review.accept();
  assert(!h.review.dirty); assert.equal(h.calls.length, 0);
});

test('switch/dispose drops private CLI buffers and an old read cannot update the new scope', async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; }); let notifications = 0;
  const c = card(), r = new ConfigReview({ async request() { await waiting; return { workflowId: 'wf', current: c }; } }, c,
    { onChange: () => notifications++ });
  r.edit(7, 'rollback', 'PRIVATE_LOCAL_BUFFER'); const read = r.refresh(); r.dispose(); const before = notifications;
  release(); await read;
  assert.equal(notifications, before); assert(!r.dirty); assert.equal(r.active, false);
});

test('completed operation remains manually readable and does not leave the progress button busy', async () => {
  const h = harness(() => receipt('try')); h.review.active = true; h.review.operationId = 'op';
  await h.review.poll(); assert.equal(h.review.reading, false); assert(h.review.canAccept); h.review.dispose();
});

test('V2 server without new workflow endpoint falls back to its canonical response; V3 does not downgrade', async () => {
  const c = { ...card(), version: 2 };
  const api = { async request() { throw new ApiError('not found', 404); },
    async getResponse() { return { presentationBlocks: [c] }; } };
  const old = new ConfigReview(api, c); await old.refresh(); assert(old.canAccept); assert(!old.refreshError);
  const modern = new ConfigReview(api, card()); await modern.refresh(); assert(!modern.canAccept); assert(modern.refreshError);
});

test('restored receipt retries cannot carry CLI, internal routes or arbitrary methods from browser storage', () => {
  for (const attempt of [
    { kind: 'accept', path: '/api/chat/runs/r1/config-setup/create', body: { ...reviewReference(card()), idempotencyKey: 'key' } },
    { kind: 'try', path: '/api/chat/runs/r1/try', body: { ...reviewReference(card()), idempotencyKey: 'key', deviceIds: [7], deploy: 'CLI' } },
    { kind: 'save', path: '/api/chat/runs/r1/revisions', body: { changes: [{ deploy: 'CLI' }] } },
  ]) assert(!new ConfigReview({}, card(), { metadata: { attempt } }).attempt);
});
