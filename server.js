// Personal doc editor — local HTTP server.
// Serves the single-page app and brokers between the browser and the local
// `claude` CLI. Run with `npm start`, then open http://localhost:9999

const path = require('path');
const express = require('express');
const { marked } = require('marked');

const docs = require('./lib/docs');
const claude = require('./lib/claude');
const exporter = require('./lib/export');
const skills = require('./lib/skills');
const voicestore = require('./lib/voicestore');
const memory = require('./lib/memory');
const learn = require('./lib/learn');
const feedback = require('./lib/feedback');
const attachments = require('./lib/attachments');
const versions = require('./lib/versions');
const mail = require('./lib/mail');
const mailstore = require('./lib/mailstore');

// A short, single-line label for a revision snapshot from its request text.
function shortLabel(request) {
  const s = String(request || '').replace(/\s+/g, ' ').replace(/^Global instruction:\s*/, '').trim();
  return s.length > 60 ? s.slice(0, 57) + '…' : s || 'edit';
}

const PORT = process.env.PORT || 9999;
// Bind to loopback only by default: this is a local, single-user, no-auth tool,
// and binding to all interfaces would let anyone on the same network spawn the
// `claude` CLI against the user's subscription, read/write/delete their docs, and
// trigger arbitrary web fetches. Override with HOST (e.g. 0.0.0.0) if you really
// need LAN access and understand the exposure.
const HOST = process.env.HOST || '127.0.0.1';
const app = express();

app.use(express.json({ limit: '30mb' })); // attachments are uploaded as base64 JSON
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded attachment files (e.g. images embedded in a document).
app.get('/media/:docId/:name', (req, res) => {
  const file = attachments.mediaFile(req.params.docId, req.params.name);
  if (!file.startsWith(attachments.ASSETS_DIR)) return res.status(400).end();
  res.sendFile(file, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});
// Serve the browser build of marked so the client can render Markdown offline.
app.get('/vendor/marked.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'node_modules/marked/marked.min.js'));
});
// turndown (+ GFM plugin) converts the edited HTML back to Markdown in the browser.
app.get('/vendor/turndown.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'node_modules/turndown/dist/turndown.js'));
});
app.get('/vendor/turndown-gfm.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'node_modules/turndown-plugin-gfm/dist/turndown-plugin-gfm.js'));
});

// Browsers auto-request a favicon; answer quietly with an inline document emoji.
app.get('/favicon.ico', (req, res) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text y="14" font-size="14">📝</text></svg>';
  res.type('image/svg+xml').send(svg);
});

marked.setOptions({ gfm: true, breaks: false });
const render = (md) => marked.parse(md || '');

// --- Document CRUD -------------------------------------------------------

app.get('/api/docs', (req, res) => {
  res.json(docs.list());
});

// Available voice/style skills the user can write in.
app.get('/api/skills', (req, res) => {
  res.json(skills.list());
});

app.post('/api/docs', async (req, res) => {
  const { premise = '', intake, intakeUsage, model, effort, kind, email, voice } = req.body || {};
  // Persist the raw planning transcript on the doc so generation can ground on it
  // verbatim (and revise on a distilled summary of it) — see hybrid C.
  let meta = docs.create(premise, { kind, email, voice, intake });
  // Carry over the cost of the briefing interview turns (run before the doc existed).
  if (Array.isArray(intakeUsage) && intakeUsage.length) {
    meta = docs.addUsage(meta.id, intakeUsage.map((u) => ({ op: 'briefing', requested: model || '', ...u })));
  }
  // If this doc came from a "talk about it first" session, compile the planning
  // conversation into a structured brief that drives a more targeted draft.
  if (Array.isArray(intake) && intake.length) {
    try {
      const { brief, usage } = await claude.compileBrief(intake, { model, effort });
      meta = docs.setBrief(meta.id, brief);
      meta = docs.addUsage(meta.id, { op: 'brief', requested: model || '', ...usage });
    } catch (err) {
      // Non-fatal: fall back to a plain premise-driven draft.
      console.error('brief compilation failed:', err.message);
    }
  }
  res.json(meta);
});

