// Personal memory store: durable facts about the user — the "what is true about me"
// layer, sibling to the voice store's "how I write". See specs/personal-memory-spec.md
// and design/personal-memory-design.md.
//
// Canonical CONTENT is portable Markdown the user owns: USER.md (the always-on core)
// plus topics/<topic>.md. `memory.json` is METADATA only (provenance + the unsaved
// review queue); it annotates the Markdown and is never the source of the facts (this
// is what avoids the voice.json/SKILL.md split-brain — here Markdown is authoritative).
//
// doc-editor consumes memory ONLY through retrieve()/compose() (lean, guardrailed).
// The ~/.claude projection (syncToClaudeDir) is a separate, consented step so the
// user's OTHER Claude Code sessions benefit; doc-editor's own writing spawns exclude
// the `user` setting source (see lib/claude.js) so they never auto-load it.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Canonical store: a neutral, user-owned dir OUTSIDE the repo (privacy + portability).
const MEM_DIR = process.env.DOC_EDITOR_MEMORY_DIR || path.join(os.homedir(), '.config', 'doc-editor', 'memory');
const TOPICS_DIR = path.join(MEM_DIR, 'topics');
const PROFILE_PATH = path.join(MEM_DIR, 'USER.md');
const MANIFEST_PATH = path.join(MEM_DIR, 'memory.json');
// ~/.claude projection target (overridable so tests never touch the real one).
const CLAUDE_DIR = process.env.DOC_EDITOR_CLAUDE_DIR || path.join(os.homedir(), '.claude');

// Fixed keep-taxonomy (design Q5): predictable USER.md sections, easy to inspect.
const SECTION_TITLES = { identity: 'Identity', people: 'People', work: 'Work', taste: 'Taste', other: 'Other' };

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sanitizeTopic = (t) => String(t || 'misc').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'misc';
const cap = (s) => String(s || '').replace(/^\w/, (c) => c.toUpperCase());

function ensureDir() {
  fs.mkdirSync(TOPICS_DIR, { recursive: true });
}

// Atomic write: temp-then-rename, so a reader never catches a torn file.
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const storeExists = () => fs.existsSync(PROFILE_PATH);

// ---- Markdown content (canonical) ---------------------------------------

function readProfile() {
  try { return fs.readFileSync(PROFILE_PATH, 'utf8'); } catch { return ''; }
}
function writeProfile(md) {
  atomicWrite(PROFILE_PATH, String(md == null ? '' : md));
  return true;
}
function topicPath(name) {
  return path.join(TOPICS_DIR, `${sanitizeTopic(name)}.md`);
}
function listTopics() {
  try {
    return fs.readdirSync(TOPICS_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort();
  } catch { return []; }
}
function readTopic(name) {
  try { return fs.readFileSync(topicPath(name), 'utf8'); } catch { return ''; }
}
function writeTopic(name, md) {
  atomicWrite(topicPath(name), String(md == null ? '' : md));
  return true;
}

// Append "- text" under a "## Heading" (creating the heading if missing); when no
// heading is given (topic files), append at the end. Returns the new content.
function appendBullet(file, heading, text) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const line = `- ${text}`;
  if (heading) {
    const hRe = new RegExp(`^##\\s+${escapeRe(heading)}\\s*$`, 'm');
    const m = hRe.exec(raw);
    if (m) {
      const at = m.index + m[0].length;
      raw = `${raw.slice(0, at)}\n${line}${raw.slice(at)}`;
    } else {
      raw = `${raw.replace(/\s*$/, '')}\n\n## ${heading}\n${line}\n`;
    }
  } else {
    raw = `${raw.replace(/\s*$/, '')}\n${line}\n`;
  }
  atomicWrite(file, raw);
  return raw;
}

// Remove the first bullet line matching `text` (used by forget). Best-effort.
function removeBullet(file, text) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const want = norm(`- ${text}`);
  const lines = raw.split('\n');
  const i = lines.findIndex((l) => norm(l) === want);
  if (i === -1) return false;
  lines.splice(i, 1);
  atomicWrite(file, lines.join('\n'));
  return true;
}

// ---- Manifest (metadata only: provenance + the unsaved queue) -----------

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch { return { items: [] }; }
}
function saveManifest(data) {
  atomicWrite(MANIFEST_PATH, JSON.stringify(data, null, 2));
}
const newItemId = () => 'm_' + Math.random().toString(36).slice(2, 8);

