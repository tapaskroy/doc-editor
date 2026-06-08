# doc-editor: Personal Memory Design (Architecture)

*How the personal-memory layer is built. Companion to [`../specs/personal-memory-spec.md`](../specs/personal-memory-spec.md) (locked decisions — all 8 open questions resolved) and [`personalization-design.md`](personalization-design.md) (its sibling, the voice layer). Memory is "what is true about me"; voice is "how I write." Status: design, ready to implement after review. Section 11 lists the new design-level open questions.*

## 1. Overview

Personal memory is the **context** asset of the flywheel (CLAUDE.md north star): what the user knows — their people, work, tastes, history — that grows without bound, as distinct from voice (how they write, converges fast). It exists to do two things and nothing more in v1: **stop the writer from fabricating** (the Bali bug) and **ground writing in durable facts the user has shared**, while preserving trust.

Four pieces on top of the existing app, reusing the personalization machinery wherever it already exists:

1. **Memory store** — the portable, user-owned profile (`USER.md` + topical files) plus a thin metadata manifest. New `lib/memory.js`, sibling to `lib/voicestore.js`.
2. **Capture** — durable user/world facts proposed (suggest-only) from the intake conversation and from edits, landing in a passive **unsaved queue**. Reuses `lib/learn.js`'s classifier and `claude.analyze()`.
3. **Use in writing** — retrieval (small always-on core + per-doc relevance) → an injected, grounding-only memory block; plus the **doc-specific context fix** (hybrid C: verbatim transcript into generation, distilled summary into revise).
4. **Profile tab + transparency** — the unified surface (merges the planned Voice tab): what we know, what each draft will send, a chat box to edit, and the unsaved-memory keep/discard queue.

One-way capture flow, always through the gate; consumption is explicit and retrieval-scoped:

```
intake transcript / edits ─► capture pass (Haiku) ─► unsaved queue (manifest) ─► [user keeps] ─► USER.md / topical file
  (meta.intake, versions.js)   (lib/learn.js)         (provenance, keep/discard)                       │
                                                                                                        ▼
generation ◄─ memory.compose(retrieve(doc))  +  verbatim intake block        revise ◄─ memory.compose(...) + distilled contextSummary
            (always-on core + per-doc relevance, grounding-only)                       (never the raw transcript)
```

## 2. Where memory lives (Q1 decided)

### 2.1 Canonical store — portable, open, outside the repo

```
$DOC_EDITOR_MEMORY_DIR            # default ~/.config/doc-editor/memory/ — neutral, user-owned, NOT in the git repo
  USER.md                          # curated, sectioned profile (the always-on core). Human-editable. Portable.
  memory/<topic>.md                # topical files that grow: travel.md, work.md, taste-film.md, …
  memory.json                      # thin metadata manifest (NOT the content; see 2.3)
```

Markdown is the **canonical content** — open format, the user owns it, takeable to any tool or model. `memory.json` is auxiliary metadata, never the source of the facts themselves (avoids the split-brain we hit with `voice.json`/`SKILL.md`: there, JSON was authoritative; here, the *Markdown* is authoritative for content, JSON only annotates it).

### 2.2 Projection into `~/.claude/` — for *other* Claude instances

A projection step keeps `~/.claude/` pointing at the canonical so the user's *regular* CLI sessions benefit: **symlink preferred** (`~/.claude/USER.md` → `$DOC_EDITOR_MEMORY_DIR/USER.md`, and `~/.claude/memory/` → the topical dir), **copy as fallback** when symlinks aren't viable. Because Claude Code auto-loads `~/.claude/CLAUDE.md` (and its `@import`s) but not an arbitrary `USER.md`, the projection also ensures a single `@USER.md` import line exists in `~/.claude/CLAUDE.md`. *(Sub-detail to verify against current Claude Code memory-loading rules — see 11.)*

