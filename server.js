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
const attachments = require('./lib/attachments');

const PORT = process.env.PORT || 9999;
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
  const { premise = '', intake, intakeUsage, model, effort } = req.body || {};
  let meta = docs.create(premise);
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

app.get('/api/docs/:id', (req, res) => {
  if (!docs.exists(req.params.id)) return res.status(404).json({ error: 'not found' });
  const doc = docs.get(req.params.id);
  // Don't expose server-only absolute paths to the browser.
  const safeAttachments = (doc.attachments || []).map(({ refPath, ...a }) => a);
  res.json({ ...doc, attachments: safeAttachments, html: render(doc.markdown) });
});

app.delete('/api/docs/:id', (req, res) => {
  attachments.removeAll(req.params.id); // also drop its uploaded files
  docs.remove(req.params.id);
  res.json({ ok: true });
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

// --- Generation (Server-Sent Events stream) ------------------------------

app.get('/api/docs/:id/generate', (req, res) => {
  const { id } = req.params;
  if (!docs.exists(id)) return res.status(404).end();
  const { premise, brief, attachments: atts = [] } = docs.readMeta(id);
  const { model, effort } = req.query;
  const web = req.query.web === 'true';
  const style = req.query.skill ? skills.read(req.query.skill) : null;
  const references = attachments.referenceBlock(id, atts);
  const op = docs.getMarkdown(id).trim() ? 'regenerate' : 'draft';
  // A briefed doc generates from its structured brief; otherwise from the premise.
  const genPrompt = brief ? claude.briefToPrompt(brief) : premise;
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
    onReset: () => send('reset', {}),
    onDelta: (text) => send('delta', { text }),
    onDone: (markdown, usage) => {
      docs.setMarkdown(id, markdown);
      const meta = docs.addUsage(id, { op, requested: model || '', ...usage });
      send('done', { markdown, html: render(markdown), title: meta.title, history: meta.history, usage: meta.usage });
      res.end();
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
    const { history = [], attachments: atts = [] } = docs.readMeta(id);
    const style = skill ? skills.read(skill) : null;
    const references = attachments.referenceBlock(id, atts);
    const { edits, request, usage } = await claude.revise({ markdown, comments, instruction, history, model, effort, web, style, references });
    const { markdown: updated, applied } = claude.applyEdits(markdown, edits);
    docs.addHistory(id, request); // record this turn so future revisions remember it
    docs.setMarkdown(id, updated);
    const meta = docs.addUsage(id, { op: 'revise', requested: model || '', ...usage });
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

app.listen(PORT, () => {
  console.log(`\n  📝  Doc editor running at  http://localhost:${PORT}\n`);
});
