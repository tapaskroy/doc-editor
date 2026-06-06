# How much of my context should the editor have?

_A **doc-editor** design note on conversational / context memory: how much of the
user's context the editor should carry to do the best possible job as their editor.
Status: **design only — to align on.** Implement **after** the Output /
publishing-skills feature ships. No code beyond this note. Builds on
[`architecture.md`](architecture.md), the **Conversation memory** decision in
[`../CLAUDE.md`](../CLAUDE.md), and the cross-surface `threadSummary` pattern in
[`mail-design.md`](mail-design.md) §6._

## 1. The question

> **"How much of my context should the doc editor have in order to do the best job
> to act as my editor?"**

That is the whole note. Everything below is an attempt to answer it honestly: to
name the levels of context the editor could have, what it costs to have them, and
what we should build (later) so the editor knows roughly what a good human editor
you briefed would know, and no more.

## 2. Why this matters, and why now

The editor's Claude and the CLI's Claude are **two different Claudes.**

When you draft a document at the `claude` CLI, the model carries the *whole
conversation* that shaped it: the reasoning, the alternatives you considered and
rejected, your stated intent, the constraints you discovered along the way, your
standing preferences. That conversation **is** most of the editorial context. It is
the difference between "fix this sentence" and "fix this sentence in a way that
respects the three decisions we just made about who this is for."

The doc-editor revise call is **stateless by design** (see `CLAUDE.md`,
"Conversation memory"). It runs `claude -p --output-format json`, asks for a JSON
object of find/replace edits, and is fed only:

- the **document text** (the source of truth), and
- the doc's **`history`** array: the premise (turn 0) plus every prior revision
  *instruction* ("make it shorter", "warmer tone").

It does **not** see the discussion that produced the document. So the editor, by
construction, **cannot continue the conversation that created the doc.** It can
splice text; it cannot reason about *why* the text is the way it is unless that
"why" was typed into a revision instruction.

A concrete, live example. The user was reviewing an "Output Skills" spec with the
CLI and realized: if they now switch to the editor to refine it, the editor-Claude
loses all the reasoning just built up. The spec on disk is the *output* of a long
think; the think itself stays in the CLI session and never crosses over. The
better the editor knows the user's intent, the document's purpose, the decisions
behind it, and the user's standing preferences, the better an editor it can be.

But context is not free. The same long conversational context is *exactly* what
the stateless-revise decision was made to avoid (§5). So this is a real design
question with real tension, not an obvious "give it everything."

## 3. A context spectrum

Least to most context. Each level is "the previous one, plus."

### L0 — the document text alone
What a revise call could see at minimum: the bytes on the page. Enough to fix a
typo; blind to intent.

### L1 — + the doc's revision history *(exists today)*
The premise and the running list of revision instructions, fed back as context on
every revise (`history`-as-context). This is real memory of *what was asked*, and
it already carries facts stated only in the premise. It is terse and
instruction-shaped: it remembers "make section 2 punchier," not the conversation
that decided section 2 should exist.

### L2 — + the shaping discussion / decisions: the "why" *(the gap)*
The reasoning behind the document. The alternatives weighed and rejected, the open
questions, the *decisions* and their rationale. **Not captured today.** This is the
gap the central question is really pointing at. L1 knows the edits you requested;
L2 would know the *thinking* that makes those edits make sense, the thing the CLI
Claude has and the editor Claude does not.

### L3 — + user-level standing context
Who you are, your voice and recurring preferences, your default audience and tone,
your hard rules. **Partially present today** but scattered: the em-dash ban and the
common-AI-tic avoid-list live in `ANTI_TIC_NOTE`; voice lives in the selected
**voice/style skill** (`styleNote`). These are real standing preferences, but they
are not unified, not per-user *memory*, and (for style) sent as a global picker
rather than remembered.

### L4 — + related corpus
Your other documents, the mailbox, linked sources. Retrieval / RAG territory:
context the editor *fetches* rather than *holds*. Powerful and the furthest out.

| Level | Content | Status today |
|------|---------|--------------|
| L0 | document text | implicit minimum |
| L1 | + revision history (premise + instructions) | **built** (history-as-context) |
| L2 | + shaping discussion, decisions, rejected alternatives | **missing** (the gap) |
| L3 | + user voice / standing preferences / defaults | **partial** (anti-tic + voice skills, not unified) |
| L4 | + related corpus (docs, mail, links) | not built (RAG) |

## 4. The "Let's talk about it first" precedent

We already have a working proof that *distilled* context can shape generation
invisibly and well: the **brief**. The `#/brief` intake interviews the user, then
`compileBrief` produces a structured object
(`{title, summary, audience, purpose, tone, targetWords, keyPoints, structure}`)
stored on the doc, and generation runs from `briefToPrompt(brief)` instead of the
bare premise. The user never sees the brief drive the draft; they just get a more
targeted document.

That is L2-flavored context, captured *before* the doc exists and applied to the
first draft. The open move this note proposes is to extend the same idea **past the
first draft, into every revise**, and to broaden what counts as context.

## 5. The trade-offs of "more context"

More context is not strictly better. Concretely:

- **Editing quality & consistency vs. token cost.** More context means more
  faithful, more consistent edits, and more tokens on every call. doc-editor
  already pays a baseline per call (mostly system-prompt cache-creation); piling a
  transcript on top multiplies it. (Recall the load-bearing lesson in `CLAUDE.md`:
  running in the project cwd dragged the whole `CLAUDE.md` into every call and
  inflated cost 7-23x. Context bloat is a known, measured failure mode here.)

