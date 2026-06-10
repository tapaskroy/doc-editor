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

test('topic files: write, read, list, delete', () => {
  mem.writeTopic('travel', '# Travel\n\n- Bali 2025\n');
  assert.match(mem.readTopic('travel'), /Bali 2025/);
  assert.ok(mem.listTopics().includes('travel'));
  assert.equal(mem.deleteTopic('travel'), true);
  assert.ok(!mem.listTopics().includes('travel'));
  assert.equal(mem.readTopic('travel'), ''); // gone
  assert.equal(mem.deleteTopic('nope'), false); // missing -> false
  // name is sanitized (no path traversal)
  mem.writeTopic('../evil', 'x');
  assert.ok(!fs.existsSync(path.join(MEM, '..', 'evil.md')));
});

test('propose dedups against facts already in the canonical Markdown (not just the manifest)', () => {
  mem.writeProfile('# USER.md\n\n## People\n- Has a spouse and one child.\n');
  const added = mem.propose([{ text: 'has a spouse and ONE child.', section: 'people' }, { text: 'A brand new fact.' }]);
  assert.equal(added.length, 1); // the one already in USER.md is dropped
  assert.equal(added[0].text, 'A brand new fact.');
});

test('keep is idempotent — never double-appends a fact already in the Markdown', () => {
  const [item] = mem.propose([{ text: 'Engineer.', section: 'work' }]); // not in markdown yet -> queued
  mem.writeProfile('# USER.md\n\n## Work\n- Engineer.\n'); // appears by hand-edit/crash before keep
  mem.keep(item.id);
  assert.equal((mem.readProfile().match(/- Engineer\./g) || []).length, 1); // not duplicated
  assert.equal(mem.listKept().length, 1);
});

test('forget reports whether the Markdown line was actually removed', () => {
  const [a] = mem.propose([{ text: 'Has a cat.', section: 'other' }]);
  mem.keep(a.id);
  assert.equal(mem.forget(a.id).removed, true);
  assert.doesNotMatch(mem.readProfile(), /Has a cat/);

  const [b] = mem.propose([{ text: 'Has a dog.', section: 'other' }]);
  mem.keep(b.id);
  mem.writeProfile(mem.readProfile().replace('- Has a dog.', '- Has a dog named Rex.')); // drift
  const r = mem.forget(b.id);
  assert.equal(r.removed, false); // couldn't find the (drifted) line
  assert.match(mem.readProfile(), /Rex/); // still present -> caller must warn, not claim success
});

test('sanitizeTopic is exported and strips path traversal', () => {
  assert.equal(mem.sanitizeTopic('../../etc/passwd'), 'etc-passwd');
  assert.equal(mem.sanitizeTopic('Travel Notes'), 'travel-notes');
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

test('syncToClaudeDir symlinks USER.md but does NOT write ~/.claude/CLAUDE.md', () => {
  mem.writeProfile('# USER.md\n- hi\n');
  const r1 = mem.syncToClaudeDir();
  assert.equal(r1.ok, true);
  const link = path.join(CLA, 'USER.md');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), mem.PROFILE_PATH);
  // We must NOT create/modify CLAUDE.md (auto-import would re-load the profile into
  // the editor's own writing calls). It hands back the line for the user to add.
  assert.equal(fs.existsSync(path.join(CLA, 'CLAUDE.md')), false);
  assert.equal(r1.importLine, '@USER.md');
  assert.equal(r1.alreadyImported, false);

  // idempotent: a second run just re-points the symlink, still no CLAUDE.md
  const r2 = mem.syncToClaudeDir();
  assert.equal(r2.ok, true);
  assert.equal(fs.existsSync(path.join(CLA, 'CLAUDE.md')), false);
});

test('syncToClaudeDir never touches an existing CLAUDE.md; reports alreadyImported', () => {
  mem.writeProfile('# USER.md\n- hi\n');
  fs.writeFileSync(path.join(CLA, 'CLAUDE.md'), '# My global instructions\n\nBe concise.\n');
  const r = mem.syncToClaudeDir();
  assert.equal(r.alreadyImported, false); // user hasn't added the import
  const cm = fs.readFileSync(path.join(CLA, 'CLAUDE.md'), 'utf8');
  assert.equal(cm, '# My global instructions\n\nBe concise.\n'); // byte-for-byte unchanged

  // if the user HAS added @USER.md themselves, we detect it (and still don't edit)
  fs.writeFileSync(path.join(CLA, 'CLAUDE.md'), '# Mine\n\n@USER.md\n');
  assert.equal(mem.syncToClaudeDir().alreadyImported, true);
  assert.equal(fs.readFileSync(path.join(CLA, 'CLAUDE.md'), 'utf8'), '# Mine\n\n@USER.md\n'); // unchanged
});
