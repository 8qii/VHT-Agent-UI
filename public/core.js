export const STATUSES = ['Pending', 'Running', 'Uncertain', 'WaitingConfirmation', 'Superseded', 'Executing', 'Completed', 'Rejected', 'Failed', 'Cancelled', 'Interrupted'];
export const statusName = value => typeof value === 'number' ? STATUSES[value] || 'Unknown' : value || 'Unknown';
export const isTerminal = value => ['Superseded', 'Completed', 'Rejected', 'Failed', 'Cancelled', 'Interrupted'].includes(statusName(value));
export function randomId(provider = globalThis.crypto) {
  if (typeof provider.randomUUID === 'function') return provider.randomUUID();
  const bytes = provider.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const initialRun = (sessionId, runId) => ({ sessionId, runId, status: 'Pending', text: '', provisional: false, progress: [], blocks: [], actions: [], sequence: 0, hydrated: false, events: [], eventCount: 0, connectionIndex: 0 });

export function publicEvent(event, connection, receivedAt = new Date().toISOString()) {
  const entry = { receivedAt, connection, version: 2, sequence: event.sequence, kind: event.kind };
  for (const key of ['sessionId', 'runId', 'status', 'operation', 'activity', 'activityState', 'textSource']) {
    if (typeof event[key] === 'string') entry[key] = event[key].slice(0, 128);
  }
  for (const key of ['terminal', 'provisional', 'resetDraft']) if (typeof event[key] === 'boolean') entry[key] = event[key];
  if (typeof event.label === 'string') entry.label = event.label.slice(0, 500);
  if (typeof event.text === 'string') {
    entry.text = event.text.slice(0, 1000); entry.textCharacters = event.text.length; entry.textTruncated = event.text.length > 1000;
  }
  return entry; // fixed public projection; never persist unknown runtime/tool fields
}

export function safeActivity(detail, sequence = 0) {
  if (!detail || typeof detail.spanId !== 'string' || !['model', 'tool', 'capture'].includes(detail.stage)
      || !['started', 'completed', 'failed', 'cancelled', 'interrupted'].includes(detail.state)) return null;
  const clean = { sequence: Number.isInteger(sequence) ? sequence : 0 };
  for (const key of ['spanId', 'parentSpanId', 'stage', 'state', 'toolName', 'modelCallId', 'toolCallId', 'durationSource'])
    if (typeof detail[key] === 'string') clean[key] = detail[key].slice(0, 160);
  for (const key of ['startedAt', 'endedAt'])
    if (typeof detail[key] === 'string' && Number.isFinite(Date.parse(detail[key]))) clean[key] = new Date(detail[key]).toISOString();
  clean.durationMs = typeof detail.durationMs === 'number' && Number.isFinite(detail.durationMs) && detail.durationMs >= 0 ? detail.durationMs : null;
  return clean;
}
export function applyActivitySnapshot(state, snapshot) {
  if (!snapshot || snapshot.runId !== state.runId || !Array.isArray(snapshot.spans)) return state;
  const spans = snapshot.spans.map(s => safeActivity(s.detail, s.sequence)).filter(Boolean).slice(0, 1000);
  return { ...state, activitySpans: spans, activityStatus: snapshot.captureStatus,
    activityTotal: snapshot.totalSpans, activityHasMore: snapshot.nextOffset != null,
    activityWatermark: snapshot.lastSequence || 0, activityObservedAt: Date.now(), activityHydrated: true,
    activityClockOffset: Number.isFinite(Date.parse(snapshot.serverNow)) ? Date.parse(snapshot.serverNow) - Date.now() : 0,
    activityTotalMs: Number.isFinite(snapshot.totalElapsedMs) ? snapshot.totalElapsedMs : null };
}
export function activityDuration(span, now = Date.now(), offset = 0, running = true) {
  if (span.state !== 'started') return span.durationMs;
  if (!running || !Number.isFinite(Date.parse(span.startedAt))) return null;
  return Math.max(0, now + offset - Date.parse(span.startedAt));
}
export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return 'Chưa có số đo';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function reduceRun(state, event) {
  if (event.version !== 2 || !['snapshot', 'assistant.text', 'agent.progress', 'run.terminal'].includes(event.kind)) throw new Error('UNSUPPORTED_STREAM');
  if (event.runId !== state.runId || event.sessionId !== state.sessionId) throw new Error('MISMATCHED_STREAM');
  if (!Number.isInteger(event.sequence) || event.sequence <= state.sequence) throw new Error('INVALID_SEQUENCE');
  const next = { ...state, sequence: event.sequence };
  if (event.status != null) next.status = statusName(event.status);
  if (event.kind === 'snapshot') { next.text = event.text ?? ''; next.provisional = false; }
  if (event.kind === 'assistant.text') {
    if (!['append', 'replace'].includes(event.operation)) throw new Error('INVALID_OPERATION');
    next.text = event.operation === 'append' ? state.text + (event.text ?? '') : event.text ?? '';
    next.textSource = ['model_stream', 'committed_message', 'canonical'].includes(event.textSource) ? event.textSource : 'unknown';
    next.provisional = event.provisional === true;
    next.textUpdates = (state.textUpdates || 0) + 1;
    if (event.text && state.firstTextDelayMs == null && state.streamStartedAt != null)
      next.firstTextDelayMs = Math.max(0, Date.now() - state.streamStartedAt);
  }
  if (event.kind === 'agent.progress') {
    const activity = { activity: event.activity, state: event.activityState, label: event.label || 'Agent đang xử lý' };
    next.progress = [...state.progress.filter(p => p.activity !== activity.activity), activity].slice(-8);
  }
  if (event.kind === 'snapshot' && event.activitySnapshot) Object.assign(next, applyActivitySnapshot(next, event.activitySnapshot));
  if (event.kind === 'agent.progress' && event.activityDetail && event.sequence > (next.activityWatermark || 0)) {
    const span = safeActivity(event.activityDetail, event.sequence);
    if (span) {
      const rows = (next.activitySpans || []).filter(s => s.spanId !== span.spanId);
      next.activityHasMore = rows.length >= 1000 || next.activityHasMore;
      next.activitySpans = [...rows, span].sort((a,b) => (Date.parse(a.startedAt) - Date.parse(b.startedAt)) || a.sequence - b.sequence).slice(0, 1000);
      next.activityStatus = span.stage === 'capture' ? 'degraded' : next.activityStatus === 'degraded' ? 'degraded' : 'observed';
    }
  }
  next.terminal = event.terminal === true || isTerminal(next.status);
  next.events = [...(state.events || []), publicEvent(event, state.connectionIndex || 1)].slice(-200);
  next.eventCount = (state.eventCount || 0) + 1;
  return next;
}

// Stateful SSE framing supports CR, LF, CRLF (even split across chunks),
// multiline data and heartbeat comments. TextDecoder owns UTF-8 boundaries.
export function createSseParser(onFrame) {
  let buffer = '', name = '', data = [], skipLF = false;
  function line(value) {
    if (!value) {
      if (data.length) onFrame({ name: name || 'message', data: data.join('\n') });
      name = ''; data = []; return;
    }
    if (value.startsWith(':')) return;
    const split = value.indexOf(':');
    const field = split < 0 ? value : value.slice(0, split);
    let content = split < 0 ? '' : value.slice(split + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'event') name = content;
    if (field === 'data') data.push(content);
  }
  return {
    feed(chunk) {
      for (const char of chunk) {
        if (skipLF) { skipLF = false; if (char === '\n') continue; }
        if (char === '\r' || char === '\n') { line(buffer); buffer = ''; skipLF = char === '\r'; }
        else buffer += char;
        if (buffer.length > 4 * 1024 * 1024) throw new Error('STREAM_FRAME_TOO_LARGE');
      }
    },
    end() { buffer = ''; data = []; }, // unfinished EOF frames are not events
  };
}

export async function consumeSse(response, onEvent, signal) {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error('UNSUPPORTED_STREAM');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(frame => {
    const event = JSON.parse(frame.data);
    if (frame.name !== event.kind) throw new Error('UNSUPPORTED_STREAM');
    onEvent(event);
  });
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) { parser.feed(decoder.decode()); break; }
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); parser.end(); }
}

