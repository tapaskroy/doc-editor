'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-')), 'feedback.json');
process.env.DOC_EDITOR_FEEDBACK_FILE = FILE;

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fb = require('../../lib/feedback');

beforeEach(() => { try { fs.unlinkSync(FILE); } catch { /* fresh */ } });

test('compose builds a deduped "avoid these" block; empty when no items', () => {
  assert.equal(fb.compose(), '');
  fb.add({ kind: 'guardrail', text: 'Do not invent statistics.' });
  fb.add({ kind: 'quality', text: 'do not invent statistics.' }); // case-dup -> deduped
  fb.add({ kind: 'guardrail', text: 'Do not use em dashes.' });
  const c = fb.compose();
  assert.match(c, /AVOID THESE/);
  assert.match(c, /invent statistics\./i); // one survives (casing depends on order)
  assert.match(c, /Do not use em dashes\./);
  assert.equal((c.match(/invent statistics/gi) || []).length, 1); // deduped
});

test('compose caps the number of lines', () => {
  for (let i = 0; i < 30; i++) fb.add({ kind: 'guardrail', text: `Rule number ${i}.` });
  const lines = fb.compose({ limit: 5 }).split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 5);
});
