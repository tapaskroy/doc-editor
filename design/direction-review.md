# doc-editor: Direction Review & Roadmap

*A critical review of product direction and a prioritized build roadmap. This is a
**decision document**, not another design spec — when it conflicts with a feature
spec on sequencing or priority, this wins. Companion to [`vision.md`](../specs/vision.md).
Written 2026-06-08, against `main` after PR #4 (personal memory) merged.*

---

## TL;DR

The vision is right and unusually self-aware. The craftsmanship is high. But the
**build order is backwards relative to where the defensibility and the risk live.**
The team has shipped the spokes (publish, mail, context-memory) and even the
*machinery* of the voice loop — but the two things that actually determine whether
the flywheel ever spins are still missing:

1. **Proof that the loop produces signal a user wants** (the diff → keepable lesson
   assumption is unvalidated), and
2. **Cold-start** — a way to get a good voice from your *existing* writing, so a new
   user (or your beachhead friends) experiences value before they've done 50 edits
   inside the tool.

And the consent guarantee the whole moat rests on isn't yet true in the code.

The roadmap below reorders work around those facts.

## Where things actually stand (2026-06-08)

**Shipped and working:**
- Core editor: draft, surgical revise, inline edit, versions/undo, export.
- Mail: discovery-based provider-agnostic engine, fast cached inbox, draft save, review gate.
- Output skills: portable `plan`/`run` CLI contract, blog publish behind a gate.
- **Voice store** (`voicestore.js`): per-voice `voice.json` (rules + confidence + provenance) layered onto a skill, prompt composition.
- **Learn-from-edits loop** (`learn.js`): collect edit events from version history → classify → propose candidates → review/apply. Suggest-only. *This is the moat machinery, and it now exists in v1 form.*
- **Context memory** (`memory.js`, PR #4): `USER.md` + topic files, grounding, the leakage gate, the Profile tab, projection to `~/.claude`.

**Not built — and this is the gap that matters:**
- **Cold-start importers.** No `lib/importers`, no import route. The loop can only learn from edits made *inside the tool*. So the voice is only good after heavy in-tool use — the flywheel requires the flywheel to already be spinning. `personalization-spec` lists the docs importer in v1 scope; it isn't there.
- **Validated loop quality.** No evidence yet that `learn.propose` produces lessons a human keeps. The single biggest assumption in the whole thesis is untested.
- **Multi-voice management** (create/clone/name/default/delete as a first-class surface). Voices are still pre-existing skill folders.
- **A felt loop**: the ambient "new observations" badge and a Voice tab that's a mirror, not a form.

## The critique, sharpened

1. **The flywheel has machinery but no fuel and no proof.** Building `learn.js`
   before validating that edits yield keepable lessons, and before there's any way
   to seed a voice from existing writing, means the engine is installed in a car
   with an empty tank that no one has test-driven. Fuel (import) and proof
   (validation) are cheaper than what's already been built, and they gate
   everything.

2. **Context-memory is the least differentiated slice — frame it honestly.**
   `USER.md` + retrieval + grounding is the ChatGPT-memory / OpenClaw pattern (the
   spec credits OpenClaw). Incumbents ship this. PR #4 is a real **correctness fix**
   (stop fabricating — the "Bali" bug), and worth having, but it is table stakes,
   not moat. The moat is specifically *learning from your edits* and *portable
   user-owned voices*. Don't let memory's visible progress disguise that the
   differentiated work is the under-invested part.

3. **Consent is the product, and it isn't true yet.** The vision says
   consent-and-legibility is "the line between the flywheel and creepy
   personalization." PR #4's review flagged a `forget()` that tombstones the UI
   entry while the fact keeps grounding every draft, and a leakage toggle that
   desyncs from server truth. Those aren't ordinary bugs — they are the one promise
   the product cannot break. The correctness bar on the consent surface is higher
   than on any feature, because it *is* the moat.

4. **Thinking is outrunning building.** ~10 vision/spec/design docs, several
   circling the same question (`personal-memory-spec` exists to resolve a Q4 left by
   `personalization-spec`, which overlaps `editor-context-memory`). For a tool still
   validating its first non-author user, the ratio of spec-writing to
   validated-learning is inverted. Risk: a beautiful personalization cathedral built
   before confirming anyone changes behavior because of it.

## The roadmap

Sequenced by **risk retired per unit of work**, not by feature size. Each milestone
has an explicit purpose and, where it matters, a go/kill gate. Do them in order.

### M0 — Make consent true *(blocks everything; days)*
The trust layer must actually work before the product is allowed to claim it.
- `forget()` must forget: propagate the not-found case; never report success while a fact still grounds drafts.
- The leakage toggle must reflect server truth (revert/refetch on failure).
- A model/parse failure must not be silently indistinguishable from "no facts" (don't burn the run-once capture guard on a transient miss).
- Dedup capture against the canonical Markdown, not just the last proposal.

**Why first:** shipping a broken privacy promise under a "consented" banner poisons
the exact well the moat draws from.

### M1 — Validate the loop on yourself *(the riskiest assumption; ~1 week, mostly usage)*
Not a feature — an **experiment**. Dogfood `learn.propose` across 15–20 real
documents and measure: *what fraction of proposed lessons do you keep, and do the
kept ones feel like "yes, that's me"?*
- Instrument keep/edit/dismiss rates and surface them.
- **Go/kill gate:** if you aren't keeping a meaningful share of proposals (suggested
  bar: ≥~40%, and the keeps feel real), stop and fix the classifier/prefilter before
  building anything else. If the diff isn't keepable signal, the entire thesis is
  wrong and no downstream feature saves it.

**Why second:** it's the cheapest way to find out if the moat is real, and it needs
zero new surface area.

### M2 — Cold-start: import past writing into a voice *(the make-or-break for anyone but you; ~1–2 weeks)*
The "five-minute magic moment" the vision names as a top risk, and the only way a
new user gets value before grinding edits inside the tool.
- `lib/importers/docs.js`: point at a folder or paste samples → distilled candidate voice rules → the existing review gate → seed a named voice.
- Then `lib/importers/mail.js`: the sent-mail importer (Mail is already connected) for professional register.
- Distil-and-discard by default; consent gate on every import (already the locked policy).

**Why third:** without it the flywheel cannot spin from zero, so the beachhead
("the builder crowd," "the skill is the viral unit") never experiences the product.
This is the highest-leverage *growth* lever in the whole plan.

### M3 — Make the loop felt, and multi-voice real *(only worth it once M1 passes; ~1–2 weeks)*
Turn learning from a per-doc on-demand action into a visible, compounding asset.
- The ambient, dismissible "Voice: N new observations" badge in the editor.
- The Voice tab as a *mirror* (shows the before/after evidence behind each lesson), with create / clone / name / set-default / delete, per-doc attribution, and promote-to-baseline.

**Why here, not earlier:** a management UI for a loop that doesn't yet produce good
lessons is polish on sand. Gate it behind M1.

### M4 — Close the loop end-to-end *(small; the PR's own deferred follow-up)*
Route `learn`'s edit-derived **context** candidates to memory instead of the voice
store, so durable facts and voice rules flow through one pipeline into their correct
homes. Unifies the two assets the vision says must stay separate but coordinated.

### M5 — Breadth *(explicitly gated behind a working, fueled, validated loop)*
Only after M1–M4 compound: confidence decay tuning and high-confidence auto-apply
(with logging + undo); WhatsApp and taste importers; the journal track (its own tab,
higher privacy bar, mobile); the BYO-model endpoint seam. None of these move the
needle until the core loop is proven and fueled — defer hard.

## Cross-cutting (do alongside, cheap)

- **Instrument all Claude-call cost.** Mail read/refresh and `learn`/`memory` passes
  are billable `claude -p` calls that don't all show in the cost panel. For a tool
  whose signature value is cost transparency, that gap should close.
- **Freeze new specs until the loop is validated (M1).** There is more than enough
  design. The missing input is evidence, not documents.
- **Consolidate the context docs.** `personalization-spec`, `personal-memory-spec`,
  and `editor-context-memory` should collapse into one once the model is settled, to
  stop the cross-referencing drift.

## What to stop doing

- Building adjacent capabilities (more output targets, more mail polish, more memory
  tiers) while the loop is unvalidated and unfueled.
- Framing context-memory as "the flywheel." It's a correctness fix; the flywheel is
  the edit-learning + cold-start pair.
- Writing the next spec before M1 returns a number.

## The one-line version

The direction is right and the engine is now built — but it has no fuel
(cold-start import), no proof (loop validation), and the consent promise it runs on
isn't yet real. Fix consent, prove the loop, fuel it, *then* make it felt and broad.
In that order.
