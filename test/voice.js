'use strict';

/*
 * Behavior test for the Profile tab's "Your voice" editor: selecting a voice loads
 * its PREAMBLE (editable) + learned rules (read-only); saving persists the preamble
 * while preserving the YAML frontmatter and the managed learned-rules block.
 *
 *   Opt-in: needs Google Chrome + playwright-core.   Run:  npm run test:voice
 */

const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = process.env.VOICE_PORT || 9979;
const BASE = `http://localhost:${PORT}`;
const DOCS = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-editor-voice-docs-'));
const SK = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-editor-voice-sk-'));
const SKILL = path.join(SK, 'blog-x', 'SKILL.md');

fs.mkdirSync(path.join(SK, 'blog-x'), { recursive: true });
fs.writeFileSync(SKILL,
  '---\nname: Blog X\ndescription: a seeded voice\n---\n\nOriginal preamble line.\n\n<!-- learned:start -->\n## Learned rules\n\n- Cut filler.\n<!-- learned:end -->\n');
fs.writeFileSync(path.join(SK, 'blog-x', 'voice.json'), JSON.stringify({ id: 'blog-x', lastReviewedAt: null, rules: [
  { id: 'r_1', observation: 'You cut filler.', text: 'Cut filler.', layer: 'voice', status: 'active', confidence: 1, support: [], source: 'edits', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
] }, null, 2));

let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { console.error('playwright-core required:  npm i --no-save playwright-core'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DOC_EDITOR_DOCS_DIR: DOCS, DOC_EDITOR_SKILLS_DIR: SK }, stdio: 'ignore' });
  let browser; let failed = false;
  const fail = (m) => { console.log('  ✗ ' + m); failed = true; };
  const pass = (m) => console.log('  ✓ ' + m);
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/')).ok) break; } catch {} await sleep(200); }
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(BASE + '/#/profile', { waitUntil: 'networkidle' });
    await sleep(300);

    // select the voice
    await page.evaluate(() => { const s = document.getElementById('voice-pick'); s.value = 'blog-x'; s.dispatchEvent(new Event('change')); });
    await sleep(300);
    const loaded = await page.evaluate(() => ({
      preamble: document.getElementById('voice-preamble').value,
      rules: [...document.querySelectorAll('#voice-rules li')].map((li) => li.textContent),
      editorVisible: !document.getElementById('voice-editor').classList.contains('hidden'),
    }));
    if (loaded.editorVisible && loaded.preamble.trim() === 'Original preamble line.') pass('selecting a voice loads its preamble (only, not the block)');
    else fail('preamble not loaded correctly: ' + JSON.stringify(loaded.preamble));
    if (loaded.rules.some((t) => /Cut filler\./.test(t))) pass('learned rules render read-only'); else fail('learned rules missing: ' + JSON.stringify(loaded.rules));
    if (!/learned:start|## Learned rules/.test(loaded.preamble)) pass('the managed block is NOT in the editable preamble'); else fail('preamble leaked the managed block');

    // edit + save
    await page.evaluate(() => { document.getElementById('voice-preamble').value = 'Rewritten preamble.\nKeep it terse.'; });
    await page.click('#voice-save');
    await sleep(400);
    const raw = fs.readFileSync(SKILL, 'utf8');
    const okFm = /^---\nname: Blog X\ndescription: a seeded voice\n---/.test(raw);
    const okNew = /Rewritten preamble\.\nKeep it terse\./.test(raw);
    const okBlock = /## Learned rules\n\n- Cut filler\./.test(raw);
    const oldGone = !/Original preamble line/.test(raw);
    if (okNew && oldGone) pass('saving persists the new preamble'); else fail('preamble not persisted');
    if (okFm) pass('frontmatter preserved'); else fail('frontmatter lost');
    if (okBlock) pass('learned-rules block preserved (re-rendered from voice.json)'); else fail('learned block lost');

    // reload round-trips
    await page.goto(BASE + '/#/profile', { waitUntil: 'networkidle' }); await sleep(200);
    await page.evaluate(() => { const s = document.getElementById('voice-pick'); s.value = 'blog-x'; s.dispatchEvent(new Event('change')); });
    await sleep(300);
    const reloaded = await page.evaluate(() => document.getElementById('voice-preamble').value);
    if (reloaded.trim() === 'Rewritten preamble.\nKeep it terse.') pass('reload shows the saved preamble'); else fail('reload mismatch: ' + JSON.stringify(reloaded));

    if (errs.length) fail('JS errors: ' + errs.join('; '));
    console.log('\n' + (failed ? 'VOICE EDITOR TEST FAILED' : 'VOICE EDITOR TEST PASSED'));
  } catch (e) {
    console.error('VOICE TEST ERROR:', e.message); failed = true;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
    for (const d of [DOCS, SK]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    process.exit(failed ? 1 : 0);
  }
})();
