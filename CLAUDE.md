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
| `lib/claude.js` | The only place that spawns the `claude` CLI. `generate()` (streaming), `revise()` (find/replace edits), `interview()`/`compileBrief()`/`briefToPrompt()` (the intake flow), `toDeck()` (pptx), plus prompt construction and output parsing. |
| `lib/docs.js` | Disk persistence. One document = `docs/<id>.md` (body) + `docs/<id>.meta.json` (metadata). No database. |
| `lib/skills.js` | Discovers voice/style "skills" (`~/.claude/skills`, project `.claude/skills`) — `list()` for browsing, `read(id)` for the chosen SKILL.md body. |
| `lib/attachments.js` | Per-doc uploaded reference files under `docs-assets/<docId>/`. Stores bytes, converts office docs to Markdown (pandoc), builds the prompt reference block. |
| `lib/versions.js` | Per-doc version snapshots under `docs-versions/<id>.json` (full Markdown each). `add` (coalesces manual bursts), `list`, `get`, `previous` (for undo). |
| `lib/export.js` | Export to HTML / PDF / docx / pptx. HTML is pure `marked`; PDF shells out to Chrome; docx to pandoc; pptx is a Claude deck-builder + `pptxgenjs`. |
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

## Two generation paths

- **Draft it** (fast path): `POST /api/docs {premise}` → editor auto-streams from
  the premise. Unchanged original behavior.
- **Let's talk about it first** (`#/brief` view): an adaptive interview that
  produces a *targeted* draft.
  1. `POST /api/intake {messages}` runs one interviewer turn (`claude.interview`,
     prose, stateless — the client holds the transcript). The interviewer probes
     goal/audience/length/reading-time/tone/key-points, 1–2 questions at a time,
     and is told **not** to write the doc and to offer to draft once it has the
     essentials. "Draft it now" is always available too.
  2. "Draft it now" → `POST /api/docs {premise, intake}`. The server calls
     `claude.compileBrief(intake)` → a structured brief
     (`{title, summary, audience, purpose, tone, targetWords, keyPoints, structure}`),
     stored on the doc; the brief's `summary` becomes the premise (so history /
     the conversation panel reflect it). `targetWords` is derived from any
     length/reading-time the user gave (~500 words/page, ~225 wpm).
  3. Generation: if the doc has a `brief`, the route generates from
     `claude.briefToPrompt(brief)` (explicit constraints) instead of the bare
     premise.
  4. Length check is **client-side**: `updateLength()` counts words from the
     Markdown, shows "≈N words · ~M min", and — when a `targetWords` exists and
     actual is off by >15% — offers Expand/Trim, which is just a `revise()` call
     with a length instruction. No special server endpoint.

## Attachments (reference pictures / documents)

The user attaches files to a doc (📎 on the home composer, or the editor's
Attachments panel); they are **input/reference for Claude**, which decides on its
own whether a picture belongs in the output.

- Upload is base64 JSON (`POST /api/docs/:id/attachments`); bytes live under
  `docs-assets/<docId>/` (gitignored). `lib/attachments.js` classifies each file
  (image / pdf / text / doc) and, for office docs, writes a Markdown sidecar via
  pandoc so it's readable as text. Each attachment gets a `url`
  (`/media/<docId>/<name>`, served by the app) and a `refPath` (absolute path
  Claude reads — never sent to the browser).
- At generate/revise, `attachments.referenceBlock()` lists each file (its
  `refPath`, and for images the exact `![](url)` to use if embedding) and is
  prepended to the prompt; `ATTACH_NOTE` is appended to the system prompt telling
  Claude to read them and use judgment. The **Read tool is enabled+pre-approved**
  (`toolArgs({read:true})`) so headless Claude can actually view images / read
  files. Verified: it genuinely sees image content.
- Embedded images (`![](/media/...)`) flow into exports: `export.inlineMedia()`
  turns them into data-URIs for HTML/PDF; `export.localizeMedia()` rewrites them
  to absolute paths so pandoc embeds them in docx. **pptx is text-only** (the
  deck-builder summarizes prose) — images-on-slides is a follow-up.
- Why Read-tool injection over multimodal stream-json input: it reuses Claude
  Code's native file/image reading, works with our spawn model, and handles
  images + PDFs + text uniformly. Office formats go through pandoc first.

## Cost / usage tracking

