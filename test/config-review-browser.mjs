import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, targets } from '../server.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const runs = new Map(), workflows = new Map(), operations = new Map(), receipts = new Map();
const posts = [], auth = [], checks = [], errors = [], timers = new Set();
let saveError = 0, loseReceipt = false, failNext = false, unknownNext = false, holdNext = false, createCount = 0;
const later = (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); };
const json = (res, value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const makeCard = (run, version = 3, count = 2) => ({ kind: 'configProposal', version, workflowId: crypto.randomUUID(),
  runId: run.id, proposalId: crypto.randomUUID(), revision: 1, reviewVersion: 1, candidateHash: 'a'.repeat(64),
  summary: 'Đổi hostname cho các thiết bị đã chọn.', reviewState: 'Ready', status: 'WaitingConfirmation', executionAllowed: true,
  capabilities: { accept: true, editContent: true, editRollback: true, try: true, reviseByChat: true },
  targets: Array.from({ length: count }, (_, i) => ({ deviceId: i + 7, deviceName: `sw${i + 7}`,
    deploy: `hostname NEW-${i + 7}\n`, rollback: `hostname OLD-${i + 7}\n`, pairHash: `pair-${i + 7}-r1`,
    canTry: true, canEditRollback: true, diff: [`+ hostname NEW-${i + 7}`], baselineStatus: 'available', rollbackStatus: 'known' })),
  targetCoverage: { requestedCount: count, executableCount: count, unchangedCount: 0, blockedCount: 0, complete: true }, warnings: [] });
function idle(card) {
  card.pendingOperation = null; card.reviewState = 'Ready'; card.reviewVersion++;
  card.capabilities = { accept: card.targets.every(t => t.rollback.trim()), editContent: true, editRollback: true, try: true, reviseByChat: true };
  card.targets.forEach(t => { t.canTry = !!t.rollback.trim(); t.canEditRollback = true; });
  card.executionAllowed = card.capabilities.accept;
}
const fixture = http.createServer(async (req, res) => {
  auth.push(req.headers['x-demo-user'] || '');
  let raw = ''; for await (const chunk of req) raw += chunk;
  const data = raw ? JSON.parse(raw) : null, url = new URL(req.url, 'http://fixture');
  if (req.method === 'POST') posts.push({ path: url.pathname, body: data });
  if (url.pathname === '/health/ready') return json(res, { status: 'ready' });
  if (url.pathname === '/api/chat/sessions') return json(res, { id: crypto.randomUUID() }, 201);
  const prompt = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/prompts$/);
  if (prompt) {
    const run = { id: crypto.randomUUID(), sessionId: prompt[1], status: 3, text: 'Đây là lời giải thích tự nhiên của Agent.' };
    const c = makeCard(run, data.text === 'v2' ? 2 : 3, data.text === 'multi50' ? 50 : 2); run.card = c;
    runs.set(run.id, run); workflows.set(c.workflowId, c); return json(res, { ...run, card: undefined }, 202);
  }
  const workflow = url.pathname.match(/^\/api\/chat\/config-workflows\/([^/]+)$/);
  if (workflow) {
    const c = workflows.get(workflow[1]); if (!c) return json(res, {}, 404);
    return json(res, { workflowId: c.workflowId, current: Object.fromEntries(Object.entries(c).filter(([key]) => key !== 'kind')), revisions: [{ proposal: { proposalId: c.proposalId, runId: c.runId, revision: c.revision }, origin: c.origin || 'Agent', createdAt: '2026-11-04T10:00:00Z' }] });
  }
  const operation = url.pathname.match(/^\/api\/chat\/config-operations\/([^/]+)$/);
  if (operation) return operations.has(operation[1]) ? json(res, operations.get(operation[1])) : json(res, {}, 404);
  const path = url.pathname.match(/^\/api\/chat\/runs\/([^/]+)(.*)$/);
  if (path) {
    const run = runs.get(path[1]); if (!run) return json(res, {}, 404);
    if (!path[2]) return json(res, { id: run.id, sessionId: run.sessionId, status: run.status });
    if (path[2] === '/response') return json(res, { runId: run.id, sessionId: run.sessionId, text: run.text,
      presentationBlocks: run.card ? [run.card] : [], actions: [] });
    if (path[2] === '/activity') return json(res, { runId: run.id, spans: [], captureStatus: 'not_recorded' });
    if (path[2] === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(`event: snapshot\ndata: ${JSON.stringify({ version: 2, kind: 'snapshot', sequence: 1, sessionId: run.sessionId,
        runId: run.id, status: run.status === 4 ? 'Superseded' : 'WaitingConfirmation', terminal: run.status === 4, text: null })}\n\n`);
    }
    if (req.method === 'POST' && path[2] === '/config-setup/reconcile') {
      const c = workflows.get(run.card.workflowId), op = operations.get(c.pendingOperation.operationId);
      createCount++; op.status = 'Succeeded'; op.error = null; op.result = { status: 'Created', configSetupId: 'setup-reconciled', upstreamStatus: 'Draft' };
      c.pendingOperation = null; c.reviewState = 'Created'; return json(res, { configSetupId: 'setup-reconciled' });
    }
    if (req.method === 'POST' && ['/revisions', '/try', '/approve'].includes(path[2])) {
      const replay = receipts.get(data.idempotencyKey); if (replay) return json(res, replay);
      const c = workflows.get(run.card.workflowId);
      if (path[2] === '/revisions' && saveError) { const status = saveError; saveError = 0; return json(res, { code: 'FIXTURE_SAVE_REJECTED' }, status); }
      if (data.proposalId !== c.proposalId || data.expectedRevision !== c.revision || data.expectedCandidateHash !== c.candidateHash || data.expectedReviewVersion !== c.reviewVersion)
        return json(res, { code: 'PROPOSAL_VERSION_CONFLICT' }, 409);
      const id = crypto.randomUUID();
      if (path[2] === '/revisions') {
        if (data.mode === 'instruction') {
          const aiRun = { id: crypto.randomUUID(), sessionId: run.sessionId, status: 6, text: 'Rollback dùng lại hostname đã lưu; yêu cầu này không thay đổi cấu hình.' };
          runs.set(aiRun.id, aiRun); c.reviewVersion++;
          const op = { operationId: id, workflowId: c.workflowId, runId: aiRun.id, kind: 'revision', status: 'Succeeded', result: { status: 'NoRevision' } };
          operations.set(id, op); receipts.set(data.idempotencyKey, op); return json(res, op);
        }
        assert.equal(data.mode, 'content');
        for (const change of data.changes) assert.equal(typeof change.rollback, 'string');
        const next = structuredClone(c), nextRun = { ...run, id: crypto.randomUUID() };
        next.revision++; next.reviewVersion++; next.runId = nextRun.id; next.proposalId = crypto.randomUUID(); next.candidateHash = String(next.revision).repeat(64); next.origin = 'Content';
        for (const change of data.changes) {
          const target = next.targets.find(t => t.deviceId === change.deviceId);
          Object.assign(target, change, { pairHash: `pair-${change.deviceId}-r${next.revision}` });
          if (target.lastTry) target.lastTry.status = 'Stale';
        }
        idle(next); nextRun.card = next; run.status = 4; runs.set(nextRun.id, nextRun); workflows.set(next.workflowId, next);
        const receipt = { operationId: id, workflowId: c.workflowId, runId: nextRun.id, kind: 'revision', status: 'Succeeded',
          result: { status: 'Published', proposal: { proposalId: next.proposalId, runId: next.runId, revision: next.revision } } };
        operations.set(id, receipt); receipts.set(data.idempotencyKey, receipt);
        if (loseReceipt) { loseReceipt = false; req.socket.destroy(); return; }
        return json(res, receipt);
      }
      const kind = path[2] === '/approve' ? 'accept' : 'try';
      assert(!('changes' in data)); if (kind === 'accept') assert(!('deviceIds' in data));
      const ids = kind === 'accept' ? c.targets.map(t => t.deviceId) : data.deviceIds;
      const receipt = { operationId: id, workflowId: c.workflowId, runId: c.runId, kind, status: 'Pending',
        operationUrl: `/api/chat/config-operations/${id}` };
      const op = { ...receipt, status: 'Running', currentStage: 'Preflight', completed: 0, total: ids.length,
        items: ids.map(deviceId => ({ deviceId, pairHash: c.targets.find(t => t.deviceId === deviceId).pairHash, status: 'Queued', stage: 'Preflight', rollbackValidation: 'NotSeparatelyReported' })) };
      operations.set(id, op); receipts.set(data.idempotencyKey, receipt); c.pendingOperation = receipt; c.reviewVersion++;
      c.reviewState = kind === 'accept' ? 'Accepting' : 'Trying'; c.capabilities = {}; c.targets.forEach(t => { t.canTry = false; t.canEditRollback = false; });
      const fail = failNext, unknown = unknownNext, hold = holdNext; failNext = unknownNext = holdNext = false;
      later(() => { op.currentStage = 'TRY'; op.items[0].status = 'Dispatching'; op.items[0].stage = 'TRY'; }, 150);
      const complete = () => {
        op.items.forEach((item, index) => {
          item.status = unknown ? 'Unknown' : fail && index === 0 ? 'Failed' : 'Passed'; item.stage = 'TRY';
          item.message = item.status === 'Failed' ? 'Thiết bị từ chối candidate.' : item.status === 'Unknown' ? 'Chưa rõ kết quả upstream.' : 'TRY trả về thành công.';
          item.errorCode = item.status === 'Failed' ? 'TRY_VALIDATION_FAILED' : null;
          item.baselineFreshness = 'Unknown'; item.baselineCheckedAt = new Date().toISOString();
          c.targets.find(t => t.deviceId === item.deviceId).lastTry = { ...item, operationId: id };
        });
        op.completed = ids.length; op.currentStage = 'Finished'; op.status = unknown ? 'OutcomeUnknown' : fail ? 'Failed' : 'Succeeded';
        if (fail || unknown) op.error = { code: unknown ? kind === 'accept' ? 'CREATE_OUTCOME_UNKNOWN' : 'TRY_OUTCOME_UNKNOWN' : 'TRY_VALIDATION_FAILED', retryable: false };
        if (!fail && !unknown && kind === 'accept') {
          createCount++; op.result = { status: 'Created', configSetupId: `setup-${createCount}`, upstreamStatus: 'Draft' };
          c.pendingOperation = null; c.reviewState = 'Created'; c.capabilities = {};
        } else if (unknown) c.reviewState = 'OutcomeUnknown';
        else idle(c);
      };
      if (hold) op.complete = complete;
      else later(complete, 1700);
      if (loseReceipt) { loseReceipt = false; req.socket.destroy(); return; }
      return json(res, receipt, 202);
    }
  }
  return json(res, {}, 404);
});

