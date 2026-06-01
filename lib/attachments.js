// Per-document attachments: pictures and reference documents the user uploads
// for Claude to use as input. Files live under docs-assets/<docId>/. Images are
// read by Claude's Read tool and may be embedded in the output (its judgment);
// office documents are converted to Markdown (pandoc) so they're readable.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ASSETS_DIR = process.env.DOC_EDITOR_ASSETS_DIR || path.join(__dirname, '..', 'docs-assets');

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'json']);
const DOC_EXT = new Set(['docx', 'doc', 'odt', 'rtf', 'html', 'htm', 'epub']); // pandoc-convertible

function docDir(docId) {
  return path.join(ASSETS_DIR, path.basename(docId));
}
function mediaFile(docId, storedName) {
  return path.join(docDir(docId), path.basename(storedName));
}

function classify(name, type) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if ((type || '').startsWith('image/') || IMAGE_EXT.has(ext)) return 'image';
  if ((type || '') === 'application/pdf' || ext === 'pdf') return 'pdf';
  if ((type || '').startsWith('text/') || TEXT_EXT.has(ext)) return 'text';
  if (DOC_EXT.has(ext)) return 'doc';
  return 'other';
}

// Store an uploaded file and return its attachment metadata. Office docs get a
// Markdown sidecar (via pandoc) so Claude can read them as text.
function store(docId, { name, type, dataBase64 }) {
  fs.mkdirSync(docDir(docId), { recursive: true });
  const safeBase = (name || 'file').replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
  const storedName = `${crypto.randomUUID().slice(0, 8)}-${safeBase}`;
  const filePath = mediaFile(docId, storedName);
  fs.writeFileSync(filePath, Buffer.from(dataBase64, 'base64'));

  const kind = classify(name, type);
  let refPath = filePath; // what Claude should Read
  if (kind === 'doc') {
    const sidecar = filePath + '.md';
    try {
      execFileSync('pandoc', [filePath, '-t', 'gfm', '-o', sidecar], { stdio: 'ignore' });
      refPath = sidecar;
    } catch {
      // pandoc missing or conversion failed — leave refPath as the original.
    }
  }

  return {
    id: storedName,
    name: name || storedName,
    type: type || '',
    kind,
    storedName,
    url: `/media/${docId}/${storedName}`, // for in-app rendering / embedding
    refPath, // absolute path Claude reads
  };
}

function remove(docId, storedName) {
  const f = mediaFile(docId, storedName);
  for (const p of [f, f + '.md']) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }
}

function removeAll(docId) {
  fs.rmSync(docDir(docId), { recursive: true, force: true });
}

// Build the prompt section that lists attachments for Claude.
function referenceBlock(docId, attachments = []) {
  if (!attachments.length) return '';
  const lines = ['ATTACHED REFERENCE MATERIALS — read each one before writing:'];
  attachments.forEach((a, i) => {
    if (a.kind === 'image') {
      lines.push(
        `${i + 1}. [image] "${a.name}" — read it at: ${a.refPath}\n` +
          `   If you include it in the document, embed it with EXACTLY this Markdown: ![concise alt text](${a.url})`
      );
    } else {
      lines.push(`${i + 1}. [${a.kind === 'doc' ? 'document' : a.kind}] "${a.name}" — read it at: ${a.refPath}`);
    }
  });
  return lines.join('\n');
}

module.exports = { ASSETS_DIR, store, remove, removeAll, mediaFile, referenceBlock, classify, docDir };
