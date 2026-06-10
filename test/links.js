'use strict';

/*
 * Behavior test: links in the (contentEditable) document are clickable and open in a
 * new tab; unsafe schemes (javascript:/data:) are NOT opened.
 *
 *   Opt-in (like the smoke/UI tests): needs Google Chrome + playwright-core.
 *   Run:  npm run test:links
 */

const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const PORT = process.env.LINKS_PORT || 9978;
const BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-editor-links-'));

let chromium;
try { ({ chromium } = require('playwright-core')); }
catch { console.error('playwright-core required:  npm i --no-save playwright-core'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (b) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

(async () => {
  const server = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: String(PORT), DOC_EDITOR_DOCS_DIR: TMP }, stdio: 'ignore' });
  let browser;
  let failed = false;
  const fail = (m) => { console.log('  ✗ ' + m); failed = true; };
  const pass = (m) => console.log('  ✓ ' + m);
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/')).ok) break; } catch {} await sleep(200); }

    // A doc whose body has a safe link and an unsafe (javascript:) link.
    const doc = await (await fetch(BASE + '/api/docs', J({ premise: 'links test' }))).json();
    await fetch(BASE + `/api/docs/${doc.id}/content`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# Links\n\nVisit [Example](https://example.com/foo) and a [bad one](javascript:window.__pwned=1).\n' }),
    });

    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(BASE + `/#/doc/${doc.id}`, { waitUntil: 'networkidle' });
    await sleep(400);

    // The doc must actually be editable (that's the context where the bug lived) and
    // the links must have rendered as anchors.
    const setup = await page.evaluate(() => ({
      editable: document.getElementById('doc').getAttribute('contenteditable') === 'true',
      safe: !!document.querySelector('#doc a[href="https://example.com/foo"]'),
      bad: !!document.querySelector('#doc a[href^="javascript:"]'),
    }));
    if (!setup.editable) fail('doc is not contentEditable (test premise wrong)'); else pass('doc is contentEditable (the bug context)');
    if (!setup.safe || !setup.bad) fail('links did not render as anchors'); else pass('links rendered as anchors');

    // Stub window.open, click the safe link.
    await page.evaluate(() => { window.__opened = []; window.open = (u, t) => { window.__opened.push({ u, t }); return null; }; });
    await page.evaluate(() => document.querySelector('#doc a[href="https://example.com/foo"]').click());
    const opened = await page.evaluate(() => window.__opened);
    if (opened.length === 1 && opened[0].u === 'https://example.com/foo' && opened[0].t === '_blank') pass('clicking a link opens its URL in a new tab (_blank)');
    else fail('safe link did not open in a new tab: ' + JSON.stringify(opened));

    // Click the unsafe link — must NOT open, and must NOT execute.
    await page.evaluate(() => { window.__opened = []; document.querySelector('#doc a[href^="javascript:"]').click(); });
    const after = await page.evaluate(() => ({ opened: window.__opened, pwned: !!window.__pwned }));
    if (after.opened.length === 0 && !after.pwned) pass('javascript: link is NOT opened or executed');
    else fail('unsafe link was opened/executed: ' + JSON.stringify(after));

    if (errs.length) fail('JS errors: ' + errs.join('; '));
    console.log('\n' + (failed ? 'LINKS TEST FAILED' : 'LINKS TEST PASSED'));
  } catch (e) {
    console.error('LINKS TEST ERROR:', e.message); failed = true;
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    process.exit(failed ? 1 : 0);
  }
})();
