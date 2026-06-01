// Document export. Markdown is the source; we render to four formats:
//   html  — marked + embedded CSS (pure Node, always available)
//   pdf   — print the styled HTML with headless system Chrome
//   docx  — pandoc (gfm -> docx)
//   pptx  — Claude restructures the doc into a slide deck, rendered with
//           pptxgenjs (title slide + bulleted slides + speaker notes)
//
// docx requires `pandoc` on PATH; pdf requires Google Chrome (or set
// CHROME_PATH); pptx requires the `claude` CLI (the deck builder is injected by
// the caller). Missing engines surface as a clear error rather than a crash.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { marked } = require('marked');
const PptxGenJS = require('pptxgenjs');
const attachments = require('./attachments');

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

marked.setOptions({ gfm: true, breaks: false });

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

function findChrome() {
  return CHROME_CANDIDATES.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

// Self-contained styling so exported HTML/PDF resembles the editor's reading view.
const DOC_CSS = `
  @page { margin: 1in; }
  body { background: #fff; color: #20201d; font-family: Georgia, "Times New Roman", serif; font-size: 12pt; line-height: 1.6; }
  .doc { max-width: 46rem; margin: 2.5rem auto; padding: 0 1.5rem; }
  h1 { font-size: 2em; line-height: 1.2; margin: 0 0 .6em; }
  h2 { font-size: 1.5em; margin: 1.6em 0 .5em; }
  h3 { font-size: 1.2em; margin: 1.4em 0 .4em; }
  p { margin: 0 0 1em; }
  ul, ol { margin: 0 0 1em; padding-left: 1.5em; }
  li { margin: .25em 0; }
  blockquote { margin: 1em 0; padding: .4em 1.1em; border-left: 3px solid #b4532a; color: #555; }
  code { font-family: "SF Mono", Menlo, monospace; font-size: .85em; background: #f0ede6; padding: .1em .35em; border-radius: 4px; }
  pre { background: #2a2722; color: #f3efe7; padding: 1em 1.1em; border-radius: 8px; overflow: auto; }
  pre code { background: none; padding: 0; color: inherit; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: .5em .75em; text-align: left; }
  th { background: #faf7f1; }
  a { color: #b4532a; }
  @media print { .doc { max-width: none; margin: 0; padding: 0; } }
`;

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Inline /media/<docId>/<name> image sources as data URIs so exported HTML/PDF
// is self-contained (no dependency on the running server).
function inlineMedia(html, docId) {
  if (!docId) return html;
  return html.replace(/src="\/media\/[^/"]+\/([^"]+)"/g, (m, name) => {
    try {
      const file = attachments.mediaFile(docId, decodeURIComponent(name));
      const ext = (name.split('.').pop() || '').toLowerCase();
      const data = fs.readFileSync(file).toString('base64');
      return `src="data:${MIME[ext] || 'application/octet-stream'};base64,${data}"`;
    } catch {
      return m; // leave the src as-is if the file can't be read
    }
  });
}

// Rewrite Markdown image links from /media/<docId>/<name> to absolute local file
// paths so pandoc embeds them in docx.
function localizeMedia(markdown, docId) {
  if (!docId) return markdown;
  return markdown.replace(/\]\(\/media\/[^/)]+\/([^)]+)\)/g, (m, name) => {
    const file = attachments.mediaFile(docId, decodeURIComponent(name));
    return fs.existsSync(file) ? `](${file})` : m;
  });
}

function buildHtml(markdown, title, docId) {
  const body = inlineMedia(marked.parse(markdown || ''), docId);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title || 'Document')}</title>
<style>${DOC_CSS}</style></head>
<body><article class="doc">${body}</article></body>
</html>`;
}

function tmpFile(ext) {
  return path.join(os.tmpdir(), `doc-export-${crypto.randomUUID()}.${ext}`);
}

// Spawn a command, optionally feed stdin, resolve on exit 0 (else reject with stderr).
function run(cmd, args, { input, label } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) =>
      reject(new Error(`${label || cmd} is not available (${err.code === 'ENOENT' ? 'not found on PATH' : err.message})`))
    );
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${label || cmd} failed: ${stderr.trim() || 'exit ' + code}`))
    );
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

