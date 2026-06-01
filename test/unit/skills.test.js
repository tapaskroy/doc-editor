'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

// Point skill discovery at a throwaway fixture dir BEFORE requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-editor-skills-'));
process.env.DOC_EDITOR_SKILLS_DIR = TMP;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const skills = require('../../lib/skills');
const { styleNote } = require('../../lib/claude');

function writeSkill(id, frontmatter, body) {
  const dir = path.join(TMP, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
}

before(() => {
  writeSkill('my-voice', 'name: my-voice\ndescription: A terse, first-person voice.', '# My Voice\n\nWrite plainly. No throat-clearing.');
  writeSkill('no-frontmatter', 'name: ignored', ''); // has frontmatter; body empty
  fs.mkdirSync(path.join(TMP, 'not-a-skill'), { recursive: true }); // dir without SKILL.md
});

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('list() finds skills with SKILL.md and reads their frontmatter', () => {
  const all = skills.list();
  const v = all.find((s) => s.id === 'my-voice');
  assert.ok(v, 'my-voice should be listed');
  assert.equal(v.name, 'my-voice');
  assert.match(v.description, /terse, first-person/);
  // a directory without SKILL.md is not listed
  assert.equal(all.some((s) => s.id === 'not-a-skill'), false);
});

test('read() returns the body with frontmatter stripped', () => {
  const body = skills.read('my-voice');
  assert.match(body, /# My Voice/);
  assert.match(body, /Write plainly/);
  assert.doesNotMatch(body, /^---/); // frontmatter removed
  assert.doesNotMatch(body, /description:/);
});

test('read() is path-traversal safe and returns null for unknown ids', () => {
  assert.equal(skills.read('../../etc/passwd'), null);
  assert.equal(skills.read('does-not-exist'), null);
  assert.equal(skills.read(''), null);
});

test('styleNote wraps a guide and is empty when none is given', () => {
  assert.equal(styleNote(''), '');
  assert.equal(styleNote(null), '');
  const note = styleNote('Write plainly.');
  assert.match(note, /VOICE & STYLE GUIDE/);
  assert.match(note, /Write plainly\./);
});
