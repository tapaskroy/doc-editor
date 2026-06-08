'use strict';

// Voice store: composed read (authoritative from voice.json), learned rules, and
// per-document voice. Points skill + doc discovery at throwaway dirs BEFORE require.

const os = require('os');
const fs = require('fs');
const path = require('path');

const SK = fs.mkdtempSync(path.join(os.tmpdir(), 'de-voices-sk-'));
const DK = fs.mkdtempSync(path.join(os.tmpdir(), 'de-voices-dk-'));
process.env.DOC_EDITOR_SKILLS_DIR = SK;
process.env.DOC_EDITOR_DOCS_DIR = DK;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const voicestore = require('../../lib/voicestore');
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

test('compose() returns the preamble when there are no learned rules', () => {
  assert.equal(voicestore.compose('v1'), '# V1\n\nWrite plainly.');
});

test('addRule defaults to suggested and is NOT injected into compose()', () => {
  const r = voicestore.addRule('v1', { observation: 'You cut intensifiers.', text: "Cut 'very' and 'really'." });
  assert.equal(r.status, 'suggested');
  assert.equal(r.layer, 'voice');
  assert.equal(r.observation, 'You cut intensifiers.'); // provenance kept
  assert.equal(voicestore.listRules('v1').length, 1);
  assert.ok(!voicestore.compose('v1').includes("Cut 'very'"), 'suggested rules must not reach the prompt');
});

test('activating a rule injects it into compose() (from voice.json) and writes the SKILL.md mirror', () => {
  const r = voicestore.listRules('v1')[0];
  voicestore.setRuleStatus('v1', r.id, 'active');
  const composed = voicestore.compose('v1');
  assert.ok(composed.includes("Cut 'very'"), 'active rule should be in the composed prompt');
  assert.ok(!composed.includes('learned:start'), 'markers never appear in the injected text');
  const raw = fs.readFileSync(path.join(SK, 'v1', 'SKILL.md'), 'utf8');
  assert.ok(raw.includes('<!-- learned:start -->') && raw.includes("Cut 'very'"), 'portability mirror written to SKILL.md');
});

test('compose() is authoritative from voice.json even if the SKILL.md block is stale', () => {
  // Corrupt the SKILL.md mirror; compose() should ignore it and use voice.json.
  const file = path.join(SK, 'v1', 'SKILL.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("Cut 'very' and 'really'.", 'STALE MIRROR TEXT'));
  const composed = voicestore.compose('v1');
  assert.ok(composed.includes("Cut 'very'"), 'voice.json wins');
  assert.ok(!composed.includes('STALE MIRROR TEXT'), 'the SKILL.md block is not the source');
});

test('dismissing a rule removes it from the injected text', () => {
  const r = voicestore.listRules('v1')[0];
  voicestore.setRuleStatus('v1', r.id, 'dismissed');
  assert.ok(!voicestore.compose('v1').includes("Cut 'very'"));
});

test('compose()/listRules are safe for an unknown voice', () => {
  assert.equal(voicestore.compose('nope'), null);
  assert.deepEqual(voicestore.listRules('nope'), []);
});

test('docs.create sets voice:null; create({voice}) carries it; setVoice updates/clears', () => {
  const m = docs.create('hello');
  assert.equal(m.voice, null);
  assert.equal(docs.create('with voice', { voice: 'v1' }).voice, 'v1');
  assert.equal(docs.setVoice(m.id, 'v1').voice, 'v1');
  assert.equal(docs.readMeta(m.id).voice, 'v1');
  assert.equal(docs.setVoice(m.id, null).voice, null);
});
