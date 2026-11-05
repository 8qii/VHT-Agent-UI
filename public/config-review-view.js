const el = (tag, cls, text) => {
  const node = document.createElement(tag); if (cls) node.className = cls;
  if (text != null) node.textContent = String(text); return node;
};
const control = (label, handler, disabled = false, cls = '') => {
  const node = el('button', `config-button ${cls}`, label); node.type = 'button';
  node.disabled = disabled; node.addEventListener('click', handler); return node;
};
const states = { Ready: 'Sẵn sàng review', ReviewOnly: 'Đang review', Trying: 'Đang Try', Accepting: 'Đang Accept',
  Executing: 'Đang TRY / CREATE', Created: 'Đã tạo Config Setup Draft', Revising: 'Đang sửa bằng AI',
  Superseded: 'Đã có phiên bản mới', OutcomeUnknown: 'Cần đối soát', ValidationFailed: 'Cần xem lại kết quả' };
const statuses = { Queued: 'Đang chờ', Ready: 'Đã kiểm tra nguồn', Dispatching: 'Đang Try', Passed: 'Try thành công',
  Failed: 'Không thành công', Unknown: 'Chưa xác định · cần đối soát', NotRun: 'Chưa gửi Try', Stale: 'Kết quả của cặp cũ',
  Pending: 'Đang chờ', Running: 'Đang xử lý', Succeeded: 'Hoàn tất', OutcomeUnknown: 'Chưa xác định · cần đối soát' };

// Rendering the surrounding chat must not interrupt a CLI edit or its scroll position.
export function captureConfigFocus(root = document) {
  const node = document.activeElement;
  return node?.matches('[data-config-editor]') && root.contains(node)
    ? { node, start: node.selectionStart, end: node.selectionEnd, top: node.scrollTop } : null;
}
export function restoreConfigFocus(focus, root = document) {
  if (!focus) return;
  const node = focus.node.isConnected ? focus.node : [...root.querySelectorAll('[data-config-editor]')]
    .find(n => n.dataset.configEditor === focus.node.dataset.configEditor);
  if (node && !node.disabled) { node.focus({ preventScroll: true }); node.setSelectionRange(focus.start, focus.end); node.scrollTop = focus.top; }
}

