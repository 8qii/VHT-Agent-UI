import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatApi, promptBody, citationLabel, libraryDownloadPath, fileSettled, canAskAbout, documentType } from '../public/core.js';

const id = '11111111-1111-4111-8111-111111111111';

test('upload sends one multipart file with Idempotency-Key and no manual Content-Type', async () => {
  const calls = [];
  const client = new ChatApi('/backend/goose', { 'X-Demo-User': 'owner' }, async (url, options) => { calls.push({ url, options }); return Response.json({ file: { id } }, { status: 201 }); });
  const file = new File(['%PDF-1.4'], 'mau.pdf', { type: 'application/pdf' });
  const result = await client.uploadDocument(file, 'upload-key-1');
  assert.equal(result.file.id, id);
  assert.equal(calls[0].url, '/backend/goose/api/library/uploads');
  assert.equal(calls[0].options.headers['Idempotency-Key'], 'upload-key-1');
  assert.equal(calls[0].options.headers['X-Demo-User'], 'owner');
  assert.equal(calls[0].options.headers['Content-Type'], undefined);
  assert.equal([...calls[0].options.body.keys()].join(), 'file');
});

test('attachment endpoints and Problem Details code', async () => {
  const calls = [];
  const client = new ChatApi('', {}, async (url, options) => {
    calls.push(`${options.method} ${url}`);
    if (options.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith('/prompts')) return Response.json({ title: 'Document question answering is not enabled', status: 503, code: 'DOCUMENT_QA_NOT_ENABLED' }, { status: 503 });
    return Response.json({ items: [] });
  });
  await client.attach('s1', id); await client.listAttachments('s1'); assert.equal(await client.detach('s1', id), null);
  await assert.rejects(client.submit('s1', { text: 'hỏi', key: 'k', attachmentFileIds: [id] }), error => error.status === 503 && error.code === 'DOCUMENT_QA_NOT_ENABLED');
  assert.deepEqual(calls.slice(0, 3), [`PUT /api/chat/sessions/s1/attachments/${id}`, 'GET /api/chat/sessions/s1/attachments', `DELETE /api/chat/sessions/s1/attachments/${id}`]);
  await assert.rejects(client.request('/api/admin/x'), /Unsupported API path/);
});

test('text-only prompts keep the old body; document prompts add attachmentFileIds', () => {
  assert.deepEqual(promptBody({ text: 'a', key: 'k' }), { text: 'a', idempotencyKey: 'k' });
  assert.deepEqual(promptBody({ text: 'a', key: 'k', attachmentFileIds: [] }), { text: 'a', idempotencyKey: 'k' });
  assert.deepEqual(promptBody({ text: 'a', key: 'k', attachmentFileIds: [id] }), { text: 'a', idempotencyKey: 'k', attachmentFileIds: [id] });
});

test('citation locations render as page, paragraph or table', () => {
  assert.equal(citationLabel({ kind: 'pdf_page', pageNumber: 3 }), 'Trang 3');
  assert.equal(citationLabel({ kind: 'docx_paragraph', paragraphNumber: 12, headingPath: ['Chương 2', 'Phê duyệt'] }), 'Đoạn 12 · Chương 2 › Phê duyệt');
  assert.equal(citationLabel({ kind: 'docx_table', tableNumber: 1, rowNumber: null }), 'Bảng 1');
  assert.equal(citationLabel({ kind: 'docx_table', tableNumber: 1, rowNumber: 4 }), 'Bảng 1, dòng 4');
  assert.equal(citationLabel(null), 'Không rõ vị trí');
});

test('only backend library download paths and ready files with QA enabled are usable', () => {
  assert.equal(libraryDownloadPath(`/api/library/files/${id}/download`), `/api/library/files/${id}/download`);
  assert.equal(libraryDownloadPath('https://evil.test/a.pdf'), null);
  assert.equal(documentType({ name: 'A.PDF' }), 'pdf'); assert.equal(documentType({ name: 'a.doc' }), null);
  assert.equal(fileSettled({ availability: 'pending', agentRead: { status: 'not_supported' } }), false);
  assert.equal(fileSettled({ availability: 'available', agentRead: { status: 'processing' } }), false);
  assert.equal(fileSettled({ availability: 'available', agentRead: { status: 'not_supported' } }), true);
  assert.equal(canAskAbout({ agentRead: { status: 'ready' } }, { agentRead: { enabled: false } }), false);
  assert.equal(canAskAbout({ agentRead: { status: 'ready' } }, { agentRead: { enabled: true } }), true);
  assert.equal(canAskAbout({ agentRead: { status: 'not_supported' } }, { agentRead: { enabled: true } }), false);
});
