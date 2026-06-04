# doc-editor — Design & Architecture

_How the system is built and why. For what it does from a user's view, see
[`specs/product-spec.md`](../specs/product-spec.md). For day-to-day repo
conventions and gotchas, see [`CLAUDE.md`](../CLAUDE.md) (the authoritative,
most-detailed reference for contributors)._

## 1. Goals & non-goals

**Goals**
- Turn the "talk to Claude to write, then tweak" workflow into a real editing
  surface in the browser.
- Reuse the user's existing **Claude Code subscription** (no API key, no separate
  billing).
- Keep it simple to run: `npm install && npm start`, no build step.

**Non-goals (v1)**
- Multi-user, auth, real-time collaboration, a database, or a deployment story.
- It is explicitly a local, single-user tool.

## 2. High-level architecture

```
Browser (http://localhost:9999)
  public/ (vanilla JS SPA)
        │  HTTP + Server-Sent Events
        ▼
Node + Express  (server.js — thin routing/transport)
        │  require()
        ▼
lib/ (all logic, the only code that touches the CLI / filesystem)
        │  spawn
        ▼
claude -p (headless)  +  pandoc / Chrome (export)  +  local files
```

- **Frontend**: a single-page app in plain HTML/CSS/JS. No framework, no bundler.
  Third-party browser libs (`marked`, `turndown`, `turndown-plugin-gfm`) are
  served straight from `node_modules`; `public/linediff.js` is shared with tests.
- **Server**: Express. `server.js` is a thin layer — routing, request/response,
  SSE plumbing — and delegates all real work to `lib/`.
- **Engines**: the `claude` CLI (drafting/revision/brief/deck), pandoc (docx +
  reading Office attachments), headless Chrome (PDF). All are shelled out to; none
  is an in-process dependency.

## 3. Tech stack & rationale

| Choice | Why |
|--------|-----|
| Shell out to the `claude` CLI (`-p` headless) | Reuses the user's subscription; no API key; "Claude Code running locally" with the user's own auth. |
| Node + Express | Minimal, ubiquitous, fine for a local single-user server. |
| No build step; vanilla JS | Keep it trivial to run and hack on. Browser libs served from `node_modules`. |
| Markdown as the source of truth | Clean to diff, edit (find/replace), export, and store; portable plain-text files. |
| `marked` (render), `turndown` (HTML→MD), `pptxgenjs` (pptx) | Small, well-maintained, browser+node capable. |
| pandoc (docx, Office→MD), Chrome (PDF) | Best-in-class fidelity; treated as optional external tools with graceful degradation. |

## 4. Components

| Path | Responsibility |
|------|----------------|
| `server.js` | Express app: static hosting, JSON API, SSE generation stream, export routes. Thin; delegates to `lib/`. Binds **loopback by default** (`HOST` env to override). |
| `lib/claude.js` | The **only** place that spawns the CLI. `generate()` (streaming), `revise()` (find/replace edits), `interview()` / `compileBrief()` / `briefToPrompt()` (intake), `toDeck()` (pptx). Prompt construction, output parsing, usage extraction, model/effort/tool flags. |
| `lib/docs.js` | Document persistence: `docs/<id>.md` + `docs/<id>.meta.json`. Title derivation, history, attachments list, usage log. |
| `lib/attachments.js` | Uploaded reference files under `docs-assets/<id>/`. Classify, store, convert Office docs to Markdown via pandoc, build the prompt reference block. |
| `lib/versions.js` | Version snapshots under `docs-versions/<id>.json` (full Markdown each). Append (coalescing manual bursts), list, get, `previous` (undo), `diffPair`. |
| `lib/export.js` | HTML / PDF / docx / pptx. Pure `marked` for HTML; Chrome for PDF; pandoc for docx; deck-builder + `pptxgenjs` for pptx. Image embedding (data-URI / localize). |
| `lib/skills.js` | Discover voice/style skills (`~/.claude/skills`, project `.claude/skills`). |
| `public/` | The SPA — `index.html`, `app.js` (all client logic), `styles.css`, `linediff.js` (shared diff). |

## 5. Data model & storage

All on local disk, gitignored (personal content never committed):

- `docs/<id>.md` — the document body (Markdown, **source of truth**).
- `docs/<id>.meta.json` — metadata:
  ```jsonc
  {
    "id", "title", "premise",
    "history":     [{ "role": "user", "content": "…" }],   // intent log (conversation memory)
    "attachments": [{ "id","name","type","kind","storedName","url","refPath" }],
    "brief":       { "title","summary","audience","purpose","tone","targetWords","keyPoints","structure" }, // if intake
    "usage":       [{ "op","model","requested","usd","input","output","cacheRead","cacheCreation","at" }],
    "createdAt", "updatedAt"
  }
  ```
- `docs-assets/<id>/…` — uploaded attachment bytes (+ Markdown sidecars for Office docs).
- `docs-versions/<id>.json` — ordered array of snapshots `{ vid, label, kind, model, usd, at, markdown }`.

`id` is a timestamp-prefixed, filesystem-safe string. The base dirs are overridable
via env (`DOC_EDITOR_DOCS_DIR`, `…_ASSETS_DIR`, `…_VERSIONS_DIR`, `…_SKILLS_DIR`)
so tests use throwaway directories.

## 6. Key flows

1. **Generate (SSE)** — `GET /api/docs/:id/generate`. Spawns `claude -p
   --output-format stream-json`; forwards `text_delta` chunks as `delta` events
   (progressive render); a new `message_start` emits `reset` (drop interim text
   from tool turns); the `result` event yields the authoritative final Markdown +
   usage. A briefed doc generates from `briefToPrompt(brief)`.
