'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// Point persistence at a throwaway dir BEFORE requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-editor-test-'));
process.env.DOC_EDITOR_DOCS_DIR = TMP;

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const docs = require('../../lib/docs');

beforeEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
});

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('create() produces a fresh document with empty history', () => {
  const meta = docs.create('write about otters');
  assert.ok(meta.id);
  assert.equal(meta.premise, 'write about otters');
  assert.deepEqual(meta.history, []);
  assert.equal(meta.title, 'Untitled');
  assert.equal(docs.exists(meta.id), true);
});

test('setMarkdown stores the body and derives the title from the first H1', () => {
  const { id } = docs.create('p');
  docs.setMarkdown(id, '# Sea Otters\n\nThey float.');
  const doc = docs.get(id);
  assert.equal(doc.markdown, '# Sea Otters\n\nThey float.');
  assert.equal(doc.title, 'Sea Otters');
});

test('deriveTitle falls back from H1 → first line → premise', () => {
  assert.equal(docs.deriveTitle('# Title Here\nbody', 'prem'), 'Title Here');
  assert.equal(docs.deriveTitle('just a line\nmore', 'prem'), 'just a line');
  assert.equal(docs.deriveTitle('', 'the premise'), 'the premise');
  assert.equal(docs.deriveTitle('', ''), 'Untitled');
});

test('history can be reset, appended, and pruned (premise is protected)', () => {
  const { id } = docs.create('premise text');
  docs.setHistory(id, [{ role: 'user', content: 'premise text' }]);
  docs.addHistory(id, 'revision one');
  docs.addHistory(id, 'revision two');
  assert.equal(docs.readMeta(id).history.length, 3);

  // index 0 (premise) is protected
  docs.removeHistory(id, 0);
  assert.equal(docs.readMeta(id).history.length, 3);

  // removing a real revision works
  docs.removeHistory(id, 1);
  const h = docs.readMeta(id).history;
  assert.equal(h.length, 2);
  assert.equal(h[1].content, 'revision two');

  // out-of-range index is a no-op
  docs.removeHistory(id, 99);
  assert.equal(docs.readMeta(id).history.length, 2);
});

test('list() returns documents newest-first and re-sorts on update', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = docs.create('a');
  await sleep(10);
  const b = docs.create('b'); // created later → newest
  let list = docs.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, b.id);

  await sleep(10);
  docs.setMarkdown(a.id, '# A bumped'); // updatedAt bump moves a to the front
  list = docs.list();
  assert.equal(list[0].id, a.id);
});

test('addUsage appends timestamped usage events', () => {
  const { id } = docs.create('x');
  docs.addUsage(id, { op: 'draft', model: 'sonnet', usd: 0.03, input: 10, output: 20 });
  docs.addUsage(id, [
    { op: 'revise', usd: 0.01 },
    { op: 'revise', usd: 0.01 },
  ]);
  const u = docs.readMeta(id).usage;
  assert.equal(u.length, 3);
  assert.equal(u[0].op, 'draft');
  assert.ok(u[0].at); // timestamped
  assert.equal(u.filter((e) => e.op === 'revise').length, 2);
});

test('create() persists the intake transcript; bare docs have intake:null', () => {
  const intake = [
    { role: 'user', content: 'recap our trip' },
    { role: 'assistant', content: 'Who went, and how long?' },
    { role: 'user', content: 'my family and I, 8 days in Bali' },
  ];
  const withIntake = docs.create('recap', { intake });
  assert.deepEqual(withIntake.intake, intake);
  assert.equal(withIntake.contextSummary, null);

  const bare = docs.create('plain');
  assert.equal(bare.intake, null);
  assert.equal(bare.contextSummary, null);

  // empty transcript is treated as no intake
  assert.equal(docs.create('p', { intake: [] }).intake, null);
});

test('setContextSummary stores and clears the distilled summary', () => {
  const { id } = docs.create('x', { intake: [{ role: 'user', content: 'hi' }] });
  assert.equal(docs.setContextSummary(id, 'Family trip, 8 days, Bali.').contextSummary, 'Family trip, 8 days, Bali.');
  assert.equal(docs.setContextSummary(id, null).contextSummary, null); // cleared (e.g. on regenerate)
  assert.equal(docs.setContextSummary(id, '').contextSummary, null); // empty also clears
});

test('usePersonalFacts defaults false and toggles (the per-doc output gate)', () => {
  const { id } = docs.create('x');
  assert.equal(docs.readMeta(id).usePersonalFacts, false);
  assert.equal(docs.setUsePersonalFacts(id, true).usePersonalFacts, true);
  assert.equal(docs.setUsePersonalFacts(id, false).usePersonalFacts, false);
  assert.equal(docs.setUsePersonalFacts(id, 1).usePersonalFacts, true); // coerced to boolean
});

test('remove() deletes both files', () => {
  const { id } = docs.create('x');
  docs.setMarkdown(id, '# X');
  docs.remove(id);
  assert.equal(docs.exists(id), false);
  assert.equal(fs.readdirSync(TMP).length, 0);
});