// One interviewer turn for the "talk about it first" intake (stateless;
// the client holds the running transcript and accumulates usage).
app.post('/api/intake', async (req, res) => {
  const { messages = [], model, effort } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'no messages provided' });
  }
  try {
    const { reply, usage } = await claude.interview(messages, { model, effort });
    res.json({ reply, usage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Inline editing: save the document's Markdown (converted from the edited HTML
// client-side). No Claude call — this is a free, direct edit; just persist it.
// PUT for normal autosave; POST too so navigator.sendBeacon (close-tab) works.
function saveContent(req, res) {
  const { id } = req.params;
  if (!docs.exists(id)) return res.status(404).json({ error: 'not found' });
  const { markdown } = req.body || {};
  if (typeof markdown !== 'string') return res.status(400).json({ error: 'markdown (string) required' });
  const meta = docs.setMarkdown(id, markdown);
  versions.add(id, { label: 'Manual edit', kind: 'manual', markdown }); // coalesced per burst
  res.json({ title: meta.title, updatedAt: meta.updatedAt });
}
app.put('/api/docs/:id/content', saveContent);
app.post('/api/docs/:id/content', saveContent);

// The voice (style skill id) a document writes in. Per-document; the Style picker
// sets it. Generation/revision resolve this before the legacy ?skill= fallback.
app.put('/api/docs/:id/voice', (req, res) => {
  if (!docs.exists(req.params.id)) return res.status(404).json({ error: 'not found' });
  const meta = docs.setVoice(req.params.id, (req.body || {}).voiceId || null);
  res.json({ ok: true, voice: meta.voice });
});

// --- Learn from my edits (the personalization loop) ----------------------
// propose: classify the doc's edit history into candidates for the review gate.
// apply: commit an approved candidate (voice/context -> voice store; claude ->
// the feedback channel). Suggest-only: nothing is written until the user keeps it.
app.post('/api/docs/:id/learn/propose', async (req, res) => {
  if (!docs.exists(req.params.id)) return res.status(404).json({ error: 'not found' });
  try {
    const result = await learn.propose(req.params.id, { model: (req.body || {}).model });
    if (result.usage) docs.addUsage(req.params.id, { op: 'learn', requested: (req.body || {}).model || '', ...result.usage });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/docs/:id/learn/apply', (req, res) => {
  if (!docs.exists(req.params.id)) return res.status(404).json({ error: 'not found' });
  const { voiceId, candidate } = req.body || {};
  const r = learn.applyCandidate(req.params.id, voiceId || docs.readMeta(req.params.id).voice || null, candidate);
  res.status(r.ok ? 200 : 400).json(r);
});

app.get('/api/feedback', (req, res) => {
  res.json({ items: feedback.list() });
});

app.get('/api/docs/:id', (req, res) => {
  if (!docs.exists(req.params.id)) return res.status(404).json({ error: 'not found' });
  const doc = docs.get(req.params.id);
  // Don't expose server-only absolute paths to the browser.
  const safeAttachments = (doc.attachments || []).map(({ refPath, ...a }) => a);
  res.json({ ...doc, attachments: safeAttachments, html: render(doc.markdown), versions: versions.list(req.params.id) });
});

app.delete('/api/docs/:id', (req, res) => {
  attachments.removeAll(req.params.id); // also drop its uploaded files
  versions.remove(req.params.id); // and its version history
  docs.remove(req.params.id);
  res.json({ ok: true });
});

// --- Version history -----------------------------------------------------

app.get('/api/docs/:id/versions', (req, res) => {
  if (!docs.exists(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json({ versions: versions.list(req.params.id) });
});

// Full Markdown of one snapshot (for the diff / preview).
app.get('/api/docs/:id/versions/:vid', (req, res) => {
  const v = versions.get(req.params.id, req.params.vid);
  if (!v) return res.status(404).json({ error: 'version not found' });
  res.json({ vid: v.vid, label: v.label, at: v.at, markdown: v.markdown });
});

// What this snapshot changed: its Markdown paired with the previous snapshot's.
app.get('/api/docs/:id/versions/:vid/diff', (req, res) => {
  const pair = versions.diffPair(req.params.id, req.params.vid);
  if (!pair) return res.status(404).json({ error: 'version not found' });
  res.json(pair);
});

// Restore a snapshot (non-destructive: records a new "Restored" snapshot).
app.post('/api/docs/:id/versions/:vid/restore', (req, res) => {
  const { id, vid } = req.params;
  if (!docs.exists(id)) return res.status(404).json({ error: 'not found' });
  const v = versions.get(id, vid);
  if (!v) return res.status(404).json({ error: 'version not found' });
  const meta = docs.setMarkdown(id, v.markdown);
  const list = versions.add(id, { label: `Restored: ${v.label}`, kind: 'restore', markdown: v.markdown });
  res.json({ markdown: v.markdown, html: render(v.markdown), title: meta.title, versions: list });
});

// Single-step undo: revert to the snapshot just before the current head.
app.post('/api/docs/:id/undo', (req, res) => {
  const { id } = req.params;
  if (!docs.exists(id)) return res.status(404).json({ error: 'not found' });
  const prev = versions.previous(id);
  if (!prev) return res.status(400).json({ error: 'nothing to undo' });
  const meta = docs.setMarkdown(id, prev.markdown);
  const list = versions.add(id, { label: 'Undo', kind: 'restore', markdown: prev.markdown });
  res.json({ markdown: prev.markdown, html: render(prev.markdown), title: meta.title, versions: list });
});

// --- Attachments (reference pictures / documents for a doc) --------------

app.post('/api/docs/:id/attachments', (req, res) => {
  const { id } = req.params;
  if (!docs.exists(id)) return res.status(404).json({ error: 'not found' });
  const { name, type, dataBase64 } = req.body || {};
  if (!name || !dataBase64) return res.status(400).json({ error: 'name and dataBase64 required' });
  try {
    const att = attachments.store(id, { name, type, dataBase64 });
    docs.addAttachment(id, att);
    // Don't leak the absolute server path to the browser.
    const { refPath, ...safe } = att;
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/docs/:id/attachments/:name', (req, res) => {
  const { id, name } = req.params;
  if (!docs.exists(id)) return res.status(404).json({ error: 'not found' });
  attachments.remove(id, name);
  const meta = docs.removeAttachment(id, name);
  res.json({ attachments: meta.attachments.map(({ refPath, ...a }) => a) });
});

// Prune one conversation-history entry (the premise at index 0 is protected).
app.delete('/api/docs/:id/history/:index', (req, res) => {
  if (!docs.exists(req.params.id)) return res.status(404).json({ error: 'not found' });
  const meta = docs.removeHistory(req.params.id, parseInt(req.params.index, 10));
  res.json({ history: meta.history });
});

// Mine a doc's planning transcript for durable user facts and offer them to the
// personal-memory review queue (suggest-only). Fire-and-forget, runs once per doc
// (guarded by meta.capturedAt), never blocks the draft response. No-op without an
// intake transcript.
function captureMemory(id) {
  const meta = docs.readMeta(id);
  if (!Array.isArray(meta.intake) || !meta.intake.length || meta.capturedAt) return;
  learn.captureFromIntake(meta.intake)
    .then(({ facts, usage }) => {
      if (facts && facts.length) {
        memory.propose(facts.map((f) => ({ ...f, source: 'intake', provenance: `Learned from the planning conversation on "${meta.title}"` })));
      }
      if (usage) docs.addUsage(id, { op: 'capture', requested: 'haiku', ...usage });
      docs.setCapturedAt(id);
    })
    .catch((e) => console.error('memory capture failed:', e.message));
}

// --- Generation (Server-Sent Events stream) ------------------------------

app.get('/api/docs/:id/generate', (req, res) => {
  const { id } = req.params;
  if (!docs.exists(id)) return res.status(404).end();
  const { premise, brief, attachments: atts = [], kind, email, voice, intake, usePersonalFacts } = docs.readMeta(id);
  const { model, effort } = req.query;
  let web = req.query.web === 'true';
  // Per-document voice takes precedence; the ?skill= query is a legacy fallback.
  const voiceId = voice || req.query.skill || null;
  const style = voiceId ? voicestore.compose(voiceId) : null;
  const references = attachments.referenceBlock(id, atts);
  // Personal memory: ground the draft in the relevant slice of the user's profile,
  // carrying the leakage guardrail (volunteering gated by the per-doc toggle). Empty
  // when there is no store, so this is a no-op until memory is set up.
  const recipients = kind === 'email' && email?.envelope?.to ? email.envelope.to : [];
  const memNote = memory.compose(memory.retrieve({ premise, brief, recipients }), { usePersonalFacts });
  const op = docs.getMarkdown(id).trim() ? 'regenerate' : 'draft';
  // Regenerating produces fresh document text, so any distilled context summary is
  // now potentially stale — clear it so the next revise re-distills (the freshness
  // rule for hybrid C).
  if (op === 'regenerate') docs.setContextSummary(id, null);
  // A briefed doc generates from its structured brief; otherwise from the premise.
  let genPrompt = brief ? claude.briefToPrompt(brief) : premise;

  // Email: fold the "provide more context" bundle (free text + links) into the
  // prompt. Links need web reading, so enable it when any are present.
  if (kind === 'email' && email) {
    const blocks = [];
    if (email.context?.text?.trim()) blocks.push(`----- CONTEXT -----\n${email.context.text.trim()}`);
    if (Array.isArray(email.context?.links) && email.context.links.length) {
      blocks.push(`----- LINKS (read these for context) -----\n${email.context.links.join('\n')}`);
      web = true;
    }
    if (blocks.length) genPrompt = `${blocks.join('\n\n')}\n\n----- REQUEST -----\n${genPrompt}`;
  }
  // Start the conversation fresh for this (re)generation; the premise is turn 1.
  docs.setHistory(id, [{ role: 'user', content: premise }]);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const child = claude.generate(genPrompt, {
    model,
    effort,
    web,
    style,
    references,
    kind,
    intake,
    memory: memNote,
    addDir: references ? attachments.docDir(id) : null,
    onReset: () => send('reset', {}),
    onDelta: (text) => send('delta', { text }),
    onDone: (markdown, usage) => {
      docs.setMarkdown(id, markdown);
      const meta = docs.addUsage(id, { op, requested: model || '', ...usage });
      versions.add(id, { label: op === 'draft' ? 'Draft' : 'Regenerated', kind: 'ai', model: usage.model, usd: usage.usd, markdown, voice: voiceId });
      send('done', { markdown, html: render(markdown), title: meta.title, history: meta.history, usage: meta.usage });
      res.end();
      // After the first draft, mine the planning transcript for durable user facts
      // (non-blocking, suggest-only -> the unsaved memory queue). Never on regenerate.
      if (op === 'draft') captureMemory(id);
    },
    onError: (message) => {
      send('error', { message });
      res.end();
    },
  });

  req.on('close', () => {
    try {
      child.kill();
    } catch {}
  });
});

// --- Export (html / pdf / docx / pptx) -----------------------------------

app.get('/api/docs/:id/export', async (req, res) => {
  const { id } = req.params;
  if (!docs.exists(id)) return res.status(404).json({ error: 'not found' });
  const format = String(req.query.format || 'html');
  if (!exporter.FORMATS[format]) {
    return res.status(400).json({ error: `unsupported format: ${format}` });
  }

  try {
    const { title } = docs.readMeta(id);
    const markdown = docs.getMarkdown(id);
    const { model, effort } = req.query;
    // pptx is built by having Claude restructure the doc into a slide deck first.
    let deckUsage = null;
    const deckBuilder = async (md) => {
      const { deck, usage } = await claude.toDeck(md, { model, effort });
      deckUsage = usage;
      return deck;
    };
    const { buffer, contentType, ext } = await exporter.exportDoc(format, markdown, title, { deckBuilder, docId: id });
    if (deckUsage) docs.addUsage(id, { op: 'export-pptx', requested: model || '', ...deckUsage });
    const safe = (title || 'document').replace(/[^\w\d ]+/g, '').trim().replace(/\s+/g, ' ') || 'document';
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="${safe}.${ext}"`);
    res.send(buffer);
  } catch (err) {
    // 501: the format is understood but its engine (pandoc/Chrome) is unavailable.
    res.status(501).json({ error: err.message });
  }
});

// --- Revision (apply selected-text comments / global instruction) --------

app.post('/api/docs/:id/revise', async (req, res) => {
  const { id } = req.params;
  if (!docs.exists(id)) return res.status(404).json({ error: 'not found' });

  const { comments = [], instruction = '', model, effort, web, skill } = req.body || {};
  if (!comments.length && !instruction.trim()) {
    return res.status(400).json({ error: 'no comments or instruction provided' });
  }

  try {
    const markdown = docs.getMarkdown(id);
    const { history = [], attachments: atts = [], voice, intake, contextSummary, premise, brief, kind, email, usePersonalFacts } = docs.readMeta(id);
    const voiceId = voice || skill || null;
    const style = voiceId ? voicestore.compose(voiceId) : null;
    const references = attachments.referenceBlock(id, atts);
    // Same personal-memory grounding as generation (guardrail applies to edits too).
    const recipients = kind === 'email' && email?.envelope?.to ? email.envelope.to : [];
    const memNote = memory.compose(memory.retrieve({ premise, brief, recipients }), { usePersonalFacts });
    // Hybrid C: ground revisions on a distilled summary of the planning transcript
    // (never the raw transcript). Compute it once, lazily, then reuse until a
    // regenerate clears it.
    let summary = contextSummary;
    if (!summary && Array.isArray(intake) && intake.length) {
      try {
        const { summary: s, usage: du } = await claude.distillContext(intake);
        if (s) {
          docs.setContextSummary(id, s);
          docs.addUsage(id, { op: 'distill', requested: 'haiku', ...du });
        }
        summary = s;
      } catch (e) {
        console.error('distillContext failed:', e.message);
      }
    }
    const { edits, request, usage } = await claude.revise({ markdown, comments, instruction, history, contextSummary: summary, memory: memNote, model, effort, web, style, references, addDir: references ? attachments.docDir(id) : null });
    const { markdown: updated, applied } = claude.applyEdits(markdown, edits);
    docs.addHistory(id, request); // record this turn so future revisions remember it
    docs.setMarkdown(id, updated);
    const meta = docs.addUsage(id, { op: 'revise', requested: model || '', ...usage });
    versions.add(id, { label: `Revision: ${shortLabel(request)}`, kind: 'ai', model: usage.model, usd: usage.usd, markdown: updated, voice: voiceId });
    res.json({
      markdown: updated,
      html: render(updated),
      title: meta.title,
      applied,
      history: meta.history,
      usage: meta.usage,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Personal memory: per-doc output gate + transparency -----------------

// Toggle whether this doc may surface known personal facts in its OUTPUT (the
// per-doc half of the leakage guardrail). Grounding is always on regardless.
app.put('/api/docs/:id/use-personal-facts', (req, res) => {
  const { id } = req.params;
  if (!docs.exists(id)) return res.status(404).json({ error: 'not found' });
  const meta = docs.setUsePersonalFacts(id, !!(req.body && req.body.on));
  res.json({ usePersonalFacts: meta.usePersonalFacts });
});

// "What this draft will use": the exact context fed to generation/revision —
// the active voice, the retrieved memory (profile + relevant topic names), whether
// a planning transcript is attached, and the output-facts gate. Powers the
// transparency panel (input-transparency half of the guardrail).
app.get('/api/docs/:id/context', (req, res) => {
  const { id } = req.params;
  if (!docs.exists(id)) return res.status(404).json({ error: 'not found' });
  const { premise, brief, voice, kind, email, intake, usePersonalFacts } = docs.readMeta(id);
  const recipients = kind === 'email' && email?.envelope?.to ? email.envelope.to : [];
  const retrieved = memory.retrieve({ premise, brief, recipients });
  res.json({
    voice: voice || null,
    usePersonalFacts: !!usePersonalFacts,
    hasIntake: Array.isArray(intake) && intake.length > 0,
    memory: {
      enabled: memory.storeExists(),
      profile: retrieved.profile || '',
      topics: retrieved.topics.map((t) => t.name),
    },
  });
});

// --- Personal memory: browse the store + review the unsaved queue ---------
// (The Profile-tab UI is step 5; these backend routes back it and let capture be
// verified now. Keep/discard/forget are the consent gate — suggest-only capture
// never reaches the Markdown until kept here.)

app.get('/api/memory', (req, res) => {
  res.json({
    enabled: memory.storeExists(),
    profile: memory.readProfile(),
    topics: memory.listTopics(),
    queue: memory.listQueue(), // unsaved candidates awaiting keep/discard
    kept: memory.listKept(),
  });
});

app.post('/api/memory/keep', (req, res) => {
  const item = memory.keep((req.body || {}).id);
  if (!item) return res.status(404).json({ error: 'item not found or not unsaved' });
  res.json({ item });
});

app.post('/api/memory/discard', (req, res) => {
  const item = memory.discard((req.body || {}).id);
  if (!item) return res.status(404).json({ error: 'item not found' });
  res.json({ item });
});

app.post('/api/memory/forget', (req, res) => {
  const item = memory.forget((req.body || {}).id);
  if (!item) return res.status(404).json({ error: 'item not found' });
  res.json({ item });
});

// --- Output skills (skill-driven Export / Publish) -----------------------
// doc-editor discovers output skills and shells out to their plan/run CLI. The
// procedure (render/deploy) lives in the skill, never here; the app only knows it
// can call `plan` (no side effects, drives the gate) then `run` (after confirm).

// Run a discovered output skill's subcommand: feed the doc on stdin, parse its
// JSON on stdout. The skill is the user's own code (locked trust model); we run
// its declared `command` in its own directory.
function runOutputSkill(skill, sub, input) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    if (!skill.command) return reject(new Error(`skill "${skill.id}" declares no command`));
    const parts = skill.command.split(/\s+/);
    const child = spawn(parts[0], [...parts.slice(1), sub], { cwd: skill.dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => reject(new Error(`failed to launch skill: ${e.message}`)));
    child.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop() || ''); } catch {}
      if (parsed && parsed.ok === false) return reject(new Error(parsed.error || 'skill reported an error'));
      if (!parsed) return reject(new Error(err.trim() || `skill exited ${code} without JSON output`));
      resolve(parsed);
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

// The document payload the contract hands a skill.
function docInput(id, params) {
  const meta = docs.readMeta(id);
  const media = (meta.attachments || []).map(({ refPath, ...a }) => a); // no server-only paths
  return { markdown: docs.getMarkdown(id), title: meta.title, params: params || {}, media };
}

// List output skills for the Export panel (dir/command stay server-only).
app.get('/api/output-skills', (req, res) => {
  res.json({ skills: skills.listOutputs().map(({ dir, command, ...s }) => s) });
});

// Plan: no side effects; returns the data that populates the review gate.
app.post('/api/docs/:id/output/plan', async (req, res) => {
  const { id } = req.params;
  if (!docs.exists(id)) return res.status(404).json({ error: 'not found' });
  const skill = skills.outputSkill((req.body || {}).skillId);
  if (!skill) return res.status(404).json({ error: 'output skill not found' });
  try {
    const plan = await runOutputSkill(skill, 'plan', docInput(id, (req.body || {}).params));
    res.json({ skill: { id: skill.id, name: skill.name, kind: skill.kind }, plan });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Run: the side effect, only after the gate confirms.
app.post('/api/docs/:id/output/run', async (req, res) => {
  const { id } = req.params;
  if (!docs.exists(id)) return res.status(404).json({ error: 'not found' });
  const skill = skills.outputSkill((req.body || {}).skillId);
  if (!skill) return res.status(404).json({ error: 'output skill not found' });
  try {
    const result = await runOutputSkill(skill, 'run', docInput(id, (req.body || {}).params));
    res.json({ result });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Persist envelope / context / status / pointers for an email doc.
app.put('/api/docs/:id/email', (req, res) => {
  const { id } = req.params;
  if (!docs.exists(id)) return res.status(404).json({ error: 'not found' });
  const meta = docs.setEmail(id, req.body || {});
  res.json({ email: meta.email, title: meta.title, updatedAt: meta.updatedAt });
});

// Save the email as a draft in the connected mailbox (the single write commit).
// The body is split out of the doc markdown (H1 = subject); recipients confirmed
// at the gate are authoritative. Stores the draftId pointer and flips status.
app.post('/api/docs/:id/draft', async (req, res) => {
  const { id } = req.params;
  if (!docs.exists(id)) return res.status(404).json({ error: 'not found' });
  const meta = docs.readMeta(id);
  if (meta.kind !== 'email') return res.status(400).json({ error: 'not an email' });
  const { subject, body } = mail.splitDraft(docs.getMarkdown(id));
  const env = (meta.email && meta.email.envelope) || {};
  const b = req.body || {};
  const to = b.to || env.to || [];
  const cc = b.cc || env.cc || [];
  const bcc = b.bcc || env.bcc || [];
  try {
    const { draftId, usage } = await mail.saveDraft(
      { to, cc, bcc, subject, body, htmlBody: render(body), replyToMessageId: env.replyToMessageId || null },
      { model: b.model }
    );
    const updated = docs.setEmail(id, { envelope: { to, cc, bcc }, status: 'draft-saved', mailbox: { draftId } });
    docs.addUsage(id, { op: 'draft-save', requested: b.model || '', ...usage });
    res.json({ ok: true, draftId, email: updated.email });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---- Mail (Phase 1: capability discovery + read ops) -------------------
// Mail I/O is mediated by `claude -p` against the connected mail MCP; the app
// adapts to discovered capabilities rather than assuming a provider.

app.get('/api/mail/capabilities', async (req, res) => {
  try {
    res.json(await mail.capabilities({ refresh: req.query.refresh === '1' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/mail/threads', async (req, res) => {
  try {
    res.json({ threads: await mail.searchThreads(req.query.q || '') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mail is served from a PERSISTENT local store (lib/mailstore) so threads appear
// instantly. The slow Claude+MCP fetches happen in the BACKGROUND — on boot, on an
// interval, and opportunistically when something is stale — and never block a read.
const INBOX_FRESH_MS = 3 * 60 * 1000;
let refreshingInbox = false;
async function refreshInbox() {
  if (refreshingInbox) return;
  refreshingInbox = true;
  try {
    mailstore.setInbox(await mail.inbox({ limit: 10 }));
    prefetchInboxThreads(); // background: warm thread bodies so opening is instant
  } catch {
    /* keep the last good cache */
  } finally {
    refreshingInbox = false;
  }
}
function refreshThread(id) {
  mail.readThread(id).then((d) => mailstore.setThread(id, d)).catch(() => {});
}

// Warm each inbox thread's body in the background (sequential, gentle), so that
// clicking a thread opens instantly. Skips threads already cached recently.
let prefetching = false;
const THREAD_FRESH_MS = 30 * 60 * 1000;
async function prefetchInboxThreads() {
  if (prefetching) return;
  prefetching = true;
  try {
    const { threads } = mailstore.getInbox();
    for (const t of threads || []) {
      const cached = mailstore.getThread(t.id);
      if (cached && Date.now() - (cached.fetchedAt || 0) < THREAD_FRESH_MS) continue;
      try { mailstore.setThread(t.id, await mail.readThread(t.id)); } catch { /* skip */ }
    }
  } finally {
    prefetching = false;
  }
}

// Inbox: respond IMMEDIATELY with the stored list; kick a background refresh if
// stale (or forced). The client polls briefly for the updated list.
app.get('/api/mail/inbox', (req, res) => {
  const { threads, fetchedAt } = mailstore.getInbox();
  const stale = Date.now() - (fetchedAt || 0) > INBOX_FRESH_MS;
  if (req.query.refresh === '1' || stale) refreshInbox();
  res.json({ threads, fetchedAt, refreshing: refreshingInbox });
});

// Thread read: serve the cached copy instantly when we have it (refresh in the
// background if stale); otherwise fetch live once and cache it.
app.get('/api/mail/threads/:id', async (req, res) => {
  const { id } = req.params;
  const cached = mailstore.getThread(id);
  if (cached && req.query.refresh !== '1') {
    if (Date.now() - (cached.fetchedAt || 0) > INBOX_FRESH_MS) refreshThread(id);
    return res.json({ ...cached.data, fetchedAt: cached.fetchedAt, cached: true });
  }
  try {
    const data = await mail.readThread(id);
    mailstore.setThread(id, data);
    res.json({ ...data, fetchedAt: Date.now() });
  } catch (err) {
    if (cached) return res.json({ ...cached.data, fetchedAt: cached.fetchedAt, cached: true });
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`\n  📝  Doc editor running at  http://localhost:${PORT}\n`);
  // Serve the stored inbox instantly; keep it fresh in the background.
  const cached = mailstore.getInbox();
  console.log(`  ✉️   Mail: ${cached.threads.length} threads from local cache; refreshing in background…\n`);
  mail.capabilities().then(refreshInbox).catch(() => {});
  setInterval(() => { refreshInbox(); }, INBOX_FRESH_MS);
});
