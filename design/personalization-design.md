# doc-editor: Personalization Design (Architecture)

*How the personalization system is built. Companion to [`../specs/personalization-spec.md`](../specs/personalization-spec.md) (which holds the locked product decisions) and [`../specs/vision.md`](../specs/vision.md). Status: design, pre-implementation. Section 9 lists the open questions and ambiguities to resolve before building.*

## 1. Overview

Three subsystems on top of the existing app:

1. **Voice store** — the read-write profile format (`SKILL.md` + `voice.json`) and the
   functions that read, compose, and update it. Extends `lib/skills.js`.
2. **Learn pipeline** — turns edit-diffs (and imported corpora) into reviewable candidate
   lessons. New `lib/learn.js` plus `lib/importers/*`. Reads `lib/versions.js`.
3. **Awareness surface** — the ambient editor badge and the Voice tab where the user
   reviews, approves, and manages. New routes in `server.js`, new UI in `public/`, reusing
   the review-gate modal.

Data flows one way into a voice, always through the gate:

```
edits / imports  ->  candidates (classified, scored)  ->  review gate  ->  voice store
   (versions.js,        (lib/learn.js,                     (Voice tab /      (SKILL.md +
    importers)           a Claude analysis pass)            editor badge)     voice.json)
                                                                   |
                                       generation reads <----------+
                                  (composed system prompt: baseline + voice + active rules)
```

## 2. Data model

### 2.1 A voice (a skill folder)

```
~/.claude/skills/<voice-id>/
  SKILL.md      # human + portable: frontmatter (name, description) + preamble + a
                # managed "## Learned rules" section listing ACTIVE rules in prose
  voice.json    # app-managed metadata (NOT read by other Claude Code instances)
```

`voice.json` (sketch):

```json
{
  "id": "blog",
  "baseOf": null,
  "rules": [
    {
      "id": "r_8f2",
      "text": "Cut intensifiers like 'very' and 'really'.",
      "layer": "voice",            // voice | context
      "status": "active",          // active | suggested | dismissed | retired
      "confidence": 0.82,
      "support": ["20260606-rev3#d2", "20260601-rev1#d5"],  // edit/source refs
      "createdAt": "…", "lastSeenAt": "…",
      "source": "edits"            // edits | docs | sent-mail | whatsapp | taste
    }
  ]
}
```

- The **portable** truth is `SKILL.md`. Its "Learned rules" section is rendered from the
  `active` rules in `voice.json`; `voice.json` is the source of metadata, `SKILL.md` is the
  source of injected prose. Keeping the two in sync is a named risk (section 9).
- **Context** lives as `layer: "context"` rules (or a sibling `context.json`, open question
  9.4). Context is facts, not style, so it is composed into the prompt differently
  (section 5).

### 2.2 Candidate lesson (shared shape)

Every producer (edit loop and each importer) emits the same shape, so the review gate and
accumulator are source-agnostic:

```json
{
  "observation": "You replace 'utilize' with 'use'.",
  "target": "voice",
  "proposedText": "Prefer 'use' over 'utilize'.",
  "evidence": [{ "before": "…", "after": "…", "ref": "…" }],
  "confidence": 0.4,
  "sourceType": "edits"
}
```

### 2.3 Per-document voice

`docs/<id>.meta.json` gains `voice: "<voice-id>"` (kind-agnostic; works for docs and
emails). New docs inherit the default voice. Generation and the learn loop both read it.

## 3. The learn pipeline (`lib/learn.js`)

1. **Collect diffs.** From `lib/versions.js`, pair each `ai` snapshot with the `manual`
   edits that followed it (what Claude wrote vs what the user kept), plus any comment text
   attached to that revision. This is the labeled signal.
2. **Classify + infer (one Claude analysis pass, `--tools none`).** Feed a batch of
   `(before, after, comment)` triples; the model returns candidates in the 2.2 shape,
   each labeled `voice`, `context`, or dropped as noise (typos, reorderings). Reuse the
   `firstJsonObject` / sterner-retry pattern from `lib/claude.js`. This is analysis, not
   writing, so it carries no voice skill itself.
3. **Accumulate.** Match each candidate against existing rules (semantic dedup, open
   question 9.2). A match bumps `support` and `confidence`; a new one is created
   `status: "suggested"`. Confidence is a function of independent supporting edits over
   time.
4. **Surface.** The ambient badge counts `suggested` (and changed) rules since the last
   review. The Voice tab lists them with evidence.
5. **Apply / dismiss.** On approval: `status: "active"`, re-render the `SKILL.md` Learned
   rules section. On dismiss: `status: "dismissed"` so it does not resurface.
6. **Decay.** When later edits contradict an active rule, lower its confidence; below a
   threshold demote to `suggested` or `retired`. Contradiction detection is open (9.3).

Trigger: on-demand in v1 (decision 3). Computation can run in a background task after an
edit burst so the badge is ready, but nothing surfaces unprompted.

## 4. Importers (`lib/importers/*`)

Contract: `import(input, opts) -> candidate[]` in the 2.2 shape, then the same gate.

- **docs** — read a folder or pasted samples; a Claude pass derives voice candidates and,
  for cold start, can draft the whole `SKILL.md` preamble. Keep-locally allowed.
- **sent-mail** — pull the user's sent messages via the existing `lib/mail`; derive a
  professional-register voice. Distil and discard.
- **whatsapp** — parse the export (`.txt`/`.zip`), keep only the user's own lines
  (matched by display name), derive a casual voice. Distil and discard; never learn other
  participants.