- **Drift / reliability — the central risk.** This is the one that already bit us.
  The revise path is stateless *on purpose*: when the call was primed with the
  conversation (via the CLI's native `--resume`), conversationally-phrased context
  reliably pulled the model **out of clean JSON-edit mode** and broke structured
  output. So naively dumping the whole conversation into a revise call is exactly
  the mistake the current design avoids. Any L2 mechanism has to feed context as a
  **distilled summary, not a raw transcript**, or it will reintroduce that drift.

- **Staleness.** Wrong or old context is worse than none. A "decision" that was
  later reversed, fed forward forever, makes the editor confidently wrong. Captured
  context needs a freshness story.

- **Privacy.** Pulling in user-level memory or a related corpus widens what each
  call sees. This is a local, single-user tool, which softens it, but "which of my
  things does this edit get to read" should still be a deliberate, inspectable
  choice, not an accident.

- **The "whose intent" problem.** Context lives at different scopes: **per-document**
  (this doc's decisions), **user-global** (your standing preferences), and
  **shared / cross-surface** (memory the CLI can also read). These are not the same
  thing and should not be conflated into one bucket.

## 6. Mechanisms (options, mapped to the levels)

Described as options with trade-offs, not a single prescribed winner.

- **Per-doc invisible context fed to every revise (L2).** Generalize the existing
  `brief` field into a standing per-doc context object that rides along on *every*
  revise call, not just first-draft generation. Cheap to reach (the seam exists);
  the question is what fills it and how it stays fresh.

- **A durable per-doc decision / conversation log (L2).** Distinct from the terse
  revision-instruction `history`: a record of the *reasoning and decisions* (the
  rejected alternatives, the open questions). Could be auto-summarized from a
  session or explicitly authored. Heavier to maintain; closest to closing the gap.

- **Cross-surface shared memory (L2/L3).** This is **the Mail Phase-6
  `threadSummary` pattern, generalized to all docs.** In `mail-design.md` §6 each
  mail thread keeps a compact `threadSummary` (purpose, connections, key decisions)
  persisted **where the `claude` CLI can also read it**, so a normal CLI
  conversation can draw on it. The exact same primitive, applied per document,
  gives a compact, inspectable per-doc memory that **both** the editor's revise
  calls **and** a standalone CLI session can read. Say it plainly: *the thing this
  note proposes is the doc-wide version of `threadSummary`.* It is the natural
  bridge between the two Claudes of §2.

- **User-level memory / standing preferences (L3).** Make the em-dash rule, the
  voice, and the default audience/tone a **first-class, unified** user memory,
  rather than scattering them across `ANTI_TIC_NOTE` (hard-coded baseline) and the
  per-request voice-skill picker. Connects to the existing "per-doc voice memory"
  idea in `CLAUDE.md`'s ideas list, but aims higher: one place that answers "how
  does this user like to write."

- **Comment persistence — the missing link (enabling mechanism).** Today comments
  the user adds in the editor but does **not** "Send to Claude" are **not
  persisted**, and cannot be read by a separate Claude (CLI) session. (Logged as an
  app-wide enhancement during the Mail work; see `mail-design.md` §15, "Comments as
  durable annotations.") Persisting anchored comments unlocks the ideal hybrid
  loop: **you annotate precisely in the editor** (notes pinned to specific
  passages), and a **full-context Claude** (CLI or otherwise) reads those
  annotations and revises with the whole picture. This is the keystone that turns
  "annotate here, lose context there" into one continuous workflow.

## 7. Open questions (to resolve before building)

- **How is context captured?** Auto-summarized by Claude from a session, or
  explicitly authored by the user? (Auto is low-effort but can drift; explicit is
  accurate but a chore. Likely both: auto-draft, user-editable.)
- **Where does it live?** Per-doc (`meta.json` / a sidecar), user-global, or a
  shared store the CLI also reads? The `threadSummary` precedent argues for a
  CLI-readable location for at least the shared slice.
- **How is it kept fresh?** What invalidates a captured decision when the document
  moves on? Re-summarize on major revisions? Let the user prune?
- **How does it coexist with stateless-revise reliability?** The answer must be
  **summary-as-context, never raw transcript** (§5). The distilled-brief shape is
  the safe template.
- **Invisible vs. inspectable?** Strong recommendation: context should be
  **inspectable and editable, not a black box.** If the editor is acting on a
  remembered "decision," the user should be able to see it, correct it, and delete
  it. A wrong invisible memory is the worst outcome (§5, staleness). Make it a
  panel, not a secret.

## 8. Guiding principle & recommendation

> The editor should know roughly what **a good human editor you briefed** would
> know: the document, its purpose and the decisions behind it, and your standing
> preferences. And no more. That context should be **explicit and inspectable**,
> and fed as a **distilled summary, not a raw transcript**, to preserve the
> reliability of surgical find/replace edits.

A layered rollout follows directly from the spectrum:

1. **L0-L1 — done.** Document text plus history-as-context already work.
2. **Next: L2 + L3.** Add a per-doc decision/context object (the generalized
   `brief` / `threadSummary`) that rides on every revise, plus a unified user-level
   preference memory. Pair both with **comment persistence** so annotation and
   revision become one loop. Keep all of it inspectable and editable.
3. **Later: L4.** Corpus retrieval (other docs, mail, links) once the per-doc and
   per-user layers prove their value.

## 9. Sequencing

This is a **design note to align on.** Nothing here is built yet, and
**implementation is deferred until after the Output / publishing-skills feature
ships.** When we pick it up, L2 + L3 + comment persistence are the first
increment, the `threadSummary` pattern is the model to copy, and "distilled,
inspectable summary, never raw transcript" is the constraint that keeps surgical
edits reliable.
