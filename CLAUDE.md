# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

**doc-editor** is a personal, browser-based document editor backed by the local
`claude` CLI. You describe a document in the browser, Claude drafts it, and you
refine it by selecting text and leaving comments — each revision goes back to
Claude, which returns surgical edits that are spliced into the document.

> ⚠️ **This is a v1 — a weekend project to play with, not production software.**
> It runs locally, single-user, with no auth, no tests beyond manual smoke
> checks, and no multi-user/concurrency story. Treat it as a toy to iterate on.

## Running it

```bash
npm install
npm start            # serves http://localhost:9999 (override with PORT=…)
```

Requirements: Node 18+, and the **`claude` CLI installed and authenticated**
(`claude --version`). No Anthropic API key is needed — the app shells out to the
CLI in headless mode and reuses your existing Claude Code subscription.

There is **no build step**. The frontend is plain HTML/CSS/JS served statically;
the Markdown renderer (`marked`) is served straight from `node_modules`.

## Architecture

```
Browser (:9999)  ──HTTP + SSE──►  Express server  ──spawn──►  claude -p (headless)
   public/                          server.js                  lib/claude.js
```

| Path | Responsibility |
|------|----------------|
| `server.js` | Express app: static hosting, JSON API, the SSE generation stream. Thin — delegates to `lib/`. |
| `lib/claude.js` | The only place that spawns the `claude` CLI. `generate()` (streaming) and `revise()` (find/replace edits), plus prompt construction and output parsing. |
| `lib/docs.js` | Disk persistence. One document = `docs/<id>.md` (body) + `docs/<id>.meta.json` (metadata). No database. |
| `public/index.html` | Single-page app shell: home (composer + library) and editor views. |
| `public/app.js` | All client logic: hash routing, streaming render, text-selection comments, revision, the model/effort/web picker, and the conversation panel. |
| `public/styles.css` | Styling. Document reads in a serif column; UI is sans-serif. |
| `docs/` | Saved documents (gitignored — personal content never leaves the machine). |

## The two core operations

### Generate (`GET /api/docs/:id/generate`, Server-Sent Events)
- Spawns `claude -p --output-format stream-json --include-partial-messages`.
- Parses the JSONL event stream; forwards `content_block_delta` → `text_delta`
  chunks to the browser as `delta` SSE events, which render progressively.
- On a new `message_start` (a fresh assistant turn — e.g. after a web-research
  tool call) it emits a `reset` event so the client clears interim text and only
  the final document's turn is shown. The authoritative final text comes from
  the `result` event.

### Revise (`POST /api/docs/:id/revise`)
- Spawns `claude -p --output-format json` and asks for a JSON object of
  **find/replace edits**: `{"edits":[{"find":"…","replace":"…"}]}`.
- The server applies those edits to the Markdown source (`applyEdits`), so
  untouched text stays byte-for-byte identical (this is why edits are surgical,
  not a full rewrite).
- `find` strings are matched verbatim; ambiguous/missing matches are reported in
  the `applied[]` array rather than silently dropped.

## Conversation memory (important design decision)

Each document keeps an ordered `history` array in its `.meta.json`: the premise
(turn 0, pinned) followed by every revision request. On each revision the server
sends this history back as **context**, so Claude remembers earlier intent —
including facts stated only in the premise.

**Why history-as-context instead of the CLI's native `--resume`:** session resume
*does* carry memory, but it primes the model as a prose *writer*. When a revision
then needs structured JSON edits, conversationally-phrased instructions reliably
pulled it back into prose mode and broke JSON parsing. Keeping the edit call
**stateless** (clean JSON mode) while feeding history as plain context gives both
reliable structured output and real memory. Don't reintroduce `--resume` for the
revise path without solving that drift.

The reviser also has a tolerant JSON extractor (handles stray text / code fences)
and a single sterner retry, as belt-and-suspenders against occasional drift.

## `claude` CLI integration notes

All flags live in `lib/claude.js`. Things that are load-bearing:

- **`--system-prompt`** replaces Claude Code's default agent prompt with a lean
  writing/editing prompt. This strips coding-agent scaffolding (and cost).
- **Tools are off by default** (`--tools none`) — it's a writing engine. When the
  **Web** toggle is on, the app passes
  `--tools WebFetch WebSearch --allowedTools WebFetch WebSearch`. Both halves
  matter: `--tools` exposes only the web tools (no filesystem/shell), and
  `--allowedTools` **pre-approves** them — without that, headless mode can't
  prompt for permission and silently declines (the tool reports "not available").
- **`--model`** (`opus`/`sonnet`/`haiku`) and **`--effort`**
  (`low`/`medium`/`high`/`xhigh`/`max`) are user-selectable. Values are
  whitelisted server-side; anything else is dropped (the browser can't inject
  arbitrary flags). Empty = use the CLI's own default.
- The prompt is fed over **stdin**, not as an argv string, to avoid arg-length
  limits with large documents.

## Data model

`docs/<id>.meta.json`:
```json
{
  "id": "20260531044535-tr7o",
  "title": "Derived from the first H1",
  "premise": "the original request",
  "history": [{ "role": "user", "content": "…" }],
  "createdAt": "ISO", "updatedAt": "ISO"
}
```
Title is derived from the document's first H1 (`deriveTitle`). IDs are
timestamp-prefixed and filesystem-safe.

## Conventions

- **Keep `lib/` as the only place that touches the CLI or the filesystem.**
  `server.js` stays a thin routing/transport layer.
- Match the existing comment density: short "why" comments above non-obvious
  logic, not narration of obvious code.
- No frameworks on the client — vanilla JS, `$ = querySelector`. Keep it that way
  unless there's a strong reason.
- Client settings (model/effort/web) persist in `localStorage` under `de.*`.
- Highlights (comment selection, recent changes) use the CSS Custom Highlight
  API, with graceful no-op fallback when unavailable.

## Testing

Two layers (see `test/README.md`):

- **`npm test`** — fast `node:test` unit suite under `test/unit/`. No deps, no
  network, no CLI. Covers the pure logic: `applyEdits`, `extractEdits`, the
  model/effort/tool flag builders, request formatting, and `docs.js` persistence
  (run against a temp dir via the `DOC_EDITOR_DOCS_DIR` env override). Keep these
  green and add to them when touching `lib/`.
- **`npm run test:smoke`** — opt-in end-to-end test (`test/smoke.js`). Spawns the
  server on a spare port against a throwaway docs dir and drives the real UI in
  headless Chrome. Requires the `claude` CLI, Google Chrome, and `playwright-core`
  (`npm i --no-save playwright-core` — it is intentionally **not** a project
  dependency; don't add it to `package.json`).

To keep `lib/` helpers testable they are exported from `lib/claude.js` even
though they're internal; `lib/docs.js` honors `DOC_EDITOR_DOCS_DIR` so tests
never touch the real `docs/`.

## Ideas / not yet built

Inline hand-editing of the rendered doc, per-comment "apply individually",
Markdown/PDF export, and true document-level undo (would require snapshotting the
Markdown per revision — pruning history today does **not** roll back the doc).
