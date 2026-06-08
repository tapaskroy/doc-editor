// The learn-from-my-edits pipeline (personalization spec sections 4, 5, 7).
//
// collect edit events from version history -> guard against failure/retry loops ->
// classify in one Haiku pass into voice / context / claude-correction / noise ->
// return candidates for the review gate. Nothing is written without approval;
// applyCandidate() (after the user keeps it) routes to the voice store or the
// process-feedback channel. The classify pass runs through the user's own claude
// CLI (trust boundary; spec section 9), the same channel drafting already uses.

const docs = require('./docs');
const versions = require('./versions');
const voicestore = require('./voicestore');
const feedback = require('./feedback');
const claude = require('./claude');

const MAX_EVENTS = Number(process.env.LEARN_MAX_EVENTS || 40);
const EXCERPT = 1200; // chars of before/after sent to the classifier

// Correction language: the user fixing a Claude mistake, not stating a preference.
// Used as a hint to the classifier and to pre-flag likely process-feedback.
const CORRECTION_RE = /\b(you made (this|that|it) up|made (this|that|it) up|fabricat\w*|hallucinat\w*|this is wrong|that'?s wrong|still wrong|not (what|true|right)|i (did ?n'?t|never) (say|said|write|wrote|mean|meant)|wrong (date|name|number|fact|year|spelling)|fails? the|stop (adding|using|inventing|making)|don'?t (add|invent|make up))\b/i;

function isCorrection(text) {
  return CORRECTION_RE.test(String(text || ''));
}

// Build edit "events" from a doc's snapshots, oldest-first, each carrying markdown.
//  - manual:   an AI snapshot followed by a manual edit (before=ai, after=manual)
//  - revision: a Claude revision (the instruction is the signal)
// Each event is attributed to the voice that produced the AI side (spec decision 10).
function collectEvents(snapshots) {
  const events = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const cur = snapshots[i];
    if (!prev || !cur) continue;
    if (cur.kind === 'manual') {
      events.push({ type: 'manual', before: prev.markdown || '', after: cur.markdown || '', instruction: '', voice: prev.voice || cur.voice || null, at: cur.at });
    } else if (cur.kind === 'ai' && /^Revision:/.test(cur.label || '')) {
      events.push({ type: 'revision', before: prev.markdown || '', after: cur.markdown || '', instruction: (cur.label || '').replace(/^Revision:\s*/, ''), voice: cur.voice || prev.voice || null, at: cur.at });
    }
  }
  return events;
}

// Drop no-op events (identical before/after after trimming).
function prefilter(events) {
  return events.filter((e) => (e.before || '').trim() !== (e.after || '').trim());
}

const CLASSIFY_SYSTEM = `You analyze how a user edited or corrected an AI's draft, to learn WHO the user is without mistaking your own errors for their taste.

For each edit event, decide what it teaches and output exactly one classification:
- "voice": a stable STYLE/TASTE preference in HOW the user writes (word choice, rhythm, structure, tone). Only if it looks like a general preference, not a one-off content change.
- "context": a FACT about the user or their world the user supplied or corrected (people, projects, history, preferences). Not style.
- "claude": the user is CORRECTING YOUR MISTAKE, not expressing a preference. This is feedback about you, never the user's personality. Use subtype "guardrail" for a behavioral fix or bug (you hallucinated/fabricated a fact, ignored an instruction, broke formatting) or "quality" for a recurring stylistic mistake of yours (e.g. you keep adding em dashes).
- "noise": typo fixes, reordering, or one-off content with no general lesson.

Rules:
- A repeated correction of the SAME passage is a retry loop: it means you failed, NOT that the user feels strongly. Classify it as "claude" (and/or "context" for the corrected fact). It is ONE lesson, never several.
- Correction language ("you made this up", "this is wrong", "fails the math test") means "claude" and possibly "context", never "voice".
- Be conservative about "voice": prefer "noise" unless it is clearly a general style preference.
- Each candidate also includes a one-line human-readable "observation" and a "text" (the rule/guardrail to remember).

Respond with ONLY this JSON (no prose, no code fence):
{"candidates":[{"target":"voice|context|claude|noise","subtype":"guardrail|quality|null","observation":"…","text":"…"}]}`;

function excerpt(s) {
  s = String(s || '');
  return s.length > EXCERPT ? s.slice(0, EXCERPT) + ' …[truncated]' : s;
}