- **taste (experimental)** — parse Netflix/Spotify export files into low-weight persona
  candidates (`sourceType: "taste"`), voice-only, never factual.

## 5. Prompt composition (how a voice reaches generation)

The writing system prompt is composed, in order:

```
GLOBAL BASELINE (ANTI_TIC_NOTE: no em dashes, precision, etc.)
  + selected voice preamble (SKILL.md)
  + active high-confidence learned rules (voice layer)
  + relevant context (context layer)        <- see open question 9.4
```

- Conflict resolution: later (more specific) layers win; the baseline is the floor.
- Size budget: the active-rules set must stay within a token ceiling; lowest-confidence
  active rules are trimmed first (open question 9.5).
- This composition replaces today's single `styleNote(style)` injection in
  `lib/claude.js`.

## 6. Server and UI

- **Routes:** `GET /api/voices`, `POST /api/voices` (create/clone), `PUT/DELETE
  /api/voices/:id`, `POST /api/voices/:id/default`; `GET /api/voices/:id/pending`
  (proposed lessons), `POST /api/voices/:id/lessons/apply|dismiss`; `POST
  /api/voices/:id/import`; `PUT /api/docs/:id/voice`.
- **Voice tab** (`#/voice`): a third surface beside Docs and Mail. Summary at top
  (Claude's plain-language "what I noticed"), then proposal cards with before/after
  evidence and keep/edit/dismiss, then voice management (list, create, clone, default,
  delete) and the About-me context section.
- **Ambient badge:** a small indicator in the editor sidebar showing pending count, linking
  to the tab. Reuses the existing modal styles for any inline confirm.

## 7. Reuse of existing seams

- `lib/versions.js` is the diff source (no new capture).
- `lib/skills.js` already discovers and reads skills; extend it rather than replace.
- The Claude analysis pass mirrors `toDeck` / the injected `deckBuilder`: a stateless
  JSON-returning call, kept out of `lib/export`-style modules.
- The review gate mirrors Mail and publishing: one confirm surface, nothing acts without it.
- Writing and analysis both run `--tools none`; importers read local files on the server
  side, not via model tools.

## 8. Build order

1. Voice store (two-file format, read/compose/update, per-doc voice) and migrate the
   current Style picker onto it.
2. Learn pipeline (collect, classify, accumulate) with the Voice tab review of suggestions,
   suggest-only.
3. Ambient editor badge.
4. Cold-start docs importer, then sent-mail importer.
5. Decay, baseline promotion, the context section.
6. Later: WhatsApp, taste, auto-nudge, auto-apply.

## 9. Open questions and ambiguities

These are unresolved at the design level and worth settling before or early in the build.

1. **Classification cost and reliability.** Step 3.2 is a Claude pass per batch of edits.
   How big a batch, how often, and what does it cost on a busy week? Is a cheap heuristic
   pre-filter (drop tiny/typo diffs) enough to keep the model pass small? Which model and
   effort?
2. **Semantic dedup.** How do we decide a new candidate is "the same rule" as an existing
   one, to bump confidence rather than create a duplicate? Embeddings, a model judgment, or
   simple normalized-text matching? Getting this wrong fragments a voice or merges distinct
   rules.
3. **Decay and contradiction.** What counts as an edit "contradicting" an active rule, and
   how fast should confidence fall? Without this, voices ossify or drift. Needs a concrete
   rule, not just the intent.
4. **Context: representation and use.** The spec splits voice and context, but how context
   is *used* in generation is underspecified. Is it a small always-on profile, or retrieved
   per document by relevance? Where stored (rules in `voice.json` vs a separate
   `context.json`, possibly shared across voices since facts are not voice-specific)? This is
   the biggest ambiguity.
5. **Prompt budget and conflicts.** As active rules accumulate, the injected prompt grows.
   What is the token ceiling, how do we trim, and how do we resolve two rules that disagree?
6. **SKILL.md / voice.json sync.** `SKILL.md` is the portable injected artifact; `voice.json`
   is the metadata. If the user hand-edits `SKILL.md`, or another Claude Code instance does,
   how do the two reconcile? Proposed: `SKILL.md` "Learned rules" section is machine-owned and
   regenerated, the preamble is human-owned, but the boundary needs to be unambiguous and
   safe.
7. **Per-document voice migration.** Existing docs have no `voice` field. Assign the default
   on first open, or leave unset and treat unset as default? Does changing a doc's voice
   retroactively re-attribute its past edits?
8. **Cross-instance portability vs metadata.** Other Claude Code instances read `SKILL.md`
   and ignore `voice.json`. That is fine for *using* a voice, but they cannot *learn* into it.
   Is that acceptable for v1 (only doc-editor writes), or do we want a portable learn format
   later?
9. **Cold-start quality bar.** How good must the first drafted voice be (from pasted samples)
   to be worth keeping? What is the minimum corpus, and what does the tool say when the sample
   is too thin to infer a voice?
10. **Attribution when voices are switched mid-document.** If the user drafts under "Blog,"
    switches to "Casual," and edits, which voice should those edits teach? Last-active-at-edit,
    or the doc's current voice?
11. **"Forget" semantics.** When the user forgets a context fact or a rule, is it suppressed
    (kept as dismissed so it never resurfaces) or truly deleted (and may be re-learned later)?
    Privacy argues for true delete; usefulness argues for tombstoning. Likely needs both, user
    choice.
12. **WhatsApp "self" detection.** Identifying the user's own messages in an export depends on
    a display name that may be ambiguous or change. How do we confirm we are learning the right
    person's lines?
