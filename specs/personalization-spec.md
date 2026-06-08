# doc-editor: Personalization Spec (Voice and Context Learning)

*Status: design, spec-level decisions **locked 2026-06-08** (section 12), reworked after an architecture review and a real-history finding (the "Bali" retry loop, section 5). The engine behind the flywheel in [`vision.md`](vision.md). Architecture in [`personalization-design.md`](../design/personalization-design.md). Builds on the Phase 1 voice store (`lib/skills.js` `compose()` + `voice.json`) and reuses the consented review-gate pattern.*

## 1. What it is, and why

Bring the person to the AI: the user keeps teaching the tool who they are, so it
shows up in their writing. Three parts:

1. **Learn from my edits** — mine the difference between what Claude drafted and what
   the user kept, classify it, and turn the right parts into durable, reviewable
   lessons (sections 4, 5).
2. **Bring my context** — seed and refine a voice from material the user already has
   (section 6).
3. **Many voices, mine to manage** — a voice is a living, user-owned, read-write,
   portable profile; the user keeps several and picks one per document (sections 3, 8).

A voice is not read-only to the editor: the editor reads it to generate and writes to
it to learn, and the user owns it.

## 2. Two layers: voice and context

- **Voice** — how the user writes (cadence, diction, the tics they cut). Converges fast.
- **Context** — what the user knows (people, projects, facts, history). Grows without
  bound; the deeper moat and the heavier privacy weight.

A single edit can feed either, or neither (section 4).

## 3. A voice is a living, multi-source, user-owned profile

- Shows in the Style dropdown by name; the user can create, name, clone, edit, set
  default, delete (section 8).
- Fed by authored rules, lessons learned from edits, and imported corpora (section 6).
- Carries provenance and confidence per rule, so it is auditable and can decay.
- **Single source of truth (locked):** `voice.json` is authoritative for rules and
  metadata. `SKILL.md` is a human-owned **preamble** plus a deterministic,
  regenerated, **read-only** "Learned rules" block rendered from the active rules in
  `voice.json`. The block exists so other Claude Code instances see the rules too
  (portability); it is never the source. This collapses the old sync question to: the
  block is overwritten, the preamble is preserved.

## 4. The learn-from-my-edits loop, and the classifier that protects it

The signal: the diff between Claude's draft and what the user kept (version history
already snapshots this; comments record intent). The loop:

1. **Capture.** Reuse version history. No new capture.
2. **Detect failure episodes first (the guard).** Before anything is attributed to the
   user, detect *retry loops*: multiple edits to the same span in one session, each
   superseding the last, and correction language in the comments ("you made this up",
   "this is wrong", "still wrong"). A retry loop means Claude failed and the user is
   fighting it. It is **one failure episode, not N endorsements**, and it is excluded
   from voice-confidence entirely (section 5 has the worked example).
3. **Classify** each edit (or collapsed episode) into one of:
   - **voice** — a style/taste preference. Reaches the voice layer, but only with
     **cross-document corroboration** (the same kind of edit in independent docs). A
     within-span retry chain counts as at most one observation, never as confidence.
   - **context** — a fact the user corrected or supplied. Reaches the context layer
     (with consent).
   - **claude-correction** — the user fixing a Claude mistake. This is **process
     feedback, never personalization** (section 7). It splits into a generalizable
     quality rule (→ global baseline) or a behavioral guardrail / bug (→ the feedback
     channel).
   - **noise** — typos, reorderings, one-off content. Dropped.
   The classifier weights the user's own instruction text heavily, and is told
   explicitly to separate "the user's stable preferences" from "the user correcting
   your mistakes."
4. **Accumulate.** Dedup against existing rules; raise confidence only on independent
   corroboration. New items start `suggested`.
5. **Review (the gate).** Each candidate shown with evidence: keep / edit / dismiss.
   Approved voice/context lessons are written; approved process-feedback items go to
   the feedback channel. **Suggest-only in v1; nothing is baked in without confirmation.**