**Key architectural point:** doc-editor does **not** consume memory via this projection. Its own writing spawns run in a neutral `RUN_DIR` precisely to avoid auto-loading `CLAUDE.md` (the 7–23× cost blow-up, CLAUDE.md "load-bearing"). So doc-editor reads the canonical files **directly** and injects **only the retrieved slice** (lean, controlled — Q5). The `~/.claude/` projection exists solely so external Claude instances get the benefit. The two never fight: one path is explicit injection, the other is auto-load, and they read the same canonical bytes.

Seeding is **deferred** (Q6): v1 starts empty and learns from day one. No OpenClaw import in v1; no write-back ever.

### 2.3 The manifest (`memory.json`)

Metadata only — provenance, status, and the unsaved queue. It annotates content that lives in Markdown; it is **not read at generation time** (generation reads the Markdown).

```json
{
  "items": [{
    "id": "m_3a9",
    "topic": "profile",                 // profile (→ USER.md) | <topic> (→ memory/<topic>.md)
    "text": "Has a spouse and one child.",     // the durable fact, as written into the Markdown
    "status": "unsaved",                // unsaved | kept | discarded
    "provenance": "Learned from the planning conversation on \"Bali trip recap\" (doc 20260608-…).",
    "source": "intake",                 // intake | edits | chat
    "sensitivity": "normal",            // seam for deferred tiers; always "normal" in v1
    "createdAt": "…", "keptAt": null
  }]
}
```

`status: unsaved` items are the **queue** (never injected). On **keep**, the item's `text` is appended to its target Markdown file under the right section, `status→kept`, `keptAt` stamped, and the projection refreshed. On **discard**, `status→discarded` (tombstone, so the same fact isn't re-proposed forever). **Forget** a kept fact = remove the line from the Markdown *and* tombstone the item. Direct user edits to the Markdown are authoritative for content; the manifest may drift slightly on hand-edits — acceptable because the manifest drives only provenance/UX, not generation.

All writes are **write-temp-then-rename** (atomic), same as `voicestore.js`/`mailstore.js`. Markdown edits preserve sections; only the relevant region changes.

## 3. The memory model (tiers)

