'use strict';

/*
 * Opt-in end-to-end smoke test. Drives the real app in a headless browser.
 *
 *   Requirements (NOT installed by default — this is intentionally opt-in):
 *     - the `claude` CLI, installed and authenticated (generation calls it)
 *     - Google Chrome installed (driven via playwright-core's `chrome` channel)
 *     - playwright-core available:  npm i --no-save playwright-core
 *
 *   Run:  npm run test:smoke
 *
 * It spawns its own server on a spare port against a throwaway docs directory,
 * exercises generate → comment → revise → conversation-history, then tears
 * everything down. It is deliberately kept out of `npm test` (the fast,
 * offline unit suite) because it is slow and depends on the CLI + network.
 */

const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = process.env.SMOKE_PORT || 9988;
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-editor-smoke-'));

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is required for the smoke test.\n  Install it with:  npm i --no-save playwright-core');
  process.exit(1);
}

const log = (...a) => console.log('•', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/');
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error('server did not start in time');
}

(async () => {
  let server;
  let browser;
  let failed = false;
  try {
    // 1) Spawn the server against a throwaway docs dir.
    server = spawn('node', [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(PORT), DOC_EDITOR_DOCS_DIR: TMP },
      stdio: 'inherit',
    });
    await waitForServer();
    log('server up on', BASE);

    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

    // 2) Home renders.
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=What do you want to write?');
    log('home rendered');

    // 2b) "Let's talk about it first" intake: interviewer asks, user answers.
    await page.fill('#premise', 'A short explainer about why sleep matters.');
    await page.click('#talk-btn');
    await page.waitForFunction(() => location.hash === '#/brief', null, { timeout: 5000 });
    await page.waitForFunction(
      () => document.querySelectorAll('#brief-thread .msg.assistant:not(.thinking)').length >= 1,
      null,
      { timeout: 90000 }
    );
    await page.fill('#brief-input', 'Busy parents, ~200 words, warm and practical.');
    await page.click('#brief-send');
    await page.waitForFunction(
      () => document.querySelectorAll('#brief-thread .msg.assistant:not(.thinking)').length >= 2,
      null,
      { timeout: 90000 }
    );
    log('intake interview: interviewer asked and responded');
    await page.goto(BASE, { waitUntil: 'networkidle' }); // back home for the draft-path check

    // 3) Create + stream a draft.
    await page.fill('#premise', 'Write one short paragraph titled "Beacons" about lighthouses.');
    await page.click('#create-btn');
    await page.waitForFunction(() => location.hash.startsWith('#/doc/'), null, { timeout: 10000 });
    await page.waitForFunction(
      () => !(document.querySelector('#status')?.textContent || '').includes('drafting') && document.querySelector('#doc h1'),
      null,
      { timeout: 120000 }
    );
    log('draft generated; title =', JSON.stringify(await page.textContent('#doc-title')));

    // 3b) Inline editing: the doc is editable, and typing autosaves.
    assert((await page.locator('#doc').getAttribute('contenteditable')) === 'true', 'doc should be editable');
    await page.click('#doc p');
    await page.keyboard.press('End');
    await page.keyboard.type(' Edited-inline.');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved', null, { timeout: 6000 });
    assert(/Edited-inline\./.test(await page.locator('#doc').textContent()), 'inline edit should be present');
    log('inline edit autosaved');

    // 4) Conversation panel shows the premise.
    await page.click('#hist-toggle');
    const histCount = await page.textContent('#hist-count');
    const firstLabel = await page.locator('#history li .label').first().textContent();
    assert(histCount === '1', `expected 1 history item, got ${histCount}`);
    assert(firstLabel === 'Premise', `expected Premise label, got ${firstLabel}`);
    log('conversation panel shows premise');

    // 5) Select text -> comment -> revise.
    const popoverShown = await page.evaluate(() => {
      const p = document.querySelector('#doc p');
      const tn = [...p.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.trim().length > 15);
      const r = document.createRange();
      r.setStart(tn, 0);
      r.setEnd(tn, Math.min(20, tn.nodeValue.length));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      document.querySelector('#doc').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return !document.querySelector('#sel-popover').classList.contains('hidden');
    });
    assert(popoverShown, 'selection popover did not appear');
    await page.click('#sel-comment-btn');
    await page.fill('.comment textarea', 'Make this opening more vivid.');
    await page.click('#revise-btn');
    await page.waitForFunction(
      () => document.querySelectorAll('.comment').length === 0 && !document.querySelector('#toast').classList.contains('hidden'),
      null,
      { timeout: 120000 }
    );
    const toast = (await page.textContent('#toast')).trim();
    log('revision applied; toast =', JSON.stringify(toast));

    // 6) History now has the revision too.
    await page.waitForFunction(() => document.querySelectorAll('#history li').length === 2, null, { timeout: 5000 });
    log('conversation panel recorded the revision');

    // 7) Export — HTML needs no external engine, so it always works here.
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('.export-btn[data-format="html"]'),
    ]);
    assert(download.suggestedFilename().endsWith('.html'), 'HTML export did not download a .html file');
    log('exported:', download.suggestedFilename());

    if (errors.length) throw new Error('console errors: ' + JSON.stringify(errors));
    log('no console errors');
    console.log('\n✓ SMOKE PASSED');
  } catch (err) {
    failed = true;
    console.error('\n✗ SMOKE FAILED:', err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
})();

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