export class ApiError extends Error {
  constructor(message, status, retryAfter = 0) { super(message); this.status = status; this.retryAfter = retryAfter; }
}
export class ChatApi {
  constructor(base, headers = {}, fetcher = (...args) => fetch(...args)) { this.base = base.replace(/\/$/, ''); this.headers = headers; this.fetcher = fetcher; }
  async request(path, { method = 'GET', body, signal, raw = false } = {}) {
    if (!path.startsWith('/api/chat/') && path !== '/health/ready') throw new Error('Unsupported API path');
    const timeout = raw && path.endsWith('/events') ? undefined : AbortSignal.timeout(30000);
    const combined = signal && timeout ? AbortSignal.any([signal, timeout]) : signal || timeout;
    const response = await this.fetcher(this.base + path, {
      method, signal: combined, credentials: 'include',
      headers: { ...this.headers, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(raw && path.endsWith('/events') ? { Accept: 'text/event-stream' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      let detail;
      try { const error = JSON.parse(text); detail = error.error || error.errorCode || error.code || error.detail || error.title; } catch {}
      const after = response.headers.get('retry-after');
      const seconds = /^\d+$/.test(after || '') ? Number(after) : Math.max(0, (Date.parse(after) - Date.now()) / 1000);
      throw new ApiError(typeof detail === 'string' ? detail : `API trả HTTP ${response.status}`, response.status, Number.isFinite(seconds) ? seconds * 1000 : 0);
    }
    return raw ? response : response.status === 204 ? null : response.json();
  }
  createSession(title, signal) { return this.request('/api/chat/sessions', { method: 'POST', body: { title }, signal }); }
  submit(sessionId, pending, signal) { return this.request(`/api/chat/sessions/${encodeURIComponent(sessionId)}/prompts`, { method: 'POST', body: { text: pending.text, idempotencyKey: pending.key }, signal }); }
  getActivity(runId, signal) { return this.request(`/api/chat/runs/${encodeURIComponent(runId)}/activity?limit=1000`, { signal }); }
  getRun(runId, signal) { return this.request(`/api/chat/runs/${encodeURIComponent(runId)}`, { signal }); }
  getResponse(runId, signal) { return this.request(`/api/chat/runs/${encodeURIComponent(runId)}/response`, { signal }); }
}

export function allowedAction(action, runId) {
  return ['approve', 'reject', 'revise'].includes(action?.id) && action.method === 'POST' && action.url === `/api/chat/runs/${runId}/${action.id === 'revise' ? 'revisions' : action.id}`;
}
export function artifactPath(url) {
  return typeof url === 'string' && /^\/api\/chat\/artifacts\/[a-f\d-]{36}\/download$/i.test(url) ? url : null;
}

const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

// One observer per selected run. Reload/switch aborts GETs only, never the run.
export async function observeRun(api, initial, update, signal, { streamFirst = false } = {}) {
  let state = { ...initial }, attempts = 0, polling = false;
  const emit = patch => { state = { ...state, ...patch }; update(state); };
  async function reconcile(hydrate = false) {
    const run = await api.getRun(state.runId, signal);
    const status = statusName(run.status);
    emit({ status, errorCode: run.errorCode, cancellationRequestedAt: run.cancellationRequestedAt, hydrated: status !== state.status ? false : state.hydrated });
    if (hydrate || isTerminal(status) || status === 'WaitingConfirmation') {
      const response = await api.getResponse(state.runId, signal);
      // Never hydrate private fields or use a successful response to infer completion.
      emit({ text: response.text ?? '', blocks: response.presentationBlocks || [], actions: response.actions || [], textSource: 'canonical', provisional: false, hydrated: true, hydrationError: false });
      if (typeof api.getActivity === 'function') {
        try {
          const snapshot = await api.getActivity(state.runId, signal);
          const newest = Math.max(state.activityWatermark || 0, ...(state.activitySpans || []).map(s => s.sequence));
          if ((snapshot.lastSequence || 0) >= newest) emit(applyActivitySnapshot(state, snapshot));
        } catch (error) {
          if (!signal.aborted) emit({ activityError: error.status === 404 ? 'Backend chưa có timeline cho run này.' : 'Chưa đọc được timeline đã lưu.', activityHydrated: true });
        }
      }
      if (isTerminal(status)) emit({ connection: 'closed' });
    }
    return isTerminal(status);
  }
  while (!signal.aborted) {
    try {
      if (!streamFirst && await reconcile(isTerminal(state.status))) return;
      streamFirst = false;
      if (polling) { emit({ connection: 'polling' }); await delay(3000, signal); continue; }
      emit({ connection: 'connecting', streamStartedAt: Date.now(), sequence: 0, connectionIndex: (state.connectionIndex || 0) + 1, connectionError: '' });
      const streamAbort = new AbortController();
      const streamSignal = AbortSignal.any([signal, streamAbort.signal]);
      let terminal = false, waiting = false;
      // Reconcile even if a connected stream stalls/only sends heartbeats.
      let pollTask = Promise.resolve();
      const watchdog = setInterval(() => {
        pollTask = pollTask.then(async () => {
          if (streamSignal.aborted) return;
          try {
            const run = await api.getRun(state.runId, streamSignal);
            const status = statusName(run.status);
            emit({ status, errorCode: run.errorCode, cancellationRequestedAt: run.cancellationRequestedAt, hydrated: status !== state.status ? false : state.hydrated });
            if (isTerminal(run.status) || statusName(run.status) === 'WaitingConfirmation' && !state.hydrated) {
              terminal = isTerminal(run.status); waiting = !terminal; streamAbort.abort();
            }
          } catch (error) { if ([401, 403, 404].includes(error.status)) streamAbort.abort(error); }
        });
      }, 10000);
      try {
        const response = await api.request(`/api/chat/runs/${state.runId}/events`, { raw: true, signal: streamSignal });
        emit({ connection: 'live' });
        await consumeSse(response, event => {
          state = reduceRun(state, event); update(state);
          if (state.terminal) { terminal = true; streamAbort.abort(); }
          if (state.status === 'WaitingConfirmation' && !state.hydrated) { waiting = true; streamAbort.abort(); }
        }, streamSignal);
      } catch (error) { if (!terminal && !waiting) throw error; }
      finally { clearInterval(watchdog); streamAbort.abort(); await pollTask; }
      if (terminal) { await reconcile(true); return; }
      if (waiting) { await reconcile(true); polling = true; continue; }
      throw new Error('STREAM_DISCONNECTED');
    } catch (error) {
      if (signal.aborted) return;
      if ([401, 403, 404].includes(error.status)) { emit({ connection: 'error', connectionError: error.message, hydrationError: isTerminal(state.status) && !state.hydrated }); return; }
      attempts++;
      if (error.message.includes('UNSUPPORTED') || attempts >= 3) polling = true;
      emit({ connection: polling ? 'polling' : 'reconnecting', connectionError: error.message, hydrationError: isTerminal(state.status) && !state.hydrated });
      await delay(Math.max(Math.min(1000 * 2 ** (attempts - 1), 10000), error.retryAfter || 0), signal);
    }
  }
}
