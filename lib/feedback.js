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

module.exports = { add, list, FILE };
