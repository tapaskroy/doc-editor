// Voice-learning signal log (M1 instrumentation). Records, for each "learn from my
// edits" decision, whether the user KEPT or DISMISSED a proposed candidate, plus the
// candidate's class and its human-readable evidence (`observation`). This is the
// cheapest way to test the moat's core assumption — that edits yield lessons a human
// keeps — by letting us read the kept/dismissed corpus and compute a keep-rate.
//
// Append-only flat JSON (like lib/feedback.js), so it's also CLI-readable. Kept
// deliberately light: the distilled `observation`/`text`, not raw diffs.

const fs = require('fs');
const path = require('path');

const FILE = process.env.DOC_EDITOR_LEARNLOG_FILE || path.join(__dirname, '..', 'learnlog.json');
const CAP = 2000; // keep the file small; we only need a rolling window for analysis

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { entries: [] }; }
}

function save(data) {
  const tmp = `${FILE}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

// Record one decision. `decision` is 'kept' | 'dismissed'; `candidate` is the learn
// candidate ({ target, subtype, observation, text }).
function add({ decision, candidate = {}, docId = null, voiceId = null } = {}) {
  if (decision !== 'kept' && decision !== 'dismissed') return null;
  const data = load();
  const entry = {
    id: 'l_' + Math.random().toString(36).slice(2, 8),
    at: new Date().toISOString(),
    decision,
    target: candidate.target || 'unknown', // voice | context | claude
    subtype: candidate.subtype || null,
    observation: String(candidate.observation || candidate.text || '').trim(),
    text: String(candidate.text || '').trim(),
    docId,
    voiceId,
  };
  data.entries = [...(data.entries || []), entry];
  if (data.entries.length > CAP) data.entries = data.entries.slice(-CAP);
  save(data);
  return entry;
}

function list() {
  return load().entries || [];
}

// Aggregate keep-rate, overall and per candidate class — the go/kill signal for M1.
function summary() {
  const entries = list();
  const byClass = {};
  let kept = 0;
  let dismissed = 0;
  for (const e of entries) {
    const c = e.target || 'unknown';
    byClass[c] = byClass[c] || { kept: 0, dismissed: 0 };
    byClass[c][e.decision] = (byClass[c][e.decision] || 0) + 1;
    if (e.decision === 'kept') kept++;
    else if (e.decision === 'dismissed') dismissed++;
  }
  const total = kept + dismissed;
  return { kept, dismissed, total, keepRate: total ? kept / total : null, byClass };
}

module.exports = { add, list, summary, FILE };
