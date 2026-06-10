'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { modelEffortArgs, toolArgs, formatRequest } = require('../../lib/claude');

test('modelEffortArgs passes through whitelisted values', () => {
  assert.deepEqual(modelEffortArgs({ model: 'opus', effort: 'high' }), [
    '--model', 'opus', '--effort', 'high',
  ]);
  assert.deepEqual(modelEffortArgs({ model: 'sonnet' }), ['--model', 'sonnet']);
  assert.deepEqual(modelEffortArgs({ model: 'fable' }), ['--model', 'fable']);
});

test('modelEffortArgs drops unknown / empty values', () => {
  assert.deepEqual(modelEffortArgs({ model: 'gpt-9', effort: 'turbo' }), []);
  assert.deepEqual(modelEffortArgs({}), []);
  assert.deepEqual(modelEffortArgs(), []);
});

test('toolArgs exposes only web tools (and pre-approves them) when enabled', () => {
  assert.deepEqual(toolArgs({ web: true }), [
    '--tools', 'WebFetch', 'WebSearch', '--allowedTools', 'WebFetch', 'WebSearch',
  ]);
});

test('toolArgs adds Read for attachments, and combines with web', () => {
  assert.deepEqual(toolArgs({ read: true }), ['--tools', 'Read', '--allowedTools', 'Read']);
  assert.deepEqual(toolArgs({ web: true, read: true }), [
    '--tools', 'Read', 'WebFetch', 'WebSearch', '--allowedTools', 'Read', 'WebFetch', 'WebSearch',
  ]);
});

test('toolArgs disables all tools when nothing is needed', () => {
  assert.deepEqual(toolArgs({}), ['--tools', 'none']);
  assert.deepEqual(toolArgs(), ['--tools', 'none']);
});

test('formatRequest renders comments and a global instruction', () => {
  const out = formatRequest(
    [{ quote: 'the sea', note: 'make it vivid' }],
    'tighten the ending'
  );
  assert.match(out, /1\. Passage: "the sea"/);
  assert.match(out, /Instruction: make it vivid/);
  assert.match(out, /Global instruction: tighten the ending/);
});

test('formatRequest works with only an instruction', () => {
  assert.equal(formatRequest([], 'make it formal'), 'Global instruction: make it formal');
});
