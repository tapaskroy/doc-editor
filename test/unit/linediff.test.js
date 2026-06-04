'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const lineDiff = require('../../public/linediff.js');

const counts = (rows) => ({
  same: rows.filter((r) => r.t === 'same').length,
  add: rows.filter((r) => r.t === 'add').length,
  del: rows.filter((r) => r.t === 'del').length,
});

test('identical text → all same, no add/del', () => {
  const c = counts(lineDiff('a\nb\nc', 'a\nb\nc'));
  assert.deepEqual(c, { same: 3, add: 0, del: 0 });
});

// This is the regression guard for the diff bug: an add-only edit must show
// ONLY additions, with every original line preserved as "same" (no noise).
test('inserting a line shows exactly one addition and zero deletions', () => {
  const before = '# Report\n\nThe tournament begins next week.\n\n## Format\n\nTen teams compete.';
  const after = '# Report\n\nThe tournament begins next week.\nAustralia arrive as the most successful side.\n\n## Format\n\nTen teams compete.';
  const rows = lineDiff(before, after);
  const c = counts(rows);
  assert.equal(c.del, 0, 'add-only edit must produce no deletions');
  assert.equal(c.add, 1, 'exactly the inserted line is added');
  assert.equal(c.same, before.split('\n').length, 'every original line is preserved as unchanged');
  assert.equal(rows.find((r) => r.t === 'add').s, 'Australia arrive as the most successful side.');
});

test('changing a line shows it as one delete + one add', () => {
  const rows = lineDiff('one\ntwo\nthree', 'one\nTWO\nthree');
  const c = counts(rows);
  assert.equal(c.del, 1);
  assert.equal(c.add, 1);
  assert.equal(c.same, 2);
});

test('removing a line shows one deletion', () => {
  const c = counts(lineDiff('a\nb\nc', 'a\nc'));
  assert.deepEqual(c, { same: 2, add: 0, del: 1 });
});

test('from empty → everything is added (initial draft case)', () => {
  const c = counts(lineDiff('', 'a\nb'));
  assert.equal(c.del, 0);
  assert.equal(c.add, 2);
});
