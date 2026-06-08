'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// Point the store AND the ~/.claude projection target at throwaway dirs BEFORE
// requiring the module (paths are resolved from env at load time).
const MEM = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-store-'));
const CLA = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-claude-'));
process.env.DOC_EDITOR_MEMORY_DIR = MEM;
process.env.DOC_EDITOR_CLAUDE_DIR = CLA;

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const mem = require('../../lib/memory');

beforeEach(() => {
  for (const d of [MEM, CLA]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
});
after(() => { for (const d of [MEM, CLA]) fs.rmSync(d, { recursive: true, force: true }); });

test('storeExists reflects the USER.md profile; write/read round-trips', () => {
  assert.equal(mem.storeExists(), false);
  mem.writeProfile('# USER.md\n\n## Identity\n- Based in the Bay Area.\n');
  assert.equal(mem.storeExists(), true);
  assert.match(mem.readProfile(), /Bay Area/);
});

test('propose queues unsaved items and dedups by normalized text', () => {
  const a = mem.propose([{ text: 'Has a spouse and one child.', section: 'people', provenance: 'intake' }]);
  assert.equal(a.length, 1);
  assert.equal(a[0].status, 'unsaved');
  // duplicate (case/space-insensitive) is dropped
  const b = mem.propose([{ text: 'has a spouse and ONE child.' }, { text: 'Works at Acme.' }]);
  assert.equal(b.length, 1);
  assert.equal(b[0].text, 'Works at Acme.');
  assert.equal(mem.listQueue().length, 2);
});

test('keep appends the fact to USER.md under its fixed section and marks it kept', () => {
  const [item] = mem.propose([{ text: 'Speaks French and German.', section: 'identity' }]);
  const kept = mem.keep(item.id);
  assert.equal(kept.status, 'kept');
  assert.ok(kept.keptAt);
  const profile = mem.readProfile();
  assert.match(profile, /## Identity/);
  assert.match(profile, /- Speaks French and German\./);
  assert.equal(mem.listQueue().length, 0);
  assert.equal(mem.listKept().length, 1);
  // keeping again is a no-op (already kept)
  assert.equal(mem.keep(item.id), null);
});

test('topic items land in topics/<topic>.md, not USER.md', () => {
  const [item] = mem.propose([{ text: 'Loves historical dramas.', topic: 'taste' }]);
  mem.keep(item.id);
  assert.match(mem.readTopic('taste'), /Loves historical dramas\./);
  assert.deepEqual(mem.listTopics(), ['taste']);
  assert.doesNotMatch(mem.readProfile(), /historical dramas/);
});

test('discard tombstones (and blocks re-propose); forget removes from Markdown', () => {
  const [d] = mem.propose([{ text: 'Temporary fact.' }]);
  mem.discard(d.id);
  assert.equal(mem.listQueue().length, 0);
  assert.equal(mem.propose([{ text: 'temporary fact.' }]).length, 0); // tombstoned -> not re-proposed

  const [k] = mem.propose([{ text: 'Allergic to walnuts.', section: 'other' }]);
  mem.keep(k.id);
  assert.match(mem.readProfile(), /Allergic to walnuts\./);
  mem.forget(k.id);
  assert.doesNotMatch(mem.readProfile(), /Allergic to walnuts\./); // removed from canonical Markdown
});

test('retrieve returns the always-on profile plus relevant topics only', () => {
  mem.writeProfile('# USER.md\n\n## Identity\n- Tester.\n');
  mem.writeTopic('travel', '# Travel\n\n- Home base is the Bay Area; recent trip to Bali and Mount Batur.\n');
  mem.writeTopic('taste', '# Taste\n\n- Enjoys jazz records and historical dramas.\n');

  const r = mem.retrieve({ premise: 'Write a recap of our Bali trip and the Batur hike' });
  assert.match(r.profile, /Tester/);
  const names = r.topics.map((t) => t.name);
  assert.ok(names.includes('travel'), 'travel topic retrieved by overlap');
  assert.ok(!names.includes('taste'), 'unrelated taste topic not retrieved');
});

test('compose carries the guardrail; usePersonalFacts flips volunteering; empty -> ""', () => {
  assert.equal(mem.compose({ profile: '', topics: [] }), '');
  const off = mem.compose({ profile: '## Identity\n- X', topics: [] }, { usePersonalFacts: false });
  assert.match(off, /Do NOT volunteer private facts/);
  const on = mem.compose({ profile: '## Identity\n- X', topics: [] }, { usePersonalFacts: true });
  assert.match(on, /MAY weave in relevant personal details/);
  assert.match(on, /WHAT IS TRUE ABOUT THE USER/);
});

test('syncToClaudeDir symlinks USER.md and adds an idempotent @USER.md import', () => {
  mem.writeProfile('# USER.md\n- hi\n');
  const r1 = mem.syncToClaudeDir();
  assert.equal(r1.ok, true);
  const link = path.join(CLA, 'USER.md');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), mem.PROFILE_PATH);
  assert.match(fs.readFileSync(path.join(CLA, 'CLAUDE.md'), 'utf8'), /^@USER\.md$/m);

  // idempotent: second run adds nothing
  const r2 = mem.syncToClaudeDir();
  assert.equal(r2.importMode, 'import-present');
  const occurrences = (fs.readFileSync(path.join(CLA, 'CLAUDE.md'), 'utf8').match(/@USER\.md/g) || []).length;
  assert.equal(occurrences, 1);
});

test('syncToClaudeDir appends to an existing CLAUDE.md without clobbering it', () => {
  mem.writeProfile('# USER.md\n- hi\n');
  fs.writeFileSync(path.join(CLA, 'CLAUDE.md'), '# My global instructions\n\nBe concise.\n');
  const r = mem.syncToClaudeDir();
  assert.equal(r.importMode, 'import-appended');
  const cm = fs.readFileSync(path.join(CLA, 'CLAUDE.md'), 'utf8');
  assert.match(cm, /My global instructions/); // preserved
  assert.match(cm, /Be concise\./); // preserved
  assert.match(cm, /^@USER\.md$/m); // added
});
