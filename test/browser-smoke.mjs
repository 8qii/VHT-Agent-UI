import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, targets } from '../server.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const runs = new Map(), submissions = [], receipts = new Map(), auth = [], executionCalls = [];
const artifactId = '00000000-0000-0000-0000-000000000099';
const finishedText = '## Kết quả\n\n**BGP** trao đổi thông tin định tuyến giữa các hệ tự trị.\n\n| Thiết bị | Trạng thái |\n|---|---|\n| sw137 | Có kết nối |\n\n<script>window.__unsafe = true</script><img src="x" onerror="window.__unsafe=true">\n\n[Unsafe](javascript:alert(1))';
const sseEvent = (run, sequence, kind, extra = {}) => `event: ${kind}\ndata: ${JSON.stringify({ version: 2, sessionId: run.sessionId, runId: run.id, sequence, kind, status: run.status === 3 ? 'WaitingConfirmation' : run.status === 6 ? 'Completed' : run.status === 9 ? 'Cancelled' : 'Running', terminal: [6, 7, 9].includes(run.status), ...extra })}\n\n`;
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
const fixture = http.createServer(async (req, res) => {
  auth.push(req.headers['x-demo-user'] || req.headers.authorization || 'cookie');
  let body = ''; for await (const chunk of req) body += chunk;
  const data = body ? JSON.parse(body) : null, url = req.url;
  if (url === '/health/ready') return json(res, { status: 'ready' });
  if (req.method === 'POST' && url === '/api/chat/sessions') return json(res, { id: crypto.randomUUID(), title: data.title }, 201);
  const prompt = url.match(/^\/api\/chat\/sessions\/(.+)\/prompts$/);
  if (prompt) {
    submissions.push({ sessionId: prompt[1], ...data });
    assert.equal(Object.keys(data).length, 2);
    const existing = receipts.get(prompt[1] + data.idempotencyKey);
    if (existing) return json(res, existing, 202);
    const run = { id: crypto.randomUUID(), sessionId: prompt[1], status: data.text === 'proposal' ? 3 : 1, text: data.text, streams: [] };
    runs.set(run.id, run); receipts.set(prompt[1] + data.idempotencyKey, { id: run.id, sessionId: run.sessionId, status: run.status });
    if (data.text === 'lost receipt') { req.socket.destroy(); return; }
    return json(res, { id: run.id, sessionId: run.sessionId, status: run.status }, 202);
  }
  const path = url.match(/^\/api\/chat\/runs\/([^/]+)(.*)$/);
  if (path) {
    const run = runs.get(path[1]); if (!run) return json(res, {}, 404);
    if (path[2] === '') return json(res, { id: run.id, sessionId: run.sessionId, status: run.status, errorCode: null, cancellationRequestedAt: run.cancelledAt });
    if (path[2].startsWith('/trace?')) {
      const after=Number(new URL(url,'http://fixture').searchParams.get('afterSequence') || 0);
      const entry=(sequence,kind,data,extra={})=>({sequence,kind,data,runtimeRequestId:'fixture-request',runtimeSessionId:'fixture-session',...extra});
      const items=[entry(1,'model.request',{model:'fixture-gemma',messages:[{role:'user',content:'PRIVATE_TRACE_PROMPT <script>window.__traceUnsafe=true</script>\n'+Array.from({length:150},(_,i)=>'Prompt line '+i).join('\n')}]},{modelCallId:'m1'}),
        entry(2,'assistant/message',{message:{content:[{type:'text',text:'Trace model output'}]}}),
        entry(3,'tool/call',{callId:'a',name:'inventory_ListNetworkInterfaces',arguments:'{"deviceId":387}'}),
        entry(4,'tool/result',{message:{toolCallId:'a',content:[{type:'text',text:'{"count":2,"items":[{"name":"eth1"},{"name":"eth2"}]}'}]}}),
        entry(5,'tool/call',{callId:'b',name:'create_mcp',arguments:'{"kind":"inventory"}'}),
        entry(6,'tool/result',{message:{toolCallId:'b',content:[{type:'text',text:'started inventory; callable tools ready'}]}})];
      return json(res,{runId:run.id,items:items.filter(e=>e.sequence>after),lastSequence:6,nextAfterSequence:null,captureStatus:'recorded'});
    }
    if (path[2].startsWith('/activity')) return json(res, {
      runId:run.id,runStatus:run.status===6?'Completed':'Running',serverNow:new Date().toISOString(),lastSequence:5,
      captureStatus:'observed',totalElapsedMs:run.status===6?103790:1800,totalSpans:3,nextOffset:null,
      ...(run.status===6?{agentElapsedMs:28700,agentStopped:true,reviewWaitMs:13800,operations:[{operationId:'fixture-op',kind:'Accept',status:'Succeeded',elapsedMs:61300}]}:{}),
      spans:[{sequence:2,detail:{schemaVersion:1,spanId:'model1',stage:'model',state:run.status===6?'completed':'started',startedAt:new Date(Date.now()-1800).toISOString(),endedAt:new Date().toISOString(),durationMs:9390,durationSource:'runtime_monotonic',modelCallId:'m1'}},
             {sequence:4,detail:{schemaVersion:1,spanId:'tool1',stage:'tool',state:'completed',startedAt:new Date(Date.now()-1000).toISOString(),endedAt:new Date().toISOString(),durationMs:24,durationSource:'runtime_monotonic',toolName:'inventory_ListNetworkInterfaces',toolCallId:'a'}},
             {sequence:5,detail:{schemaVersion:1,spanId:'tool2',stage:'tool',state:'completed',startedAt:new Date(Date.now()-500).toISOString(),durationMs:16,durationSource:'runtime_monotonic',toolName:'create_mcp',toolCallId:'b'}}]
    });
    if (path[2] === '/response') return json(res, {
      messageId: crypto.randomUUID(), sessionId: run.sessionId, runId: run.id,
      text: run.status === 3 ? 'Đề xuất cần được bạn xem lại.' : run.status === 7 ? 'Đã từ chối đề xuất.' : run.status === 9 ? 'Đã dừng.' : finishedText,
      presentationBlocks: run.status === 3 ? [{ kind: 'configProposal', version: 1, revision: 2, summary: 'Đề xuất fixture', targets: [{ deviceId: 10, deviceName: 'sw137', deploy: 'hostname demo', rollback: 'hostname sw137', diff: ['- hostname sw137', '+ hostname demo'] }], warnings: [] }] : run.status === 6 ? [
        { kind: 'artifact', version: 1, artifactId, filename: 'inventory.csv', size: 24, type: 'CSV', downloadUrl: `/api/chat/artifacts/${artifactId}/download`, expiresAt: '2026-10-13T00:00:00Z' },
        { kind: 'evidenceCollection', version: 1, title: 'Nguồn inventory', sources: [{ category: 'inventory', source: '<img onerror="window.__unsafe=true">', recordCount: 1, observedAt: null, retrievedAt: '2026-10-12T00:00:00Z', freshness: 'UNKNOWN', records: [{ deviceId: 10, name: 'sw137' }], limitations: ['Fixture dữ liệu'] }] },
        { kind: 'future', version: 55, raw: 'PRIVATE_BLOCK_SECRET' },
      ] : [],
      actions: run.status === 3 ? [
        { id: 'reject', label: 'Từ chối', method: 'POST', url: `/api/chat/runs/${run.id}/reject` },
        { id: 'approve', label: 'Không được hiện', method: 'POST', url: '/internal/apply' },
      ] : [],
      provenance: { tools: [{ arguments: 'PRIVATE_ARGUMENT_SECRET' }] },
    });
    if (path[2] === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders();
      res.write(sseEvent(run, 1, 'snapshot', { text: null, resetDraft: true, arguments: 'PRIVATE_EVENT_SECRET' }));
      if ([3, 6, 9].includes(run.status)) { res.end(); return; }
      run.streams.push(res);
      if (run.text === 'slow') return;
      if (run.text === 'streaming') {
        res.write(sseEvent(run, 2, 'agent.progress', { activity: 'collectingEvidence', activityState: 'started', label: 'Collecting supporting information',
          activityDetail:{schemaVersion:1,spanId:'model1',stage:'model',state:'started',startedAt:new Date().toISOString(),modelCallId:'m1',durationSource:'runtime_monotonic'} }));
        setTimeout(() => res.write(sseEvent(run, 3, 'assistant.text', { operation: 'replace', text: 'Thiết bị ', provisional: true, textSource: 'model_stream' })), 200);
        setTimeout(() => res.write(sseEvent(run, 4, 'assistant.text', { operation: 'append', text: 'đang kết nối.', provisional: true, textSource: 'model_stream' })), 700);
        setTimeout(() => { run.status = 6; res.end(sseEvent(run, 5, 'run.terminal', { status: 'Completed', terminal: true })); }, 1800);
        return;
      }
      res.write(sseEvent(run, 2, 'agent.progress', { activity: 'retrievingReferences', activityState: 'started', label: '<script>unsafe progress</script>' }));
      res.write(sseEvent(run, 3, 'assistant.text', { operation: 'replace', text: 'Bản nháp sẽ được thay thế', provisional: true }));
      if (run.text === 'disconnect' && !run.disconnected) {
        run.disconnected = true; setTimeout(() => { res.destroy(); run.status = 6; }, 80); return;
      }
      setTimeout(() => {
        run.status = 6;
        res.end(sseEvent(run, 4, 'run.terminal', { status: 'Completed', terminal: true }));
      }, 120);
      return;
    }
    if (req.method === 'POST' && path[2] === '/cancel') {
      run.status = 9; run.cancelledAt = new Date().toISOString();
      for (const stream of run.streams) if (!stream.destroyed) stream.end(sseEvent(run, 10, 'run.terminal', { status: 'Cancelled', terminal: true }));
      return json(res, { status: 9, cancellationRequestedAt: run.cancelledAt });
    }
    if (req.method === 'POST' && path[2] === '/reject') {
      executionCalls.push('fixture-reject'); run.status = 7; return json(res, { id: run.id, status: 7 });
    }
    executionCalls.push(url); return json(res, {}, 404);
  }
  if (url === `/api/chat/artifacts/${artifactId}/download`) {
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="inventory.csv"' }); res.end('deviceId,name\n10,sw137\n'); return;
  }
  return json(res, {}, 404);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const previous = { ...targets }; targets.goose = targets.dsh = `http://127.0.0.1:${fixture.address().port}`;
const ui = createServer(); await new Promise(resolve => ui.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${ui.address().port}`;
const output = new URL('../test-results/', import.meta.url); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [], errors = [];
async function check(label, work) { await work(); results.push(label); console.log('PASS', label); }
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, acceptDownloads: true });
  const page = await context.newPage(); page.on('pageerror', error => { errors.push(error.message); console.error('PAGEERROR', error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error('CONSOLE', message.text()); });
  page.on('requestfailed', request => console.error('NETWORK', request.url(), request.failure()?.errorText));
  await page.goto(origin);
  console.log('PAGE_LOADED', await page.locator('#health-label').innerText(), await page.locator('#health-label').getAttribute('title'));
  await page.getByText('Backend sẵn sàng', { exact: true }).waitFor();
  await check('Desktop opens a plain empty chat without welcome hero or suggestion cards', async () => {
    assert.equal(await page.locator('#welcome,.suggestion').count(), 0);
    assert.equal(await page.locator('#messages').innerText(), '');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: new URL('desktop.png', output).pathname });
  });
  async function send(text) { await page.locator('#prompt').fill(text); await page.locator('#send-button').click(); }
  async function completed() { await page.locator('.message-status').last().filter({ hasText: 'Hoàn thành' }).waitFor(); await page.locator('.download-button').last().waitFor(); }
  await check('Accepted DTO id, canonical replacement, sanitized Markdown and separated blocks', async () => {
    await send('What is BGP?'); await completed();
    const assistant = page.locator('.message.assistant').last();
    assert((await assistant.innerText()).includes('BGP'));
    assert(!(await assistant.innerText()).includes('Bản nháp sẽ được thay thế'));
    assert.equal(await assistant.locator('.markdown table').count(), 1);
    assert.equal(await assistant.locator('script,img').count(), 0);
    assert.equal(await assistant.locator('.markdown a[href^="javascript:"]').count(), 0);
    assert.equal(await page.evaluate(() => window.__unsafe), undefined);
    assert(!(await page.locator('#messages').innerText()).includes('PRIVATE_'));
    assert((await assistant.locator('.source-details').innerText()).includes('<img'));
    await page.screenshot({ path: new URL('chat.png', output).pathname });
  });
  await check('Artifact download retains owner authentication', async () => {
    const downloaded = page.waitForEvent('download'); await page.locator('.download-button').last().click(); const download = await downloaded;
    assert.equal(download.suggestedFilename(), 'inventory.csv');
    await download.saveAs(new URL('inventory.csv', output).pathname);
    assert(auth.every(value => value === '00000000-0000-0000-0000-000000000001'));
  });
  await check('Reload hydrates same run without prompt resubmission', async () => {
    const count = submissions.length; await page.reload(); await completed(); assert.equal(submissions.length, count);
  });
  await check('Text renders incrementally before terminal; event viewer survives completion/reload and snapshot GET', async () => {
    await page.locator('#new-chat').click(); await send('streaming');
    await page.getByText('Thiết bị', { exact: true }).waitFor();
    await page.locator('.activity-heading').last().click();
    await page.locator('.activity-row.started').waitFor();
    const clockBefore=await page.locator('.activity-row.started .activity-duration').last().innerText();
    await page.waitForTimeout(300);
    assert.notEqual(await page.locator('.activity-row.started .activity-duration').last().innerText(),clockBefore);
    assert.equal(await page.locator('.stream-badge.live').count(), 1);
    assert.equal(await page.locator('.streaming-answer.receiving').count(), 1);
    assert((await page.locator('.stream-receipt').innerText()).includes('Đang nhận text từ model'));
    await page.locator('#events-toggle').click();
    await page.getByText('Thiết bị đang kết nối.', { exact: true }).waitFor();
    assert((await page.locator('.message-status').last().innerText()).includes('Đang xử lý'));
    assert((await page.locator('.event-viewer[open]').innerText()).includes('assistant.text'));
    await page.screenshot({ path: new URL('streaming-events.png', output).pathname });
    await completed();
    await page.locator('.activity-row.completed').first().waitFor();
    assert((await page.locator('.activity-content').last().innerText()).includes('9.39 s'));
    assert((await page.locator('.activity-content').last().innerText()).includes('24 ms'));
    const timeline=await page.locator('.activity-content').last().innerText();
    assert(timeline.includes('Thời gian Agent chuẩn bị / trả lời'));
    assert(timeline.includes('28.70 s'));assert(timeline.includes('Chờ người dùng Accept: 13.80 s'));
    assert(timeline.includes('Accept · Succeeded: 1m 1.3s') || timeline.includes('Accept · Succeeded: 61.30 s'));
    const total=await page.locator('.activity-total').last().innerText();
    await page.waitForTimeout(300);assert.equal(await page.locator('.activity-total').last().innerText(),total);
    await page.getByText('create_mcp · inventory',{exact:true}).waitFor();
    await page.locator('.activity-row').filter({has:page.getByText('Model · fixture-gemma',{exact:true})}).locator(':scope > summary').click();
    const promptBox=page.locator('pre[aria-label="Prompt / messages gửi LLM"]').last();
    assert((await promptBox.innerText()).includes('PRIVATE_TRACE_PROMPT'));
    await promptBox.evaluate(node=>{node.scrollTop=150;});
    assert(await promptBox.evaluate(node=>node.scrollHeight>node.clientHeight && node.scrollTop>0));
    assert.equal(await page.evaluate(()=>window.__traceUnsafe),undefined);
    await page.locator('.activity-row').filter({has:page.getByText('inventory_ListNetworkInterfaces',{exact:true})}).locator(':scope > summary').click();
    assert((await page.locator('pre[aria-label="Tham số gọi tool"]').first().innerText()).includes('387'));
    assert((await page.locator('pre[aria-label="Kết quả tool trả về"]').first().innerText()).includes('eth1'));
    await page.waitForTimeout(400);
    assert(!(await page.evaluate(()=>JSON.stringify(localStorage))).includes('PRIVATE_TRACE_PROMPT'));
    await page.screenshot({path:new URL('activity-completed.png',output).pathname});
    assert.equal(await page.locator('.event-row').count(), 5);
    assert((await page.locator('.event-viewer').innerText()).includes('run.terminal'));
    assert(!(await page.locator('.event-viewer').innerText()).includes('PRIVATE_EVENT_SECRET'));
    const posts = submissions.length;
    await page.getByRole('button', { name: 'Đọc snapshot SSE', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.event-row').length === 6);
    assert.equal(submissions.length, posts);
    assert((await page.locator('.event-row').last().innerText()).includes('C2 #1'));
    await page.reload(); await completed(); await page.locator('#events-toggle').click();
    assert.equal(await page.locator('.event-row').count(), 6); assert.equal(submissions.length, posts);
  });
  await check('Disconnect recovers run through GET without prompt resubmission', async () => {
    await page.locator('#new-chat').click(); await send('disconnect'); await completed(); assert.equal(submissions.filter(s => s.text === 'disconnect').length, 1);
  });
  await check('Lost POST receipt and reload retry preserve original session/key', async () => {
    await page.locator('#new-chat').click(); await send('lost receipt'); await page.getByText('Thử lại lần gửi này', { exact: true }).waitFor(); await page.reload();
    await page.getByText('Thử lại lần gửi này', { exact: true }).click(); await completed();
    const posts = submissions.filter(s => s.text === 'lost receipt'); assert.equal(posts.length, 2); assert.equal(posts[0].sessionId, posts[1].sessionId); assert.equal(posts[0].idempotencyKey, posts[1].idempotencyKey);
  });
  await check('WaitingConfirmation stays active; only canonical action and explicit fixture reject', async () => {
    await page.locator('#new-chat').click(); await send('proposal'); await page.getByText('Đề xuất cấu hình · phiên bản 2', { exact: true }).waitFor();
    assert.equal(await page.getByText('Không được hiện', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Từ chối', exact: true }).click(); await page.locator('#action-dialog').waitFor({ state: 'visible' });
    assert.equal(executionCalls.length, 0); await page.locator('#action-confirm').click(); await page.getByText('Đã từ chối đề xuất.', { exact: true }).waitFor(); assert.deepEqual(executionCalls, ['fixture-reject']);
  });
  await check('Reload an active run; Stop sends cancellation API and waits for lifecycle', async () => {
    await page.locator('#new-chat').click(); await send('slow'); await page.locator('#cancel-run').waitFor({ state: 'visible' }); await page.reload(); await page.locator('#cancel-run').waitFor({ state: 'visible' });
    await page.locator('#cancel-run').click(); await page.getByText('Đã dừng.', { exact: true }).waitFor(); assert.equal(submissions.filter(s => s.text === 'slow').length, 1);
  });
  await check('Backend switch separates history and sends shared API contract', async () => {
    await page.locator('#backend-open').click(); await page.locator('input[name=backend][value=dsh]').check(); await page.getByRole('button', { name: 'Lưu kết nối' }).click();
    await page.waitForFunction(() => document.querySelector('#messages').children.length === 0); assert.equal(await page.locator('.history-item').count(), 0); await send('DSH same flow'); await completed();
  });
  await check('Bearer token stays in memory; identity change separates and restores owner history', async () => {
    const token = 'browser-fixture-private-token';
    await page.locator('#backend-open').click(); await page.locator('#auth-mode').selectOption('bearer'); await page.locator('#bearer-token').fill(token); await page.getByRole('button', { name: 'Lưu kết nối' }).click();
    await page.waitForFunction(() => document.querySelector('#messages').children.length === 0); await send('Bearer flow'); await completed();
    assert(auth.includes('Bearer ' + token));
    assert(!(await page.evaluate(() => JSON.stringify(localStorage))).includes(token));
    await page.locator('#backend-open').click(); await page.locator('#auth-mode').selectOption('demo'); await page.locator('#demo-user').fill('different-owner'); await page.getByRole('button', { name: 'Lưu kết nối' }).click();
    await page.waitForFunction(() => document.querySelector('#messages').children.length === 0); assert.equal(await page.locator('.history-item').count(), 0);
    await page.locator('#backend-open').click(); await page.locator('#auth-mode').selectOption('demo'); await page.locator('#demo-user').fill('00000000-0000-0000-0000-000000000001'); await page.getByRole('button', { name: 'Lưu kết nối' }).click();
    await page.locator('.history-item').waitFor(); await completed(); assert((await page.locator('.user-bubble').innerText()).includes('DSH same flow'));
  });
  await check('Mobile empty chat/menu/composer fit a 390px viewport', async () => {
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 });
    const mp = await mobile.newPage(); mp.on('pageerror', error => errors.push(error.message)); await mp.goto(origin); await mp.getByText('Backend sẵn sàng', { exact: true }).waitFor();
    assert(await mp.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await mp.screenshot({ path: new URL('mobile.png', output).pathname });
    await mp.locator('#menu-toggle').click(); await mp.waitForFunction(() => document.querySelector('.sidebar').getBoundingClientRect().left === 0);
    await mp.locator('#sidebar-overlay').click({ position: { x: 350, y: 400 } }); await mp.locator('#prompt').fill('BGP'); assert(await mp.locator('#send-button').isEnabled());
    await mobile.close();
  });
  await check('HTTP-origin crypto fallback starts UI, sends prompt, restores history and SHA256 is correct', async () => {
    const httpContext = await browser.newContext();
    await httpContext.addInitScript(() => { Object.defineProperty(crypto, 'subtle', { value: undefined }); Object.defineProperty(crypto, 'randomUUID', { value: undefined }); });
    const hp = await httpContext.newPage(); hp.on('pageerror', e => errors.push(e.message));
    await hp.goto(origin); await hp.getByText('Backend sẵn sàng', { exact: true }).waitFor();
    assert.equal(await hp.evaluate(() => sha256('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    await hp.locator('#prompt').fill('HTTP crypto fallback'); await hp.locator('#send-button').click();
    await hp.locator('.download-button').waitFor();
    await hp.reload(); await hp.locator('.download-button').waitFor();
    assert.equal(submissions.filter(s => s.text === 'HTTP crypto fallback').length, 1);
    await httpContext.close();
  });
  assert.deepEqual(errors, []);
  await writeFile(new URL('browser-results.json', output), JSON.stringify({ passed: results, pageErrors: errors, submissions: submissions.length, executionCalls, liveAgent: 'NOT_RUN' }, null, 2));
  console.log(`${results.length} browser checks passed; live agent NOT_RUN.`);
} finally {
  await browser.close(); Object.assign(targets, previous); ui.closeAllConnections(); fixture.closeAllConnections();
  await Promise.all([new Promise(resolve => ui.close(resolve)), new Promise(resolve => fixture.close(resolve))]);
}