function buildClassifyPrompt(events, existingRules, history) {
  const parts = [];
  if (existingRules && existingRules.length) {
    parts.push('EXISTING RULES for this voice (do not duplicate; say so if an event matches one):\n' +
      existingRules.map((r) => `- [${r.status}] ${r.text}`).join('\n'));
  }
  if (history && history.length) {
    parts.push('THE USER\'S INSTRUCTIONS THIS SESSION (in order):\n' +
      history.map((h, i) => `${i}. ${String(h.content || '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n'));
  }
  parts.push('EDIT EVENTS:\n' + events.map((e, i) => {
    const hint = isCorrection(e.instruction) ? ' [looks like a correction]' : '';
    return `--- event ${i + 1} (${e.type})${hint} ---\n` +
      (e.instruction ? `instruction: ${e.instruction}\n` : '') +
      `BEFORE:\n${excerpt(e.before)}\nAFTER:\n${excerpt(e.after)}`;
  }).join('\n\n'));
  return { system: CLASSIFY_SYSTEM, prompt: parts.join('\n\n') };
}

function normalizeCandidates(data) {
  const arr = (data && Array.isArray(data.candidates)) ? data.candidates : [];
  return arr
    .map((c) => ({
      target: ['voice', 'context', 'claude', 'noise'].includes(c.target) ? c.target : 'noise',
      subtype: c.subtype === 'guardrail' || c.subtype === 'quality' ? c.subtype : null,
      observation: String(c.observation || '').trim(),
      text: String(c.text || '').trim(),
    }))
    .filter((c) => c.text && c.target !== 'noise');
}

// ---- Capture durable user facts from the planning conversation ----------
// A separate, suggest-only pass (no in-flow prompts — design Q3): after a briefed
// draft, mine the intake transcript for DURABLE facts about the user/world to offer
// to personal memory, kept apart from this document's one-off details.

const CAPTURE_SYSTEM = `You read a planning conversation in which a user described a document they want written. Extract ONLY durable facts ABOUT THE USER OR THEIR WORLD that are worth remembering across FUTURE documents: their people (names, relationships), work/role/employer, where they live or regularly go, languages, and lasting preferences or tastes.

Do NOT extract:
- document-specific details (this trip's itinerary, this email's one-off ask, this doc's deadline) — those belong to the document, not long-term memory;
- transient, speculative, or one-off things;
- the user's writing STYLE preferences (handled elsewhere);
- facts about other people that aren't really about the user's own life.

For each durable fact give:
- "text": one short sentence, the fact as it should be remembered (e.g. "Has a spouse and one child." or "Works as a VP at a logistics company.");
- "topic": "profile" for core identity/people/work, otherwise a single lowercase word like "travel" or "taste";
- "section": one of identity|people|work|taste|other (only meaningful when topic is "profile").

Respond with ONLY this JSON (no prose, no code fence):
{"facts":[{"text":"…","topic":"profile","section":"people"}]}
If there are no durable user facts, return {"facts":[]}.`;

function normalizeFacts(data) {
  const arr = data && Array.isArray(data.facts) ? data.facts : [];
  return arr
    .map((f) => ({
      text: String((f && f.text) || '').trim(),
      topic: f && typeof f.topic === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(f.topic) ? f.topic.toLowerCase() : 'profile',
      section: ['identity', 'people', 'work', 'taste', 'other'].includes(f && f.section) ? f.section : 'other',
    }))
    .filter((f) => f.text);
}

// Mine an intake transcript for durable user facts (Haiku). Returns { facts, usage }.
// The caller stamps provenance and routes them to memory.propose() (suggest-only).
async function captureFromIntake(intake, { model } = {}) {
  if (!Array.isArray(intake) || !intake.length) return { facts: [], usage: null };
  const prompt = 'PLANNING CONVERSATION:\n' +
    intake.map((m) => `${m.role === 'user' ? 'User' : 'Interviewer'}: ${String(m.content || '').trim()}`).join('\n\n');
  const { data, usage } = await claude.analyze(CAPTURE_SYSTEM, prompt, { model });
  return { facts: normalizeFacts(data), usage };
}

// Run the pipeline for a document. Returns candidates grouped for the review gate.
async function propose(docId, { model } = {}) {
  const metaList = versions.list(docId) || []; // newest-first metadata
  const ordered = metaList.slice().reverse().map((s) => ({ ...s, markdown: (versions.get(docId, s.vid) || {}).markdown || '' }));
  let events = prefilter(collectEvents(ordered));
  const total = events.length;
  const capped = total > MAX_EVENTS;
  if (capped) events = events.slice(-MAX_EVENTS); // keep the most recent

  if (!events.length) return { voiceId: docs.readMeta(docId).voice || null, voiceCandidates: [], contextCandidates: [], feedbackCandidates: [], events: 0, capped: false, usage: null };

  const meta = docs.readMeta(docId);
  const voiceId = meta.voice || null;
  const existing = voiceId ? voicestore.listRules(voiceId) : [];
  const { system, prompt } = buildClassifyPrompt(events, existing, meta.history || []);
  const { data, usage } = await claude.analyze(system, prompt, { model });
  const candidates = normalizeCandidates(data);

  return {
    voiceId,
    voiceCandidates: candidates.filter((c) => c.target === 'voice'),
    contextCandidates: candidates.filter((c) => c.target === 'context'),
    feedbackCandidates: candidates.filter((c) => c.target === 'claude'),
    events: total,
    capped,
    usage,
  };
}

// Commit an approved candidate. voice/context -> the voice store (active);
// claude -> the process-feedback channel. Never the reverse.
function applyCandidate(docId, voiceId, candidate) {
  if (!candidate || !candidate.text) return { ok: false, error: 'empty candidate' };
  if (candidate.target === 'claude') {
    const rec = feedback.add({ kind: candidate.subtype || 'guardrail', text: candidate.text, observation: candidate.observation, doc: docId });
    return { ok: true, where: 'feedback', rec };
  }
  if (candidate.target === 'voice' || candidate.target === 'context') {
    if (!voiceId) return { ok: false, error: 'no voice selected for this document' };
    const rule = voicestore.addRule(voiceId, {
      observation: candidate.observation,
      text: candidate.text,
      layer: candidate.target,
      source: 'edits',
      status: 'active', // approved through the gate
    });
    return { ok: true, where: 'voice', rule };
  }
  return { ok: false, error: 'unsupported target' };
}

module.exports = {
  isCorrection, collectEvents, prefilter, buildClassifyPrompt, normalizeCandidates, propose, applyCandidate, CORRECTION_RE,
  captureFromIntake, normalizeFacts,
};
