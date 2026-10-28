import { mergeTracePage, traceStep } from './trace-view.js';
import { marked } from './vendor/marked.js';
import DOMPurify from './vendor/purify.js';
import { ChatApi, initialRun, observeRun, isTerminal, statusName, allowedAction, artifactPath, randomId, applyActivitySnapshot, activityDuration, formatDuration, activityPhase } from './core.js';

const $ = selector => document.querySelector(selector);
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  sparkles: '<path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z"/><path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6L20 2Z"/>',
  message: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 0 1 4 11.5 8.5 8.5 0 0 1 8.7 3.9a8.4 8.4 0 0 1 3.8-.9H13a8.5 8.5 0 0 1 8 8v.5Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 18 17"/>',
  settings: '<path d="m9 3-1 3-3 1v3l-2 2 2 2v3l3 1 1 3h6l1-3 3-1v-3l2-2-2-2V7l-3-1-1-3H9Z"/><circle cx="12" cy="12" r="3"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  book: '<path d="M12 5c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v14"/>',
  network: '<rect x="8" y="3" width="8" height="6" rx="1"/><rect x="2" y="16" width="8" height="5" rx="1"/><rect x="14" y="16" width="8" height="5" rx="1"/><path d="M12 9v4M6 16v-3h12v3"/>',
  chart: '<path d="M3 3v18h18M8 16v-4M13 16V8M18 16V5"/>',
  'arrow-up-right': '<path d="M7 17 17 7M7 7h10v10"/>',
  'arrow-up': '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  command: '<path d="M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V7Z"/>',
  square: '<rect x="5" y="5" width="14" height="14" rx="1" fill="currentColor"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  link: '<path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 3 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  file: '<path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h5"/>',
  activity: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
};
function icon(name) {
  const wrapper = document.createElement('span');
  wrapper.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.message}</svg>`;
  return wrapper.firstElementChild;
}
document.querySelectorAll('[data-icon]').forEach(node => node.append(icon(node.dataset.icon)));
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = String(text); return node; }
function button(label, handler, className = '', iconName) {
  const node = el('button', className); node.type = 'button';
  if (iconName) node.append(icon(iconName));
  node.append(document.createTextNode(label)); node.addEventListener('click', handler); return node;
}
const textValue = value => value == null ? 'Chưa có thông tin' : ['string', 'number', 'boolean'].includes(typeof value) ? String(value) : 'Thông tin có cấu trúc';
function publicFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return textValue(value);
  return Object.entries(value).filter(([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 16).map(([k, v]) => `${k}: ${textValue(v)}`).join(' · ') || 'Thông tin có cấu trúc';
}
const statusLabels = { Pending: 'Đang chờ', Running: 'Đang xử lý', Uncertain: 'Chưa xác định kết quả', WaitingConfirmation: 'Chờ bạn xác nhận', Executing: 'Đang thực thi', Completed: 'Hoàn thành', Superseded: 'Đã có phiên bản mới', Rejected: 'Đã từ chối', Failed: 'Không hoàn thành', Cancelled: 'Đã dừng', Interrupted: 'Bị gián đoạn' };
let config, prefs, authToken = '', scope = '', conversations = [], selectedId, observer, selection = 0, sending = false, renderQueued = false, storageTimer, toastTimer, currentAction;
const openEventRuns = new Set();
const openEventRows = new Set();
const openActivityRuns = new Set(), openActivityRows = new Set(), activityLoading = new Set(), activityAttempts = new Set();
const privateTraces = new Map(), traceScroll = new Map();
const traceKey = runId => `${scope}:${runId}`;
const connectionLabels = { connecting: 'Đang mở SSE', live: 'SSE trực tiếp', reconnecting: 'SSE đang kết nối lại', polling: 'Theo dõi qua GET', closed: 'SSE đã kết thúc', error: 'Lỗi kết nối' };
try { prefs = JSON.parse(localStorage.getItem('vht-ui:settings')) || {}; } catch { prefs = {}; }
prefs = { backend: 'goose', mode: 'demo', demoUser: '00000000-0000-0000-0000-000000000001', directUrl: '', ...prefs };
const activeConversation = () => conversations.find(c => c.localId === selectedId);
const latestState = () => activeConversation()?.messages.filter(m => m.role === 'assistant' && m.state).at(-1)?.state;
const activeRun = () => { const s = latestState(); return s && (!isTerminal(s.status) || !s.hydrated) ? s : null; };
function baseUrl() { return prefs.directUrl || `/backend/${prefs.backend}`; }
function api() { return new ChatApi(baseUrl(), prefs.mode === 'demo' ? { 'X-Demo-User': prefs.demoUser } : prefs.mode === 'bearer' ? { Authorization: `Bearer ${authToken}` } : {}); }
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 4500); }
function save() {
  // Cookie identity can change outside this app; don't persist an unknown owner's chat.
  if (prefs.mode === 'cookie') return;
  try { localStorage.setItem(scope, JSON.stringify({ selectedId, conversations })); }
  catch { toast('Không lưu được lịch sử vào trình duyệt. Bạn vẫn có thể tiếp tục trong tab này.'); }
}
function persistSoon() { clearTimeout(storageTimer); storageTimer = setTimeout(save, 300); }
async function loadScope() {
  selection++; observer?.abort(); clearTimeout(storageTimer); sending = false;
  privateTraces.clear(); traceScroll.clear();
  const identity = prefs.mode === 'bearer' ? authToken : prefs.mode === 'demo' ? prefs.demoUser : 'cookie';
  const input = new TextEncoder().encode([prefs.backend, prefs.directUrl || config.targets[prefs.backend], prefs.mode, identity].join('|'));
  const bytes = crypto.subtle ? await crypto.subtle.digest('SHA-256', input) : globalThis.sha256.arrayBuffer(input);
  scope = 'vht-ui:history:' + [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
  try { const stored = prefs.mode === 'cookie' ? {} : JSON.parse(localStorage.getItem(scope)) || {}; conversations = Array.isArray(stored.conversations) ? stored.conversations : []; selectedId = stored.selectedId; } catch { conversations = []; selectedId = null; }
  conversations = conversations.filter(c => c && Array.isArray(c.messages));
  for (const conversation of conversations) {
    if (!conversation.pending) continue;
    const message = conversation.messages.find(m => m.localId === conversation.pending.assistantId);
    if (message) message.submitError = 'Lần gửi trước chưa có kết quả xác nhận. Thử lại cùng lần gửi để lấy run hiện có; không tạo yêu cầu mới.';
  }
  if (!activeConversation()) selectedId = conversations[0]?.localId;
  updateChrome(); renderHistory(); renderMessages(); updateComposer();
  if (latestState()) startObserver();
  checkHealth();
}
function updateChrome() {
  $('#backend-label').textContent = prefs.backend === 'dsh' ? 'VHT Backend DSH' : 'VHT Backend';
  $('#backend-caption').textContent = prefs.backend === 'dsh' ? 'VHT-Agent-Backend-DSH' : 'VHT-Agent-Backend';
  $('#owner-caption').textContent = prefs.mode === 'demo' ? 'Development · Demo user' : prefs.mode === 'bearer' ? 'Bearer · phiên của tab' : 'Cookie · phiên đăng nhập';
}
function renderHistory() {
  $('#history').replaceChildren(); $('#chat-count').textContent = conversations.length;
  if (!conversations.length) $('#history').append(el('p', 'history-empty', 'Cuộc trò chuyện của bạn sẽ xuất hiện ở đây.'));
  for (const conversation of conversations) {
    const node = button('', () => selectConversation(conversation.localId), `history-item${conversation.localId === selectedId ? ' active' : ''}`, 'message');
    node.append(el('span', '', conversation.title)); node.title = conversation.title;
    if (conversation.localId === selectedId) node.setAttribute('aria-current', 'page');
    $('#history').append(node);
  }
  $('#conversation-title').textContent = activeConversation()?.title || 'Trợ lý AI';
}
function selectConversation(id) {
  if (sending) { toast('Đang gửi yêu cầu. Vui lòng đợi kết quả gửi.'); return; }
  selection++; observer?.abort(); selectedId = id; save();
  $('#sidebar').classList.remove('open'); renderHistory(); renderMessages(); updateComposer();
  if (latestState()) startObserver();
}
function newChat() { selectConversation(null); $('#prompt').value = ''; fitTextarea(); $('#prompt').focus(); }
function markdown(text) {
  const node = el('div', 'markdown');
  node.innerHTML = DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: true }), {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'hr'],
    ALLOWED_ATTR: ['href', 'start', 'colspan', 'rowspan'],
  });
  for (const a of node.querySelectorAll('a')) {
    const value = a.getAttribute('href');
    if (artifactPath(value)) {
      a.href = '#'; a.addEventListener('click', event => { event.preventDefault(); downloadArtifact(value, a.textContent || 'report'); });
    } else {
      try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
        a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
      } catch { a.removeAttribute('href'); }
    }
  }
  return node;
}
function createBlock(title, iconName = 'chart') {
  const node = el('section', 'block'); const heading = el('div', 'block-title'); heading.append(icon(iconName), document.createTextNode(title)); node.append(heading); return node;
}
function notice(node, items) {
  const values = (Array.isArray(items) ? items : typeof items === 'string' ? [items] : []).filter(i => typeof i === 'string');
  if (values.length) node.append(el('div', 'block-notice', values.join(' · ')));
}
function dataTable(columns, rows) {
  const wrap = el('div', 'table-wrap'), table = el('table', 'data-table'), thead = el('thead'), header = el('tr');
  for (const column of columns || []) header.append(el('th', '', textValue(column)));
  thead.append(header); table.append(thead); const body = el('tbody');
  for (const row of (rows || []).slice(0, 200)) { const tr = el('tr'); for (const cell of Array.isArray(row) ? row : []) tr.append(el('td', '', textValue(cell))); body.append(tr); }
  table.append(body); wrap.append(table); return wrap;
}
function renderBlock(block) {
  if (block?.version !== 1) return null;
  let node;
  if (block.kind === 'table') {
    node = createBlock(block.title || 'Dữ liệu', 'chart'); node.append(dataTable(block.columns, block.rows));
    notice(node, [block.displayNotice, block.topN ? 'Bảng hiển thị các dòng được chọn; không đại diện cho toàn bộ kết quả.' : '', block.completeResultSet === false ? 'Kết quả chưa đầy đủ.' : '', (block.rows?.length || 0) > 200 ? `Hiển thị 200/${block.rows.length} dòng trong UI.` : ''].filter(Boolean));
  } else if (block.kind === 'metricCard') {
    node = createBlock(block.metric || 'Chỉ số'); const body = el('div', 'block-content');
    const value = el('div', 'metric-value', textValue(block.value)); value.append(el('small', '', block.unit || '')); body.append(value, el('p', '', `Thời điểm ghi nhận: ${textValue(block.observedTime)}`)); node.append(body);
  } else if (block.kind === 'reportSummary') {
    node = createBlock(block.title || 'Tổng hợp'); const body = el('div', 'block-content');
    body.append(el('p', '', `Phạm vi: ${publicFields(block.scope)}`), el('p', '', `Thời gian: ${textValue(block.from)} → ${textValue(block.to)}`));
    if (block.mode) body.append(el('p', '', `Chế độ: ${block.mode}`));
    for (const field of ['value', 'average', 'minimum', 'maximum', 'latest', 'totalActive', 'totalEvents']) if (block[field] != null) body.append(el('p', '', `${field}: ${textValue(block[field])}`));
    if (block.completeness != null) body.append(el('p', '', `Độ đầy đủ: ${publicFields(block.completeness)}`));
    node.append(body);
  } else if (block.kind === 'chart') {
    node = createBlock(block.title || 'Biểu đồ'); const body = el('div', 'block-content');
    // Render a table for non-bar charts rather than change their semantics.
    if (String(block.chartType).toUpperCase() !== 'BAR') {
      body.append(dataTable([block.xAxis || 'Mốc', ...(block.series || []).map(s => `${s.name} (${block.unit || '—'})`)], (block.categories || block.xValues || []).map((c, i) => [c, ...(block.series || []).map(s => s.values?.[i])])));
    } else {
      const all = (block.series || []).flatMap(s => s.values || []).filter(v => typeof v === 'number' && Number.isFinite(v));
      // Signed/negative bars need an axis; preserve their actual values in a table.
      if (all.some(v => v < 0)) body.append(dataTable([block.xAxis || 'Nhóm', ...(block.series || []).map(s => s.name)], (block.categories || []).map((c, i) => [c, ...(block.series || []).map(s => s.values?.[i])])));
      else {
        const max = Math.max(...all, 1);
        for (const series of block.series || []) {
          body.append(el('div', 'chart-series-name', series.name)); const values = el('div', 'chart-values');
          for (let i = 0; i < Math.min(block.categories?.length || 0, 100); i++) {
            const row = el('div', 'chart-row'), value = series.values?.[i]; row.append(el('span', 'chart-label', block.categories[i]));
            const track = el('div', 'chart-bar-track'), bar = el('div', 'chart-bar');
            bar.style.setProperty('--bar-scale', typeof value === 'number' && Number.isFinite(value) ? value / max : 0); track.append(bar); row.append(track, el('span', 'chart-number', value == null ? '—' : String(value))); values.append(row);
          }
          body.append(values);
        }
        if ((block.categories?.length || 0) > 100) notice(body, ['UI hiển thị 100 nhóm đầu tiên.']);
      }
    }
    body.append(el('p', '', `Đơn vị: ${block.unit || 'Chưa có'} · Phạm vi: ${publicFields(block.scope)}`));
    if (block.missingValuePolicy) body.append(el('p', '', `Dữ liệu thiếu: ${block.missingValuePolicy}`));
    node.append(body);
  } else if (block.kind === 'artifact' && artifactPath(block.downloadUrl)) {
    node = el('section', 'artifact-card'); const fileIcon = el('span', 'file-icon'); fileIcon.append(icon('file'));
    const info = el('div', 'artifact-info'); info.append(el('strong', '', block.filename || 'Báo cáo'), el('small', '', `${(Number(block.size || 0) / 1024).toFixed(1)} KB · ${block.type || 'File'} · Hết hạn: ${textValue(block.expiresAt)}`));
    const download = button('Tải về', () => downloadArtifact(block.downloadUrl, block.filename, download), 'download-button', 'download');
    node.append(fileIcon, info, download);
  } else if (block.kind === 'evidenceCollection') {
    node = createBlock(block.title || 'Nguồn tham khảo', 'book');
    for (const source of block.sources || []) {
      const detail = el('details', 'source-details'); detail.append(el('summary', '', `${source.category || 'Nguồn'} · ${textValue(source.source)} · ${source.recordCount ?? '—'} bản ghi`));
      const meta = el('div', 'source-meta'); meta.append(el('p', '', `Loại nguồn: ${textValue(source.evidenceKind)}`), el('p', '', `Thu thập: ${textValue(source.retrievedAt)}`), el('p', '', `Quan sát: ${textValue(source.observedAt)}`), el('p', '', `Độ mới: ${textValue(source.freshness)}`), el('p', '', `Phạm vi: ${publicFields(source.scope)}`)); detail.append(meta);
      const records = el('ul', 'source-records'); for (const record of (source.records || []).slice(0, 25)) records.append(el('li', '', publicFields(record))); detail.append(records);
      notice(detail, source.limitations); notice(detail, [`Hiển thị ${Math.min(source.records?.length || 0, 25)} bản ghi nguồn; số lượng tổng do backend cung cấp là ${source.recordCount ?? 'chưa biết'}.`]); node.append(detail);
    }
  } else if (block.kind === 'configProposal') {
    node = createBlock(`Đề xuất cấu hình · phiên bản ${block.revision}`, 'network'); node.append(el('div', 'block-content', block.summary || ''));
    for (const target of block.targets || []) {
      const body = el('div', 'proposal-target'); body.append(el('h4', '', `${target.deviceName} · ID ${target.deviceId}`), el('div', '', 'Cấu hình đề xuất'), el('pre', '', target.deploy || 'Chưa có candidate'));
      const detail = el('details'); detail.append(el('summary', '', 'Rollback và thay đổi'), el('pre', '', target.rollback || 'Chưa có rollback'), el('pre', '', (target.diff || []).join('\n') || 'Chưa có diff'));
      body.append(detail); notice(body, [`Baseline: ${target.baselineStatus ?? 'chưa biết'} · Diff: ${target.diffStatus ?? 'chưa biết'} · Rollback: ${target.rollbackStatus ?? 'chưa biết'}`]); node.append(body);
    }
    notice(node, block.warnings); if (block.executionAllowed === false) notice(node, [`Chưa đủ điều kiện thực thi: ${block.executionBlockReason || 'Backend không cho phép'}`]);
  }
  if (node) notice(node, block.limitations);
  return node || null;
}
async function loadActivity(runId) {
  if (activityLoading.has(runId)) return;
  const conversation = activeConversation(), generation = selection;
  const message = conversation?.messages.find(m => m.state?.runId === runId);
  if (!message) return;
  activityLoading.add(runId); activityAttempts.add(`${scope}:${runId}`); message.state.activityError = ''; message.state.activityHydrated = true; scheduleRender();
  try {
    const snapshot = await api().getActivity(runId);
    if (generation !== selection) return;
    // A GET racing newer SSE must never overwrite a later span end with an older start.
    if ((snapshot.lastSequence || 0) >= Math.max(message.state.activityWatermark || 0, ...((message.state.activitySpans || []).map(s => s.sequence))))
      message.state = applyActivitySnapshot(message.state, snapshot);
    persistSoon();
  } catch (error) {
    if (generation === selection) message.state.activityError = error.status === 404
      ? 'Không tìm thấy activity trên Backend/tài khoản đang chọn. Các bước SSE đã nhận vẫn hiển thị.' : 'Chưa đọc được timeline. Các event SSE đã nhận vẫn giữ nguyên.';
  } finally { activityLoading.delete(runId); if (generation === selection) scheduleRender(); }
}
async function loadTrace(runId) {
  const key = traceKey(runId), generation = selection, client = api();
  let cached = privateTraces.get(key) || { items: [], cursor: 0, bytes: 0 };
  if (cached.loading || cached.limited) return;
  cached = { ...cached, loading: true, error: '' }; privateTraces.set(key, cached);
  while (privateTraces.size > 3) privateTraces.delete(privateTraces.keys().next().value);
  scheduleRender();
  try {
    // Two pages per refresh bounds transfer; next cursor is retained for realtime/explicit refresh.
    for (let page = 0; page < 2; page++) {
      const result = await client.getTrace(runId, cached.cursor);
      if (generation !== selection || key !== traceKey(runId)) return;
      cached = { ...mergeTracePage(cached, result), loading: true };
      privateTraces.set(key, cached);
      if (!cached.hasMore || cached.limited) break;
    }
  } catch (error) {
    if (generation === selection) { cached.error = error.status === 404
      ? 'Không tìm thấy trace trên Backend/tài khoản đang chọn.'
      : error.status === 401 || error.status === 403 ? 'Không có quyền đọc trace bằng phiên đăng nhập hiện tại.' : 'Chưa đọc được chi tiết trace; có thể nhấn đọc lại.'; }
  } finally {
    if (privateTraces.get(key) === cached) { cached.loading = false; if (generation === selection) scheduleRender(); }
  }
}
function traceSection(runId, spanId, heading, text) {
  const box = el('section', 'trace-section'); box.append(el('h4', '', heading));
  const pre = el('pre', 'activity-json trace-content', text), key = `${scope}:${runId}:${spanId}:${heading}`;
  pre.tabIndex = 0; pre.setAttribute('aria-label', heading); pre.scrollTop = traceScroll.get(key) || 0;
  pre.addEventListener('scroll', () => { traceScroll.set(key, pre.scrollTop); });
  // Restore after insertion, since detached elements have no scroll range yet.
  requestAnimationFrame(() => { if (pre.isConnected) pre.scrollTop = traceScroll.get(key) || 0; });
  box.append(pre); return box;
}
setInterval(() => {
  const conversation = activeConversation();
  if (document.hidden || !conversation) return;
  for (const message of conversation.messages) {
    const state = message.state;
    if (state && openActivityRuns.has(state.runId) && !isTerminal(state.status) && !['WaitingConfirmation','Uncertain'].includes(state.status)) loadTrace(state.runId);
  }
}, 3000);
function renderActivity(state) {
  const panel = el('details', 'activity-panel'); panel.open = openActivityRuns.has(state.runId);
  panel.addEventListener('toggle', () => {
    if (!panel.isConnected) return;
    if (panel.open) { openActivityRuns.add(state.runId); if (!activityAttempts.has(`${scope}:${state.runId}`)) loadActivity(state.runId); if (!privateTraces.has(traceKey(state.runId))) loadTrace(state.runId); }
    else openActivityRuns.delete(state.runId);
  });
  const rows = state.activitySpans || [], active = rows.filter(s => s.state === 'started');
  const running = !isTerminal(state.status) && !['WaitingConfirmation', 'Uncertain'].includes(state.status);
  const summary = el('summary', 'activity-heading');
  summary.append(icon('activity'), el('strong', '', 'Hoạt động'), el('span', 'activity-count', `${rows.filter(s => s.stage !== 'capture').length} bước${active.length && running ? ` · ${active.length} đang chạy` : ''}`));
  panel.append(summary);
  const content = el('div', 'activity-content');
  const toolbar = el('div', 'activity-toolbar');
  toolbar.append(el('code', '', state.runId), button(activityLoading.has(state.runId) ? 'Đang tải…' : 'Đọc lại timeline', () => loadActivity(state.runId), 'activity-refresh', 'refresh'));
  const trace = privateTraces.get(traceKey(state.runId));
  toolbar.append(button(trace?.loading ? 'Đang đọc chi tiết…' : trace?.hasMore ? 'Đọc tiếp chi tiết' : 'Đọc lại chi tiết', () => loadTrace(state.runId), 'activity-refresh'));
  content.append(toolbar, el('p', 'activity-help', `Backend: ${prefs.backend} · ${baseUrl()}. Chi tiết lấy từ trace đã che bí mật, chỉ tài khoản sở hữu run đọc được; không lưu prompt/kết quả vào lịch sử trình duyệt.`));
  if (trace?.error) content.append(el('p', 'error-note', trace.error));
  if (trace?.limited || trace?.truncated || trace?.hasMore) content.append(el('p', 'activity-empty', 'Chi tiết chưa đầy đủ hoặc đã giới hạn; dùng “Đọc tiếp chi tiết” khi còn trang.'));
  if (trace && !trace.items.length && !trace.loading && !trace.error) content.append(el('p', 'activity-empty', `Chưa có nội dung trace. Trạng thái thu: ${trace.captureStatus || 'chưa rõ'}.`));
  if (state.activityError) content.append(el('p', 'error-note', state.activityError));
  if (running && active.length && state.connection && state.connection !== 'live') content.append(el('p', 'activity-empty', 'Kết nối chưa trực tiếp; đây là trạng thái cuối đã nhận. Đồng hồ chỉ là ước tính.'));
  if (!rows.length) content.append(el('p', 'activity-empty', activityLoading.has(state.runId) ? 'Đang đọc hoạt động đã lưu…' : 'Chưa ghi nhận bước model/tool. Run cũ hoặc instance chưa bật thu activity có thể không có timeline.'));
  if (state.activityStatus === 'degraded' || state.activityHasMore) content.append(el('p', 'activity-empty', 'Timeline bị giới hạn hoặc thiếu dữ liệu; danh sách này chưa bao phủ toàn bộ lượt chạy.'));
  for (const span of rows) {
    if (span.stage === 'capture') { content.append(el('p', 'error-note', 'Đã chạm giới hạn thu log hoạt động.')); continue; }
    const item = el('details', `activity-row ${span.state}`), key = `${state.runId}:${span.spanId}`;
    item.open = openActivityRows.has(key);
    item.addEventListener('toggle', () => { if (!item.isConnected) return; if (item.open) openActivityRows.add(key); else openActivityRows.delete(key); });
    const detail = traceStep(trace?.items, span);
    const title = el('summary'), info = el('div', 'activity-info');
    info.append(el('strong', '', detail.title));
    const phase = activityPhase(rows, rows.indexOf(span));
    if (phase) info.append(el('span', 'activity-state', phase));
    const status = span.state === 'started' && !running ? 'Chưa có kết quả kết thúc' : ({started:'Đang chạy', completed:span.stage === 'tool' ? 'OK' : 'Hoàn tất', failed:'Lỗi', cancelled:'Đã hủy', interrupted:'Bị ngắt'})[span.state];
    info.append(el('span', 'activity-state', status));
    const timer = el('span', 'activity-duration', formatDuration(activityDuration(span, Date.now(), state.activityClockOffset || 0, running)));
    if (span.state === 'started' && running && span.startedAt) { timer.dataset.startedAt = span.startedAt; timer.dataset.clockOffset = String(state.activityClockOffset || 0); }
    timer.title = span.state === 'started' ? 'Ước tính từ thời điểm bắt đầu; cập nhật theo đồng hồ client.' : span.durationSource === 'runtime_monotonic' ? 'Thời gian runtime đo bằng đồng hồ monotonic.' : 'Không có số đo runtime đầy đủ.';
    title.append(info, timer); item.append(title);
    if (detail.description) item.append(el('p', 'activity-help', detail.description));
    if (detail.failed) item.append(el('p', 'error-note', 'Tool trả về lỗi (theo trace).'));
    if (detail.missing) item.append(el('p', 'activity-empty', detail.missing));
    for (const [heading, text] of detail.sections || []) item.append(traceSection(state.runId, span.spanId, heading, text));
    if (detail.truncated) item.append(el('p', 'activity-empty', 'Bản ghi nguồn đã được giới hạn nội dung.'));
    const metadata = el('details', 'trace-metadata'); metadata.append(el('summary', '', 'Metadata thời gian / định danh'), el('pre', 'activity-json', JSON.stringify(span, null, 2))); item.append(metadata);content.append(item);
  }
  const footer = el('div', 'activity-footer');
  const separated = Number.isFinite(state.activityAgentMs);
  const total = el('strong', 'activity-total', formatDuration(separated ? state.activityAgentMs : state.activityTotalMs));
  if (running && !state.activityAgentStopped && Number.isFinite(state.activityTotalMs) && state.activityObservedAt) {
    total.dataset.baseMs = String(separated ? state.activityAgentMs : state.activityTotalMs); total.dataset.observedAt = String(state.activityObservedAt);
  }
  footer.append(el('span', '', separated ? 'Thời gian Agent chuẩn bị / trả lời' : 'Tổng thời gian lượt chạy'), total);
  if (Number.isFinite(state.activityReviewWaitMs)) content.append(el('p', 'activity-help', `Chờ người dùng Accept: ${formatDuration(state.activityReviewWaitMs)}`));
  for (const op of state.activityOperations || []) content.append(el('p', 'activity-help', `${op.kind} · ${op.status}: ${formatDuration(op.elapsedMs)} (gồm chờ worker và xử lý)`));
  content.append(footer, el('p', 'activity-help', 'Thời gian đang chạy là ước tính; khi hoàn tất dùng số đo runtime. Tổng lượt chạy không phải tổng các bước song song. Mở từng bước để xem metadata đã ghi nhận.'));
  panel.append(content); return panel;
}
setInterval(() => {
  if (document.hidden) return;
  for (const timer of document.querySelectorAll('.activity-duration[data-started-at]'))
    timer.textContent = '~' + formatDuration(Math.max(0, Date.now() + Number(timer.dataset.clockOffset || 0) - Date.parse(timer.dataset.startedAt)));
  for (const timer of document.querySelectorAll('.activity-total[data-base-ms]'))
    timer.textContent = '~' + formatDuration(Number(timer.dataset.baseMs) + Math.max(0, Date.now() - Number(timer.dataset.observedAt)));
}, 250);

function renderEvents(state) {
  const detail = el('details', 'event-viewer'); detail.open = openEventRuns.has(state.runId);
  detail.addEventListener('toggle', () => {
    if (!detail.isConnected) return;
    if (detail.open) openEventRuns.add(state.runId); else openEventRuns.delete(state.runId);
    if (latestState()?.runId === state.runId) $('#events-toggle').setAttribute('aria-pressed', String(detail.open));
  });
  const summary = el('summary', 'event-summary'); summary.append(icon('activity'), el('span', '', 'Events'), el('span', 'event-count', `${state.eventCount || 0} nhận được`)); detail.append(summary);
  const content = el('div', 'event-content'), meta = el('div', 'event-meta');
  meta.append(el('code', '', `Run: ${state.runId}`), el('span', '', connectionLabels[state.connection] || 'Chưa mở SSE'));
  const refresh = button('Đọc snapshot SSE', () => {
    if (activeRun() && activeRun().runId !== state.runId) { toast('Đang theo dõi run khác. Mở snapshot sau khi run hiện tại kết thúc.'); return; }
    openEventRuns.add(state.runId); startObserver(state.runId, true);
  }, 'event-refresh', 'refresh');
  refresh.title = 'GET stream của run này; không gửi lại prompt'; meta.append(refresh); content.append(meta);
  if (state.connectionError) content.append(el('div', 'event-error', state.connectionError));
  const list = el('div', 'event-list'); list.dataset.runId = state.runId;
  for (const event of state.events || []) {
    const item = el('details', 'event-row'), heading = el('summary');
    const key = `${state.runId}:${event.connection}:${event.sequence}:${event.receivedAt}`;
    item.open = openEventRows.has(key);
    item.addEventListener('toggle', () => { if (!item.isConnected) return; if (item.open) openEventRows.add(key); else openEventRows.delete(key); });
    const time = new Date(event.receivedAt).toLocaleTimeString('vi-VN', { hour12: false });
    heading.append(el('span', 'event-time', time), el('code', 'event-kind', event.kind), el('span', 'event-sequence', `C${event.connection} #${event.sequence}`));
    const description = event.kind === 'assistant.text' ? `${event.operation} · ${event.textCharacters ?? 0} ký tự${event.provisional ? ' · bản nháp' : ''}` : event.kind === 'agent.progress' ? `${event.activityState || ''} · ${event.label || event.activity || ''}` : event.status || '';
    item.append(heading, el('div', 'event-description', description), el('pre', 'event-json', JSON.stringify(event, null, 2))); list.append(item);
  }
  if (!list.children.length) list.append(el('p', 'event-empty', 'Chưa ghi nhận event trong UI này. Với câu trả lời cũ, nhấn “Đọc snapshot SSE” để xem trạng thái backend hiện tại.'));
  content.append(list, el('p', 'event-help', `Lưu tối đa 200 event gần nhất/run; text mỗi event tối đa 1.000 ký tự. Sequence bắt đầu lại khi kết nối lại. Các token trước khi bật bản UI này hoặc lúc mất kết nối không được phát lại.`));
  detail.append(content); return detail;
}
function renderMessages() {
  const scroll = $('#chat-scroll'), nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 130;
  const eventScroll = new Map([...document.querySelectorAll('.event-list')].map(node => [node.dataset.runId, { top: node.scrollTop, bottom: node.scrollHeight - node.scrollTop - node.clientHeight < 40 }]));
  const conversation = activeConversation();
  $('#messages').replaceChildren();
  for (const message of conversation?.messages || []) {
    const node = el('article', `message ${message.role}`);
    if (message.role === 'user') { node.append(el('div', 'user-bubble', message.text)); $('#messages').append(node); continue; }
    const state = message.state || initialRun(conversation.sessionId, '');
    const header = el('div', 'assistant-header'), avatar = el('span', 'assistant-avatar'); avatar.append(icon('sparkles'));
    header.append(avatar, document.createTextNode('VHT Agent'));
    if (state.connection) header.append(el('span', `stream-badge ${state.connection === 'live' && !isTerminal(state.status) ? 'live' : ''}`, connectionLabels[state.connection] || 'SSE'));
    header.append(el('span', 'message-status', statusLabels[state.status] || 'Đang gửi')); node.append(header);
    const body = el('div', 'message-body');
    if (!isTerminal(state.status) && state.progress?.length) {
      const progress = el('div', 'progress');
      for (const activity of state.progress) { const row = el('div', `progress-row ${['started', 'completed', 'failed'].includes(activity.state) ? activity.state : ''}`); row.append(el('span', 'progress-dot'), el('span', '', activity.label)); progress.append(row); }
      body.append(progress);
    }
    if (state.text) {
      const answer = el('div', `streaming-answer${state.provisional && !isTerminal(state.status) ? ' receiving' : ''}`);
      answer.append(markdown(state.text));
      if (state.provisional && !isTerminal(state.status)) {
        const receipt = el('div', 'stream-receipt', `${state.textSource === 'model_stream' ? 'Đang nhận text từ model' : 'Đang nhận nội dung qua SSE'} · bản nháp, lượt chạy chưa kết thúc · ${state.textUpdates || 1} lần cập nhật`);
        if (state.firstTextDelayMs != null) receipt.append(document.createTextNode(` · text đầu sau ${(state.firstTextDelayMs / 1000).toFixed(2)} giây kết nối SSE`));
        answer.append(receipt);
      }
      body.append(answer);
    }
    else if (isTerminal(state.status)) body.append(el('div', 'empty-answer', state.hydrated ? 'Run đã kết thúc và không có nội dung trả lời.' : 'Đang đọc câu trả lời đã lưu…'));
    else { const typing = el('div', 'typing'); typing.setAttribute('aria-label', 'Agent đang xử lý'); for (let i = 0; i < 3; i++) typing.append(el('span')); body.append(typing); }
    const presentation = el('div', 'presentation'); for (const block of state.blocks || []) { const view = renderBlock(block); if (view) presentation.append(view); } if (presentation.children.length) body.append(presentation);
    if (state.status === 'WaitingConfirmation' && state.runId === latestState()?.runId && !conversation.pending && !sending) {
      const actions = el('div', 'actions');
      for (const action of (state.actions || []).filter(a => allowedAction(a, state.runId))) {
        const blocked = action.id === 'approve' && state.blocks?.some(b => b.kind === 'configProposal' && b.executionAllowed === false);
        const control = button(action.label || action.id, () => openAction(action, state.runId), `action-button ${action.id}`); control.disabled = blocked; actions.append(control);
      }
      body.append(actions);
    }
    if (state.groundingStatus) body.append(el('div', state.groundingStatus === 'passed' ? 'activity-help' : 'error-note', ({disabled:'Chế độ thử nghiệm: đã tắt kiểm chứng grounding tự động cho Query.',passed:'Grounding: các claim đã gửi được chấp nhận; không xác nhận toàn bộ lời văn.',failed:'Grounding thất bại: nội dung chưa được kiểm chứng đầy đủ.',not_verified:'Chưa kiểm chứng đầy đủ các claim đã gửi.'})[state.groundingStatus]));
    if (state.errorCode || ['Failed', 'Interrupted', 'Uncertain'].includes(state.status)) body.append(el('div', 'error-note', state.errorCode ? `Backend: ${state.errorCode}` : state.status === 'Uncertain' ? 'Kết quả chưa xác định. UI đang theo dõi trạng thái; không gửi lại yêu cầu.' : 'Yêu cầu không hoàn thành. Bạn có thể gửi một tin nhắn mới khi run đã kết thúc.'));
    if (state.connectionError && !isTerminal(state.status) || state.hydrationError) {
      const error = el('div', 'error-note', state.hydrationError ? `Chưa lấy được câu trả lời chuẩn từ backend. ${state.connection === 'error' ? state.connectionError : 'Đang thử lại.'}` : state.connection === 'error' ? state.connectionError : 'Kết nối bị gián đoạn. Đang khôi phục cùng run.');
      if (state.connection === 'error') error.append(button('Kết nối lại', () => startObserver(), '', 'refresh')); body.append(error);
    }
    if (message.submitError) { const error = el('div', 'error-note', message.submitError); error.append(button('Thử lại lần gửi này', () => submitPending(conversation), '', 'refresh')); body.append(error); }
    const footer = el('div', 'message-footer');
    if (state.text) footer.append(button('Sao chép', async () => { try { await navigator.clipboard.writeText(state.text); toast('Đã sao chép câu trả lời.'); } catch { toast('Trình duyệt không cho phép sao chép.'); } }, '', 'copy'));
    if (state.provisional) footer.append(el('span', '', 'Nội dung đang được hoàn thiện'));
    if (state.connection === 'polling' && !isTerminal(state.status)) footer.append(el('span', '', 'Đang theo dõi trạng thái backend'));
    body.append(footer);
    if (state.runId) body.append(renderActivity(state), renderEvents(state));
    node.append(body); $('#messages').append(node);
  }
  $('#events-toggle').setAttribute('aria-pressed', String(openEventRuns.has(latestState()?.runId)));
  for (const node of document.querySelectorAll('.event-list')) {
    const previous = eventScroll.get(node.dataset.runId);
    node.scrollTop = !previous || previous.bottom ? node.scrollHeight : previous.top;
  }
  if (nearBottom) scroll.scrollTop = scroll.scrollHeight;
}
function scheduleRender() {
  if (renderQueued) return; renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderMessages(); updateComposer(); });
}
function updateComposer() {
  const run = activeRun(), conversation = activeConversation(), pending = Boolean(conversation?.pending);
  $('#send-button').disabled = !$('#prompt').value.trim() || sending || pending || Boolean(run);
  $('#cancel-run').hidden = !run || isTerminal(run.status) || ['WaitingConfirmation', 'Uncertain'].includes(run.status);
  $('#cancel-run').disabled = Boolean(run?.cancellationRequestedAt) || sending;
  $('#composer-status').textContent = sending ? 'Đang gửi tin nhắn' : pending ? 'Chờ xác nhận lần gửi' : run ? statusLabels[run.status] || 'Đang xử lý' : 'Sẵn sàng trò chuyện';
  $('#session-note').textContent = run?.status === 'WaitingConfirmation' ? 'Xem lại đề xuất và chọn hành động trước khi tiếp tục.' : run?.status === 'Uncertain' ? 'Backend chưa xác định kết quả. Chờ đối soát trước khi gửi thêm.' : '';
}
function fitTextarea() { $('#prompt').style.height = 'auto'; $('#prompt').style.height = Math.min($('#prompt').scrollHeight, 180) + 'px'; updateComposer(); }
function startObserver(runId = latestState()?.runId, streamFirst = false) {
  observer?.abort(); observer = new AbortController();
  const conversation = activeConversation(), message = conversation?.messages.find(m => m.state?.runId === runId);
  if (!message) return;
  const generation = ++selection, client = api(), signal = observer.signal;
  const initial = { ...message.state, connectionError: '', hydrationError: false };
  observeRun(client, initial, state => {
    if (generation !== selection || signal.aborted) return;
    const reconciled = state.hydrated && !message.state.hydrated;
    message.state = state; persistSoon(); scheduleRender();
    if (reconciled) { loadActivity(state.runId); if (openActivityRuns.has(state.runId)) loadTrace(state.runId); }
  }, signal, { streamFirst }).catch(error => { if (!signal.aborted && generation === selection) { message.state.connectionError = error.message; message.state.connection = 'error'; scheduleRender(); } });
}
async function submitPending(conversation) {
  if (sending || !conversation.pending) return;
  const pending = conversation.pending, generation = selection, client = api();
  const message = conversation.messages.find(m => m.localId === pending.assistantId);
  if (!message) return;
  sending = true; message.submitError = ''; updateComposer(); renderMessages();
  try {
    if (!conversation.sessionId) {
      const session = await client.createSession(conversation.title);
      if (!session?.id) throw new Error('Backend không trả session ID.');
      conversation.sessionId = session.id; save();
    }
    const run = pending.path ? await client.request(pending.path, { method: 'POST', body: { text: pending.text, idempotencyKey: pending.key } }) : await client.submit(conversation.sessionId, pending);
    if (!run?.id || run.sessionId !== conversation.sessionId) throw new Error('Backend không trả accepted run DTO hợp lệ.');
    message.state = { ...initialRun(run.sessionId, run.id), status: statusName(run.status) };
    delete conversation.pending; save();
    if (pending.oldRunId) {
      const old = conversation.messages.find(m => m.state?.runId === pending.oldRunId);
      try { const oldRun = await client.getRun(pending.oldRunId); if (old) { old.state.status = statusName(oldRun.status); old.state.actions = []; } } catch {}
    }
    if (generation === selection) startObserver(run.id, true);
  } catch (error) {
    message.submitError = error.status && error.status < 500 ? error.message : `${error.message || 'Không kết nối được backend.'} Thử lại sẽ giữ cùng khóa gửi để tránh tạo run trùng.`;
    save();
  } finally { sending = false; renderHistory(); renderMessages(); updateComposer(); }
}
async function sendPrompt(event) {
  event.preventDefault(); const text = $('#prompt').value.trim();
  if (!text || sending || activeRun() || activeConversation()?.pending) return;
  if (prefs.mode === 'bearer' && !authToken) { openSettings(); return; }
  let conversation = activeConversation();
  if (!conversation) { conversation = { localId: randomId(), title: text.slice(0, 52), messages: [], createdAt: new Date().toISOString() }; conversations.unshift(conversation); selectedId = conversation.localId; }
  const assistantId = randomId();
  conversation.messages.push({ role: 'user', text }, { role: 'assistant', localId: assistantId });
  conversation.pending = { text, key: randomId(), assistantId };
  $('#prompt').value = ''; fitTextarea(); save(); renderHistory(); renderMessages(); $('#chat-scroll').scrollTop = $('#chat-scroll').scrollHeight;
  await submitPending(conversation);
}
async function downloadArtifact(path, filename, control) {
  if (!artifactPath(path)) return;
  if (control) control.disabled = true;
  try {
    const response = await api().request(path, { raw: true });
    const blob = await response.blob(), url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = String(filename || 'report').replace(/[\\/:*?"<>|]/g, '_'); a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000); toast('Đã tải báo cáo.');
  } catch (error) { toast(`Chưa tải được file: ${error.message}`); }
  finally { if (control) control.disabled = false; }
}
async function checkHealth() {
  const generation = selection; $('#health-label').textContent = 'Đang kiểm tra kết nối'; $('#health-check').disabled = true;
  try { await api().request('/health/ready'); if (generation === selection) { $('#health-label').textContent = 'Backend sẵn sàng'; $('#health-dot').className = 'status-dot ready'; } }
  catch (error) { if (generation === selection) { $('#health-label').textContent = 'Backend chưa kết nối'; $('#health-label').title = error.message; $('#health-dot').className = 'status-dot offline'; } }
  finally { $('#health-check').disabled = false; }
}
function updateSettingsFields() {
  const backend = $('input[name=backend]:checked').value;
  $('#target-url').textContent = config.targets[backend] + (config.targets.goose === config.targets.dsh ? ' · Hai lựa chọn dùng cùng cổng; kết nối stack đang chạy.' : '');
  $('#demo-field').hidden = $('#auth-mode').value !== 'demo'; $('#bearer-field').hidden = $('#auth-mode').value !== 'bearer';
}
function openSettings() {
  $(`input[name=backend][value="${prefs.backend}"]`).checked = true; $('#auth-mode').value = prefs.mode; $('#demo-user').value = prefs.demoUser; $('#bearer-token').value = authToken; $('#direct-url').value = prefs.directUrl;
  $('#settings-error').textContent = ''; updateSettingsFields(); $('#settings-dialog').showModal();
}
async function saveSettings(event) {
  event.preventDefault();
  if (sending) { $('#settings-error').textContent = 'Đợi lần gửi hiện tại hoàn tất trước khi đổi kết nối.'; return; }
  const directUrl = $('#direct-url').value.trim().replace(/\/$/, '');
  if (directUrl) {
    try { const url = new URL(directUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error(); }
    catch { $('#settings-error').textContent = 'URL cần dùng http/https, không chứa tài khoản, query hoặc fragment.'; return; }
  }
  const mode = $('#auth-mode').value, demoUser = $('#demo-user').value.trim();
  if (mode === 'demo' && !demoUser || mode === 'bearer' && !$('#bearer-token').value.trim()) { $('#settings-error').textContent = 'Nhập thông tin xác thực để tiếp tục.'; return; }
  prefs = { backend: $('input[name=backend]:checked').value, mode, demoUser, directUrl };
  authToken = $('#bearer-token').value.trim();
  try { localStorage.setItem('vht-ui:settings', JSON.stringify(prefs)); } catch {}
  $('#settings-dialog').close(); await loadScope(); toast('Đã cập nhật kết nối.');
}
function openAction(action, runId) {
  if (!allowedAction(action, runId) || latestState()?.runId !== runId || latestState()?.status !== 'WaitingConfirmation') return;
  currentAction = { action, runId, selection, key: randomId() };
  $('#action-title').textContent = action.id === 'approve' ? 'Duyệt đề xuất cấu hình' : action.id === 'reject' ? 'Từ chối đề xuất' : 'Chỉnh sửa đề xuất';
  $('#action-description').textContent = action.id === 'approve' ? 'Bạn đang duyệt đề xuất vừa hiển thị. Backend có thể bắt đầu TRY và CREATE theo quyền và điều kiện thực thi hiện có. Kiểm tra đúng thiết bị, candidate và rollback trước khi xác nhận.' : action.id === 'reject' ? 'Đề xuất hiện tại sẽ bị từ chối. Hành động này được gửi đến backend.' : 'Backend sẽ tạo phiên bản mới từ yêu cầu của bạn. Phiên bản mới cần được xem lại và duyệt riêng.';
  $('#revision-field').hidden = action.id !== 'revise'; $('#revision-text').value = ''; $('#action-error').textContent = ''; $('#action-confirm').disabled = false; $('#action-dialog').showModal();
}
async function confirmAction(event) {
  event.preventDefault(); const item = currentAction, run = latestState();
  if (!item || item.selection !== selection || run?.runId !== item.runId || run.status !== 'WaitingConfirmation') { $('#action-error').textContent = 'Trạng thái đã thay đổi. Đóng cửa sổ và kiểm tra lại đề xuất.'; return; }
  const text = $('#revision-text').value.trim();
  if (item.action.id === 'revise' && !text) { $('#action-error').textContent = 'Nhập yêu cầu thay đổi.'; return; }
  $('#action-confirm').disabled = true;
  try {
    if (item.action.id === 'revise') {
      const conversation = activeConversation(), assistantId = randomId();
      observer?.abort(); conversation.messages.push({ role: 'user', text }, { role: 'assistant', localId: assistantId });
      conversation.pending = { text, key: item.key, assistantId, path: item.action.url, oldRunId: item.runId }; save(); $('#action-dialog').close(); await submitPending(conversation);
    } else {
      // Mutation is only initiated by this explicit confirmation. Never auto-retry it.
      await api().request(item.action.url, { method: 'POST' });
      $('#action-dialog').close(); run.hydrated = false; startObserver(); toast('Đã gửi hành động. Đang cập nhật trạng thái từ backend.');
    }
  } catch (error) {
    $('#action-error').textContent = `${error.message}. Kiểm tra lại trạng thái trước khi thực hiện lần nữa.`;
    startObserver();
  } finally { $('#action-confirm').disabled = false; }
}

$('#new-chat').addEventListener('click', newChat); $('#composer').addEventListener('submit', sendPrompt);
$('#events-toggle').addEventListener('click', () => {
  const state = latestState();
  if (!state?.runId) { toast('Gửi tin nhắn để theo dõi streaming và events của run.'); return; }
  if (openEventRuns.has(state.runId)) openEventRuns.delete(state.runId); else openEventRuns.add(state.runId);
  renderMessages();
  if (openEventRuns.has(state.runId)) $('#messages .event-viewer:last-child')?.scrollIntoView({ block: 'nearest' });
});
$('#prompt').addEventListener('input', fitTextarea);
$('#prompt').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!$('#send-button').disabled) $('#composer').requestSubmit(); } });
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); newChat(); } });
$('.new-chat kbd').textContent = navigator.platform.includes('Mac') ? '⌘ K' : 'Ctrl K';
$('#settings-open').addEventListener('click', openSettings); $('#backend-open').addEventListener('click', openSettings); $('#settings-form').addEventListener('submit', saveSettings);
$('#auth-mode').addEventListener('change', updateSettingsFields); document.querySelectorAll('input[name=backend]').forEach(node => node.addEventListener('change', updateSettingsFields));
document.querySelectorAll('.close-dialog').forEach(node => node.addEventListener('click', () => node.closest('dialog').close()));
$('#health-check').addEventListener('click', checkHealth);
$('#menu-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open')); $('#sidebar-overlay').addEventListener('click', () => $('#sidebar').classList.remove('open'));
$('#action-form').addEventListener('submit', confirmAction);
$('#cancel-run').addEventListener('click', async () => {
  const state = activeRun(); if (!state) return;
  $('#cancel-run').disabled = true;
  try {
    const run = await api().request(`/api/chat/runs/${state.runId}/cancel`, { method: 'POST' });
    state.cancellationRequestedAt = run?.cancellationRequestedAt; state.status = statusName(run?.status ?? state.status); save(); scheduleRender(); toast('Đã yêu cầu dừng. Chờ backend xác nhận trạng thái.');
  } catch (error) { toast(error.message); }
  finally { updateComposer(); }
});
$('#clear-history').addEventListener('click', () => {
  if (sending) { toast('Đợi gửi xong trước khi xóa lịch sử.'); return; }
  if (!confirm('Xóa lịch sử của kết nối và tài khoản hiện tại khỏi trình duyệt? Run trên backend vẫn tiếp tục; hành động này không hủy agent.')) return;
  observer?.abort(); selection++; conversations = []; selectedId = null; save(); $('#settings-dialog').close(); renderHistory(); renderMessages(); updateComposer();
});
window.addEventListener('pagehide', () => { clearTimeout(storageTimer); save(); observer?.abort(); });
try { const response = await fetch('/ui-config'); if (!response.ok) throw new Error(); config = await response.json(); await loadScope(); }
catch (error) { console.error('UI initialization failed:', error.message); toast('Không lấy được cấu hình UI. Khởi động UI bằng ./start.sh và tải lại trang.'); }
