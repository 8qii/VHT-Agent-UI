// Private owner-authorized trace stays in memory, never in the public chat reducer/storage.
export const TRACE_ITEM_LIMIT = 1000, TRACE_BYTE_LIMIT = 8 * 1024 * 1024;
export function mergeTracePage(cache, page) {
  if (!Array.isArray(page?.items)) throw new Error('INVALID_TRACE_RESPONSE');
  const next = { items: [], bytes: 0, cursor: 0, ...cache, captureStatus: page.captureStatus, error: '' };
  const seen = new Set(next.items.map(e => e.sequence));
  for (const event of page.items) {
    if (seen.has(event.sequence)) continue;
    const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
    if (next.items.length >= TRACE_ITEM_LIMIT || next.bytes + bytes > TRACE_BYTE_LIMIT) { next.limited = true; break; }
    next.items = [...next.items, event]; next.bytes += bytes; next.cursor = event.sequence; seen.add(event.sequence);
  }
  next.hasMore = page.nextAfterSequence != null;
  next.truncated = page.truncated === true;
  return next;
}
const parse = value => {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};
export function displayTrace(value, limit = 160000) {
  const parsed = parse(value);
  const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2) ?? '';
  return text.length > limit ? text.slice(0, limit) + '\n… [Nội dung hiển thị đã giới hạn]' : text;
}
const contentText = message => typeof message?.content === 'string' ? message.content : (Array.isArray(message?.content) ? message.content : []).map(b => b.type === 'text' ? displayTrace(b.text) : displayTrace(b)).join('\n\n');
export function traceStep(items = [], span) {
  if (span.stage === 'model') {
    const id = (span.modelCallId || '').replace(/^activity-model-/, 'model-');
    const requests = items.filter(e => e.kind === 'model.request' && e.modelCallId === id);
    if (requests.length !== 1) return { title: 'Model', missing: requests.length > 1 ? 'Có nhiều binding trùng ID; chưa thể ghép chắc chắn.' : 'Chưa có bản ghi prompt cho bước này.' };
    const request = requests[0], binding = e => e.runtimeRequestId === request.runtimeRequestId && e.runtimeSessionId === request.runtimeSessionId;
    const end = items.find(e => e.sequence > request.sequence && binding(e) && e.kind === 'model.request');
    const following = items.filter(e => e.sequence > request.sequence && (!end || e.sequence < end.sequence) && binding(e));
    const output = following.filter(e => e.kind === 'assistant/message').map(e => ({ content: e.data?.message?.content, usage: e.data?.usage }));
    return { title: `Model · ${request.data?.model || 'chưa rõ model'}`, sections: [
      ['Prompt / messages gửi LLM', displayTrace((request.data?.messages || []).map((m,i) => `[${i+1}] ${(m.role || m.source?.kind || 'message').toUpperCase()}\n${contentText(m)}`).join('\n\n────────────────────\n\n'))],
      ['Cấu hình và tool schemas gửi LLM', displayTrace({ provider: request.data?.provider, model: request.data?.model, maxTokens: request.data?.maxTokens, tools: request.data?.tools })],
      ['Model trả về (text / yêu cầu tool)', output.length ? output.map(m => contentText(m) + (m.usage ? '\n\nTokens: ' + displayTrace(m.usage) : '')).join('\n\n') : 'Chưa ghi nhận đầu ra.'],
    ], truncated: request.truncated || following.some(e => e.truncated) };
  }
  const calls = items.filter(e => e.kind === 'tool/call' && e.data?.callId === span.toolCallId);
  if (calls.length !== 1) return { title: span.toolName || 'Tool', missing: calls.length > 1 ? 'Trùng call ID giữa các binding; chưa thể ghép chắc chắn.' : 'Chưa có bản ghi tham số cho bước này.' };
  const call = calls[0], args = parse(call.data.arguments);
  const result = items.find(e => e.kind === 'tool/result' && e.runtimeRequestId === call.runtimeRequestId && e.runtimeSessionId === call.runtimeSessionId && e.data?.message?.toolCallId === span.toolCallId);
  const name = call.data.name || span.toolName;
  const suffix = name === 'create_mcp' && args?.kind ? ` · ${args.kind}` : name === 'skill' && args?.name ? ` · ${args.name}` : '';
  return { title: name + suffix, description: name === 'create_mcp' ? `Nạp nhóm công cụ ${args?.kind || 'được yêu cầu'} và các nhóm phụ thuộc.` : name === 'skill' ? `Đọc hướng dẫn kỹ năng ${args?.name || 'được yêu cầu'}.` : '', failed: result?.data?.message?.isError === true,
    sections: [['Tham số gọi tool', displayTrace(args)], ['Kết quả tool trả về', result ? contentText(result.data.message) : 'Đang chờ kết quả / chưa có bản ghi kết quả.']],
    truncated: call.truncated || result?.truncated };
}
