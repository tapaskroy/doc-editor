'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-editor-assets-'));
process.env.DOC_EDITOR_ASSETS_DIR = TMP;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const attachments = require('../../lib/attachments');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// 1x1 transparent PNG.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('classify recognizes images, pdf, text, and docs', () => {
  assert.equal(attachments.classify('a.png', 'image/png'), 'image');
  assert.equal(attachments.classify('a.PDF', ''), 'pdf');
  assert.equal(attachments.classify('notes.md', ''), 'text');
  assert.equal(attachments.classify('report.docx', ''), 'doc');
  assert.equal(attachments.classify('mystery.bin', ''), 'other');
});

test('store writes the file and returns metadata with a media URL', () => {
  const att = attachments.store('doc123', { name: 'pic.png', type: 'image/png', dataBase64: PNG_B64 });
  assert.equal(att.kind, 'image');
  assert.match(att.url, /^\/media\/doc123\//);
  assert.ok(fs.existsSync(attachments.mediaFile('doc123', att.storedName)));
  assert.ok(att.refPath.endsWith(att.storedName)); // image is read directly
});

test('referenceBlock lists files and gives images an exact embed URL', () => {
  const block = attachments.referenceBlock('doc123', [
    { kind: 'image', name: 'pic.png', refPath: '/abs/pic.png', url: '/media/doc123/pic.png' },
    { kind: 'doc', name: 'spec.docx', refPath: '/abs/spec.md' },
  ]);
  assert.match(block, /\[image\] "pic\.png"/);
  assert.match(block, /!\[concise alt text\]\(\/media\/doc123\/pic\.png\)/);
  assert.match(block, /\[document\] "spec\.docx"/);
  assert.equal(attachments.referenceBlock('d', []), ''); // none -> empty
});

test('remove deletes the stored file', () => {
  const att = attachments.store('docDel', { name: 'x.png', type: 'image/png', dataBase64: PNG_B64 });
  assert.ok(fs.existsSync(attachments.mediaFile('docDel', att.storedName)));
  attachments.remove('docDel', att.storedName);
  assert.equal(fs.existsSync(attachments.mediaFile('docDel', att.storedName)), false);
});
