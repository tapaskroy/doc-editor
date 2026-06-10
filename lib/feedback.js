// The process-feedback channel: where "Claude got it wrong" lessons go, kept
// physically separate from any voice so failures never become the user's
// personality (personalization spec section 7). Two kinds:
//   'guardrail' — a behavioral fix / bug (hallucination, ignored instruction)
//   'quality'   — a recurring stylistic mistake → candidate for the global baseline
// Stored as a flat JSON file so it is also readable from the CLI.

const fs = require('fs');
const path = require('path');

const FILE = process.env.DOC_EDITOR_FEEDBACK_FILE || path.join(__dirname, '..', 'feedback.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { items: [] }; }
}

function save(data) {
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

function add({ kind = 'guardrail', text, observation = '', doc = null } = {}) {
  if (!text || !String(text).trim()) return null;
  const data = load();
  const rec = {
    id: 'f_' + Math.random().toString(36).slice(2, 8),
    kind,
    text: String(text).trim(),
    observation: String(observation || '').trim(),
    doc,
    at: new Date().toISOString(),
  };
  data.items = [...(data.items || []), rec];
  save(data);
  return rec;
}

function list() {
  return load().items || [];
}

// Compose the kept corrections into a prompt block ("avoid these"), so a kept
// Claude-correction actually changes future output (not just sits in a log).
// Deduped by text and capped to keep prompts lean. Returns '' when empty.
function compose({ limit = 20 } = {}) {
  const items = list();
  const seen = new Set();
  const lines = [];
  for (let i = items.length - 1; i >= 0 && lines.length < limit; i--) {
    const t = String(items[i].text || '').trim();
    const key = t.toLowerCase();
    if (!t || seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${t}`);
  }
  if (!lines.length) return '';
  return '\n\n----- AVOID THESE (corrections from earlier drafts) -----\n' +
    'You have made these mistakes before; do not repeat them:\n' + lines.reverse().join('\n');
}

module.exports = { add, list, compose, FILE };