Every Claude call attributable to a doc is logged to `meta.usage` (an array of
`{op, model, usd, input, output, cacheRead, cacheCreation, at}`). The CLI reports
both token `usage` and `total_cost_usd` on every call (stream `result` event and
the json envelope); `claude.extractUsage()` normalizes either shape and
`sumUsage()` combines multi-attempt calls (e.g. revise's retry).

- Ops recorded: `draft` / `regenerate` (generate), `revise` (also length-adjust),
  `briefing` (interview turns — accumulated client-side and submitted on doc
  create, since they predate the doc), `brief` (compileBrief), `export-pptx`
  (toDeck). Other exports make no Claude call.
- Threaded out of `lib/claude.js`: `generate`'s `onDone(markdown, usage)`,
  `runTurn` returns `{text, usage}`, and `revise/toDeck/interview/compileBrief`
  return usage alongside their result.
- The client (`summarizeUsage`) totals events for the editor Cost panel and the
  per-doc figure in the library. Display is **$ headline + token breakdown**.
- **Design choice — store both, tokens as truth.** Token counts never go stale
  and let cost be recomputed under any pricing; `$` is the comparable headline.
- **Subscription caveat.** `total_cost_usd` is the *API-equivalent* cost, not
  money billed (the user is on a Claude Code subscription, `apiKeySource: none`).
  The UI labels it "API-equivalent." Note most of a short call's cost is
  cache-creation of the system prompt, not output — every call has a baseline.

## Voice / style skills

The Style picker lets the user write in a chosen voice without baking any voice
into the app. `GET /api/skills` lists skills found in `~/.claude/skills` and the
project's `.claude/skills` (each a dir with a `SKILL.md` whose frontmatter gives
name + description). The selected skill id rides along on generate (query) and
revise (body); the server resolves it via `skills.read(id)` to the SKILL.md body
(frontmatter stripped) and `claude.styleNote()` appends it to the writing system
prompt as a "voice & style guide" governing *how* it writes, not *what*.

Notes:
- Injection (read the file → append to the system prompt) is the right approach
  here because generation runs headless with `--tools none` and a replaced
  `--system-prompt`, so native skill invocation isn't in play. (Skill authors
  even expect this — `tapas-voice`'s frontmatter says it's "designed to be
  appended verbatim to a writing model's system prompt.")
- `read(id)` reduces the id to a basename, so a request can't traverse out of the
  skill roots. Roots are overridable via `DOC_EDITOR_SKILLS_DIR` (used by tests).
- Style is a global picker (localStorage `de.skill`), like model/effort/web —
  sent per request, not stored on the doc. Applies to drafting (incl. briefing)
  and revisions; not to the interview/brief/deck steps.

## Version history + undo

Every change snapshots the full Markdown to `lib/versions.js` (separate per-doc
file, so it never bloats `meta.json`). Snapshots are taken server-side at the
mutation sites: generation `onDone` ("Draft"/"Regenerated"), the revise route
("Revision: …"), and the inline-content PUT ("Manual edit").

- **Coalescing**: consecutive `manual` snapshots within `COALESCE_MS` (3 min)
  update the latest in place rather than piling up — so a typing burst is one
  snapshot, not one per autosave. An AI snapshot in between breaks the run.
- **Invariant**: the head snapshot always equals the current document, so
  single-step undo = restore `versions.previous()` (the one before head). Undo
  and restore both *append* a snapshot ("Undo" / "Restored: …") — never
  destructive, so nothing is lost (you can re-restore from the panel).
- **Endpoints**: `GET …/versions` (metadata, newest-first, no markdown),
  `GET …/versions/:vid` (full markdown for the diff), `POST …/versions/:vid/restore`,
  `POST …/undo`. The doc GET also embeds the version list for first paint.
- **Client**: the Versions panel; clicking a snapshot opens a modal with a
  client-side line diff (`lineDiff`, LCS, no dependency) of that snapshot →
  current; Restore/Undo re-render via `renderDoc` and refresh the list. Undo is
  its **own button** (single-step) — ⌘Z stays for in-progress typing.

## Inline editing (WYSIWYG → Markdown autosave)

The rendered document (`#doc`) is `contentEditable` by default — the user types
in place, Google-Docs style, and select-to-comment still works alongside it.

- **Autosave**: an `input` listener debounces (~1s) then converts the edited HTML
  back to Markdown with **`turndown`** (+ the GFM plugin, served from
  `node_modules` like `marked`) and `PUT /api/docs/:id/content` persists it. No
  Claude call — direct edits are free and log no usage.
- **Source of truth stays Markdown.** The first manual save normalizes the doc to
  turndown's Markdown flavor (configured to match our conventions: atx headings,
  `-` bullets, fenced code, `*`/`**`). Prose round-trips cleanly; tables/code are
  the rough edge (documented tradeoff — chose this over a heavy rich-text editor).
