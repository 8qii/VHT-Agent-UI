import { randomId } from './core.js';

const done = new Set(['Succeeded', 'Failed', 'OutcomeUnknown', 'Cancelled']);
const editableStates = new Set(['Ready', 'ReviewOnly', 'ValidationFailed']);
export const isReviewCard = card => card?.kind === 'configProposal' && [2, 3].includes(card.version);
export const operationDone = operation => done.has(operation?.status);
const samePairRevision = (a, b) => a?.proposalId === b?.proposalId && a?.candidateHash === b?.candidateHash;
const lf = value => value.replace(/\r\n/g, '\n');
function restoredAttempt(attempt) {
  if (!attempt || !['try', 'accept'].includes(attempt.kind)) return null;
  const suffix = attempt.kind === 'try' ? 'try' : 'approve', body = attempt.body;
  const allowed = ['proposalId', 'expectedRevision', 'expectedCandidateHash', 'expectedReviewVersion', 'idempotencyKey',
    ...(attempt.kind === 'try' ? ['deviceIds'] : [])];
  if (typeof attempt.path !== 'string' || !new RegExp(`^/api/chat/runs/[^/?#]+/${suffix}$`).test(attempt.path)
      || !body || Object.keys(body).some(key => !allowed.includes(key))
      || typeof body.proposalId !== 'string' || typeof body.expectedCandidateHash !== 'string'
      || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 1
      || !Number.isSafeInteger(body.expectedReviewVersion) || body.expectedReviewVersion < 1
      || typeof body.idempotencyKey !== 'string' || !body.idempotencyKey
      || attempt.kind === 'try' && (!Array.isArray(body.deviceIds) || !body.deviceIds.length || body.deviceIds.some(id => !Number.isInteger(id) || id <= 0))) return null;
  return structuredClone({ kind: attempt.kind, path: attempt.path, body });
}

export function reviewReference(card) {
  if (!isReviewCard(card) || !card.runId || !card.proposalId || !card.workflowId || !card.candidateHash
      || !Number.isInteger(card.revision) || card.revision < 1 || !Number.isSafeInteger(card.reviewVersion) || card.reviewVersion < 1)
    throw new Error('Backend chưa trả đủ thông tin phiên bản. Cấu hình vẫn được giữ, nhưng chưa thể sửa, Try hoặc Accept.');
  return { proposalId: card.proposalId, expectedRevision: card.revision,
    expectedCandidateHash: card.candidateHash, expectedReviewVersion: card.reviewVersion };
}

// Config CLI is fetched again from the owner-authorized Backend after reload.
// Never put saved/unsaved pairs or operation diagnostics in browser storage.
export function historyForStorage(value) {
  return JSON.stringify(value, (key, item) => {
    if (Array.isArray(item?.blocks) && item.blocks.some(b => b?.kind === 'configProposal'))
      return { ...item, text: '', events: [], blocks: item.blocks.map(b => b?.kind === 'configProposal' ? {
        kind: b.kind, version: b.version, proposalId: b.proposalId, workflowId: b.workflowId,
        runId: b.runId, revision: b.revision, reviewVersion: b.reviewVersion, needsHydration: true,
      } : b) };
    if (item?.kind === 'configProposal') return {
      kind: item.kind, version: item.version, proposalId: item.proposalId, workflowId: item.workflowId,
      runId: item.runId, revision: item.revision, reviewVersion: item.reviewVersion, needsHydration: true,
    };
    return item;
  });
}