// Add captured candidates to the UNSAVED queue (suggest-only; never written to the
// Markdown until kept). Dedups against every known item (any status) by normalized
// text, so the same fact isn't re-proposed after it was kept or discarded. Returns
// the items actually added.
function propose(items = []) {
  const data = loadManifest();
  const seen = new Set((data.items || []).map((i) => norm(i.text)));
  const now = new Date().toISOString();
  const added = [];
  for (const it of items) {
    const text = String((it && it.text) || '').trim();
    if (!text || seen.has(norm(text))) continue;
    const item = {
      id: newItemId(),
      topic: (it.topic && String(it.topic)) || 'profile', // 'profile' -> USER.md; else topics/<topic>.md
      section: SECTION_TITLES[it.section] ? it.section : 'other', // only for profile items
      text,
      status: 'unsaved', // unsaved | kept | discarded
      provenance: String(it.provenance || ''),
      source: String(it.source || 'capture'), // intake | edits | chat | capture
      sensitivity: 'normal', // seam for deferred tiers; always 'normal' in v1
      createdAt: now,
      keptAt: null,
    };
    data.items = [...(data.items || []), item];
    seen.add(norm(text));
    added.push(item);
  }
  if (added.length) saveManifest(data);
  return added;
}

const listQueue = () => (loadManifest().items || []).filter((i) => i.status === 'unsaved');
const listKept = () => (loadManifest().items || []).filter((i) => i.status === 'kept');

function getItem(data, id) {
  return (data.items || []).find((i) => i.id === id) || null;
}

// Promote an unsaved item: append its fact to the canonical Markdown, mark it kept.
function keep(id) {
  const data = loadManifest();
  const item = getItem(data, id);
  if (!item || item.status !== 'unsaved') return null;
  ensureDir();
  if (!item.topic || item.topic === 'profile') {
    appendBullet(PROFILE_PATH, SECTION_TITLES[item.section] || SECTION_TITLES.other, item.text);
  } else {
    const file = topicPath(item.topic);
    if (!fs.existsSync(file)) atomicWrite(file, `# ${cap(item.topic)}\n`);
    appendBullet(file, null, item.text);
  }
  item.status = 'kept';
  item.keptAt = new Date().toISOString();
  saveManifest(data);
  return item;
}

// Discard an unsaved candidate (tombstone, so it isn't re-proposed).
function discard(id) {
  const data = loadManifest();
  const item = getItem(data, id);
  if (!item) return null;
  item.status = 'discarded';
  saveManifest(data);
  return item;
}

// Forget a kept fact: remove it from the Markdown AND tombstone it.
function forget(id) {
  const data = loadManifest();
  const item = getItem(data, id);
  if (!item) return null;
  const file = (!item.topic || item.topic === 'profile') ? PROFILE_PATH : topicPath(item.topic);
  removeBullet(file, item.text);
  item.status = 'discarded';
  saveManifest(data);
  return item;
}

// ---- Retrieval + composition (consumed by generate/revise in step 3) ----

// Small always-on core (USER.md) + topical files relevant to this document. v1 uses
// cheap lexical overlap to stay lean and instant; a Haiku-scored pass is the noted
// seam for when the store grows large. Returns { profile, topics:[{name,text}] }.
// Common words that should not count toward topic relevance (length>=4 but generic,
// incl. writing-meta words that appear in most premises).
const STOP = new Set([
  'this', 'that', 'with', 'from', 'your', 'have', 'been', 'will', 'what', 'when', 'they',
  'them', 'then', 'than', 'were', 'into', 'also', 'just', 'like', 'some', 'more', 'most',
  'much', 'very', 'here', 'there', 'about', 'would', 'could', 'should', 'their', 'these',
  'those', 'write', 'draft', 'document', 'email', 'message', 'letter', 'note', 'post',
  'piece', 'please', 'want', 'need', 'make', 'recap',
]);
const keywords = (s) => new Set(norm(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)));

