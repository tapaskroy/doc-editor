// Read-write voice store. Kept separate from lib/skills.js so the discovery seam
// stays read-only (per the architecture review). voice.json is AUTHORITATIVE for a
// voice's rules and metadata; SKILL.md carries a human preamble plus a regenerated,
// read-only "Learned rules" block that mirrors the active rules for portability
// (other Claude Code instances read SKILL.md). compose() builds the injected prompt
// from the preamble plus the active rules in voice.json, so there is one owner.

const fs = require('fs');
const path = require('path');
const skills = require('./skills'); // discovery only: voiceDir(), read()

const LEARN_START = '<!-- learned:start -->';
const LEARN_END = '<!-- learned:end -->';
const BLOCK_RE = new RegExp(`${LEARN_START}[\\s\\S]*?${LEARN_END}`);

function jsonPath(id) {
  const dir = skills.voiceDir(id);
  return dir ? path.join(dir, 'voice.json') : null;
}

// Atomic write: temp-then-rename, so a concurrent reader sees old or new, never torn.
function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function load(id) {
  const p = jsonPath(id);
  if (p && fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* fall through */ }
  }
  return { id: path.basename(String(id || '')), rules: [], lastReviewedAt: null };
}

function save(id, data) {
  const p = jsonPath(id);
  if (!p) return false;
  atomicWrite(p, JSON.stringify(data, null, 2));
  return true;
}

function listRules(id) {
  return load(id).rules || [];
}

function newRuleId() {
  return 'r_' + Math.random().toString(36).slice(2, 8);
}

// Add a learned rule. Suggest-only by default; the review gate promotes to 'active',
// which is when it reaches the prompt. `observation` (human-readable) is preserved.
function addRule(id, { observation = '', text, layer = 'voice', source = 'edits', evidence = [], status = 'suggested', confidence = 1 } = {}) {
  if (!text || !String(text).trim()) return null;
  const data = load(id);
  const now = new Date().toISOString();
  const rule = {
    id: newRuleId(),
    observation: String(observation || '').trim(),
    text: String(text).trim(),
    layer,
    status,
    confidence,
    support: evidence,
    source,
    createdAt: now,
    updatedAt: now,
  };
  data.rules = [...(data.rules || []), rule];
  save(id, data);
  if (status === 'active') regenerateBlock(id);
  return rule;
}

function setRuleStatus(id, ruleId, status) {
  const data = load(id);
  const rule = (data.rules || []).find((r) => r.id === ruleId);
  if (!rule) return null;
  rule.status = status;
  rule.updatedAt = new Date().toISOString();
  save(id, data);
  regenerateBlock(id);
  return rule;
}

function markReviewed(id) {
  const data = load(id);
  data.lastReviewedAt = new Date().toISOString();
  save(id, data);
  return data.lastReviewedAt;
}

// The SKILL.md body with the managed block removed: the human-owned preamble.
function preamble(id) {
  const body = skills.read(id);
  if (body == null) return null;
  return body.replace(BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

// The injected prompt: preamble + ACTIVE voice rules, read from voice.json (the
// authoritative source), not from the SKILL.md mirror.
function compose(id) {
  const pre = preamble(id);
  if (pre == null) return null;
  const active = listRules(id).filter((r) => r.status === 'active' && r.layer === 'voice');
  if (!active.length) return pre;
  return `${pre}\n\n## Learned rules\n\n${active.map((r) => `- ${r.text}`).join('\n')}`;
}

// Regenerate SKILL.md's managed block from the active rules (portability mirror).
// Atomic; preserves the human preamble (only the fenced block is replaced).
function regenerateBlock(id) {
  const dir = skills.voiceDir(id);
  if (!dir) return false;
  const file = path.join(dir, 'SKILL.md');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const active = listRules(id).filter((r) => r.status === 'active' && r.layer === 'voice');
  const block = active.length
    ? `${LEARN_START}\n## Learned rules\n\n${active.map((r) => `- ${r.text}`).join('\n')}\n${LEARN_END}`
    : `${LEARN_START}\n${LEARN_END}`;
  const next = BLOCK_RE.test(raw) ? raw.replace(BLOCK_RE, block) : `${raw.replace(/\s*$/, '')}\n\n${block}\n`;
  atomicWrite(file, next);
  return true;
}

// Replace the human-owned PREAMBLE (the part the user authors), preserving the YAML
// frontmatter and re-rendering the managed learned-rules block from voice.json — so
// editing the preamble never disturbs voice.json (the authoritative store). The
// learned-rules block stays a deterministic mirror; only the preamble is user-owned.
function setPreamble(id, text) {
  const dir = skills.voiceDir(id);
  if (!dir) return false;
  const file = path.join(dir, 'SKILL.md');
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const fm = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const head = fm ? `${fm[0].replace(/\s*$/, '')}\n\n` : '';
  atomicWrite(file, `${head}${String(text || '').trim()}\n`); // preamble only, no block yet
  regenerateBlock(id); // re-append the managed block from voice.json's active rules
  return true;
}

module.exports = { compose, preamble, listRules, addRule, setRuleStatus, regenerateBlock, setPreamble, markReviewed, load, save };
