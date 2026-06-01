'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { exportDoc, buildHtml, deckToPptx, FORMATS } = require('../../lib/export');

const SAMPLE_DECK = {
  title: 'How Tides Work',
  subtitle: 'Gravity, motion, and geometry',
  slides: [
    { title: 'The Pull of the Moon', bullets: ['Moon gravity is the main driver', 'Near side pulled harder'], notes: 'The Moon dominates because it is close.' },
    { title: 'Two Bulges', bullets: ['One bulge faces the Moon', 'One on the far side'], notes: 'The difference in pull stretches the oceans.' },
  ],
};

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

test('deckToPptx renders a structured deck into a valid .pptx buffer', async () => {
  const buf = await deckToPptx(SAMPLE_DECK, 'Fallback');
  assert.ok(Buffer.isBuffer(buf));
  assert.ok(buf.length > 1000);
  assert.equal(buf.slice(0, 2).toString('latin1'), 'PK'); // zip (OOXML) magic
});

test('exportDoc(pptx) uses the injected deck builder', async () => {
  let calledWith = null;
  const deckBuilder = async (md) => {
    calledWith = md;
    return SAMPLE_DECK;
  };
  const { buffer, ext, contentType } = await exportDoc('pptx', '# How Tides Work\n\nbody', 'How Tides Work', { deckBuilder });
  assert.equal(calledWith, '# How Tides Work\n\nbody'); // builder received the markdown
  assert.equal(ext, 'pptx');
  assert.match(contentType, /presentationml/);
  assert.equal(buffer.slice(0, 2).toString('latin1'), 'PK');
});

test('exportDoc(pptx) without a deck builder fails clearly', async () => {
  await assert.rejects(() => exportDoc('pptx', '# x', 'Doc'), /requires a deck builder/);
});
