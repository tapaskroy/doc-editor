# doc-editor: Personalization Design (Architecture)

*How the personalization system is built. Companion to [`../specs/personalization-spec.md`](../specs/personalization-spec.md) (locked product decisions) and [`../specs/vision.md`](../specs/vision.md). Status: design, **reworked 2026-06-08** after an architecture review (verdict: REWORK) and the Bali retry-loop finding. Section 9 lists what remains open; everything the review marked "must address" is resolved inline.*

## 1. Overview

Three subsystems plus a feedback channel, on top of the existing app:

1. **Voice store** — the read-write profile (`SKILL.md` + `voice.json`) and the functions
   that read, compose, and update it. A **thin `lib/voicestore.js` beside
   `lib/skills.js`** (the discovery seam stays read-only, per the review). Phase 1
   shipped a first cut inside `lib/skills.js`; step 2 extracts it.
2. **Learn pipeline** — edit-diffs (and imports) → failure-episode guard → classify →
   accumulate → candidates. `lib/learn.js` + `lib/importers/*`, reading `lib/versions.js`.
3. **Awareness surface** — the ambient editor badge and the Voice tab where the user
   reviews and manages. New routes + a **generic** review surface (the Mail gate is wired
   to Mail state, not reusable as-is).
4. **Feedback channel** — where Claude-corrections go (baseline quality rules + a guardrail/
   bug log), kept physically separate from voices so failures never become personality.

One-way flow, always through the gate:

```
edits / imports ─► failure-episode guard ─► classify ─► accumulate ─► review gate ─► voice.json (voice/context)
 (versions.js,       (lib/learn.js)          (Haiku)     (cross-doc                 └► feedback channel
  importers)                                              confidence)                  (baseline rule / bug log)
                                                                       generation reads ◄─ compose() from voice.json
```

## 2. Data model

### 2.1 A voice (single source of truth)

```
~/.claude/skills/<voice-id>/
  SKILL.md    # human PREAMBLE + a regenerated, READ-ONLY "## Learned rules" block
  voice.json  # AUTHORITATIVE for rules + metadata
```

`voice.json` is authoritative. `SKILL.md`'s learned block is a deterministic render of the
active rules, present only so other Claude Code instances see them (portability). The
preamble is the only human-owned part. **`compose()` builds the injected prompt from the
preamble plus the active rules in `voice.json`** (not by reading the block back), so there
is one owner. (Resolves review finding "two sources of truth" and 9.6.)

```json
{
  "id": "blog",
  "lastReviewedAt": "…",          // drives the "N since last review" badge
  "rules": [{
    "id": "r_8f2",
    "observation": "You replace 'utilize' with 'use'.",  // human-readable; kept for the tab summary
    "text": "Prefer 'use' over 'utilize'.",              // the injected instruction
    "layer": "voice",            // voice | context
    "status": "suggested",       // suggested | active | dismissed | retired
    "confidence": 1,
    "support": ["doc:20260606-…#rev3"],  // refs for OWN docs; abstract counts for sensitive sources
    "source": "edits",           // edits | docs | sent-mail | whatsapp | taste
    "createdAt": "…", "updatedAt": "…"
  }]
}
```

### 2.2 Candidate → rule (explicit transform, per the review)

Producers emit one shape; the accumulator maps it to a rule. Field mapping is now explicit
and **`observation` is preserved** so the Voice tab summary can be reconstructed:

| candidate | rule |
|---|---|
| `observation` | `observation` (kept) |
| `target` | `layer` |
| `proposedText` | `text` |
| `sourceType` | `source` |
| `evidence[]` | `support[]` (see retention policy) |
| `confidence` | `confidence` (recomputed on accumulate) |

### 2.3 Evidence retention (resolves the discard contradiction)

- **Own documents (edits, docs importer):** `support` holds *refs* into version history
  (`doc:id#vid`), not copies. Cheap, auditable, the user's own content.
- **Sensitive sources (sent-mail, whatsapp, taste):** the importer **strips verbatim
  evidence at its boundary** and stores only abstract provenance (`{ source, count, date }`).
  No private snippets ever reach `voice.json`. This is what makes "distil and discard" true.

### 2.4 Per-document voice + attribution

`docs/<id>.meta.json` carries `voice` (Phase 1, done). Additionally, **each AI snapshot in
`lib/versions.js` stores the voice that produced it** (`versions.add` gains a `voice`
field). The learn pipeline attributes an edit to the voice of the snapshot it corrects, so
mid-document voice switching is a lookup, not a guess (resolves 9.10).

## 3. Trust boundary (where data physically goes)