2. **Revise** — `POST /api/docs/:id/revise`. Claude returns a JSON array of
   **find/replace edits**; the server splices them into the stored Markdown
   (`applyEdits`), so untouched text stays byte-identical. Stateless: prior intent
   comes from the doc's `history` re-sent as context (see §7), not a resumed
   session.
3. **Intake → brief** — `POST /api/intake` runs one interviewer turn (client holds
   the transcript). "Draft it now" → `POST /api/docs {premise, intake}` →
   `compileBrief()` → structured brief stored on the doc.
4. **Attachments** — base64 JSON upload → stored under `docs-assets/`; at
   generate/revise the **Read tool is enabled+pre-approved** and a reference block
   (paths + per-image embed URL) is prepended to the prompt; Claude reads them and
   decides on embedding.
5. **Inline edit autosave** — debounced; the edited page HTML is converted back to
   Markdown via `turndown` and `PUT /api/docs/:id/content` persists it. No Claude
   call.
6. **Versions / undo / diff** — every mutation server-side appends a snapshot.
   Diff is **snapshot vs its parent** (`GET …/versions/:vid/diff` → `{before,
   after}`), rendered with the shared `lineDiff`. Restore/undo append snapshots
   (non-destructive).
7. **Export** — `GET /api/docs/:id/export?format=…`. HTML inlines `/media` images
   as data-URIs; PDF prints that HTML via Chrome; docx localizes image paths for
   pandoc; pptx restructures via `toDeck()` then renders with `pptxgenjs`.
8. **Cost capture** — the CLI reports tokens + `total_cost_usd` on every call;
   `extractUsage`/`sumUsage` normalize/combine them; the server logs an event per
   op (with requested vs actual model) to `meta.usage`.

## 7. Key design decisions (the "why")

- **Conversation memory = stored transcript, not `--resume`.** Native session
  resume carries memory but primes the model as a *writer*, which broke the
  JSON-mode find/replace revisions (prose drift). Keeping the edit call **stateless**
  and feeding the user's request history as plain context gives reliable
  structured output *and* memory. Don't reintroduce `--resume` for revise.
- **Surgical find/replace edits**, not full rewrites — preserves untouched prose
  exactly and keeps diffs clean.
- **Inline editing via `contentEditable` + `turndown`**, not a heavy rich-text
  editor. Markdown stays the source of truth; the trade-off is that complex
  structures (tables/code) round-trip imperfectly. Chosen for simplicity.
- **Writing calls run in a neutral temp working directory**, not the project. The
  CLI auto-loads `CLAUDE.md` when run in the repo, which dumped ~11–15k tokens into
  every call (≈7–23× cost). Attachment files are reached via `--add-dir`.
- **Tools are minimal and pre-approved.** `--tools none` by default; `Read` only
  when there are attachments; `WebFetch`/`WebSearch` only when 🌐 is on — all via
  `--allowedTools` so headless mode doesn't silently deny them. No write/shell.
- **Cost: store tokens (truth) + show `$` (headline).** Tokens never go stale and
  can be re-priced; `$` is the comparable headline. It's the CLI's API-equivalent
  figure (subscription ≠ billed), labeled as such, with a downgrade warning.
- **Version diff is vs the parent snapshot**, both stored Markdown — so AI
  find/replace edits diff cleanly. Diffing against the live turndown-of-HTML adds
  re-serialization noise (a fixed bug).
- **Anti-"AI tic" baseline** appended to writing prompts (hard em-dash ban + an
  avoid-list) regardless of chosen voice.
- **Loopback binding by default** — the app is unauthenticated; binding to all
  interfaces would expose `claude`/docs/web-fetch to the LAN.
- **Two-pane editor layout** — fixed 8.5in page + flexible sidebar, each scrolling
  independently; horizontal scroll when too narrow.

## 8. Security model

- **Local + loopback by default** (`127.0.0.1`); no authentication; `HOST` opt-in
  for LAN with eyes open.
- **Claude gets read-only capabilities only**: web read (when toggled) and reading
  attached files (via `--add-dir` scoped to the doc's asset dir). Never Write/Bash/Edit.
- **No path leakage**: attachment absolute `refPath` is stripped from API
  responses; the `/media` route guards against path traversal.

## 9. Testing

- **`npm test`** — fast `node:test` unit suite (`test/unit/*.test.js`), no network
  or CLI: `applyEdits`, `extractEdits`/`firstJsonObject`, model/effort/tool flag
  builders, `briefToPrompt`, skills, attachments, versions (+ coalescing + diff
  pairing), `lineDiff` (incl. the diff-noise regression), usage math, export
  registry + HTML media inlining, docs persistence (against temp dirs).
- **`npm run test:smoke`** — opt-in end-to-end (`test/smoke.js`): spawns the server
  and drives the real UI in headless Chrome (intake → draft → inline edit →
  versions → revise → export). Needs the `claude` CLI, Chrome, and an ad-hoc
  `playwright-core` (intentionally not a project dependency).
- Pure logic lives in `lib/` / shared modules so it's unit-testable; the
  CLI-spawning paths are covered by the smoke test.

## 10. Conventions

- `lib/` is the only place that touches the CLI or filesystem; `server.js` stays a
  thin transport layer.
- No client framework — vanilla JS, `$ = querySelector`, state in module vars.
- Short "why" comments above non-obvious logic; match surrounding density.
- Client settings persist in `localStorage` under `de.*`.

## 11. Known limitations & future work

Tracked more fully in `CLAUDE.md` ("Ideas / not yet built") and GitHub issues:
per-comment accept/reject, multi-level undo + redo, images-on-slides for pptx,
per-doc settings memory (remember model/effort/voice), broader skill discovery
(plugin skills), abandoned-briefing cost attribution, and the PR #2 follow-ups
(README `HOST` note, accurate startup log).
