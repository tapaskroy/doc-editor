'use strict';

// Pure helpers of the learn pipeline (no Claude call): correction detection, event
// collection from snapshots, prefiltering, and candidate normalization.

const os = require('os');
const fs = require('fs');
const path = require('path');
process.env.DOC_EDITOR_SKILLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'de-learn-sk-'));
process.env.DOC_EDITOR_DOCS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'de-learn-dk-'));

const { test } = require('node:test');
const assert = require('node:assert/strict');
const learn = require('../../lib/learn');

test('isCorrection flags Claude-mistake language, not preferences', () => {
  assert.equal(learn.isCorrection('This fails the math test. You made this up.'), true);
  assert.equal(learn.isCorrection("that's wrong, I didn't say that"), true);
  assert.equal(learn.isCorrection('stop adding em dashes'), true);
  assert.equal(learn.isCorrection('make this punchier'), false);
  assert.equal(learn.isCorrection('I prefer "use" over "utilize"'), false);
});

test('collectEvents pairs AI drafts with manual edits and revisions, attributing the voice', () => {
  const snaps = [
    { kind: 'ai', label: 'Draft', voice: 'blog', markdown: 'A' },
    { kind: 'manual', label: 'Manual edit', markdown: 'A edited' },
    { kind: 'ai', label: 'Revision: tighten the intro', voice: 'blog', markdown: 'A edited 2' },
    { kind: 'ai', label: 'Draft', voice: 'blog', markdown: 'A edited 2' }, // not a revision -> no event
  ];
  const events = learn.collectEvents(snaps);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => ({ type: e.type, before: e.before, after: e.after, instruction: e.instruction, voice: e.voice })),
    [
      { type: 'manual', before: 'A', after: 'A edited', instruction: '', voice: 'blog' },
      { type: 'revision', before: 'A edited', after: 'A edited 2', instruction: 'tighten the intro', voice: 'blog' },
    ]
  );
});

test('prefilter drops no-op events', () => {
  const events = [
    { before: 'x', after: 'x' },        // no-op
    { before: 'x ', after: '  x' },     // whitespace-only -> no-op
    { before: 'a', after: 'b' },        // real
  ];
  assert.equal(learn.prefilter(events).length, 1);
});

test('normalizeCandidates keeps valid candidates, drops noise/empty, guards fields', () => {
  const out = learn.normalizeCandidates({ candidates: [
    { target: 'voice', observation: 'o', text: 'Prefer short sentences.' },
    { target: 'noise', text: 'typo fix' },
    { target: 'claude', subtype: 'guardrail', text: 'Do not invent personal facts.' },
    { target: 'bogus', text: 'should drop' },
    { target: 'voice', text: '' },
    { target: 'context', subtype: 'weird', text: 'Family is small.' },
  ] });
  assert.deepEqual(out, [
    { target: 'voice', subtype: null, observation: 'o', text: 'Prefer short sentences.' },
    { target: 'claude', subtype: 'guardrail', observation: '', text: 'Do not invent personal facts.' },
    { target: 'context', subtype: null, observation: '', text: 'Family is small.' },
  ]);
});

test('normalizeFacts keeps durable facts, guards topic/section, drops empties', () => {
  const out = learn.normalizeFacts({ facts: [
    { text: 'Has a spouse and one child.', topic: 'profile', section: 'people' },
    { text: 'Works at Globex as VP.', section: 'work' },                 // topic defaults to profile
    { text: 'Loves historical dramas.', topic: 'taste', section: 'bogus' }, // bad section -> other
    { text: '  ' },                                                      // empty -> dropped
    { topic: 'profile', section: 'identity' },                           // no text -> dropped
  ] });
  assert.deepEqual(out, [
    { text: 'Has a spouse and one child.', topic: 'profile', section: 'people' },
    { text: 'Works at Globex as VP.', topic: 'profile', section: 'work' },
    { text: 'Loves historical dramas.', topic: 'taste', section: 'other' },
  ]);
});

test('captureFromIntake is a no-op without a transcript', async () => {
  assert.deepEqual(await learn.captureFromIntake([]), { facts: [], usage: null });
  assert.deepEqual(await learn.captureFromIntake(null), { facts: [], usage: null });
});