The classify/learn pass and every importer run through the user's **own `claude` CLI**, the
same channel drafting and revision already use: it reaches Anthropic under the user's own
subscription, **no other third party, no new key**. Nothing is sent to any server the app
controls. Chat/mail importers redact other participants before the pass. A local model is a
future option, not v1. The consent step for any import states this plainly. (Resolves the
review's top finding.)

## 4. The learn pipeline (`lib/learn.js`)

1. **Collect.** Walk a doc's ordered snapshots; pair each `ai` snapshot with the `manual`
   edits that follow it (and any comment text). Attribution voice = the snapshot's stored
   `voice` (2.4).
2. **Failure-episode guard (step 0, per the Bali finding).** Detect retry loops: ≥2 edits to
   the same span in one session each superseding the last, and/or correction language in the
   comments. Collapse to one episode, route to the feedback channel (section 6), and
   **exclude from voice-confidence**.
3. **Classify + dedup in one Haiku pass** (`--tools none`). Input: a batch (heuristic
   pre-filter drops whitespace/typo/tiny/reorder; cap ~40, surface "and N more") of
   `(before, after, comment)` plus the voice's existing rules. Output candidates tagged
   `voice | context | claude-correction | noise`, each either `matches r_X` (dedup) or new.
   The prompt explicitly separates "stable preference" from "correcting your mistake."
4. **Accumulate.** Matches bump `confidence` **only on independent cross-document
   corroboration** (a retry chain is one observation). New items are `suggested`.
5. **Review + apply.** Through the gate; voice/context lessons write to `voice.json` (then
   regenerate the SKILL.md block); `claude-correction` items go to the feedback channel.
6. **Decay.** Deferred (section 9).

Trigger: on-demand in v1; compute may run in a background task so the badge is ready.

## 5. Prompt composition

`compose()` = global baseline (`ANTI_TIC_NOTE`) + voice preamble + **active rules from
`voice.json`** + relevant context. Resolved rules from the review:

- **Intra-layer conflict:** higher `confidence` wins, then recency. Deterministic.
- **Over the token budget:** prefer **merging/summarizing** clustered rules into denser
  prose; if still over, drop deterministically (lowest-confidence last) and **show the drop
  in the Voice tab** so an approved rule never silently stops applying.

## 6. The feedback channel

`claude-correction` candidates never touch a voice. They split into:
- **baseline quality rule** — a recurring stylistic mistake (em-dash precedent) → the global
  baseline shared across voices.
- **guardrail / bug** — hallucination, ignored instruction, broken formatting → a feedback
  log (`feedback.json` or similar) with consequences: prompt guardrails or a bug/capability
  backlog. Surfaced separately from the Voice tab.

## 7. Server, UI, and verified reuse

- **Routes:** voice CRUD; `propose` (from edits/import) → candidates; `apply`/`dismiss`;
  feedback list. Per-doc voice route shipped in Phase 1.
- **Voice tab** + **ambient badge**; a **generic** review surface built fresh.
- **Reuse, verified (per the review's instruction):**
  - `lib/versions.js` — `add/list/get/previous/diffPair` exist; snapshots carry
    `kind/model/usd/at`. Pairing ai→following-manual is a **list walk** (no built-in
    helper); `add` must gain a `voice` field. ✔ with a small extension.
  - `lib/claude.js` — `firstJsonObject` and `runTurn` exist but are **not exported**. Phase 2
    adds a stateless JSON `analyze()` export. ✗→fix.
  - Review gate — Mail's is wired to Mail state; **not** directly reusable. Build a generic
    confirm surface. ✗→build.
  - `docs/<id>.meta.json` already per-document; per-doc voice extends it. ✔

## 8. Concurrency and atomic writes

Background regeneration writes `SKILL.md`/`voice.json` while other Claude Code instances may
read and the user may hand-edit. All writes are **write-temp-then-rename** (atomic). A reader
that catches a half-update sees either the old or new file, never a torn one. The preamble is
preserved across regenerations; only the managed block is replaced.

## 9. External dependencies (flagged, per the review)

- WhatsApp `.zip`/`.txt` export parsing — fragile, format not controlled; behind the
  (deferred) WhatsApp importer.
- Netflix/Spotify export parsers — fragile, back the experimental, low-value taste feature;
  deferred, and possibly not worth a place in this design yet.
- Embeddings for dedup — **avoided in v1** (we use normalized-text + in-pass model judgment).
  Revisit only if existing text-similarity infra can be reused.

## 10. Build order (revised)

1. **Extract the voice store** into `lib/voicestore.js`; make `compose()` authoritative from
   `voice.json` (step 2 of the current plan).
2. **Learn pipeline** (collect → failure guard → classify/dedup → accumulate), now that
   classification (8) and dedup (9) are locked. Add `claude.analyze()` and the snapshot
   `voice` stamp first.
3. **Generic review surface + feedback channel.**
4. **Voice tab + ambient badge.**
5. **Cold-start docs importer**, then sent-mail.
6. **Later:** WhatsApp; baseline promotion; decay + the context representation; taste.

## 11. Open questions (remaining)

Resolved and moved to spec section 12: trust boundary, discard/evidence, single source of
truth, classification cost/model, dedup, attribution, conflict/budget. Still open:

1. **Decay and contradiction (deferred).** What counts as an edit "contradicting" an active
   rule, and how fast confidence falls. Lands with the context phase.
2. **Context representation and use (deferred, the big one).** Always-on profile vs retrieval;
   storage (rules in `voice.json` vs a shared `context.json` since facts are not voice-specific).
3. **Cold-start quality bar.** Minimum corpus to infer a voice; what to say when too thin.
4. **Forget semantics.** Dismiss (tombstone) vs delete (hard, may re-learn); hard-delete by
   default for context facts.
5. **3.1 assumption to validate:** that post-snapshot edits are mostly style. The Bali case
   shows they often are not; validate against real diffs as the pipeline comes up.