- **`USER.md` — the always-on core.** Small, sectioned: identity, people (relationships/names), work, languages, durable preferences, and a **Privacy boundaries** section (hard "never put X in an output" rules). Injected on every generate (it is meant to stay small).
- **Topical files — retrieved by relevance.** `memory/<topic>.md` for areas that grow (travel, work, taste-film/-music). Only the relevant ones reach a given prompt (Q5).
- **Journal — deferred** (its own tab, higher privacy bar, mobile; do what Obsidian can't). Not in v1.

## 4. Capture (Q3: passive, no in-flow prompts)

Document creation is never interrupted. Capture runs **after** the work, asynchronously, and only ever fills the unsaved queue.

1. **Sources.** (a) the **intake transcript** (`meta.intake`) right after a brief-driven draft; (b) **edits**, via the existing learn pipeline, which already classifies `voice | context | claude-correction | noise`.
2. **One Haiku pass** via `claude.analyze()` (reused). For intake, a new prompt extracts **durable user/world facts** ("the user has a spouse and one child", "works at X") and separates them from **doc-specific details** ("this trip was 8 days") — only the durable, about-the-user ones become memory candidates. For edits, the pipeline's existing `context` candidates that are *durable + about the user* route here instead of to the doc.
3. **Land in the queue.** Each candidate becomes a `status:unsaved` manifest item with **provenance** (how/where it was learned) and `source`. Nothing is written to `USER.md`/topical files, and nothing is injected, until the user keeps it.
4. **Dedup.** Against existing kept items and existing tombstones (normalized-text + the in-pass model judgment, mirroring personalization §9 — no embeddings in v1).

This is the same "suggest-only, consented, legible" principle as the voice review gate — relocated from a blocking modal to a passive queue so it adds zero friction to writing.

## 5. Use in writing

### 5.1 Retrieval (Q5)

`memory.retrieve({ premise, brief, recipients })` → a compact set of facts:

- **Always-on core:** `USER.md` (small by construction), always included.
- **Per-doc relevance:** select topical files/facts relevant to the document. **v1 mechanism:** lightweight matching — topic tags + keyword/recipient overlap against the premise/brief — to keep it free and instant. **Seam:** a Haiku "which of these facts are relevant to this document?" scoring pass for when the store grows large (noted, not built — adds a call+latency, unnecessary while memory is small).
- **Lean by mandate:** never dump the whole store; the user's explicit ask. Retrieval returns a bounded block.

### 5.2 Composition and the leakage guardrail (Q2)

`memory.compose(retrieved, { usePersonalFacts })` returns a system-prompt block, appended in `lib/claude.js` alongside `ANTI_TIC_NOTE` and the voice's `styleNote()`:

> **What is true about the user (context to ground your writing).** Use these facts to stay accurate and to avoid inventing details. **Do not volunteer private facts** (names, household, location) into the output unless the document plainly calls for them. Honor the Privacy boundaries verbatim.

- **Grounding is always on** — the anti-fabrication job (Bali). Even with the toggle off, memory still prevents invention and answers an explicit ask.
- **Volunteering is gated** by a per-document toggle `meta.usePersonalFacts` (default **off**; the user flips it on for a piece that should name personal facts, e.g. a family blog post). Off ≠ blind; off = "don't proactively surface private facts into the artifact."
- **Privacy boundaries** from `USER.md` are passed as hard rules.
- **Input-transparency ≠ output-safety** (spec §7): the Profile tab shows what's *sent*; the don't-volunteer rule + toggle govern what *comes out*. Both are needed.

### 5.3 Doc-specific context fix (Q7, hybrid C)

Separate from memory; preserves *this* document's specifics.

- **Store:** `meta.intake` (the raw transcript) — inspectable, recoverable, re-distillable. Already produced by the brief flow; we stop dropping it.
- **Generate:** include the transcript **verbatim** as a "Conversation that shaped this document" block in the generation prompt (in addition to `briefToPrompt(brief)` for structure). Streaming prose call — no JSON-mode risk. This is the direct Bali fix.
- **Revise:** **never** the raw transcript (the load-bearing lesson: conversational context breaks clean JSON find/replace — CLAUDE.md "Conversation memory"). Instead carry a **distilled `meta.contextSummary`** (`claude.distillContext(intake)`, Haiku) alongside the existing `history`-as-context.
- **Freshness:** re-distill `contextSummary` on regenerate and on demand (a manual "refresh context" affordance), so a superseded decision isn't fed forward forever (the staleness risk the context-spectrum note flagged).

## 6. Trust boundary

Identical to personalization §3: the capture/distill passes run through the user's **own `claude` CLI** (Haiku via `analyze()`), the same channel drafting already uses — Anthropic under the user's subscription, **no other third party, no new key**. The canonical store and manifest are **local and gitignored**; nothing is sent to any server the app controls. Per-item **sensitivity tiers + bring-your-own-model endpoint (Bedrock/local) are deferred with the journal** — but the model endpoint in `lib/claude.js` stays a configurable **seam** so BYO-model is cheap to add (also the vision's platform-dependence hedge). The **"no personal info in specs/shared docs" rule** still holds: the memory store is the user's private data and may hold real names; specs and shared artifacts must not.

## 7. Modules and changes

- **`lib/memory.js` (new).** `load()`, `retrieve(ctx)`, `compose(retrieved, opts)`, `propose(items)` (queue), `keep(id)`/`discard(id)`/`forget(id)`, `editProfile(md)`, projection (`syncToClaudeDir()` — symlink/copy), atomic writes. Sibling to `voicestore.js`.
- **`lib/claude.js`.** `generate()` appends the verbatim intake block + `memory.compose(...)`; `revise()` appends `contextSummary` + `memory.compose(...)`; new `distillContext(intake)`; reuse `analyze()` for the capture pass. Keep all spawns in `RUN_DIR`.
- **`lib/learn.js`.** Route durable, about-the-user `context` candidates to `memory.propose()` (instead of the doc); add the intake-transcript capture entry point.
- **`lib/docs.js`.** New meta fields: `intake` (transcript), `contextSummary` (distilled), `usePersonalFacts` (toggle, default false).
- **`server.js` (thin).** `GET /api/memory` (profile + queue + index), `POST /api/memory/keep|discard|forget`, `PUT /api/memory/profile`, `POST /api/memory/chat` (chat-box add/edit), `GET /api/docs/:id/context` (what this draft will use), `PUT /api/docs/:id/use-personal-facts`. Capture is kicked server-side after draft (non-blocking).
- **`public/`.** **Profile tab** (unify with the planned Voice tab): "About you" (`USER.md`, editable), "Unsaved memory & context" (queue + provenance + keep/discard), chat box. Per-doc **"what this draft will use"** panel (expandable, not blocking) + the **per-doc personal-facts toggle**.

## 8. Concurrency and atomic writes

Same discipline as the voice store: write-temp-then-rename for `memory.json`, `USER.md`, and topical files; section-preserving Markdown edits; the projection is refreshed after a successful canonical write (so a torn read never reaches `~/.claude/`). Background capture writes only the manifest queue, never the Markdown — so a hand-edit and a capture pass cannot collide on the profile.

## 9. Reuse, verified

- `claude.analyze()` (stateless JSON Haiku pass) — **exists** (shipped in Phase 2). ✔ reused for capture + distill.
- `lib/learn.js` classifier/taxonomy — **exists**; add a route + an intake entry point. ✔ small extension.
- `meta.intake` — the brief flow already produces the transcript; today it is dropped. ✔ just persist + pass it.
- Review-gate UI — Mail's gate is wired to Mail state; the personalization plan already calls for a **generic** review surface. The unsaved queue reuses that, not Mail's. ✔→build with the Voice/Profile tab.
- Atomic-write helper — pattern exists in `voicestore.js`/`mailstore.js`. ✔ reuse.

## 10. Build order

1. **Doc-specific fix first (Q7 / hybrid C)** — it's self-contained and fixes the live Bali bug: persist `meta.intake`, verbatim into generate, `distillContext()` + `contextSummary` into revise. Ship and verify against a real intake doc.
2. **`lib/memory.js` store + manifest + projection** (symlink/copy), with `USER.md` scaffolding and atomic writes.
3. **Retrieval + compose + the guardrail** wired into generate/revise; per-doc toggle.
4. **Capture** (intake pass + learn-pipeline routing) → unsaved queue.
5. **Profile tab** (unified): about-you, unsaved queue (keep/discard/forget), chat box, the per-draft "what this draft uses" panel.
6. **Later:** Haiku-scored retrieval at scale; seeding/onboarding import; then the journal track (separate tab, mobile, BYO-model, sensitivity tiers).

## 11. Open questions (design-level)

1. **Projection mechanism precision.** Does current Claude Code auto-load a projected `~/.claude/USER.md`, or must we add an `@USER.md` import to `~/.claude/CLAUDE.md` (2.2)? Verify before wiring the projection; symlink-vs-copy default may depend on the answer.
2. **Default canonical path.** `~/.config/doc-editor/memory/` (proposed) vs `~/.doc-editor/memory/` vs other. Cosmetic but user-facing.
3. **`usePersonalFacts` default.** Off everywhere (safest, proposed) vs kind-aware (off for `mail`, on for clearly-personal docs). Off-by-default risks a family post omitting names until toggled; is that acceptable for v1?
4. **"Major revision" for re-distill.** Regenerate only (proposed) vs every N revisions vs size-delta threshold. Keep it cheap.
5. **Profile-section taxonomy for keep.** When a fact is kept, how do we choose its `USER.md` section / topical file — model-decided in the capture pass, or a small fixed set (identity / people / work / taste / other)? Fixed set is simpler and more predictable for v1.
