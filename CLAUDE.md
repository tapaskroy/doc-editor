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

## Why this exists (north star)

The point is not "a better word processor with AI in it." That is table stakes and
the incumbents (Google, Microsoft) will bundle it. The point is to **bring the
person to the AI**: let the user keep teaching the tool who they are, so it shows
up in their writing, a little more every day.

That is the flywheel, and it is the moat:

```
initial voice  ->  better draft  ->  user edits it  ->  learn from the edits
      ^                                                         |
      |                                                    skillify (capture)
      +----  voice + context get better  <----  improved skills  <-+
```

Two assets compound here, and they are different: **voice** (how the user writes,
converges fast) and **context** (what the user knows: their people, projects,
facts, history, grows without bound). The highest-signal input is the **diff**
between what Claude wrote and what the user kept; mining those edits and proposing
skill updates ("learn from my edits") is the literal center of the flywheel and the
feature most worth building. Keep the loop **consented and legible** (the user
reviews what was learned before it is baked in), the same principle as the review
gate. The result is lock-in the user *wants*: leaving means re-teaching a new tool
who they are.

Design consequences: stay personal (resist multi-user collaboration and the
storage/format war, which are the incumbents' home turf); interop in, publish out;
keep skills as portable, user-owned, editable files. Full strategy in
[`specs/vision.md`](specs/vision.md).

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
     length/reading-time the user gave (~500 words/page, ~225 wpm). The **raw
     transcript is also persisted on the doc as `intake`** (the brief is lossy; the
     transcript is the ground truth — see "Doc-specific context" below).
  3. Generation: if the doc has a `brief`, the route generates from
     `claude.briefToPrompt(brief)` (explicit constraints) instead of the bare
     premise. If the doc has an `intake` transcript, it is **also passed to
     `generate()` verbatim** ("conversation that shaped this document") so the
     first draft never re-loses specifics the brief compressed away (the Bali bug).
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

> **Gotcha (load-bearing):** `result.modelUsage` can list MORE than one model —
> Claude Code makes a tiny **Haiku side-call alongside the main model on every
> generation**. `extractUsage` must pick the **dominant model by cost**
> (`primaryModel`), NOT the first key. Taking the first key mislabeled every Opus
> job as Haiku and fired a false "downgrade" warning.

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
  client-side line diff (`lineDiff`, LCS, no dependency) showing **what that
  snapshot changed** — it vs its parent snapshot (`GET …/versions/:vid/diff`
  returns `{before, after}`). Both sides are stored Markdown of the same lineage,
  so AI revisions (find/replace splices) diff cleanly with no turndown noise.
  Diffing against the live turndown-of-HTML would show spurious changes — don't.
  Restore/Undo re-render via `renderDoc` and refresh the list. Undo is its **own
  button** (single-step) — ⌘Z stays for in-progress typing.

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

### Doc-specific context (the "Bali fix", hybrid C)

The compiled `brief` is lossy — it once dropped who-travelled facts the user stated
in the planning conversation, so the draft fabricated them. The fix splits by path,
because generate and revise have different constraints:

- **`meta.intake`** stores the raw planning transcript. Generation gets it
  **verbatim** (no JSON-mode risk in a streaming prose call), so the first draft has
  the user's exact words.
- **Revise must never see the raw transcript** (same drift reason as `--resume`
  above). Instead `claude.distillContext(intake)` (Haiku) produces a compact,
  fact-preserving **`meta.contextSummary`**, fed to `revise()` as grounding-only
  BACKGROUND. It's computed lazily on the first revise and **cleared on regenerate**
  (`docs.setContextSummary(id, null)`) so it re-distills against fresh text.

This is step 1 of the personal-memory work (`specs/personal-memory-spec.md`,
`design/personal-memory-design.md`); the durable cross-document layer comes next.

### Personal memory (`lib/memory.js`) — the durable, cross-document layer

The "what is true about me" store, sibling to the voice store ("how I write"). The
store is built (step 2), wired into generate/revise (step 3), fed by intake capture
(step 4), surfaced in a Profile tab (step 5), with editable topic files (step 6).

- **Canonical content is portable Markdown the user owns**, OUTSIDE the repo:
  `$DOC_EDITOR_MEMORY_DIR` (default `~/.config/doc-editor/memory/`) → `USER.md` (the
  always-on core) + `topics/<topic>.md`. `memory.json` is **metadata only**
  (provenance + the unsaved review queue); the Markdown is authoritative for content
  (this is what avoids the `voice.json`/`SKILL.md` split-brain).
- **Capture is suggest-only:** `propose()` queues candidates as `unsaved`, deduped
  against the manifest **and** the canonical Markdown (the user may hand-edit the
  files; Markdown is authoritative); `keep()` appends the fact to the right `USER.md`
  section (fixed taxonomy: identity/people/work/taste/other) or topic file and marks
  it `kept` — **idempotent** (won't double-append a fact already present, so a crash
  between the two writes can't duplicate); `discard()` tombstones; `forget()` removes
  a kept fact from the Markdown and returns whether the line was actually found (the
  UI warns if it wasn't, rather than implying a fact is gone when it isn't). Nothing
  reaches the Markdown — or a prompt — until kept. The first capture SOURCE is
  `learn.captureFromIntake()` (Haiku): after the FIRST draft, the server's
  `captureMemory()` mines the planning transcript for durable user facts (excluding
  this-doc specifics), **non-blocking** and **once** (guarded by `meta.capturedAt`,
  stamped optimistically; **cleared again if the pass fails** so a transient model
  error doesn't permanently/silently suppress capture), routing them to `propose()`
  with provenance. A parse failure in `captureFromIntake` throws (distinct from an
  empty result) so the failure is retryable rather than mistaken for "no facts". Browse/manage the queue via
  `GET /api/memory` + `POST /api/memory/{keep,discard,forget}`. (Routing the learn
  pipeline's edit-`context` candidates to memory is a deliberate follow-up — today
  they still go to the voice store.)
- **Consumption is controlled:** `retrieve({premise,brief,recipients})` returns the
  always-on `USER.md` plus only the topically-relevant files (v1 lexical overlap; a
  Haiku-scored pass is the noted seam). `compose(retrieved,{usePersonalFacts})` builds
  the injected block carrying the guardrail: grounding is always on; *volunteering*
  private facts into the output is gated by the per-doc `usePersonalFacts` (default
  off). This is the ONLY path memory takes into a prompt (which is why the projection
  must not auto-load it — see the `~/.claude` note above). The composed block is appended to the **writing system prompt**
  (`generate()`/`revise()` take a `memory` param); the per-doc gate flips via
  `PUT /api/docs/:id/use-personal-facts`; and `GET /api/docs/:id/context` exposes
  exactly "what this draft will use" (voice + retrieved profile/topics + the gate)
  for the transparency panel. Empty store ⇒ empty block ⇒ no-op (back-compatible).
- **Projection (`syncToClaudeDir`, consented):** symlinks `USER.md` →
  `~/.claude/USER.md` only (which Claude Code does NOT auto-load, so it can't leak into
  the editor's own writing calls). It returns the `@USER.md` import line for the user to
  add to `~/.claude/CLAUDE.md` **themselves** if they want their other sessions to read
  the profile — doc-editor deliberately does **not** write that import (auto-loading the
  profile would bypass the guardrail, and the `--setting-sources` flag that used to
  suppress it broke some installs). Overridable target via `DOC_EDITOR_CLAUDE_DIR`.
- **UI (Profile tab, `#/profile`):** about-you (view/edit `USER.md`), the unsaved
  keep/discard queue, kept facts (forget), **clickable topic chips** (a modal to
  view/edit/delete each topic file — step 6), and the consented "Sync to ~/.claude"
  button. In the editor, a Personal-memory panel shows "what this draft will use"
  and the per-doc personal-facts toggle (which reverts on a failed save so the
  control never lies). Rendered memory Markdown is **sanitized** before `innerHTML`
  (script/embed/on*/javascript: stripped) — it's user- *and* LLM-written, so treated
  as untrusted. Routes: `GET /api/memory`,
  `POST /api/memory/{keep,discard,forget}`, `PUT /api/memory/profile`,
  `GET|PUT|DELETE /api/memory/topic/:name`, `POST /api/memory/sync`, plus
  `GET /api/docs/:id/context` and `PUT /api/docs/:id/use-personal-facts`.

### Voice-learning signal log (`lib/learnlog.js`) — M1 instrumentation

The single biggest unproven assumption is that "learn from my edits" produces lessons
the user actually keeps. To measure it, every keep/dismiss decision on a learn
proposal is logged (append-only flat JSON, gitignored, `DOC_EDITOR_LEARNLOG_FILE`):
`POST …/learn/apply` records a **kept** entry; a new `POST …/learn/dismiss` records a
**dismissed** one (the negatives the UI used to throw away). `GET /api/learn/log`
returns the keep-rate (overall + per class voice/context/claude) and the recent
kept/dismissed corpus with each candidate's `observation` (the distilled evidence) —
surfaced in the Profile tab's "Voice-learning signal" panel so the misses are
readable. It's instrumentation only: no effect on the voice store. The point is a
go/kill number for the loop before investing in cold-start import / multi-voice.

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
- **Keeping the USER-level `~/.claude/CLAUDE.md` out of writing calls.** `RUN_DIR`
  blocks the *project* CLAUDE.md, but the *user* one auto-loads regardless of cwd. We
  briefly passed `--setting-sources project,local` to exclude it, then removed it —
  **that flag is incompatible with some `claude` installs** (and `--bare` is out too:
  it skips keychain reads and breaks subscription auth). So instead we ensure there is
  **nothing to exclude**: `memory.syncToClaudeDir()` only **symlinks `~/.claude/USER.md`**
  (which Claude Code does NOT auto-load) and does **not** write an `@USER.md` import
  into `~/.claude/CLAUDE.md`. The user adds that import themselves if they want their
  other sessions to read the profile. So the profile still enters doc-editor's prompts
  **only** via the guardrailed `memory.compose()` path. (Mail spawns are separate in
  `lib/mail.js` and unaffected.)

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

## Mail (`lib/mail.js`)

Mail I/O is mediated by `claude -p` against the connected mail MCP (the MCP is
bound to the CLI, not Node). The engine is **provider-agnostic by dynamic
capability discovery** — no hardcoded tool names. `capabilities()` runs a one-time
classification turn → `{connected, server, identityAddress, tools:{searchThreads,
readThread, listDrafts, createDraft, send}, canAttachToDraft}`;
`searchThreads`/`readThread` run constrained turns that return structured JSON.
`saveDraft(message)` is the one write op — a turn allowing ONLY the discovered
`createDraft` tool, passing the staged payload verbatim (recipients normalized to
bare addresses via `bareEmail`; `replyToMessageId` for threaded replies; `htmlBody`
rich + `body` plain). The client routes every commit through the **review gate**
(recipients/lint/identity); `POST /api/docs/:id/draft` then stores the `draftId`
pointer and flips status to `draft-saved`. Gmail's `create_draft` rejects "Name
<addr>" recipients and does not support attachments. Spec: `specs/mail-spec.md`,
design: `design/mail-design.md`.

> **Gotcha (load-bearing):** to use an MCP tool from `claude -p`, pre-approve it
> with **`--allowedTools mcp__…`** but do **NOT** pass `--tools` to restrict — the
> `--tools` allow-list *drops* MCP tools entirely (the model reports them "not
> available"). `--tools` works for built-ins (Read/WebFetch); MCP tools must be
> left unrestricted and merely pre-approved.

> **Gotcha:** model-driven capability discovery is **non-deterministic** — it
> occasionally returns an empty/unparseable descriptor. `capabilities()` retries
> and **caches only a usable result**, so a transient miss never disables Mail.
> (Gmail today: `send → null` (draft-only), `canAttachToDraft → false`.)

**Performance.** Mail spawns run in a **neutral cwd** (`RUN_DIR`, like generation),
NOT the project — otherwise every call loads `CLAUDE.md` (~36k→8k tokens of
cache-creation per call). Even so, each call is a ~20-30s `claude -p` + MCP round
trip (the architectural floor — no persistent session). So mail is served from a
**persistent local store** (`lib/mailstore.js` → gitignored `docs-cache/mail.json`)
and **refreshed in the background** (on boot + a 3-min interval + opportunistically
when stale): `GET /api/mail/inbox` returns the stored list **instantly and never
blocks** on a fetch (it kicks a background refresh and the client polls briefly for
the swap-in), so the rail renders in ~150ms even across restarts. Thread reads are
cached the same way, and inbox thread bodies are **background-prefetched** after
each list refresh so opening a thread is instant (first-ever open still ~7s, then
cached). The reader renders each message's **`htmlBody` in a sandboxed iframe**
(faithful formatting, no scripts); `messageBody()` prefers a substantial plaintext
part else stripped HTML (some senders put junk like literally `"False"` in the
plaintext part). `mailstore` is versioned — bump `VERSION` when the cached shape
changes to invalidate old caches. `searchThreads` is
relevance-tuned (translate to a focused query, scope to inbox, never pad) and the
client debounces + fires on Enter (min 2 chars). Use **sonnet** for mail turns —
haiku gave no speed win (it did MORE post-tool thinking). `mail.inbox()` lists
recent Primary threads (provider-agnostic; Gmail `in:inbox category:primary`).

> **Gotcha (load-bearing, biggest latency lever):** for list reads
> (`searchThreads`/`inbox`) we **capture the MCP tool's raw `tool_result` from the
> stream-json output and `SIGKILL` the process the instant it arrives** (`mcpRead`),
> rather than waiting for the model to re-format it. Measured breakdown of a ~18-30s
> call: the model's reformatting turn was **~9s of pure waste** (the tool result
> already holds the data). Capturing it took search/inbox to **~7s**. Because we
> skip the model's curation, **relevance must live in the query** — the prompts tell
> the model to scope to `in:inbox category:primary` (Gmail) by default, which keeps
> results clean. Also: the spawned CLI **defers MCP tools**, so the model burns a
> turn on `ToolSearch` to load the schema before calling; `mcpRead` matches the
> result by the real tool's `tool_use_id` to ignore that detour. `--effort low`
> trims the thinking. `readThread` also uses `mcpRead`, with two wrinkles: a large
> `get_thread` result **exceeds the tool-result token cap and is offloaded to a
> file** (the result becomes a "saved to <path>" notice) — `mcpRead` reads that
> file; and message bodies arrive as `plaintextBody`/`htmlBody` (no plain `body`),
> so `messageBody()` prefers plaintext, strips HTML otherwise, and caps length.
> `saveDraft`/`capabilities` still use the full model turn (they need the model's
> own output/usage).

## Data model

`docs/<id>.meta.json`:
```json
{
  "id": "20260531044535-tr7o",
  "title": "Derived from the first H1",
  "premise": "the original request",
  "history": [{ "role": "user", "content": "…" }],
  "intake": [{ "role": "user", "content": "…" }],   // raw planning transcript, or null
  "contextSummary": "distilled facts from intake, for revise (lazy; cleared on regenerate)",
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
- **Editor layout**: app shell is a flex column (fixed top bar + the active view
  fills the rest; `body` itself doesn't scroll). The editor is a two-column grid —
  a **fixed 8.5in US-Letter page** (`.doc` inside a `.doc-pane` scroll container)
  and a flexible **sidebar**, each scrolling independently. The grid stays
  ≥ page+panel wide, so `#view-editor` scrolls **horizontally** when the window is
  narrower. Home/brief views remain normal centered scrollable pages.
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