await new Promise(r => fixture.listen(0, '127.0.0.1', r));
const previous = { ...targets }; targets.goose = `http://127.0.0.1:${fixture.address().port}`;
const ui = createServer(); await new Promise(r => ui.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${ui.address().port}`;
const output = new URL(`../test-results/config-review/${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
let debugPage;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1060 } }), page = await context.newPage();
  debugPage = page;
  page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  const panel = () => page.locator('.config-review').last(), target = (id = 7) => panel().locator(`.config-target[data-device-id="${id}"]`);
  const check = async (name, fn) => { await fn(); checks.push(name); console.log('PASS', name); };
  async function start(text = 'v3') {
    await page.locator('#new-chat').click(); await page.locator('#prompt').fill(text); await page.locator('#send-button').click();
    await panel().getByText('Sẵn sàng review', { exact: true }).waitFor();
    await panel().getByRole('button', { name: 'Làm mới trạng thái', exact: true }).isEnabled();
    await page.waitForFunction(() => !document.querySelector('.config-review:last-child .config-save-all')?.disabled
      || !!document.querySelector('.config-review .config-accept:not(:disabled)'));
  }
  async function edit(field, value, id = 7) {
    const label = field === 'deploy' ? 'Config' : 'Rollback config';
    const input = target(id).getByRole('textbox', { name: `${label} · sw${id}`, exact: true });
    if (!await input.count()) await target(id).getByRole('button', { name: field === 'deploy' ? '✎ Sửa config' : '✎ Sửa rollback', exact: true }).click();
    await input.fill(value); return input;
  }
  assert.equal((await page.request.get(origin + '/config-review.css')).status(), 200);
  await page.goto(origin); await page.getByText('Backend sẵn sàng', { exact: true }).waitFor();
  await check('V3 card renders beside natural explanation; controls come from canonical capabilities', async () => {
    await start(); assert((await page.locator('.markdown').innerText()).includes('lời giải thích tự nhiên'));
    assert.equal(await panel().locator('.config-target').count(), 2); assert.equal(await panel().locator('.config-pane').count(), 4);
  });
  await check('Concrete workflow response without kind enables Try/Edit/Accept; unchanged refresh gives visible feedback and Save explains no edits', async () => {
    assert.equal(await panel().locator('.config-error').count(), 0);
    assert(await panel().getByRole('button', { name: 'Try tất cả', exact: true }).isEnabled());
    assert(await panel().getByRole('button', { name: '✎ Sửa config', exact: true }).first().isEnabled());
    assert(await panel().locator('.config-accept').isEnabled());
    assert(await panel().getByRole('button', { name: 'Lưu tất cả', exact: true }).isDisabled());
    assert.equal(await panel().getByRole('button', { name: 'Lưu tất cả', exact: true }).getAttribute('title'), 'Chưa có chỉnh sửa cần lưu.');
    const count = posts.length;
    await panel().getByRole('button', { name: 'Làm mới trạng thái', exact: true }).click();
    await panel().getByText(/Đã làm mới trạng thái lúc/).waitFor();
    assert.equal(posts.length, count);
    await panel().getByText(/Chưa có chỉnh sửa cần lưu. Bạn có thể/).waitFor();
  });
  await check('Rollback and deploy edit, dirty gates, full-pair Save, exact whitespace and untouched devices', async () => {
    const postsBefore = posts.length;
    await edit('rollback', '  hostname ROLLBACK-USER 🌐\n\n');
    assert(await panel().getByRole('button', { name: 'Try tất cả', exact: true }).isDisabled());
    assert(await panel().locator('.config-accept').isDisabled());
    await edit('deploy', ' hostname USER-7\n\n');
    await target().getByRole('button', { name: 'Lưu cặp', exact: true }).click();
    await panel().getByText('Device Config · revision 2', { exact: true }).waitFor();
    const save = posts.slice(postsBefore).find(p => p.path.endsWith('/revisions'));
    assert.deepEqual(save.body.changes, [{ deviceId: 7, deploy: ' hostname USER-7\n\n', rollback: '  hostname ROLLBACK-USER 🌐\n\n' }]);
    assert((await target(8).innerText()).includes('NEW-8')); assert.equal(posts.slice(postsBefore).length, 1);
    assert(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('hostname'));
  });
  await check('Standalone Try progress/result uses only saved IDs and does not CREATE or submit a prompt', async () => {
    const count = posts.length;
    await target().getByRole('button', { name: 'Try cặp này', exact: true }).click();
    await panel().locator('.config-operation').getByText('TRY · 0/1 cặp', { exact: true }).waitFor();
    await panel().getByText('Try thành công', { exact: true }).first().waitFor();
    const request = posts.slice(count); assert.equal(request.length, 1); assert(request[0].path.endsWith('/try'));
    assert.deepEqual(request[0].body.deviceIds, [7]); assert(!('changes' in request[0].body)); assert.equal(createCount, 0);
    await page.locator('#chat-scroll').evaluate(n => { n.scrollTop = 0; });
    await page.screenshot({ path: new URL('desktop-review.png', output).pathname, fullPage: true });
  });
  await check('Editing invalidates old Try and Save all sends both changed pairs in one command', async () => {
    await edit('deploy', 'hostname CHANGED-AGAIN\n'); await edit('rollback', 'hostname USER-8-ROLLBACK\n', 8);
    await panel().getByRole('button', { name: 'Lưu tất cả', exact: true }).click();
    await panel().getByText('Device Config · revision 3', { exact: true }).waitFor();
    assert.equal(posts.at(-1).body.changes.length, 2); await panel().getByText('Kết quả của cặp cũ', { exact: true }).first().waitFor();
  });
  await check('Rejected Save keeps editor contents for HTTP 413 and 429', async () => {
    for (const code of [413, 429]) {
      await edit('rollback', `hostname KEEP-${code}\n`); saveError = code;
      await target().getByRole('button', { name: 'Lưu cặp', exact: true }).click();
      await panel().getByText(/FIXTURE_SAVE_REJECTED/).waitFor();
      assert.equal(await target().getByRole('textbox', { name: 'Rollback config · sw7', exact: true }).inputValue(), `hostname KEEP-${code}\n`);
    }
    await target().getByRole('button', { name: 'Bỏ chỉnh sửa', exact: true }).click();
  });
  await check('Lost Save receipt requires explicit same-key replay with frozen full pair', async () => {
    await edit('rollback', 'hostname LOST-RECEIPT\n'); loseReceipt = true;
    await target().getByRole('button', { name: 'Lưu cặp', exact: true }).click();
    await panel().getByRole('button', { name: 'Lấy lại biên nhận lần gửi', exact: true }).click();
    await panel().getByText('Device Config · revision 4', { exact: true }).waitFor();
    assert.deepEqual(posts.at(-1), posts.at(-2));
  });
  await check('Conflict preserves draft; explicit read shows new head and never auto-accepts', async () => {
    await edit('rollback', 'hostname MY-STALE-EDIT\n');
    const c = [...workflows.values()].at(-1); c.proposalId = crypto.randomUUID(); c.revision++; c.candidateHash = 'f'.repeat(64); c.reviewVersion++;
    await target().getByRole('button', { name: 'Lưu cặp', exact: true }).click();
    await panel().getByText(/PROPOSAL_VERSION_CONFLICT/).waitFor();
    await panel().getByRole('button', { name: 'Làm mới trạng thái', exact: true }).click();
    await panel().getByRole('button', { name: 'Dùng bản mới và bỏ chỉnh sửa', exact: true }).waitFor();
    assert.equal(await target().getByRole('textbox', { name: 'Rollback config · sw7', exact: true }).inputValue(), 'hostname MY-STALE-EDIT\n');
    await panel().getByRole('button', { name: 'Dùng bản mới và bỏ chỉnh sửa', exact: true }).click();
    await panel().getByText('Device Config · revision 5', { exact: true }).waitFor();
  });
  await check('Reload during Try resumes GET operation polling without any repeated mutation', async () => {
    holdNext = true; await panel().getByRole('button', { name: 'Try tất cả', exact: true }).click();
    await panel().locator('.config-operation').waitFor(); await page.waitForTimeout(450);
    const count = posts.length; await page.reload();
    await panel().getByText('Đang Try', { exact: true }).first().waitFor();
    assert.equal(posts.length, count); const op = [...operations.values()].at(-1); op.complete();
    await panel().locator('.config-operation').getByText('Try · Hoàn tất', { exact: true }).waitFor();
    assert.equal(posts.length, count);
  });
  await check('Accept failure creates nothing; explicit retry on same revision creates one Draft, no Agent turn', async () => {
    const count = posts.length, before = createCount; failNext = true;
    await panel().locator('.config-accept').click();
    await panel().locator('.config-operation').getByText('Accept · Không thành công', { exact: true }).waitFor();
    assert.equal(createCount, before); await panel().locator('.config-accept:not(:disabled)').waitFor();
    await panel().locator('.config-accept').click();
    await panel().getByText('Đã tạo Config Setup Draft', { exact: true }).waitFor();
    assert.equal(createCount, before + 1);
    const requests = posts.slice(count); assert.equal(requests.length, 2); assert(requests.every(p => p.path.endsWith('/approve')));
    assert.equal(requests[0].body.expectedRevision, requests[1].body.expectedRevision);
    assert.notEqual(requests[0].body.idempotencyKey, requests[1].body.idempotencyKey);
    assert(await panel().locator('.config-accept').isDisabled());
  });
  await check('TRY Unknown blocks fresh execution and offers no false reconcile/retry action', async () => {
    await start(); unknownNext = true; await target().getByRole('button', { name: 'Try cặp này', exact: true }).click();
    await panel().getByText('Cần đối soát', { exact: true }).waitFor();
    assert(await panel().locator('.config-accept').isDisabled());
    assert.equal(await panel().getByRole('button', { name: 'Đối soát CREATE', exact: true }).count(), 0);
  });
  await check('CREATE Unknown exposes read-only reconciliation, never a repeated Accept', async () => {
    await start(); unknownNext = true; await panel().locator('.config-accept').click();
    await panel().getByRole('button', { name: 'Đối soát CREATE', exact: true }).click();
    await panel().getByText('Đã tạo Config Setup Draft', { exact: true }).waitFor();
    assert(posts.at(-1).path.endsWith('/config-setup/reconcile'));
  });
  await check('V2 is readable with ref-bound Accept; V3 pair editing/Try remain unavailable', async () => {
    await start('v2'); assert.equal(await panel().getByRole('button', { name: 'Try cặp này', exact: true }).count(), 0);
    assert(await panel().getByRole('button', { name: '✎ Sửa config', exact: true }).first().isDisabled());
    await panel().locator('.config-accept').click(); assert(posts.at(-1).body.expectedCandidateHash);
    await panel().getByText('Đã tạo Config Setup Draft', { exact: true }).waitFor();
  });
  await check('Empty rollback is saved as incomplete; restoring it re-enables Try after Save', async () => {
    await start('empty-rollback'); await edit('rollback', '');
    await target().getByRole('button', { name: 'Lưu cặp', exact: true }).click();
    await panel().getByText('Device Config · revision 2', { exact: true }).waitFor();
    assert(await target().getByRole('button', { name: 'Try cặp này', exact: true }).isDisabled());
    assert(await panel().locator('.config-accept').isDisabled());
    await edit('rollback', 'hostname RESTORED\n'); await target().getByRole('button', { name: 'Lưu cặp', exact: true }).click();
    await panel().getByText('Device Config · revision 3', { exact: true }).waitFor();
    assert(await target().getByRole('button', { name: 'Try cặp này', exact: true }).isEnabled());
  });
  await check('Optional AI follow-up binds the exact parent; NoRevision shows text and keeps the saved pair', async () => {
    const count = posts.length;
    await panel().locator('.config-chat > summary').click();
    await panel().getByRole('textbox', { name: 'Yêu cầu AI sửa cấu hình', exact: true }).fill('Giải thích rollback đang lưu');
    await panel().getByRole('button', { name: 'Gửi yêu cầu sửa bằng AI', exact: true }).click();
    await panel().getByText('Rollback dùng lại hostname đã lưu; yêu cầu này không thay đổi cấu hình.', { exact: true }).waitFor();
    assert.equal(posts.length, count + 1); assert.equal(posts.at(-1).body.mode, 'instruction');
    assert.equal(posts.at(-1).body.expectedRevision, 3); assert.equal(await panel().locator('.config-title strong').innerText(), 'Device Config · revision 3');
  });
  await check('Lost Try receipt survives reload and explicit replay keeps the exact key/selection', async () => {
    await start('lost-try'); loseReceipt = holdNext = true;
    await target().getByRole('button', { name: 'Try cặp này', exact: true }).click();
    await panel().getByRole('button', { name: 'Lấy lại biên nhận lần gửi', exact: true }).waitFor();
    await panel().getByText(/Chưa rõ kết quả/).waitFor();
    const request = structuredClone(posts.at(-1)), count = posts.length;
    await page.reload(); await panel().getByRole('button', { name: 'Lấy lại biên nhận lần gửi', exact: true }).waitFor();
    assert.equal(posts.length, count);
    await panel().getByRole('button', { name: 'Lấy lại biên nhận lần gửi', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.config-retry-receipt'));
    assert.deepEqual(posts.at(-1), request); [...operations.values()].at(-1).complete();
    await panel().locator('.config-operation').getByText('Try · Hoàn tất', { exact: true }).waitFor();
  });
  await check('Two browser tabs cannot overwrite a newer revision and keep the losing edit for review', async () => {
    await start('two-tabs'); await page.waitForTimeout(400);
    const other = await context.newPage(); other.on('pageerror', e => errors.push(e.message)); other.on('dialog', d => d.accept());
    await other.goto(origin); const otherPanel = other.locator('.config-review').last();
    await otherPanel.locator('.config-accept:not(:disabled)').waitFor();
    const otherTarget = otherPanel.locator('.config-target[data-device-id="7"]');
    await otherTarget.getByRole('button', { name: '✎ Sửa rollback', exact: true }).click();
    await otherTarget.getByRole('textbox', { name: 'Rollback config · sw7', exact: true }).fill('hostname SECOND-TAB\n');
    await edit('deploy', 'hostname FIRST-TAB\n'); await target().getByRole('button', { name: 'Lưu cặp', exact: true }).click();
    await panel().getByText('Device Config · revision 2', { exact: true }).waitFor();
    await otherTarget.getByRole('button', { name: 'Lưu cặp', exact: true }).click();
    await otherPanel.getByText(/PROPOSAL_VERSION_CONFLICT/).waitFor();
    assert.equal(await otherTarget.getByRole('textbox', { name: 'Rollback config · sw7', exact: true }).inputValue(), 'hostname SECOND-TAB\n');
    await otherTarget.getByRole('button', { name: 'Bỏ chỉnh sửa', exact: true }).click(); await other.close();
  });
  await check('Switching conversations keeps unsaved buffers in the tab and never persists CLI', async () => {
    await start('draft-switch'); await edit('rollback', 'hostname MEMORY-ONLY\n'); await start('other-conversation');
    await page.getByRole('button', { name: 'draft-switch', exact: true }).click();
    await target().getByRole('textbox', { name: 'Rollback config · sw7', exact: true }).waitFor();
    assert.equal(await target().getByRole('textbox', { name: 'Rollback config · sw7', exact: true }).inputValue(), 'hostname MEMORY-ONLY\n');
    assert(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('MEMORY-ONLY'));
    await target().getByRole('button', { name: 'Bỏ chỉnh sửa', exact: true }).click();
  });
  await check('50-device layout collapses CLI and filters errors without dropping requested targets', async () => {
    await start('multi50'); assert.equal(await panel().locator('.config-target').count(), 50);
    assert.equal(await panel().locator('.config-target[open]').count(), 0);
    await panel().getByRole('combobox', { name: 'Lọc thiết bị cấu hình', exact: true }).selectOption('issues');
    assert.equal(await panel().locator('.config-target').count(), 0);
    await panel().getByRole('combobox', { name: 'Lọc thiết bị cấu hình', exact: true }).selectOption('all');
    assert.equal(await panel().locator('.config-target').count(), 50);
  });
  await check('Mobile editors, keyboard input/focus and layout fit 390px viewport', async () => {
    await start(); await page.setViewportSize({ width: 390, height: 844 });
    const input = await edit('deploy', 'hostname MOBILE'); await input.press('End'); await input.pressSequentially('-USER');
    assert.equal(await input.inputValue(), 'hostname MOBILE-USER');
    assert.equal(await input.evaluate(n => n === document.activeElement), true);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: new URL('mobile-edit.png', output).pathname, fullPage: true });
    await target().getByRole('button', { name: 'Bỏ chỉnh sửa', exact: true }).click();
  });
  assert.deepEqual(errors, []); assert(auth.every(a => a === '00000000-0000-0000-0000-000000000001'));
  await writeFile(new URL('results.json', output), JSON.stringify({ checks, pageErrors: errors, mutations: posts.length,
    fixtureCreateCount: createCount, realModelCalls: 0, realTryCreateCalls: 0, qualification: 'browser + contract fixture' }, null, 2));
  console.log(`${checks.length} Device Config browser checks passed.`);
} catch (error) {
  await debugPage?.screenshot({ path: new URL('failure.png', output).pathname, fullPage: true });
  await writeFile(new URL('failure.json', output), JSON.stringify({ checks, errors, message: error.message, stack: error.stack,
    pageText: await debugPage?.locator('body').innerText(), posts, operations: [...operations.values()] }, null, 2));
  throw error;
} finally {
  for (const timer of timers) clearTimeout(timer);
  await browser.close(); Object.assign(targets, previous);
  for (const server of [ui, fixture]) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
}
