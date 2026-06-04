# doc-editor — Product Spec

_User-facing specification of what doc-editor does and how it behaves. For how
it's built, see [`design/architecture.md`](../design/architecture.md). For
working in the repo, see [`CLAUDE.md`](../CLAUDE.md)._

> Status: **v1**, a personal, local, single-user tool. No accounts, no
> authentication. It runs on your machine and talks to your own `claude` CLI.

## 1. What it is

doc-editor is a browser-based writing tool. You describe a document, Claude
drafts it, and you refine it two ways at once: **type directly** like a normal
editor, and **select text to ask Claude** for changes. It is the "talk to Claude
to write, then tweak" loop, made into a real editing surface.

You reach it at **http://localhost:9999**.

## 2. Who it's for / requirements

- A single person, on their own machine.
- **Required:** the `claude` CLI, installed and authenticated (it reuses your
  Claude Code subscription — no API key, drafting/revisions are billed to your
  plan). A modern browser (Chrome recommended).
- **Optional, per feature:** [pandoc](https://pandoc.org) for Word (`.docx`)
  export and for reading uploaded Office documents; Google Chrome for PDF export.
  Missing one only disables that one capability, with a clear message.

## 3. The core loop

1. **Describe** what you want on the home screen.
2. **Get a draft** (immediately, or after a short planning chat).
3. **Refine** by typing inline and/or selecting text and commenting.
4. **Export** to HTML / PDF / Word / PowerPoint when done.

Everything is saved automatically. Every change is snapshotted so you can roll
back.

## 4. Creating a document

The home screen has a description box and two ways to start:

### Draft it
Writes a full first draft from your description immediately, streaming in
token-by-token.

### Let's talk about it first
Opens a short **planning conversation**. Claude interviews you — purpose,
audience, length / reading time, tone, must-include points — one or two questions
at a time, and tells you when it has enough. You can hit **Draft it now** at any
point. The conversation is compiled into a brief that produces a noticeably more
**targeted** draft (right audience, right length, right structure).

### Attachments at creation
Before drafting (either path) you can **📎 Attach** pictures or reference
documents (see §9). Claude uses them as source material.

## 5. The editing surface

- The document opens **editable**, laid out as a faithful **US Letter page**
  (8.5in wide, 1in margins). You click in and type like any editor.
- **Autosave**: your edits save automatically a moment after you stop typing (a
  "Saving… / Saved" indicator shows status). Direct edits cost nothing — no Claude
  call.
- The right-hand panel holds your tools and the document's history/metadata. The
  page and the panel **scroll independently**.

## 6. Refining with Claude

Three ways, all of which preserve the rest of your document (Claude makes
**surgical edits**, not full rewrites):

- **Comment on a selection** — highlight text, click **💬 Comment**, write what
  you want changed, then **Send to Claude**. You can stack several comments and
  send them together.
- **Whole-document change** — a box for global instructions ("make the tone more
  formal", "add a conclusion").
- **Regenerate from premise** — throw away the draft and start over from the
  original description/brief.

Changed passages briefly highlight green after each revision.

## 7. Voice & style

A **Style** picker (top bar) lets you write in a chosen *voice*. It lists the
"skills" in your `~/.claude/skills` (and the project's `.claude/skills`) — each a
folder with a `SKILL.md` describing a writing voice. Pick one and every draft and
revision comes out in that voice. No voice is baked into the app; it's a file you
select.

## 8. Web research

A **🌐 Web** toggle (top bar, on by default). When on, Claude may search the web
and read any URLs you mention, then write from what it finds. When off, it writes
purely from its own knowledge (faster, fully offline). Claude can never touch your
filesystem or run commands — only read the web (when on) and read the files you
attach.

## 9. Attachments (reference material)

Upload **pictures** and **documents** (images, PDF, text/Markdown, Word) as input
for Claude — on the home screen or the editor's **Attachments** panel. Claude
reads them as source material and **uses its own judgment about whether to embed
a picture** in the document (you can also just ask it to). Embedded images render
in the page and are baked into HTML / PDF / Word exports. (PowerPoint export is
text-only for now.)

## 10. Version history & undo

Every change is snapshotted — the first draft, each revision, length adjustments,
and bursts of inline typing.

- The **Versions** panel lists snapshots newest-first (e.g. _Draft_, _Revision:
  make the intro warmer_, _Manual edit_).
- Click a snapshot to see a **diff** of exactly what it changed, and **Restore**
  it. Restoring is non-destructive — it's recorded as a new snapshot, so nothing
  is ever lost.
- An **Undo** button reverts the last change (one step; for deeper rollbacks use
  the panel). Your in-document typing also uses the browser's normal ⌘Z.

## 11. Length targeting

When a document was created from a brief with a target length, the editor shows
**≈ N words · ~M min read**. If the draft is off the target by more than ~15%, a
one-click **Expand** / **Trim** appears to bring it in line.

## 12. Cost tracking

Every Claude action a document triggers is recorded. The **Cost** panel shows a
running **≈ $ (API-equivalent) · N tokens** with a per-operation breakdown (draft,
each revision, briefing, etc.), and each operation shows **which model ran**. The
library lists per-document spend.

- If a model you requested was silently swapped for a cheaper one (a subscription
  rate-limit downgrade — e.g. Opus → Haiku), a **warning** appears so it's never
  invisible.
- The `$` figure is the **API-equivalent** cost. On a subscription it isn't money
  billed — treat it as a relative/awareness number.

## 13. Model & effort

Top-bar pickers choose the **model** (Default / Opus / Sonnet / Haiku) and
**effort** (Default / Low … Max) for drafting and revisions. "Default" uses your
`claude` CLI's own configured default. Selections persist across sessions.

## 14. Export

Buttons for **HTML**, **PDF**, **Word (.docx)**, **PowerPoint (.pptx)**.

- **HTML** works out of the box (self-contained, images inlined).
- **PDF** prints the styled page via headless Chrome (matches the on-screen look).
- **Word** uses pandoc.
- **PowerPoint** is special: Claude first restructures the document into a real
  slide deck (title slide, concise bullets, speaker notes), then it's rendered —
  so you get a presentation, not paragraphs on slides. (It runs a Claude call, so
  it has a small cost; images aren't placed on slides yet.)

## 15. Your library

The home screen lists your documents (newest first) with their spend. Open one to
keep editing; delete removes it and its attachments and history.

## 16. Privacy & security

- **Local only.** The server binds to loopback (`127.0.0.1`) by default, so it is
  not reachable from your network. (You can opt into LAN access with `HOST=0.0.0.0`,
  but there is no authentication, so understand the exposure.)
- **Your content stays on your machine** — documents, attachments, and history
  live in local files; nothing is uploaded to a third party beyond the Claude
  calls your drafting/revisions make through your own CLI/subscription.
- Claude is given **read-only** access to the web (only when 🌐 is on) and to the
  files you attach — never write/shell access to your machine.

## 17. Known limits (v1)

- Single user, no auth, no concurrency story.
- Undo is single-step (the Versions panel covers deeper rollbacks).
- Inline editing round-trips through Markdown: prose is faithful, but heavy tables
  are the rough edge.
- PowerPoint export doesn't place attached images on slides yet.
- A planning chat you abandon before drafting isn't cost-attributed to any doc.