- **Sync rules (important):**
  - `renderDoc(html, editable)` is the single entry point for setting `#doc`
    content — it cancels any pending autosave (so a stale timer can't overwrite
    Claude's/loaded content) and toggles editability.
  - Before any Claude op (revise, length-adjust, export) the client calls
    `flushSave()` so the server reads the latest text. While a draft is streaming,
    the doc is read-only; it becomes editable on `done`.
  - `route()` flushes on navigation; `beforeunload` uses `navigator.sendBeacon`
    (hence the content route accepts POST too) to save on tab close.
  - If `turndown` fails to load, the doc stays read-only (we never allow edits we
    can't persist).

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
- **`ANTI_TIC_NOTE`** is appended to generate/revise/deck system prompts as a
  baseline (regardless of chosen voice): a hard ban on em/en dashes plus a short
  avoid-list of common AI tics. A selected voice skill (e.g. `tapas-voice`)
  layers its own checklist on top.
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
- **Writing calls run in a neutral cwd (`RUN_DIR`, a temp dir), NOT the project.**
  The `claude` CLI auto-loads the project's `CLAUDE.md` (this file) when run in
  the project tree — which dumped ~11–15k tokens of dev docs into *every*
  generation/revision as cache-creation, inflating cost ~7–23×. Running in an
  empty dir drops cache-creation to ~600 tokens. **Don't move these spawns back
  to the project cwd.** Attachment files (under the project) are reached via
  `--add-dir <doc's asset dir>`, passed only when references are present, since
  we're no longer in the project tree.

## Export (`lib/export.js`, `GET /api/docs/:id/export?format=…`)

Markdown is the source for all four formats:

- **html** — `marked` + embedded CSS. Pure Node, always available.
- **pdf** — write the styled HTML to a temp file and print it with headless
  system Chrome (`--headless=new … --print-to-pdf`). Matches the on-screen look.
  Chrome is located via `CHROME_PATH` or common macOS install paths.
- **docx** — `pandoc` (`-f gfm -t docx`), fed Markdown on stdin.
- **pptx** — a document is not a deck, so we don't convert it mechanically.
  `claude.toDeck()` first restructures the doc into a slide model
  (`{title, subtitle, slides:[{title, bullets[], notes}]}`), then
  `export.deckToPptx()` renders it with **`pptxgenjs`** (title slide + bulleted
  content + speaker notes, 16:9). The deck builder is **injected by the server**
  (`exportDoc(format, md, title, { deckBuilder })`) so `lib/export.js` has no
  direct dependency on the CLI and the pptx renderer stays unit-testable with a
  stub deck. This is the one export that calls Claude (and respects the
  model/effort picker), so it's slower than the others.

docx/pdf engines are external tools, not npm deps — consistent with how the app
shells out to `claude`. A missing engine throws a clear "install X" error; the
route maps an unknown format to **400** and a missing/failed engine to **501**,
so the other formats keep working. The client downloads via `fetch` → Blob →
`<a download>`, surfacing any 4xx/5xx message as a toast.

Note: `file(1)` labels pptxgenjs output as generic "Zip archive data" (its JSZip
zipper doesn't store `[Content_Types].xml` first) — that's cosmetic, not
corruption; the file is valid OOXML and opens in PowerPoint/Keynote/Slides.

Gotcha worth remembering: **don't pass `--user-data-dir` to headless Chrome** for
print-to-pdf — on recent Chrome it triggers a first-run flow that hangs. The
working flag set is `--headless=new --disable-gpu --no-first-run
--no-default-browser-check --no-pdf-header-footer --print-to-pdf=…`. (And note
`html-to-docx` was evaluated and rejected: its output won't open in MS Word.)

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

Per-comment "apply individually" (accept/reject a single AI edit before it
lands). Multi-level undo + redo (today's Undo is single-step; the Versions panel
covers deeper rollbacks via restore).

A richer **presentation** path: let the user bring their own slide skills /
templates, formatting conventions, and images so pptx export produces a polished,
on-brand deck rather than the current generic theme. The deck-builder
(`claude.toDeck`) and renderer (`export.deckToPptx`) are the seams to extend —
e.g. feed a user template/theme into the renderer and image guidance into the
deck model.

**Per-doc voice memory.** Style is currently a global picker (localStorage
`de.skill`), sent per request — not stored on the doc. So switching styles and
then revising an old doc applies the *current* pick. To make each doc remember
the voice it was written in, store the skill id on the doc (like `brief`) and
default the picker to it when the doc opens.

**Broader skill discovery.** `lib/skills.js` scans only `~/.claude/skills` and
the project's `.claude/skills` — not plugin skills
(`~/.claude/plugins/**/skills`). Add those roots to `roots()` if writing in a
plugin-provided style is ever wanted.
