'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { exportDoc, buildHtml, FORMATS } = require('../../lib/export');

test('buildHtml renders Markdown into a standalone, styled document', () => {
  const html = buildHtml('# Title\n\nHello **world**.', 'My Doc');
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<title>My Doc<\/title>/);
  assert.match(html, /<style>/); // embedded CSS, no external assets
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /<strong>world<\/strong>/);
});

test('buildHtml escapes the title', () => {
  const html = buildHtml('# x', 'A < B & C');
  assert.match(html, /<title>A &lt; B &amp; C<\/title>/);
});

test('the format registry exposes the four supported formats', () => {
  assert.deepEqual(Object.keys(FORMATS).sort(), ['docx', 'html', 'pdf', 'pptx']);
  assert.equal(FORMATS.docx.ext, 'docx');
  assert.match(FORMATS.pptx.contentType, /presentationml/);
  assert.match(FORMATS.pdf.contentType, /application\/pdf/);
});

test('exportDoc(html) returns a UTF-8 buffer with the right content type (no engine needed)', async () => {
  const { buffer, contentType, ext } = await exportDoc('html', '# Hi\n\nthere', 'Doc');
  assert.ok(Buffer.isBuffer(buffer));
  assert.equal(ext, 'html');
  assert.match(contentType, /text\/html/);
  assert.match(buffer.toString('utf8'), /<h1[^>]*>Hi<\/h1>/);
});

test('exportDoc rejects an unknown format', async () => {
  await assert.rejects(() => exportDoc('xlsx', '# x', 'Doc'), /unknown export format/);
});
