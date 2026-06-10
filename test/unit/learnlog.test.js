'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'learnlog-'));
const FILE = path.join(DIR, 'learnlog.json');
process.env.DOC_EDITOR_LEARNLOG_FILE = FILE;

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const ll = require('../../lib/learnlog');

beforeEach(() => { try { fs.unlinkSync(FILE); } catch { /* fresh */ } });
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} });

test('add records kept/dismissed with class + evidence; rejects an invalid decision', () => {
  assert.equal(ll.add({ decision: 'bogus', candidate: { text: 'x' } }), null);
  const k = ll.add({ decision: 'kept', candidate: { target: 'voice', observation: 'You prefer short sentences.', text: 'Prefer short.' }, docId: 'd1', voiceId: 'blog' });
  assert.equal(k.decision, 'kept');
  assert.equal(k.target, 'voice');
  assert.match(k.observation, /short sentences/);
  ll.add({ decision: 'dismissed', candidate: { target: 'context', text: 'noise' } });
  assert.equal(ll.list().length, 2);
});

test('summary computes overall + per-class keep rate', () => {
  ll.add({ decision: 'kept', candidate: { target: 'voice' } });
  ll.add({ decision: 'kept', candidate: { target: 'voice' } });
  ll.add({ decision: 'dismissed', candidate: { target: 'voice' } });
  ll.add({ decision: 'dismissed', candidate: { target: 'context' } });
  const s = ll.summary();
  assert.equal(s.kept, 2);
  assert.equal(s.dismissed, 2);
  assert.equal(s.total, 4);
  assert.equal(s.keepRate, 0.5);
  assert.deepEqual(s.byClass.voice, { kept: 2, dismissed: 1 });
  assert.deepEqual(s.byClass.context, { kept: 0, dismissed: 1 });
});

test('summary on an empty log has null keepRate', () => {
  const s = ll.summary();
  assert.equal(s.total, 0);
  assert.equal(s.keepRate, null);
  assert.deepEqual(s.byClass, {});
});
