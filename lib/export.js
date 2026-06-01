// Document export. Markdown is the source; we render to four formats:
//   html  — marked + embedded CSS (pure Node, always available)
//   pdf   — print the styled HTML with headless system Chrome
//   docx  — pandoc (gfm -> docx)
//   pptx  — pandoc (gfm -> pptx, one slide per H2)
//
// docx/pptx require `pandoc` on PATH; pdf requires Google Chrome (or set
// CHROME_PATH). Missing engines surface as a clear error rather than a crash.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { marked } = require('marked');

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

function buildHtml(markdown, title) {
  const body = marked.parse(markdown || '');
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
    const extra = to === 'pptx' ? ['--slide-level=2'] : [];
    await run('pandoc', ['-f', 'gfm', '-t', to, '-o', out, ...extra], {
      input: markdown,
      label: 'pandoc (install it to export docx/pptx)',
    });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(out, { force: true });
  }
}

async function viaChromePdf(markdown, title) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Google Chrome not found — install it or set CHROME_PATH to export PDF');
  const htmlFile = tmpFile('html');
  const pdfFile = tmpFile('pdf');
  try {
    fs.writeFileSync(htmlFile, buildHtml(markdown, title));
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
    generate: (md, title) => Promise.resolve(Buffer.from(buildHtml(md, title), 'utf8')),
  },
  pdf: {
    ext: 'pdf',
    contentType: 'application/pdf',
    generate: (md, title) => viaChromePdf(md, title),
  },
  docx: {
    ext: 'docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    generate: (md) => viaPandoc(md, 'docx'),
  },
  pptx: {
    ext: 'pptx',
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    generate: (md) => viaPandoc(md, 'pptx'),
  },
};

// Returns { buffer, contentType, ext } or throws (unknown format / missing engine).
async function exportDoc(format, markdown, title) {
  const f = FORMATS[format];
  if (!f) throw new Error(`unknown export format: ${format}`);
  const buffer = await f.generate(markdown, title);
  return { buffer, contentType: f.contentType, ext: f.ext };
}

module.exports = { exportDoc, buildHtml, FORMATS };