function retrieve(ctx = {}) {
  const profile = readProfile();
  const hay = norm([ctx.premise, ctx.brief && JSON.stringify(ctx.brief), (ctx.recipients || []).join(' ')].filter(Boolean).join(' '));
  const words = keywords(hay);
  const topics = listTopics()
    .map((name) => ({ name, text: readTopic(name) }))
    .filter((t) => {
      if (!t.text.trim()) return false;
      if (hay.includes(norm(t.name))) return true; // topic named in the request
      const tw = keywords(t.text);
      let overlap = 0;
      for (const w of words) if (tw.has(w) && ++overlap >= 2) return true;
      return false;
    });
  return { profile: profile || '', topics };
}

// Build the system-prompt block from retrieved memory, carrying the leakage
// guardrail. Grounding is always on; volunteering private facts into the OUTPUT is
// gated by usePersonalFacts (per-document, default off). Returns '' when empty.
function compose(retrieved, { usePersonalFacts = false } = {}) {
  if (!retrieved) return '';
  const parts = [];
  if (retrieved.profile && retrieved.profile.trim()) parts.push(retrieved.profile.trim());
  for (const t of retrieved.topics || []) if (t.text && t.text.trim()) parts.push(t.text.trim());
  if (!parts.length) return '';
  const rule = usePersonalFacts
    ? 'Use these facts to stay accurate. You MAY weave in relevant personal details where the document calls for them.'
    : 'Use these facts ONLY to stay accurate and to avoid inventing details. Do NOT volunteer private facts (names, household, location) into the output unless the document plainly calls for them.';
  return (
    '\n\n----- WHAT IS TRUE ABOUT THE USER (context to ground your writing) -----\n' +
    rule + ' Honor any "Privacy boundaries" stated below.\n\n' +
    parts.join('\n\n')
  );
}

// ---- Projection into ~/.claude (consented; step 5 wires the UI) ---------

// Make the profile visible to the user's OTHER Claude Code sessions: symlink
// USER.md -> ~/.claude/USER.md (copy fallback) and idempotently ensure an
// `@USER.md` import line in ~/.claude/CLAUDE.md (created if absent, appended if
// present, never clobbering existing content). Returns a report of what it did.
// Caller must have the user's consent (Decision A) — it edits a file outside the store.
function syncToClaudeDir() {
  if (!storeExists()) return { ok: false, reason: 'no profile to project' };
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });

  // 1) the USER.md link/copy
  const link = path.join(CLAUDE_DIR, 'USER.md');
  let linkMode;
  let lst = null;
  try { lst = fs.lstatSync(link); } catch { /* absent */ }
  if (lst && lst.isSymbolicLink()) {
    if (fs.readlinkSync(link) === PROFILE_PATH) linkMode = 'symlink-present';
    else { fs.unlinkSync(link); fs.symlinkSync(PROFILE_PATH, link); linkMode = 'symlink-relinked'; }
  } else if (lst) {
    // A real (non-symlink) file already lives there — do not clobber the user's file.
    return { ok: false, reason: `${link} exists as a regular file; not overwriting` };
  } else {
    try { fs.symlinkSync(PROFILE_PATH, link); linkMode = 'symlink-created'; }
    catch { fs.copyFileSync(PROFILE_PATH, link); linkMode = 'copied'; } // symlinks unsupported -> copy
  }

  // 2) the @USER.md import in ~/.claude/CLAUDE.md (idempotent, additive)
  const claudeMd = path.join(CLAUDE_DIR, 'CLAUDE.md');
  let cm = '';
  try { cm = fs.readFileSync(claudeMd, 'utf8'); } catch { /* absent */ }
  let importMode;
  if (/^\s*@USER\.md\s*$/m.test(cm)) {
    importMode = 'import-present';
  } else {
    const block = '<!-- doc-editor: personal memory profile -->\n@USER.md\n';
    const next = cm.trim() ? `${cm.replace(/\s*$/, '')}\n\n${block}` : block;
    atomicWrite(claudeMd, next);
    importMode = cm.trim() ? 'import-appended' : 'claudemd-created';
  }
  return { ok: true, link, linkMode, claudeMd, importMode };
}

module.exports = {
  // paths (handy for the server + tests)
  MEM_DIR, TOPICS_DIR, PROFILE_PATH, MANIFEST_PATH, CLAUDE_DIR, SECTION_TITLES,
  ensureDir, storeExists,
  // markdown content
  readProfile, writeProfile, listTopics, readTopic, writeTopic,
  // manifest / queue
  loadManifest, propose, listQueue, listKept, keep, discard, forget,
  // use in writing
  retrieve, compose,
  // projection
  syncToClaudeDir,
};
