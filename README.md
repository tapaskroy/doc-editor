# doc editor

A personal, browser-based document editor backed by your local `claude` CLI.

Talk to it like you talk to Claude Code, but in a real editing surface: describe
a document, get a streamed first draft, then **select text and leave comments**
to refine it. Revisions are applied as surgical find/replace edits, so the rest
of your document stays exactly as it was.

## How it works

```
Browser (:9999)  ──HTTP/SSE──►  Node server  ──spawn──►  claude -p (your subscription)
```

- Documents are stored as Markdown in `docs/` (the source of truth) and rendered
  to HTML for display.
- **Generate** two ways:
  - **Draft it** — streams a fresh draft from your premise, token-by-token (SSE).
  - **Let's talk about it first** — Claude interviews you (goal, audience, length,
    reading time, tone, key points), compiles the conversation into a structured
    brief, then drafts a far more *targeted* document against it. After drafting,
    the editor shows the word count / reading time and offers one-click expand or
    trim if it's off your target length.
- **Revise**: sends the doc + your selected passages and notes to Claude, which
  returns minimal find/replace edits that the server splices in.
- **Conversation memory**: each document keeps an ordered history of your
  requests (the premise, then every revision), fed back as context on each
  revision — so Claude remembers earlier intent, including facts stated only in
  the premise. History lives in the doc's `.meta.json` (survives restarts);
  regenerating a document starts the conversation over.
- **Web research** (🌐 toggle, on by default): Claude may use `WebSearch`/
  `WebFetch` to read linked URLs and look things up. Filesystem/shell tools are
  never exposed.
- **Export** to HTML, PDF, Word (`.docx`), or PowerPoint (`.pptx`). HTML works
  out of the box; PDF needs Google Chrome (or `CHROME_PATH`); `.docx` needs
  [pandoc](https://pandoc.org) on your `PATH`. **PowerPoint** is special: Claude
  first restructures the document into a real slide deck (title slide, concise
  bullets, speaker notes), then it's rendered with the bundled `pptxgenjs` — so
  you get a presentation, not paragraphs on slides. Missing an engine just shows
  a helpful message; the other formats keep working.
- Uses the `claude` CLI in headless mode (`-p`) with a custom writing system
  prompt — no API key required.

## Run

```bash
npm install
npm start
# open http://localhost:9999
```

Requires the `claude` CLI installed and authenticated, plus Node 18+.

## Tests

```bash
npm test            # fast offline unit suite (node:test) — no deps, no CLI
npm run test:smoke  # opt-in end-to-end browser test (see test/README.md)
```

The smoke test needs the `claude` CLI, Google Chrome, and `playwright-core`
(`npm i --no-save playwright-core`). See [`test/README.md`](test/README.md).

## Files

- `server.js` — HTTP server, static hosting, JSON + SSE API
- `lib/claude.js` — spawns the CLI: streaming generation + find/replace revision
- `lib/docs.js` — Markdown + metadata persistence
- `lib/export.js` — export to HTML/PDF/docx/pptx (marked + Chrome + pandoc + pptxgenjs)
- `public/` — the single-page app (no build step)
- `test/` — unit tests (`test/unit/`) + opt-in smoke test (`test/smoke.js`)

- `server.js` — HTTP server, static hosting, JSON + SSE API
- `lib/claude.js` — spawns the CLI: streaming generation + find/replace revision
- `lib/docs.js` — Markdown + metadata persistence
- `public/` — the single-page app (no build step)
