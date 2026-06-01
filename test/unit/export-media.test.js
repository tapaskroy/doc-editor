'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-editor-exmedia-'));
process.env.DOC_EDITOR_ASSETS_DIR = TMP;

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const attachments = require('../../lib/attachments');
const { buildHtml } = require('../../lib/export');

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('buildHtml inlines /media images as data URIs for portability', () => {
  const att = attachments.store('expdoc', { name: 'pic.png', type: 'image/png', dataBase64: PNG_B64 });
  const html = buildHtml(`# T\n\n![a picture](${att.url})`, 'T', 'expdoc');
  assert.match(html, /src="data:image\/png;base64,/);
  assert.doesNotMatch(html, /src="\/media\//); // the server URL was replaced
});

test('buildHtml leaves a missing /media image reference untouched', () => {
  const html = buildHtml('![x](/media/expdoc/nope.png)', 'T', 'expdoc');
  assert.match(html, /src="\/media\/expdoc\/nope\.png"/);
});

test('buildHtml without a docId does not touch image srcs', () => {
  const html = buildHtml('![x](/media/expdoc/pic.png)', 'T');
  assert.match(html, /src="\/media\/expdoc\/pic\.png"/);
});
