// Personal doc editor — local HTTP server.
// Serves the single-page app and brokers between the browser and the local
// `claude` CLI. Run with `npm start`, then open http://localhost:9999

const path = require('path');
const express = require('express');
const { marked } = require('marked');

const docs = require('./lib/docs');
const claude = require('./lib/claude');
const exporter = require('./lib/export');

const PORT = process.env.PORT || 9999;
const app = express();

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));
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

app.post('/api/docs', (req, res) => {
  const meta = docs.create((req.body && req.body.premise) || '');
  res.json(meta);
});

app.get('/api/docs/:id', (req, res) => {
  if (!docs.exists(req.params.id)) return res.status(404).json({ error: 'not found' });
  const doc = docs.get(req.params.id);
  res.json({ ...doc, html: render(doc.markdown) });
});

app.delete('/api/docs/:id', (req, res) => {
  docs.remove(req.params.id);
  res.json({ ok: true });
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
  const { premise } = docs.readMeta(id);
  const { model, effort } = req.query;
  const web = req.query.web === 'true';
  // Start the conversation fresh for this (re)generation; the premise is turn 1.
  docs.setHistory(id, [{ role: 'user', content: premise }]);

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const child = claude.generate(premise, {
    model,
    effort,
    web,
    onReset: () => send('reset', {}),
    onDelta: (text) => send('delta', { text }),
    onDone: (markdown) => {
      const meta = docs.setMarkdown(id, markdown);
      send('done', { markdown, html: render(markdown), title: meta.title, history: meta.history });
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
    const { buffer, contentType, ext } = await exporter.exportDoc(format, markdown, title);
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

  const { comments = [], instruction = '', model, effort, web } = req.body || {};
  if (!comments.length && !instruction.trim()) {
    return res.status(400).json({ error: 'no comments or instruction provided' });
  }

  try {
    const markdown = docs.getMarkdown(id);
    const { history = [] } = docs.readMeta(id);
    const { edits, request } = await claude.revise({ markdown, comments, instruction, history, model, effort, web });
    const { markdown: updated, applied } = claude.applyEdits(markdown, edits);
    docs.addHistory(id, request); // record this turn so future revisions remember it
    const meta = docs.setMarkdown(id, updated);
    res.json({
      markdown: updated,
      html: render(updated),
      title: meta.title,
      applied,
      history: meta.history,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  📝  Doc editor running at  http://localhost:${PORT}\n`);
});
