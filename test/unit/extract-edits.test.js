'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractEdits } = require('../../lib/claude');

test('parses a bare JSON object', () => {
  const o = extractEdits('{"edits":[{"find":"a","replace":"b"}]}');
  assert.equal(o.edits.length, 1);
  assert.equal(o.edits[0].find, 'a');
});

test('parses JSON inside a ```json fence', () => {
  const o = extractEdits('```json\n{"edits":[]}\n```');
  assert.deepEqual(o.edits, []);
});

test('parses JSON inside a bare ``` fence', () => {
  const o = extractEdits('```\n{"edits":[{"find":"x","replace":"y"}]}\n```');
  assert.equal(o.edits[0].replace, 'y');
});

test('extracts JSON wrapped in stray prose (the resume-drift case)', () => {
  const o = extractEdits('Sure! Here are the edits:\n{"edits":[{"find":"x","replace":"y"}]}\nLet me know!');
  assert.equal(o.edits[0].find, 'x');
});

test('handles braces that appear inside string values', () => {
  const o = extractEdits('note -> {"edits":[{"find":"a{b}c","replace":"d}e"}]} <- done');
  assert.equal(o.edits[0].find, 'a{b}c');
  assert.equal(o.edits[0].replace, 'd}e');
});

test('returns null when there is no JSON', () => {
  assert.equal(extractEdits('no json here at all'), null);
});

test('returns null for an object without an edits array', () => {
  assert.equal(extractEdits('{"foo":1}'), null);
  assert.equal(extractEdits('{"edits":"not-an-array"}'), null);
});

test('returns null for empty / nullish input', () => {
  assert.equal(extractEdits(''), null);
  assert.equal(extractEdits(null), null);
});
