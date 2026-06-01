'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { briefToPrompt } = require('../../lib/claude');

test('briefToPrompt renders all brief fields as generation constraints', () => {
  const p = briefToPrompt({
    title: 'Onboarding Guide',
    summary: 'A short guide for new hires.',
    audience: 'New engineers, week one',
    purpose: 'Get them productive fast',
    tone: 'Friendly, direct',
    targetWords: 900,
    keyPoints: ['Dev setup', 'Where to ask for help'],
    structure: 'Intro, steps, FAQ',
  });
  assert.match(p, /Purpose: Get them productive fast/);
  assert.match(p, /Audience: New engineers, week one/);
  assert.match(p, /Tone and voice: Friendly, direct/);
  assert.match(p, /about 900 words/);
  assert.match(p, /~4 min read/); // 900 / 225
  assert.match(p, /Structure: Intro, steps, FAQ/);
  assert.match(p, /- Dev setup/);
  assert.match(p, /- Where to ask for help/);
  assert.match(p, /Context: A short guide for new hires\./);
});

test('briefToPrompt omits length when no target was set', () => {
  const p = briefToPrompt({ purpose: 'x', audience: 'y', targetWords: null, keyPoints: [] });
  assert.doesNotMatch(p, /Target length/);
  assert.doesNotMatch(p, /min read/);
});

test('briefToPrompt tolerates a sparse brief', () => {
  const p = briefToPrompt({ purpose: 'Explain tides', keyPoints: [] });
  assert.match(p, /Purpose: Explain tides/);
  assert.match(p, /Write the document now/);
});
