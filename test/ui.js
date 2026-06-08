'use strict';

/*
 * UI fidelity test. Renders real scenes in headless Chrome and asserts layout
 * invariants that catch visual bugs:
 *   1. every visible button fully contains its label (no text overflow), including
 *      dynamic loading-state labels;
 *   2. no horizontal page overflow at the supported desktop width;
 *   3. buttons do NOT animate `opacity` — animating opacity while a label/width
 *      also changes produced a compositing "ghost" (the reported brief-button bug);
 *      headless software rendering can't reproduce that transient, so we guard the
 *      cause as a computed-style invariant instead.
 *
 *   Opt-in (like the smoke test): needs Google Chrome + playwright-core.
 *   Run:  npm run test:ui
 *
 * No `claude` CLI / network: docs are seeded with content so the editor never
 * auto-generates; the brief view is force-rendered so its buttons are measured.
 */

const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = process.env.UI_PORT || 9977;
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-editor-ui-'));

let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { console.error('playwright-core required:  npm i --no-save playwright-core'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);

async function waitForServer(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(BASE + '/')).ok) return; } catch { /* not up */ }
    await sleep(200);
  }
  throw new Error('server did not start');
}

// Runs in the page. Returns layout facts for the active view.
function audit() {
  const vw = window.innerWidth;
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const overflowed = [];
  const opacityAnimated = [];
  let measured = 0;
  document.querySelectorAll('button').forEach((b) => {
    if (!visible(b)) return;
    measured++;
    if (b.scrollWidth > b.clientWidth + 1) {
      overflowed.push({ id: b.id || null, text: b.textContent.trim().slice(0, 40), scrollWidth: b.scrollWidth, clientWidth: b.clientWidth });
    }
    const tp = getComputedStyle(b).transitionProperty;
    if (/\b(opacity|all)\b/.test(tp)) opacityAnimated.push({ id: b.id || null, text: b.textContent.trim().slice(0, 30), transitionProperty: tp });
  });
  const de = document.documentElement;
  const pageOverflow = de.scrollWidth > vw + 2 ? { scrollWidth: de.scrollWidth, innerWidth: vw } : null;
  return { overflowed, opacityAnimated, measured, pageOverflow };
}

const failures = [];
function record(scene, width, v, { checkPage }) {
  const probs = [];
  if (v.measured === 0) probs.push('no visible buttons were measured (scene did not render?)');
  v.overflowed.forEach((b) => probs.push(`button ${b.id ? '#' + b.id : JSON.stringify(b.text)} text overflows its box (scrollWidth ${b.scrollWidth} > clientWidth ${b.clientWidth})`));
  v.opacityAnimated.forEach((b) => probs.push(`button ${b.id ? '#' + b.id : JSON.stringify(b.text)} animates opacity (transition-property: ${b.transitionProperty}) — risks a resize-during-fade ghost`));
  if (checkPage && v.pageOverflow) probs.push(`page overflows viewport (${v.pageOverflow.scrollWidth} > ${v.pageOverflow.innerWidth})`);
  if (probs.length) { failures.push({ scene, width }); console.log(`  ✗ ${scene} @${width}px`); probs.forEach((p) => console.log('      - ' + p)); }
  else console.log(`  ✓ ${scene} @${width}px`);
}

// Force a view visible without the router (the brief view bounces when navigated to
// directly, since it needs an in-progress intake; we only want its layout).
function forceView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  document.getElementById('view-' + name).classList.remove('hidden');
}
function setBtn(args) { const [id, text, disabled] = args; const el = document.getElementById(id); if (el) { el.textContent = text; if (disabled != null) el.disabled = disabled; } }

(async () => {
  let server, browser;
  try {
    server = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DOC_EDITOR_DOCS_DIR: TMP }, stdio: 'inherit' });
    await waitForServer();
    log('server up on', BASE);

    const created = await (await fetch(BASE + '/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ premise: 'test' }) })).json();
    await fetch(BASE + `/api/docs/${created.id}/content`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: '# Seeded Test Document\n\nBody text so the editor opens without generating.' }) });

    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const jsErrors = [];

    for (const width of [1280, 700]) {
      const full = width === 1280; // page-overflow only at the supported desktop width
      const page = await browser.newPage({ viewport: { width, height: 1000 } });
      page.on('pageerror', (e) => jsErrors.push(`@${width}: ${e.message}`));

      await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
      record('home', width, await page.evaluate(audit), { checkPage: full });

      // Brief: force-render so its buttons are measured; exercise the loading states
      // (disabled + long label) that caused the reported overflow.
      await page.goto(BASE + '/#/', { waitUntil: 'networkidle' });
      await page.evaluate(forceView, 'brief');
      await page.evaluate(setBtn, ['brief-draft', 'Preparing the brief…', true]);
      record('brief (Preparing the brief…)', width, await page.evaluate(audit), { checkPage: full });
      await page.evaluate(setBtn, ['brief-draft', 'Uploading attachments…', true]);
      record('brief (Uploading attachments…)', width, await page.evaluate(audit), { checkPage: full });

      // Editor (seeded content, so no generation)
      await page.goto(BASE + `/#/doc/${created.id}`, { waitUntil: 'networkidle' });
      await sleep(300);
      await page.evaluate(setBtn, ['revise-btn', 'Sending to Claude…', true]);
      await page.evaluate(setBtn, ['learn-btn', 'Analyzing your edits…', true]);
      record('editor', width, await page.evaluate(audit), { checkPage: full });

      await page.close();
    }

    if (jsErrors.length) { console.log('\nJS errors:'); jsErrors.forEach((e) => console.log('  - ' + e)); }
    if (failures.length || jsErrors.length) { console.log(`\nUI TEST FAILED: ${failures.length} layout failure(s), ${jsErrors.length} JS error(s)`); process.exitCode = 1; }
    else console.log('\nUI TEST PASSED');
  } catch (e) {
    console.error('UI test error:', e.message); process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
