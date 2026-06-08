'use strict';

// Voice store: composed read, voice.json learned rules, and per-document voice.
// Points skill + doc discovery at throwaway dirs BEFORE requiring the modules.

const os = require('os');
const fs = require('fs');
const path = require('path');

const SK = fs.mkdtempSync(path.join(os.tmpdir(), 'de-voices-sk-'));
const DK = fs.mkdtempSync(path.join(os.tmpdir(), 'de-voices-dk-'));
process.env.DOC_EDITOR_SKILLS_DIR = SK;
process.env.DOC_EDITOR_DOCS_DIR = DK;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const skills = require('../../lib/skills');
const docs = require('../../lib/docs');

function writeVoice(id, body) {
  const dir = path.join(SK, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: test voice\n---\n\n${body}\n`);
}

before(() => writeVoice('v1', '# V1\n\nWrite plainly.'));
after(() => {
  fs.rmSync(SK, { recursive: true, force: true });
  fs.rmSync(DK, { recursive: true, force: true });
});

test('compose() returns the SKILL.md body when there are no learned rules', () => {
  assert.equal(skills.compose('v1'), '# V1\n\nWrite plainly.');
});

test('addLearnedRule defaults to suggested and is NOT injected into compose()', () => {
  const r = skills.addLearnedRule('v1', { text: "Cut 'very' and 'really'." });
  assert.equal(r.status, 'suggested');
  assert.equal(r.layer, 'voice');
  assert.equal(skills.learnedRules('v1').length, 1);
  assert.ok(!skills.compose('v1').includes("Cut 'very'"), 'suggested rules must not reach the prompt');
});

test('activating a rule injects it into compose() and writes the SKILL.md block', () => {
  const r = skills.learnedRules('v1')[0];
  skills.setRuleStatus('v1', r.id, 'active');
  const composed = skills.compose('v1');
  assert.ok(composed.includes("Cut 'very'"), 'active rule should be in the composed prompt');
  assert.ok(!composed.includes('learned:start'), 'markers must be stripped from the injected text');
  const raw = fs.readFileSync(path.join(SK, 'v1', 'SKILL.md'), 'utf8');
  assert.ok(raw.includes('<!-- learned:start -->') && raw.includes("Cut 'very'"), 'managed block written to SKILL.md');
});

test('dismissing a rule removes it from the injected text', () => {
  const r = skills.learnedRules('v1')[0];
  skills.setRuleStatus('v1', r.id, 'dismissed');
  assert.ok(!skills.compose('v1').includes("Cut 'very'"));
});

test('compose() and learnedRules() are safe for an unknown voice', () => {
  assert.equal(skills.compose('nope'), null);
  assert.deepEqual(skills.learnedRules('nope'), []);
});

test('docs.create sets voice:null; create({voice}) carries it; setVoice updates/clears', () => {
  const m = docs.create('hello');
  assert.equal(m.voice, null);
  assert.equal(docs.create('with voice', { voice: 'v1' }).voice, 'v1'); // new docs inherit the default
  assert.equal(docs.setVoice(m.id, 'v1').voice, 'v1');
  assert.equal(docs.readMeta(m.id).voice, 'v1');
  assert.equal(docs.setVoice(m.id, null).voice, null);
});