export function createConfigReviewView(review) {
  const root = el('section', 'block config-review');
  root.setAttribute('aria-label', 'Device Config');
  const opened = new Map(), editors = new Set(), panelStates = new Map();
  let filter = 'all', typing = false;
  function render() {
    if (typing) { sync(); return; }
    const focus = captureConfigFocus(root), card = review.card;
    for (const panel of root.querySelectorAll('details[data-panel]')) panelStates.set(panel.dataset.panel, panel.open);
    root.replaceChildren(); root.dataset.workflowId = card.workflowId || '';
    const title = el('div', 'block-title config-title');
    title.append(el('strong', '', `Device Config · revision ${card.revision ?? '—'}`),
      el('span', 'config-state', review.refreshError ? 'Chưa tải được trạng thái' : review.loading ? 'Đang cập nhật trạng thái' : states[card.reviewState] || 'Đang đọc bản đã lưu'));
    root.append(title);
    const intro = el('div', 'block-content');
    intro.append(el('p', '', card.summary || 'Các cặp cấu hình đã lưu trên Backend.'));
    if (card.origin) intro.append(el('small', '', `${card.origin}${card.editedAt ? ` · ${new Date(card.editedAt).toLocaleString('vi-VN')}` : ''}`));
    const coverage = card.targetCoverage;
    if (coverage) intro.append(el('p', 'config-coverage', `${coverage.requestedCount} thiết bị · ${coverage.executableCount} có cấu hình · ${coverage.unchangedCount} không cần đổi · ${coverage.blockedCount} còn thiếu`));
    root.append(intro);
    const toolbar = el('div', 'config-toolbar');
    const refresh = control(review.loading ? 'Đang làm mới…' : 'Làm mới trạng thái', () => review.refresh(), review.loading || review.posting);
    refresh.title = 'Tải trạng thái và bản cấu hình mới nhất. Không lưu chỉnh sửa, không Try và không gọi AI.';
    toolbar.append(refresh);
    if (card.version === 3) {
      toolbar.append(control('Lưu tất cả', () => review.save(), false, 'config-save-all'),
        control('Try tất cả', () => review.tryDevices((review.card.targets || []).map(t => t.deviceId)), false, 'config-try-all'));
      const select = el('select', 'config-filter'); select.setAttribute('aria-label', 'Lọc thiết bị cấu hình');
      for (const [value, label] of [['all', 'Tất cả thiết bị'], ['dirty', 'Đang sửa'], ['issues', 'Lỗi / chưa đủ cấu hình']]) {
        const option = el('option', '', label); option.value = value; select.append(option);
      }
      select.value = filter; select.addEventListener('change', () => { filter = select.value; render(); }); toolbar.append(select);
    }
    root.append(toolbar);
    if (card.version === 3) root.append(el('p', 'config-toolbar-help', 'Lưu tất cả: lưu các cặp vừa sửa. Try tất cả: kiểm tra các cặp đã lưu.'));
    if (review.readOnlyReason) root.append(el('p', 'block-notice', review.readOnlyReason));
    const live = el('div', 'config-feedback'); live.setAttribute('aria-live', 'polite'); root.append(live);
    if (review.latest) {
      const conflict = el('div', 'error-note', `Backend đã có revision ${review.latest.revision}. Nội dung đang sửa vẫn giữ ở bản bạn đã mở.`);
      conflict.append(control('Dùng bản mới và bỏ chỉnh sửa', () => review.useLatest(), review.busy)); root.append(conflict);
    }
    if (review.attempt) root.append(control('Lấy lại biên nhận lần gửi', () => review.retryReceipt(), review.posting, 'config-retry-receipt'));
    if (review.loading && !card.targets) root.append(el('p', 'block-content', 'Đang đọc cấu hình từ Backend…'));
    const targets = card.targets || [];
    for (const target of targets) {
      const item = review.operation?.items?.find(i => i.deviceId === target.deviceId && i.pairHash === target.pairHash);
      const observation = item || target.lastTry;
      const issue = !target.rollback?.trim() || ['Failed', 'Unknown', 'Stale', 'NotRun'].includes(observation?.status);
      if (filter === 'dirty' && !review.drafts.has(target.deviceId) || filter === 'issues' && !issue) continue;
      const detail = el('details', 'config-target'); detail.dataset.deviceId = target.deviceId;
      detail.open = opened.get(target.deviceId) ?? targets.length <= 3;
      detail.addEventListener('toggle', () => { if (detail.isConnected) opened.set(target.deviceId, detail.open); });
      const heading = el('summary', 'config-target-title');
      heading.append(el('strong', '', `${target.deviceName} · ID ${target.deviceId}`), el('span', 'config-dirty', ''));
      if (observation) heading.append(el('span', 'config-pair-status', statuses[observation.status] || observation.status));
      detail.append(heading);
      const content = el('div', 'config-target-body'), pair = review.pair(target.deviceId);
      const panes = el('div', 'config-panes');
      for (const [field, label] of [['deploy', 'Config'], ['rollback', 'Rollback config']]) {
        const pane = el('div', 'config-pane'), head = el('div', 'config-pane-title');
        const editorKey = `${card.workflowId}:${target.deviceId}:${field}`;
        head.append(el('strong', '', label));
        const canEdit = review.canEdit && (field !== 'rollback' || card.capabilities?.editRollback && target.canEditRollback);
        head.append(control(`✎ Sửa ${field === 'deploy' ? 'config' : 'rollback'}`, () => { editors.add(editorKey); opened.set(target.deviceId, true); render();
          root.querySelectorAll('[data-config-editor]').forEach(n => { if (n.dataset.configEditor === editorKey) n.focus({ preventScroll: true }); }); }, !canEdit, 'config-edit'));
        pane.append(head);
        if (editors.has(editorKey)) {
          const input = el('textarea', 'config-editor'); input.value = pair[field] || '';
          input.dataset.configEditor = editorKey; input.setAttribute('aria-label', `${label} · ${target.deviceName}`);
          input.spellcheck = false; input.autocapitalize = 'off'; input.autocomplete = 'off'; input.wrap = 'off'; input.disabled = !canEdit;
          input.addEventListener('input', () => { typing = true; review.edit(target.deviceId, field, input.value); typing = false; });
          pane.append(input);
        } else pane.append(el('pre', 'config-code', pair[field] || (field === 'rollback' ? 'Chưa có rollback' : 'Chưa có config')));
        panes.append(pane);
      }
      content.append(panes, el('p', 'config-edit-hint', ''));
      if (card.version === 3) {
        const actions = el('div', 'config-pair-actions');
        actions.append(control('Lưu cặp', () => review.save([target.deviceId]), false, 'config-save'),
          control('Bỏ chỉnh sửa', () => review.discard(target.deviceId), false, 'config-discard'),
          control('Try cặp này', () => review.tryDevices([target.deviceId]), false, 'config-try'));
        content.append(actions);
      }
      if (observation) {
        const result = el('div', 'config-result');
        result.append(el('strong', '', statuses[observation.status] || observation.status));
        if (observation.message) result.append(el('p', '', observation.message));
        if (observation.errorCode) result.append(el('code', '', observation.errorCode));
        if (observation.baselineCheckedAt) result.append(el('p', '', `Đối chiếu nguồn: ${new Date(observation.baselineCheckedAt).toLocaleString('vi-VN')} · Độ mới: ${observation.baselineFreshness || 'Unknown'}`));
        content.append(result);
      }
      const source = el('details', 'config-source'); source.dataset.panel = `source:${target.deviceId}`; source.append(el('summary', '', 'Baseline và diff'));
      source.append(el('p', '', `Baseline: ${target.baselineStatus || 'chưa biết'} · Rollback: ${target.rollbackStatus || 'chưa biết'}`),
        el('pre', 'config-code', (target.diff || []).join('\n') || 'Chưa có diff'));
      if (target.rollbackReason) source.append(el('p', '', target.rollbackReason));
      content.append(source); detail.append(content); root.append(detail);
    }
    for (const target of card.requestedTargets || []) {
      if (!targets.some(t => t.deviceId === target.deviceId)) root.append(el('div', 'config-omitted', `${target.deviceName} · ID ${target.deviceId} · ${target.status === 'unchanged' ? 'Không cần thay đổi' : 'Chưa có cấu hình'}${target.reason ? ` · ${target.reason}` : ''}`));
    }
    if (targets.length && !root.querySelector('.config-target')) root.append(el('p', 'block-content', 'Không có thiết bị khớp bộ lọc.'));
    if (review.operation) {
      const op = review.operation, panel = el('div', 'config-operation'); panel.setAttribute('aria-live', 'polite');
      panel.append(el('strong', '', `${op.kind === 'accept' ? 'Accept' : op.kind === 'revision' ? 'Lưu / sửa' : 'Try'} · ${statuses[op.status] || op.status}`));
      panel.append(el('p', '', `${op.currentStage || 'Đã nhận thao tác'}${op.total != null ? ` · ${op.completed ?? 0}/${op.total} cặp` : ''}`));
      if (op.error?.code) panel.append(el('code', '', op.error.code));
      if (op.result?.configSetupId) panel.append(el('p', '', `Config Setup: ${op.result.configSetupId} · ${op.result.upstreamStatus || 'Draft'}`));
      panel.append(el('small', '', `Operation: ${op.operationId}`));
      panel.append(control('Đọc lại tiến trình', () => review.poll(), review.reading)); root.append(panel);
    }
    if (review.unknown) {
      const unknown = el('div', 'error-note', 'Kết quả chưa xác định. Giữ nguyên bản đã lưu và chờ đối soát; không thử gửi lại TRY/CREATE.');
      if (review.operation?.kind === 'accept' && review.operation?.error?.code === 'CREATE_OUTCOME_UNKNOWN')
        unknown.append(control('Đối soát CREATE', () => review.reconcile(), review.posting));
      else unknown.append(el('p', '', 'TRY chưa có API đối soát tự động. Cần kiểm tra candidate/cleanup với người vận hành.'));
      root.append(unknown);
    }
    const footer = el('div', 'config-footer');
    footer.append(el('p', '', 'Try dùng cặp đã lưu. Accept sẽ TRY lại tất cả rồi tạo một Config Setup Draft khi tất cả đạt.'));
    footer.append(el('small', '', 'Upstream chưa trả kết quả kiểm chứng rollback riêng.'));
    footer.append(control('Accept · TRY và tạo Draft', () => review.accept(), false, 'config-accept'));
    if (card.executionAllowed === false && card.executionBlockReason) footer.append(el('p', 'config-block-reason', card.executionBlockReason));
    if (card.version === 2) footer.append(el('p', '', 'Proposal V2: xem và Accept theo contract cũ. Sửa cặp trực tiếp và Try riêng cần proposal V3 từ Backend.'));
    root.append(footer);
    if (review.agentReply) root.append(el('div', 'block-content config-agent-reply', review.agentReply));
    if (card.capabilities?.reviseByChat) {
      const chat = el('details', 'config-chat'); chat.dataset.panel = 'chat'; chat.append(el('summary', '', 'Yêu cầu AI sửa bản cấu hình này'));
      const input = el('textarea', 'config-chat-input'); input.setAttribute('aria-label', 'Yêu cầu AI sửa cấu hình');
      input.dataset.configEditor = `${card.workflowId}:chat`; input.value = review.chatText || '';
      input.addEventListener('input', () => { review.chatText = input.value; });
      chat.append(input, control('Gửi yêu cầu sửa bằng AI', () => review.revise(input.value), review.dirty || !review.mutable)); root.append(chat);
    }
    const history = el('details', 'config-history'); history.dataset.panel = 'history'; history.append(el('summary', '', 'Lịch sử phiên bản'));
    for (const revision of review.history?.revisions || []) {
      history.append(el('p', '', `r${revision.proposal.revision} · ${revision.origin || 'Agent'} · ${new Date(revision.createdAt).toLocaleString('vi-VN')}${revision.configSetupId ? ` · Setup ${revision.configSetupId}` : ''}`));
    }
    if (!review.history) history.append(el('p', '', 'Bấm Làm mới trạng thái để tải lịch sử.'));
    if (review.history?.nextOffset != null) history.append(el('p', '', 'Đang hiển thị 20 phiên bản gần nhất.'));
    root.append(history);
    for (const text of [...(card.warnings || []), ...(card.limitations || [])]) root.append(el('div', 'block-notice', text));
    for (const panel of root.querySelectorAll('details[data-panel]')) panel.open = panelStates.get(panel.dataset.panel) || false;
    sync(); restoreConfigFocus(focus, root);
  }
  function sync() {
    const feedback = root.querySelector('.config-feedback'); feedback.replaceChildren();
    for (const text of [review.error, review.refreshError, review.notice, review.dirty ? `${review.drafts.size} cặp chưa lưu. Lưu trước khi Try hoặc Accept.` : '']) {
      if (text) feedback.append(el('p', review.error === text || review.refreshError === text ? 'config-error' : '', text));
    }
    if (!review.loading && !review.refreshError && !review.dirty && review.canEdit)
      feedback.append(el('p', 'config-idle-hint', 'Chưa có chỉnh sửa cần lưu. Bạn có thể bấm ✎ để sửa Config/Rollback, hoặc Try để kiểm tra bản hiện tại.'));
    if (review.refreshedAt && !review.loading && !review.refreshError)
      feedback.append(el('p', 'config-refresh-result', `Đã làm mới trạng thái lúc ${new Date(review.refreshedAt).toLocaleTimeString('vi-VN')}.`));
    const blocked = review.refreshError ? 'Chưa tải được trạng thái cấu hình. Bấm Làm mới trạng thái để thử kết nối lại.'
      : review.loading ? 'Đang tải trạng thái mới nhất.'
      : review.readOnlyReason || (review.unknown ? 'Kết quả lần trước chưa xác định; cần đối soát trước khi tiếp tục.'
        : review.busy ? 'Có thao tác đang xử lý; hãy đợi hoàn tất.'
          : review.latest ? 'Đã có phiên bản mới; đối chiếu trước khi thao tác.' : 'Backend chưa cho phép thao tác này.');
    const save = root.querySelector('.config-save-all'); if (save) {
      save.disabled = !review.canEdit || !review.dirty;
      save.title = !review.canEdit ? blocked : !review.dirty ? 'Chưa có chỉnh sửa cần lưu.' : `Lưu ${review.drafts.size} cặp đã sửa, không gọi AI.`;
    }
    const tryAll = root.querySelector('.config-try-all'); if (tryAll) {
      tryAll.disabled = !review.card.targets?.length || !review.card.targets.every(t => review.canTry(t.deviceId));
      tryAll.title = review.dirty ? 'Lưu các chỉnh sửa trước khi Try.' : tryAll.disabled ? blocked : 'Try tất cả các cặp đã lưu; chưa tạo Config Setup.';
    }
    const accept = root.querySelector('.config-accept'); accept.disabled = !review.canAccept;
    accept.title = review.dirty ? 'Lưu các chỉnh sửa trước khi Accept.' : accept.disabled ? blocked : 'Backend TRY lại toàn bộ, rồi tạo một Config Setup Draft khi tất cả đạt.';
    for (const detail of root.querySelectorAll('.config-target')) {
      const id = Number(detail.dataset.deviceId), draft = review.drafts.get(id), original = review.card.targets.find(t => t.deviceId === id);
      detail.querySelector('.config-dirty').textContent = draft ? 'Chưa lưu' : '';
      detail.querySelector('.config-edit-hint').textContent = draft && draft.deploy !== original.deploy && draft.rollback === original.rollback
        ? 'Config đã thay đổi; hãy xem lại rollback trước khi Try/Accept.' : !(review.pair(id)?.rollback || '').trim() ? 'Thiếu rollback: vẫn lưu được, chưa thể Try/Accept cặp này.' : '';
      const savePair = detail.querySelector('.config-save'); if (savePair) savePair.disabled = !draft || !review.canEdit;
      const discard = detail.querySelector('.config-discard'); if (discard) discard.disabled = !draft || review.busy;
      const tryPair = detail.querySelector('.config-try'); if (tryPair) tryPair.disabled = !review.canTry(id);
      if (savePair) savePair.title = !review.canEdit ? blocked : !draft ? 'Cặp này chưa có chỉnh sửa cần lưu.' : 'Lưu cả Config và Rollback của thiết bị này.';
      if (discard) discard.title = !draft ? 'Cặp này chưa có chỉnh sửa.' : 'Bỏ phần đang sửa, giữ bản đã lưu.';
      if (tryPair) tryPair.title = review.dirty ? 'Lưu các chỉnh sửa trước khi Try.' : tryPair.disabled ? blocked : 'Try cặp đã lưu của thiết bị này; chưa tạo Config Setup.';
      for (const edit of detail.querySelectorAll('.config-edit')) edit.title = edit.disabled ? blocked : 'Sửa nội dung trong giao diện, sau đó bấm Lưu cặp hoặc Lưu tất cả.';
    }
    const chat = root.querySelector('.config-chat button'); if (chat) chat.disabled = review.dirty || !review.mutable;
  }
  review.subscribe(render); render();
  return root;
}
