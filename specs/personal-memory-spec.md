# doc-editor: Personal Memory Spec (the context layer)

*Status: draft for review, open questions at the end need your decisions before design/implementation. Resolves the deferred Q4 ("context representation and use") of [`personalization-spec.md`](personalization-spec.md), and fixes the context-loss bug found on the "Bali" doc. Inspired by OpenClaw's `USER.md` + `memory/` model. All examples here are anonymized (no personal data in specs).*

## 1. What it is, and why

When the user plans a document in conversation and says durable things about themselves ("I went on this trip with my spouse and child"), two different kinds of context are in play:

- **Durable facts about the user and their world** — who their family is, where they work, languages they speak, recurring places, tastes. These are true beyond this one document.
- **Document-specific context** — this trip's itinerary, this email's specific ask. True only for this artifact.

Today both are funneled into a single, lossy `compileBrief` summary and then largely dropped (see section 2). The fix is not to stuff everything into one document's prompt. It is to **put durable facts into a personal memory the writer can draw on across documents**, and to **preserve document-specific context on the document itself**. The personal memory is the "what is true about me" layer, the counterpart to the voice layer's "how I write." This is the same idea as OpenClaw's `USER.md`: a curated, user-owned profile the assistant reads before acting.

## 2. The bug this fixes (evidence)

On the Bali doc, the user stated in the planning conversation who travelled (spouse and child). The flow compressed the whole conversation into a brief whose `summary` literally said *"specific trip details … still need to be supplied"*, dropped the actual people into a generic key-point ("who went and how long"), stored **no transcript** on the doc, and generated only from the distilled brief. The writer never saw the facts, so it **fabricated** travellers. The user's own correction nailed it: *"the summary of the initial conversation did not get carried over to the prompt."* Personal memory plus on-doc context preservation removes both failure modes: the facts persist globally and are available to ground generation.

## 3. The memory model

Inspired by OpenClaw, adapted to a writing tool. Tiers:

- **The profile (`USER.md`)** — a curated, sectioned "about me": identity, the people in the user's life (relationships, names), work, languages, durable preferences, and **privacy boundaries** (section 7). Small, always relevant, human-editable.
- **Topical files** — focused stores for areas that grow: e.g. film and music taste, travel, reading. (OpenClaw already has film/music taste files; these double as the "taste signals" from the personalization spec.)
- **A long-term journal / log — deferred, its own surface.** A private space to confide intimate thoughts is valuable to the loop, but it deserves its own carefully-handled tab, not a bolt-on to the writing memory. It is **out of v1 scope**: intimate content needs a higher privacy bar, and journaling implies mobile access (a parallel track). Design intent for later: **do not reinvent Obsidian; do the things Obsidian cannot** (the memory/voice loop, writing that draws on it). v1 captures durable *facts*, not a journal.

**Location (decided): one portable source of truth, projected to `~/.claude/`.** The canonical store is a **tool-neutral, user-owned profile in open formats** (plain Markdown + a small JSON manifest) at a configurable path **outside the doc-editor git repo** (privacy + portability) — the user's portable profile, takeable to any tool or model. The doc-editor manages it and **projects it into `~/.claude/`** (symlink preferred, copy as fallback) so every Claude Code instance benefits with no duplication and no split-brain. Anti-lock-in comes from the open format + user ownership + a neutral canonical location, not the directory name; `~/.claude/` is a convenience projection for Claude tooling, not the lock. Seed once from the existing OpenClaw memory; **no write-back to OpenClaw** (one-time source, not a sync target).

## 4. What goes where