async function viaPandoc(markdown, to) {
  const out = tmpFile(to);
  try {
    await run('pandoc', ['-f', 'gfm', '-t', to, '-o', out], {
      input: markdown,
      label: 'pandoc (install it to export Word .docx)',
    });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

// Render a structured deck (from claude.toDeck) into a themed .pptx buffer.
const DECK_THEME = { paper: 'FFFDF9', ink: '20201D', accent: 'B4532A', muted: '6B675F' };

async function deckToPptx(deck, fallbackTitle) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.3 x 7.5 in (16:9)

  // Title slide.
  const title = pptx.addSlide();
  title.background = { color: DECK_THEME.paper };
  title.addText(deck.title || fallbackTitle || 'Untitled', {
    x: 0.7, y: 2.6, w: '88%', h: 1.6, fontSize: 44, bold: true, color: DECK_THEME.ink, fontFace: 'Georgia',
  });
  if (deck.subtitle) {
    title.addText(deck.subtitle, {
      x: 0.7, y: 4.2, w: '88%', h: 1.0, fontSize: 22, color: DECK_THEME.muted, fontFace: 'Georgia',
    });
  }

  // Content slides.
  for (const s of deck.slides || []) {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addText(s.title || '', {
      x: 0.5, y: 0.4, w: '92%', h: 0.9, fontSize: 28, bold: true, color: DECK_THEME.accent, fontFace: 'Georgia',
    });
    const bullets = (s.bullets || []).map((b) => ({
      text: String(b),
      options: { bullet: { characterCode: '2022' }, fontSize: 18, color: DECK_THEME.ink, paraSpaceAfter: 10, fontFace: 'Calibri' },
    }));
    if (bullets.length) {
      slide.addText(bullets, { x: 0.8, y: 1.5, w: '86%', h: 5.2, valign: 'top' });
    }
    if (s.notes) slide.addNotes(String(s.notes));
  }

  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.isBuffer(out) ? out : Buffer.from(out);
}

async function viaChromePdf(markdown, title, docId) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Google Chrome not found — install it or set CHROME_PATH to export PDF');
  const htmlFile = tmpFile('html');
  const pdfFile = tmpFile('pdf');
  try {
    fs.writeFileSync(htmlFile, buildHtml(markdown, title, docId));
    await run(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-pdf-header-footer',
        `--print-to-pdf=${pdfFile}`,
        `file://${htmlFile}`,
      ],
      { label: 'Chrome' }
    );
    return fs.readFileSync(pdfFile);
  } finally {
    fs.rmSync(htmlFile, { force: true });
    fs.rmSync(pdfFile, { force: true });
  }
}

const FORMATS = {
  html: {
    ext: 'html',
    contentType: 'text/html; charset=utf-8',
    generate: (md, title, { docId } = {}) => Promise.resolve(Buffer.from(buildHtml(md, title, docId), 'utf8')),
  },
  pdf: {
    ext: 'pdf',
    contentType: 'application/pdf',
    generate: (md, title, { docId } = {}) => viaChromePdf(md, title, docId),
  },
  docx: {
    ext: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    generate: (md, title, { docId } = {}) => viaPandoc(localizeMedia(md, docId), 'docx'),
  },
  pptx: {
    ext: 'pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    // Needs a deck builder (markdown -> structured deck); injected by the caller
    // so this module stays free of a direct dependency on the claude CLI.
    generate: async (md, title, { deckBuilder } = {}) => {
      if (typeof deckBuilder !== 'function') throw new Error('pptx export requires a deck builder');
      const deck = await deckBuilder(md, title);
      return deckToPptx(deck, title);
    },
  },
};

// Returns { buffer, contentType, ext } or throws (unknown format / missing engine).
// opts is passed through to the format generator (e.g. { deckBuilder } for pptx).
async function exportDoc(format, markdown, title, opts = {}) {
  const f = FORMATS[format];
  if (!f) throw new Error(`unknown export format: ${format}`);
  const buffer = await f.generate(markdown, title, opts);
  return { buffer, contentType: f.contentType, ext: f.ext };
}

module.exports = { exportDoc, buildHtml, deckToPptx, FORMATS };
