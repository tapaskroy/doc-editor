'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractUsage, sumUsage } = require('../../lib/claude');

test('extractUsage normalizes the CLI result/envelope shape', () => {
  const u = extractUsage({
    total_cost_usd: 0.0217,
    usage: { input_tokens: 3, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 5737 },
    modelUsage: { 'claude-sonnet-4-6': { costUSD: 0.0217 } },
  });
  assert.equal(u.model, 'claude-sonnet-4-6');
  assert.equal(u.usd, 0.0217);
  assert.equal(u.input, 3);
  assert.equal(u.output, 12);
  assert.equal(u.cacheCreation, 5737);
  assert.equal(u.cacheRead, 0);
});

test('extractUsage tolerates missing fields', () => {
  const u = extractUsage({});
  assert.deepEqual(u, { model: null, usd: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
});

test('sumUsage adds token + cost fields and keeps the latest model', () => {
  const a = { model: 'opus', usd: 0.01, input: 5, output: 10, cacheRead: 1, cacheCreation: 2 };
  const b = { model: 'sonnet', usd: 0.02, input: 3, output: 4, cacheRead: 0, cacheCreation: 7 };
  const s = sumUsage(a, b);
  assert.equal(s.usd, 0.03);
  assert.equal(s.input, 8);
  assert.equal(s.output, 14);
  assert.equal(s.cacheCreation, 9);
  assert.equal(s.model, 'sonnet');
});