6. **Apply and compound.** `voice.json` updates; the SKILL.md block is regenerated.
   Provenance links each rule to what produced it; rules can decay later.

**Stated assumption to validate early (per the review):** that manual edits after an
AI snapshot are mostly about *style*. They are not. The classifier and the
failure-episode guard exist precisely because users also edit for facts, corrections,
and second thoughts. Validate against real diffs before trusting voice output.

## 5. Worked example: the Bali retry loop (why the guard matters)

A real doc, "Notes from Bali," produced five snapshots: a draft that **fabricated** the
travel group ("We were four… two friends"), then four revisions on the **same sentence**
as the user corrected it, with the comment "This fails the math test. You made this up."
The truth was a smaller family group than the draft claimed (the actual names are personal and deliberately kept out of this spec).

Naive learn-from-edits would treat four repetitions as high confidence and learn from
pure thrash. Correct handling:
- **voice: nothing.**
- **context (one fact, consented):** the correct makeup of the user's immediate family
  (names redacted here; they belong only in the user's own document and, with consent,
  the context store, never in a spec).
- **process feedback (one guardrail):** Claude fabricated personal facts it could not
  know; guardrail = do not invent personal facts, ask or leave a placeholder.
- The four retries **collapse to one failure episode and contribute zero to the voice.**

## 6. Bring my context (importers)

Each source is an importer producing candidates in the shared shape, through the same
gate, into a chosen voice or the context layer.

