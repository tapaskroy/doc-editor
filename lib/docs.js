// Disk persistence for documents.
// Each document is stored as two files in the docs/ directory:
//   <id>.md        — the document body in Markdown (the source of truth)
//   <id>.meta.json — { id, title, premise, createdAt, updatedAt }

const fs = require('fs');
const path = require('path');

// Defaults to ./docs; overridable via env so tests can use a throwaway dir.
const DOCS_DIR = process.env.DOC_EDITOR_DOCS_DIR || path.join(__dirname, '..', 'docs');

function ensureDir() {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

function mdPath(id) {
  return path.join(DOCS_DIR, `${id}.md`);
}
function metaPath(id) {
  return path.join(DOCS_DIR, `${id}.meta.json`);
}

// Document ids are time-ordered and filesystem-safe.
function newId() {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}-${rand}`;
}

// Derive a human title from the first H1, else first non-empty line, else premise.
function deriveTitle(markdown, premise) {
  const h1 = markdown.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim().slice(0, 120);
  const firstLine = (markdown.split('\n').find((l) => l.trim()) || '').trim();
  if (firstLine) return firstLine.replace(/^#+\s*/, '').slice(0, 120);
  return (premise || 'Untitled').trim().slice(0, 120) || 'Untitled';
}

// The email "kind". Reuses the doc body (H1 = subject, rest = body) and adds the
// envelope + the drafting context + mailbox pointers. The mailbox stays the
// source of truth for committed content; we keep pointers + a context summary.
function emailDefaults(init = {}) {
  return {
    envelope: { to: [], cc: [], bcc: [], subject: '', threadId: null, replyToMessageId: null, ...(init.envelope || {}) },
    // "Provide more context" bundle — reference input for drafting (NOT outgoing).
    context: { text: '', links: [], ...(init.context || {}) },
    // Library docs rendered as files the recipient receives (snapshotted at commit).
    outgoing: init.outgoing || [],
    provider: init.provider || null,
    // 'sender' | 'all' when replying — literal; never silently expanded.
    replyScope: init.replyScope || null,
    status: init.status || 'composing', // composing | draft-saved | sent
    // Pointers into the mailbox (source of truth); content read back on demand.
    mailbox: { threadId: null, draftId: null, messageId: null, ...(init.mailbox || {}) },
    // Drafting context/connections kept as a summary; also CLI-readable.
    threadSummary: init.threadSummary || '',
  };
}

function create(premise, { kind, email, voice } = {}) {
  ensureDir();
  const id = newId();
  const now = new Date().toISOString();
  const meta = {
    id,
    title: 'Untitled',
    premise: premise || '',
    // Ordered log of the user's requests across the conversation (premise first,
    // then each revision). Fed back as context so Claude remembers earlier intent
    // — including facts stated only in the premise.
    history: [],
    // Uploaded reference attachments (pictures / documents) for this doc.
    attachments: [],
    // Per-operation token/cost usage events (draft, revise, briefing, export…).
    usage: [],
    // The voice (style skill id) this doc writes in; null = no voice. New docs
    // inherit the picker default at creation so the first draft uses it.
    voice: voice || null,
    createdAt: now,
    updatedAt: now,
  };
  if (kind === 'email') {
    meta.kind = 'email';
    meta.email = emailDefaults(email);
  }
  fs.writeFileSync(mdPath(id), '');
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

// Shallow-merge a patch into the email block (envelope/context/mailbox merged one
// level deep). Marks the doc as an email and bumps updatedAt.
function setEmail(id, patch = {}) {
  const meta = readMeta(id);
  const cur = meta.email || emailDefaults();
  meta.kind = 'email';
  meta.email = {
    ...cur,
    ...patch,
    envelope: { ...cur.envelope, ...(patch.envelope || {}) },
    context: { ...cur.context, ...(patch.context || {}) },
    mailbox: { ...cur.mailbox, ...(patch.mailbox || {}) },
  };
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

function readMeta(id) {
  return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
}

function exists(id) {
  return fs.existsSync(metaPath(id));
}

function getMarkdown(id) {
  return fs.readFileSync(mdPath(id), 'utf8');
}

// Persist new body, refresh title + updatedAt.
function setMarkdown(id, markdown) {
  const meta = readMeta(id);
  fs.writeFileSync(mdPath(id), markdown);
  meta.title = deriveTitle(markdown, meta.premise);
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

// Attach a compiled writing brief (from the "talk about it first" intake) and
// adopt its summary as the premise so generation + history reflect the brief.
function setBrief(id, brief) {
  const meta = readMeta(id);
  meta.brief = brief;
  if (brief && brief.summary) meta.premise = brief.summary;
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

// Set the voice (style skill id) this document writes in. null clears it (the
// picker default applies). Per-document, so learning attributes to the right voice.
function setVoice(id, voiceId) {
  const meta = readMeta(id);
  meta.voice = voiceId || null;
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

// Attachment metadata (the bytes live under docs-assets/, see lib/attachments).
function addAttachment(id, att) {
  const meta = readMeta(id);
  meta.attachments = [...(meta.attachments || []), att];
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

function removeAttachment(id, storedName) {
  const meta = readMeta(id);
  meta.attachments = (meta.attachments || []).filter((a) => a.storedName !== storedName);
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

// Append one or more usage events ({ op, model, usd, input, output, ... }).
// Each is stamped with a timestamp. Returns the updated meta.
function addUsage(id, events) {
  const meta = readMeta(id);
  const list = Array.isArray(events) ? events : [events];
  const now = new Date().toISOString();
  meta.usage = [...(meta.usage || []), ...list.map((e) => ({ at: now, ...e }))];
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

// Replace the conversation history (used to reset it at generation time).
function setHistory(id, history) {
  const meta = readMeta(id);
  meta.history = history;
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

// Append one user request to the conversation history.
function addHistory(id, content) {
  const meta = readMeta(id);
  meta.history = [...(meta.history || []), { role: 'user', content }];
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

// Drop a history entry by index. Index 0 (the premise) is never removed.
function removeHistory(id, index) {
  const meta = readMeta(id);
  const h = meta.history || [];
  if (index > 0 && index < h.length) {
    h.splice(index, 1);
    meta.history = h;
    fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  }
  return meta;
}

function get(id) {
  const meta = readMeta(id);
  return { ...meta, markdown: getMarkdown(id) };
}

function list() {
  ensureDir();
  return fs
    .readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(DOCS_DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

function remove(id) {
  for (const p of [mdPath(id), metaPath(id)]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

module.exports = {
  DOCS_DIR,
  create,
  setEmail,
  exists,
  get,
  getMarkdown,
  setMarkdown,
  setBrief,
  setVoice,
  addAttachment,
  removeAttachment,
  addUsage,
  setHistory,
  addHistory,
  removeHistory,
  readMeta,
  list,
  remove,
  deriveTitle,
};
