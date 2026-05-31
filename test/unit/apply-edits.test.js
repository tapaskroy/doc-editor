'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyEdits } = require('../../lib/claude');

test('applies a single find/replace', () => {
  const { markdown, applied } = applyEdits('Hello world', [{ find: 'world', replace: 'there' }]);
  assert.equal(markdown, 'Hello there');
  assert.equal(applied[0].ok, true);
  assert.equal(applied[0].reason, undefined);
});

test('applies multiple edits in sequence against the evolving text', () => {
  const { markdown } = applyEdits('one two', [
    { find: 'one', replace: '1' },
    { find: 'two', replace: '2' },
  ]);
  assert.equal(markdown, '1 2');
});

test('reports a find that is not present', () => {
  const { markdown, applied } = applyEdits('abc', [{ find: 'xyz', replace: 'q' }]);
  assert.equal(markdown, 'abc'); // unchanged
  assert.equal(applied[0].ok, false);
  assert.equal(applied[0].reason, 'not found');
});

test('rejects an empty or missing find', () => {
  const { applied } = applyEdits('abc', [{ find: '', replace: 'q' }, { replace: 'q' }]);
  assert.equal(applied[0].ok, false);
  assert.equal(applied[0].reason, 'empty find');
  assert.equal(applied[1].ok, false);
  assert.equal(applied[1].reason, 'empty find');
});

test('replaces only the first of multiple matches and flags it', () => {
  const { markdown, applied } = applyEdits('a a a', [{ find: 'a', replace: 'b' }]);
  assert.equal(markdown, 'b a a');
  assert.equal(applied[0].ok, true);
  assert.match(applied[0].reason, /multiple matches/);
});

test('supports deletion via empty replace', () => {
  const { markdown } = applyEdits('Hello world', [{ find: ' world', replace: '' }]);
  assert.equal(markdown, 'Hello');
});

test('defaults replace to empty string when omitted', () => {
  const { markdown } = applyEdits('keep drop', [{ find: ' drop' }]);
  assert.equal(markdown, 'keep');
});
