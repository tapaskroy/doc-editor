// Per-document version history. Every change to a document appends a snapshot
// of its full Markdown (cheap; lets us diff and restore). Snapshots live in a
// separate per-doc file so they don't bloat the constantly-read meta.json.
//
// Coalescing: a burst of manual (inline) edits collapses into ONE "Manual edit"
// snapshot — consecutive manual saves within COALESCE_MS update the latest
// snapshot in place instead of piling up one per keystroke-burst.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const VERSIONS_DIR = process.env.DOC_EDITOR_VERSIONS_DIR || path.join(__dirname, '..', 'docs-versions');
const COALESCE_MS = 3 * 60 * 1000;

function file(id) {
  return path.join(VERSIONS_DIR, path.basename(id) + '.json');
}

function readAll(id) {
  try {
    return JSON.parse(fs.readFileSync(file(id), 'utf8'));
  } catch {
    return [];
  }
}

function writeAll(id, arr) {
  fs.mkdirSync(VERSIONS_DIR, { recursive: true });
  fs.writeFileSync(file(id), JSON.stringify(arr, null, 2));
}

// Append a snapshot (or coalesce into the last one for manual-edit bursts).
// kind: 'ai' | 'manual' | 'restore'. Returns the metadata list (no full text).
function add(id, { label, markdown, kind = 'ai', model = null, usd = 0 }) {
  const arr = readAll(id);
  const now = new Date().toISOString();
  const last = arr[arr.length - 1];
  if (kind === 'manual' && last && last.kind === 'manual' && Date.parse(now) - Date.parse(last.at) < COALESCE_MS) {
    last.markdown = markdown; // same editing burst — update in place
    last.at = now;
  } else {
    arr.push({ vid: crypto.randomUUID().slice(0, 8), label, kind, model, usd, at: now, markdown });
  }
  writeAll(id, arr);
  return list(id);
}

// Snapshot metadata, newest first (no full markdown — keeps the payload small).
function list(id) {
  return readAll(id)
    .map(({ markdown, ...meta }) => meta)
    .reverse();
}

// A single snapshot including its markdown.
function get(id, vid) {
  return readAll(id).find((v) => v.vid === vid) || null;
}

// The snapshot just before the current head — the target for single-step undo.
function previous(id) {
  const arr = readAll(id);
  return arr.length >= 2 ? arr[arr.length - 2] : null;
}

function remove(id) {
  try {
    fs.rmSync(file(id), { force: true });
  } catch {
    /* ignore */
  }
}

module.exports = { add, list, get, previous, remove, VERSIONS_DIR };