- **Past authored documents** — richest voice signal; the cold-start path. Keep-locally
  allowed (the user's own material).
- **Sent email** — professional register, via the existing Mail connection.
- **Chat exports (WhatsApp)** — casual register; only the user's own messages.
- **Taste (Netflix/Spotify)** — a soft persona signal, voice-only, never factual,
  experimental and low priority (the review questions whether it earns a place yet;
  it stays explicitly deferred).

Sensitive sources (mail, chat, taste) are **distilled then discarded** and store **no
verbatim evidence** (section 9).

## 7. The process-feedback channel (the third output)

Not every edit is about the user. Corrections of Claude's mistakes are routed to a
**separate channel**, never the voice:

- **Generalizable quality rule** — a stylistic mistake Claude repeatedly makes that the
  user repeatedly fixes (the em-dash precedent) → the **global baseline / quality
  rules**, shared, not a personal trait.
- **Behavioral guardrail or bug** — hallucination, ignored instruction, broken
  formatting → a feedback log with its own consequences (prompt guardrails, a bug/
  capability backlog).

This channel has its own home, separate from the Voice tab, so Claude's failures can
never be encoded as the user's personality. Tool-improvement and person-learning are
two different flywheels.

## 8. Many voices, and the Voice tab

- The Style dropdown is the quick picker; the Voice tab is its management home (create,
  name, clone, edit, default, delete).
- **Per-document** (Phase 1, done): each doc stores its voice; learning attributes to
  the voice that produced the draft (section on attribution in the design).
- **Baseline + layer:** a global baseline (anti-tic, no em dashes, precision) under every
  voice; each voice layers its own rules; the user can promote a learned rule to the
  baseline.
- **Awareness:** an ambient badge in the editor ("Voice: N new observations", per-voice
  `lastReviewedAt`) pulls the user to the tab; the tab is a mirror (evidence shown,
  augment-or-create, Voice and About-me sections, full control) where they decide.

## 9. Privacy, trust boundary, and retention

- **Where the data goes (locked, stated explicitly per the review):** the classify/learn
  pass runs through the user's **own `claude` CLI**, the same channel drafting and
  revision already use. It reaches Anthropic under the user's own subscription; it goes
  to **no other third party** and uses **no new API key**. A fully local model is a
  future option, not v1. Imports of sensitive corpora say this plainly at the consent
  step.
- **Redaction:** chat and email importers strip other participants' content and PII
  before the pass; only the user's own lines are analyzed.
- **Distil and discard, made consistent (locked):** the shared candidate shape carries
  `evidence` (before/after) only for the user's **own documents** (refs into version
  history, not copies). For **sensitive sources** (mail, chat, taste), the importer
  drops verbatim evidence at its boundary and keeps only abstract provenance ("from 3
  messages, 2026-06-01"). So no private snippets ever land in `voice.json`. This removes
  the contradiction the review flagged.
- Consent gates every change; the context layer gets a one-click forget.

## 10. Where this touches the code

- A thin **`lib/voicestore.js`** beside `lib/skills.js` owns the read-write store
  (compose, voice.json, regenerate), so the discovery seam stays read-only (per the
  review).
- `lib/learn.js` — failure-episode detection, classification, accumulation, apply.
- `lib/claude.js` — export a stateless JSON `analyze()` (today `firstJsonObject`/
  `runTurn` are internal, not exported; Phase 2 adds the export).
- `lib/versions.js` — stamp each AI snapshot with the voice that produced it, so
  attribution is a lookup, not a guess.
- `lib/docs.js` — per-doc voice (done).
- `server.js` — routes for propose/apply, voice CRUD, the feedback channel.
- `public/*` — Voice tab + ambient badge; a **generic** review surface (the Mail gate is
  wired to Mail state and is not directly reusable).

## 11. Scope

**v1:** Phase 1 (done); learn-from-edits on demand with the classifier, failure-episode
guard, and process-feedback routing; the review gate (suggest-only); the cold-start docs
importer; the Voice tab + ambient badge. **Next:** sent-mail then WhatsApp importers;
baseline promotion; auto-nudge; decay. **Later/experimental:** taste; OAuth imports;
auto-apply.

**Out of scope:** sharing/selling a voice (marketplace, separate); cross-user blending;
any upload of raw personal corpora.

## 12. Decisions (locked 2026-06-08)

1. **Voice file format:** two files; `voice.json` **authoritative** for rules + metadata;
   SKILL.md = human preamble + regenerated read-only learned block (portability mirror).
2. **Voice selection:** per-document, with a default (Phase 1, done).
3. **When the loop runs:** on-demand in v1; quiet auto-nudge later.
4. **Apply policy:** suggest-only in v1; everything through the gate.
5. **Raw corpus retention:** distil-and-discard for sensitive sources, with **no verbatim
   evidence** persisted for them; keep-locally only for the user's own authored docs.
6. **Taste signals:** file-import, low weight, voice-only, experimental, deferred.
7. **Trust boundary:** the learn pass uses the user's own `claude` CLI (Anthropic, own
   subscription); no other third party; redact others' PII from chat/mail first.
8. **Classification (resolved before the learn pipeline, per the review):** a heuristic
   pre-filter drops noise (whitespace/typo/tiny/reorder); then one batched Claude pass
   on **Haiku** (classification, not creative), capped (~40 diffs, "and N more"
   surfaced). On-demand.
9. **Dedup (resolved before the learn pipeline):** normalized-text match plus a
   model judgment **inside the same classification pass** (it sees existing rules and
   tags "matches r_X" or "new"). **No embeddings dependency in v1.**
10. **Attribution:** each AI snapshot stores the voice that produced it; edits teach that
    voice. Mid-document voice switching is therefore a lookup, not a guess.
11. **Confidence:** rises only on **independent cross-document corroboration**; retry
    chains collapse to one observation and never add confidence.
12. **Conflict + budget:** within a layer, higher confidence wins, then recency. Over the
    token budget, prefer **merging/summarizing** clustered rules over hard-dropping;
    trimming is deterministic and shown in the Voice tab so a dropped rule is never silent.
13. **Decay (still deferred to a later phase):** contradiction detection and confidence
    decay land with the context phase, not the v1 learn pipeline.