- **Durable user/world facts** (family, employer, languages, recurring places, tastes) → personal memory. Long-lived, reused across documents.
- **Document-specific context** (this conversation's specifics, this email's ask) → stored **on the document** (`meta.intake` transcript): included **verbatim into generation** (the Bali fix) and as a **distilled summary into revise** (never the raw transcript — keeps surgical find/replace reliable). Transient; not global. (Hybrid C, #7.)

Both are needed. Memory alone would not capture a one-off itinerary; on-doc context alone would re-lose the family every new document. Together, nothing is dropped.

## 5. Capture (consented, suggest-only)

Facts reach memory the same way voice rules do, through the learn pipeline and the review gate:

- During an intake conversation, from edits, or from an import, the classifier proposes durable facts as **context candidates** (it already separates voice / context / correction / noise).
- A **context candidate that is durable and about the user/world** is offered for memory ("Remember: the user's household is …"), distinct from a doc-specific detail.
- **Nothing is written to memory without the user keeping it** (suggest-only). Memory is as legible and prunable as the voice store; one-click forget.

## 6. Use in writing (retrieval, grounding, audience-aware)

- **A small always-on core** (the `USER.md` essentials) plus **retrieval of relevant topical facts per document** (by topic/recipients), so a large memory does not bloat every prompt. [resolves personalization Q4]
- **Grounding first.** Memory's primary job at generation time is to stop the writer from inventing (the Bali failure) and to supply facts the request actually needs.
- **Audience-aware, do not volunteer.** This is the crux (section 7): the writer may *use* a known fact when the piece calls for it, but must not **leak** private facts into a shared output just because it knows them.
- **Transparent per request, low-friction.** Before each draft, the Profile tab shows a compact, expandable summary of exactly what this draft will use (active voice, retrieved memory facts, doc-specific context). Shown, not blocking; editable inline or via the tab's chat box.

## 7. Privacy and the leakage guardrail (the hard part)

Unlike OpenClaw's assistant context, a doc-editor **output can be public** (a blog post, an email to a stranger). So "load the memory" is not the risk; "what reaches the artifact" is.

- **Default to grounding, not volunteering.** Memory prevents fabrication and answers what the user asked; it does not insert private facts (names, household details, locations) into an output unless the document plainly calls for them. A personal blog may name the family; a cold work email must not. A **per-document "may use personal facts in the output" control** lets the user decide explicitly.
- **Input-transparency is not output-safety.** Showing the user what is *sent* to the model (the Profile tab) is necessary but not sufficient: a private fact can legitimately be in the prompt to ground the draft yet must not appear in a shared output. The Profile tab governs what goes in and what is remembered; the grounding/don't-volunteer rule and the per-document output control govern what comes out.
- **Privacy boundaries in the profile**, like OpenClaw's: hard "never put X in an output" rules the writer must honor.
- **Local only.** Memory lives on the user's machine, is gitignored, and only ever travels through the user's own Claude calls (the same trust boundary as the rest of the app). No third party, no new key.
- **Heavier privacy machinery is deferred with the journal.** Per-item sensitivity tiers (governing what may be sent to the cloud model at all) and a bring-your-own-model endpoint (AWS Bedrock in the user's account, or a local model) matter most once intimate journaling lands. For v1's durable facts (family, tastes), the consent gate plus the grounding/leakage rules above suffice. Keep the model endpoint a configurable **seam** now so BYO-model is cheap to add later (also the vision's hedge against platform dependence).
- **Consent and forget.** Every fact is reviewed before it is stored, visible in the memory surface, and removable.
- The **"no personal information in specs" rule still holds**: memory is the user's own private store and may hold real names; specs and shared docs must not.

## 8. Relationship to the rest of the system

- **Voice store** ("how I write") and **personal memory** ("what is true about me") are siblings. The learn pipeline routes: voice → voice store, durable context → personal memory, doc-specific context → the doc, Claude-corrections → the feedback channel.
- This **resolves personalization Q4** (context representation: a `USER.md`-style profile + topical files, retrieved per doc).
- It is the proper home for the **taste signals** the personalization spec deferred (film/music files).

## 9. Seeding from existing memory (deferred)

v1 **starts from zero and learns from day one**; seeding is explicitly out of scope. The user has a rich OpenClaw memory (`USER.md`, film/music taste files) that could seed the profile later, via an **out-of-band onboarding step**. When built, the likely shape is **import-and-curate** (not in-place reuse, not a blind copy), one-time, with no write-back to OpenClaw.

## 10. Open questions (need your decisions)

1. **Where does memory live? (Decided.)** One **portable source of truth** in open formats at a neutral, user-owned path *outside* the repo, **projected (symlink/copy) into `~/.claude/`** so all Claude instances benefit — portable and not locked in. One-time import from OpenClaw; no write-back. (Sub-decisions for design: exact default path; symlink vs copy.)
2. **The leakage guardrail. (Decided: transparency + control + low friction.)** A **Profile tab** (unified with the personalization spec's Voice tab — one inspectable home for "what the tool knows about you": voice + memory) shows, per new document, a compact/expandable view of **what will be sent** (active voice, retrieved memory facts, doc-specific context), with a **chat box** to add/edit/correct in natural language. **Consent without friction:** "Let's talk about it" context is used for *that* document immediately (transient, per-doc) but is **not promoted to permanent memory** until kept; newly-acquired items wait in an **"Unsaved memory & context"** section with their **provenance**, to keep or discard at leisure — separating *use now* (frictionless) from *remember forever* (consented). And because input-transparency is not output-safety: the **ground-but-don't-volunteer default** plus a **per-document "may use personal facts in the output" control** govern what reaches a sharable artifact.
3. **Capture trigger. (Decided: no in-flow proposals.)** Document creation is never interrupted to confirm memory. Context is acquired passively and surfaced in the Profile tab's "Unsaved memory & context" queue (per #2) to keep or discard at leisure; used transiently for the doc immediately, promoted to permanent memory only on keep. No "remember this?" prompts in the creation flow.
4. **Tiers for v1. (Decided: journal DEFERRED.)** v1 is the curated `USER.md` profile + topical files only. The journal is its own future surface: separate tab, higher privacy bar, needs mobile, parallel track; do not reinvent Obsidian, do what it can't.
9. **(Deferred, with the journal) Privacy tiers + BYO-model.** Per-item sensitivity governing what may be sent to the cloud model, and a configurable endpoint (Bedrock / local) for intimate content. Not needed for v1's durable facts; just design the model endpoint as a seam now.
5. **Retrieval. (Decided.)** A small always-on core plus retrieval of only the memory relevant to the document being created. Do not flood each request with unnecessary context; keep prompts lean.
6. **Seeding. (Decided: deferred.)** v1 starts from zero and learns from day one. Seeding/onboarding (e.g. importing from OpenClaw) is out-of-band and a later concern, not in v1.
7. **Doc-specific context fix scope. (Decided: hybrid C.)** Store the raw intake transcript on the doc (inspectable, recoverable, re-distillable) and feed it **verbatim into the generation prompt** (where the facts must land and there is no JSON-mode risk — this is the direct Bali fix). For the stateless **revise** path, feed a **distilled, inspectable summary, never the raw transcript** (the context-spectrum note's hard finding: raw conversational context broke structured find/replace edits). Durable facts additionally promote to memory via #2/#3.
8. **Sharing across instances. (Decided via #1.)** Read-shared through the `~/.claude/` projection so all Claude instances benefit; the doc-editor is the writer for v1. Cross-instance *write* is deferred.

## 11. Scope (proposed v1, pending the answers above)

**In:** a global, curated `USER.md` profile + topical files; **passive** capture of durable facts into the Profile tab's keep/discard queue (no in-flow prompts); a small always-on core + per-doc relevance retrieval into the generate prompt with the grounding/leakage guardrail; on-doc preservation of the intake transcript (verbatim into generation, distilled summary into revise).
**Out / later:** **seeding / onboarding** (v1 starts from zero; any import is out-of-band, later); the long-term **journal** (its own tab, higher privacy bar, mobile, parallel track; do what Obsidian can't); per-item sensitivity tiers + bring-your-own-model endpoint (land with the journal; keep the endpoint a seam now); cross-instance write; automatic (un-reviewed) memory updates; fine-grained per-recipient policies.

**The problem v1 actually solves:** durable facts the user states (who their family is, that they took a trip) are preserved in a personal memory and used to ground writing, so context is never lost (the Bali bug) and never fabricated. Nothing more. The journal, mobile, and BYO-model are separate, later tracks.