export class ConfigReview {
  constructor(api, card, { metadata = {}, onChange = () => {}, pollMs = 1200 } = {}) {
    this.api = api; this.card = card; this.onChange = onChange; this.pollMs = pollMs;
    this.drafts = new Map(); this.operation = null; this.error = ''; this.notice = ''; this.loading = false;
    this.active = false; this.disposed = false; this.listeners = new Set(); this.generation = 0;
    this.savedRef = metadata.runId ? metadata : {};
    this.attempt = restoredAttempt(metadata.attempt); // exact retry, never an automatic POST
    if (metadata.unconfirmedSave) this.notice = 'Lần lưu trước chưa nhận được biên nhận. Đã đọc lại bản trên Backend; hãy kiểm tra nội dung trước khi tiếp tục.';
    this.operationId = metadata.operationId || card.pendingOperation?.operationId;
    this.agentOperationId = metadata.agentOperationId;
    this.recovered = false;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit() {
    if (this.disposed) return;
    this.onChange(this.metadata());
    for (const listener of this.listeners) listener();
  }
  metadata() {
    const ref = this.savedRef.runId ? this.savedRef : this.card;
    const result = { runId: ref.runId, workflowId: ref.workflowId, proposalId: ref.proposalId };
    if (this.operationId) result.operationId = this.operationId;
    if (this.agentOperationId) result.agentOperationId = this.agentOperationId;
    if (this.attempt?.kind === 'save' || this.attempt?.kind === 'chat') result.unconfirmedSave = true;
    else if (this.attempt) result.attempt = structuredClone(this.attempt);
    return result;
  }
  activate() {
    if (this.active || this.disposed) return;
    this.active = true;
    if (!this.recovered) { this.recovered = true; void this.refresh(); }
    else void this.refresh();
  }
  pause() { this.active = false; clearTimeout(this.timer); this.readAbort?.abort(); this.generation++; this.loading = false; }
  dispose() { this.pause(); this.disposed = true; this.drafts.clear(); this.attempt = null; this.listeners.clear(); }
  get dirty() { return this.drafts.size > 0; }
  get busy() { return this.posting || this.loading || !!this.attempt || !!this.operationId && !operationDone(this.operation)
    || !!this.card.pendingOperation && !operationDone(this.card.pendingOperation); }
  get unknown() { return this.card.reviewState === 'OutcomeUnknown' || this.operation?.status === 'OutcomeUnknown' || this.operation?.items?.some(i => i.status === 'Unknown'); }
  get mutable() { return !this.busy && !this.externalBusy && !this.unknown && !this.latest && !this.refreshError && !this.card.needsHydration && editableStates.has(this.card.reviewState); }
  get canEdit() { return this.card.version === 3 && this.card.capabilities?.editContent === true && this.mutable; }
  get canAccept() { return this.card.capabilities?.accept === true && this.card.executionAllowed !== false && this.mutable && !this.dirty; }
  canTry(id) { return this.card.version === 3 && this.card.capabilities?.try === true && this.mutable && !this.dirty
    && this.card.targets?.some(t => t.deviceId === id && t.canTry === true && t.rollback?.trim()); }
  pair(id) { return this.drafts.get(id) || this.card.targets?.find(t => t.deviceId === id); }
  edit(id, field, value) {
    if (!this.canEdit || !['deploy', 'rollback'].includes(field)) return;
    const original = this.card.targets?.find(t => t.deviceId === id);
    if (!original || field === 'rollback' && (this.card.capabilities?.editRollback !== true || original.canEditRollback !== true)) return;
    const pair = { deploy: original.deploy, rollback: original.rollback, ...this.drafts.get(id), [field]: value };
    if (lf(pair.deploy) === lf(original.deploy) && lf(pair.rollback) === lf(original.rollback)) this.drafts.delete(id);
    else this.drafts.set(id, pair);
    this.error = ''; this.emit();
  }
  discard(id) { if (this.busy) return; id == null ? this.drafts.clear() : this.drafts.delete(id); this.error = ''; this.emit(); }
  async save(ids = [...this.drafts.keys()]) {
    if (!this.canEdit) return;
    const changes = ids.filter(id => this.drafts.has(id)).map(deviceId => ({ deviceId, ...this.drafts.get(deviceId) }));
    if (!changes.length) return;
    return this.command('save', '/revisions', { ...reviewReference(this.card), mode: 'content', changes });
  }
  async tryDevices(ids) {
    const deviceIds = [...new Set(ids)];
    if (!deviceIds.length || !deviceIds.every(id => this.canTry(id))) return;
    return this.command('try', '/try', { ...reviewReference(this.card), deviceIds });
  }
  async accept() {
    if (!this.canAccept) return;
    return this.command('accept', '/approve', reviewReference(this.card));
  }
  async revise(text) {
    if (!text.trim() || this.dirty || !this.mutable || this.card.capabilities?.reviseByChat !== true) return;
    return this.command('chat', '/revisions', { ...reviewReference(this.card), mode: 'instruction', text });
  }
  async command(kind, suffix, body) {
    this.attempt = { kind, path: `/api/chat/runs/${encodeURIComponent(this.card.runId)}${suffix}`,
      body: { ...body, idempotencyKey: randomId() } };
    this.error = ''; this.notice = ''; this.emit(); // persist refs/key BEFORE sending
    return this.retryReceipt();
  }
  async retryReceipt() {
    if (!this.attempt || this.posting || this.disposed) return;
    const attempt = this.attempt;
    this.posting = true; this.error = ''; this.emit();
    try {
      const receipt = await this.api.request(attempt.path, { method: 'POST', body: attempt.body });
      if (this.disposed) return;
      if (!receipt?.operationId || receipt.workflowId !== this.card.workflowId)
        throw new Error('Biên nhận không hợp lệ. Chưa xác định được kết quả lần gửi.');
      this.operationId = receipt.operationId; this.operation = receipt; this.attempt = null;
      if (attempt.kind === 'chat') this.agentOperationId = receipt.operationId;
      if (attempt.kind === 'save' && receipt.status === 'Succeeded') {
        // Only clear buffers for pairs the server has confirmed saving.
        for (const change of attempt.body.changes) this.drafts.delete(change.deviceId);
        this.notice = receipt.result?.status === 'Unchanged' ? 'Nội dung không đổi.' : 'Đã lưu cặp cấu hình trực tiếp.';
        this.ownSavedProposal = receipt.result?.proposal?.proposalId;
      }
      this.emit();
      if (operationDone(receipt)) await this.finish(receipt);
      else this.schedule(0);
    } catch (error) {
      if (this.disposed) return;
      // 4xx admissions are definitive; 5xx/network/lost JSON may have committed.
      if (error.status >= 400 && error.status < 500 && ![408].includes(error.status)) this.attempt = null;
      this.error = error.status === 409
        ? `${error.message} · Bản cấu hình đã thay đổi hoặc đang xử lý. Chỉnh sửa của bạn vẫn được giữ; đọc lại bản mới để đối chiếu.`
        : `${error.message || 'Mất kết nối.'}${this.attempt ? ' Chưa rõ kết quả; lấy lại biên nhận bằng đúng lần gửi này.' : ' Nội dung đang sửa vẫn được giữ.'}`;
    } finally { this.posting = false; this.emit(); }
  }
  schedule(ms = this.pollMs) {
    clearTimeout(this.timer);
    if (this.active && !this.disposed) this.timer = setTimeout(() => void this.poll(), ms);
  }
  async poll() {
    if (!this.operationId || this.reading || !this.active || this.disposed) return;
    if (this.loading) { this.schedule(); return; }
    this.reading = true;
    const generation = this.generation;
    const controller = new AbortController(); this.readAbort = controller;
    try {
      const operation = await this.api.request(`/api/chat/config-operations/${encodeURIComponent(this.operationId)}`, { signal: controller.signal });
      if (this.disposed || generation !== this.generation) return;
      if (operation.operationId !== this.operationId || operation.workflowId !== this.card.workflowId) throw new Error('Kết quả operation không khớp.');
      this.operation = operation; this.error = ''; this.emit();
      if (operationDone(operation)) await this.finish(operation);
      else this.schedule();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.error = `Chưa đọc được tiến trình: ${error.message}. Không gửi lại thao tác thực thi.`; this.emit();
      if (![401, 403, 404].includes(error.status)) this.schedule(Math.max(3000, error.retryAfter || 0));
    } finally { this.reading = false; if (generation === this.generation) this.emit(); }
  }
  async finish(operation) {
    if (operation.result?.proposal) this.savedRef = { ...operation.result.proposal, workflowId: operation.workflowId };
    if (operation.result?.status === 'Created') this.notice = `Đã tạo Config Setup Draft · ${operation.result.configSetupId || ''}.`;
    else if (operation.status === 'Failed') this.notice = `Thao tác chưa hoàn tất · ${operation.error?.code || 'Xem kết quả từng thiết bị'}.`;
    else if (operation.status === 'OutcomeUnknown') this.notice = 'Chưa xác định được kết quả. Cần đối soát trước khi thử lại; không gửi lại TRY/CREATE.';
    if (operation.kind === 'revision' && operation.runId
        && (operation.operationId === this.agentOperationId || operation.result?.status === 'NoRevision')) {
      try { const response = await this.api.getResponse(operation.runId); if (!this.disposed) this.agentReply = response.text || ''; }
      catch { this.notice = 'AI chưa tạo phiên bản mới. Chưa đọc được lời trả lời; bạn có thể đọc lại tiến trình.'; }
    }
    await this.refresh();
  }
  async refresh() {
    if (this.disposed) return;
    if (this.refreshTask) { this.refreshQueued = true; return this.refreshTask; }
    this.refreshTask = (async () => {
      do { this.refreshQueued = false; await this.loadCurrent(); }
      while (this.refreshQueued && !this.disposed);
    })();
    try { await this.refreshTask; } finally { this.refreshTask = null; }
  }
  async loadCurrent() {
    if (this.disposed) return;
    this.loading = true; this.emit();
    const generation = this.generation, controller = new AbortController(); this.readAbort = controller;
    try {
      const workflowId = this.savedRef.workflowId || this.card.workflowId;
      let card;
      if (workflowId) {
        try {
          const history = await this.api.request(`/api/chat/config-workflows/${encodeURIComponent(workflowId)}?offset=0&limit=20`, { signal: controller.signal });
          if (history.workflowId !== workflowId || history.current?.workflowId !== workflowId) throw new Error('Workflow không khớp.');
          // `current` is a concrete ConfigProposalBlock DTO. System.Text.Json only
          // emits `kind` when it serializes the polymorphic presentationBlocks list.
          // Supply this known endpoint's type label; never invent refs/capabilities.
          if (history.current.kind != null && history.current.kind !== 'configProposal') throw new Error('Loại bản cấu hình không khớp.');
          this.history = history; card = { ...history.current, kind: 'configProposal' };
        } catch (error) {
          if (this.card.version !== 2 || ![404, 405].includes(error.status)) throw error;
          // V2 servers predate the workflow/history endpoint; keep their reader and CAS contract.
          const response = await this.api.getResponse(this.savedRef.runId || this.card.runId, controller.signal);
          card = response.presentationBlocks?.find(b => isReviewCard(b) && b.workflowId === workflowId);
        }
      } else {
        const response = await this.api.getResponse(this.savedRef.runId || this.card.runId, controller.signal);
        card = response.presentationBlocks?.find(isReviewCard);
      }
      if (this.disposed || generation !== this.generation) return;
      reviewReference(card);
      if (this.dirty && !samePairRevision(card, this.card) && card.proposalId !== this.ownSavedProposal) this.latest = card;
      else {
        this.card = card; this.latest = null;
        this.savedRef = { runId: card.runId, workflowId: card.workflowId, proposalId: card.proposalId };
        if (card.pendingOperation) {
          this.operationId = card.pendingOperation.operationId;
          if (this.operation?.operationId !== this.operationId) this.operation = card.pendingOperation;
        }
      }
      this.refreshError = ''; this.error = this.attempt ? this.error : '';
      this.refreshedAt = Date.now();
      this.ownSavedProposal = null;
      if (this.operationId && !operationDone(this.operation)) this.schedule(0);
    } catch (error) {
      if (generation === this.generation && !this.disposed) this.refreshError = `Không thể làm mới trạng thái. ${error.message}`;
    } finally { if (generation === this.generation) { this.loading = false; this.emit(); } }
  }
  useLatest() {
    if (!this.latest || this.busy) return;
    this.drafts.clear(); this.card = this.latest; this.latest = null; this.error = '';
    this.savedRef = { runId: this.card.runId, workflowId: this.card.workflowId, proposalId: this.card.proposalId };
    if (this.card.pendingOperation) {
      this.operation = this.card.pendingOperation; this.operationId = this.operation.operationId; this.schedule(0);
    }
    this.emit();
  }
  async reconcile() {
    if (this.posting || !this.unknown || this.operation?.kind !== 'accept'
        || this.operation?.error?.code !== 'CREATE_OUTCOME_UNKNOWN') return;
    this.posting = true; this.emit();
    try {
      await this.api.request(`/api/chat/runs/${encodeURIComponent(this.card.runId)}/config-setup/reconcile`, { method: 'POST' });
      await this.poll(); await this.refresh();
    } catch (error) { this.error = `Chưa đối soát được CREATE: ${error.message}`; }
    finally { this.posting = false; this.emit(); }
  }
}
