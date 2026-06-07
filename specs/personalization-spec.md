# doc-editor: Personalization Spec (Voice and Context Learning)

*Status: design, with the spec-level decisions **locked 2026-06-07** (see section 12). The engine behind the flywheel in [`vision.md`](vision.md). Architecture in the companion [`personalization-design.md`](../design/personalization-design.md). Builds on the existing voice-skill mechanism (`lib/skills.js`, the Style picker) and reuses the consented review-gate pattern from Mail and publishing.*

## 1. What it is, and why

The vision is to **bring the person to the AI**: the user keeps teaching the tool
who they are, so it shows up in their writing. This spec defines the machinery that
makes that real, in three parts:

1. **Learn from my edits** — mine the difference between what Claude drafted and what
   the user kept, and turn it into durable, reviewable lessons (section 4).
2. **Bring my context** — let the user seed and refine a voice from material they
   already have: past writing, sent email, chat exports, even taste signals from
   Netflix or Spotify (section 5).
3. **Many voices, mine to manage** — a voice is a living, user-owned, read-write,
   portable profile; the user keeps several and picks one per document (sections 3,
   7, 8).

The point that ties these together: **a voice is not read-only to the editor.** The
editor both reads it (to generate) and writes to it (to learn), and so does the
user, from many sources. It is an asset that compounds and that the user owns.

## 2. Two layers: voice and context

Two assets compound differently and are kept separate:

- **Voice** — how the user writes: cadence, diction, sentence rhythm, the tics they
  cut, the words they reach for, their sensibility. Converges fast.
- **Context** — what the user knows: their people, projects, facts, history,
  preferences. Grows without bound. The deeper long-term moat and the heavier
  privacy responsibility.

A single edit or import can feed both (cutting "utilize" to "use" is voice;
correcting a colleague's name is context). The pipeline classifies each signal and
routes it to the right layer.

## 3. A voice is a living, multi-source, user-owned profile

A voice is a managed, read-write profile that:

- shows in the Style dropdown by name; the user can **create, name, clone, edit, set
  default, and delete** voices (section 7);
- is fed by several inputs: explicit authored rules, lessons learned from edits, and
  imported corpora (section 5);
- carries **provenance and confidence** for each learned rule, so it is auditable
  and can decay or be corrected;
- stays a plain, human-legible, **portable** artifact: a normal Claude Code skill
  usable by other Claude Code instances and other surfaces (Mail, the CLI), not
  locked inside this app.

## 4. The learn-from-my-edits loop (the engine)

The signal we capture today but do not use: the **diff** between Claude's draft and
what the user kept. Version history already snapshots this; comments record intent.

The loop, in five steps:

1. **Capture.** Already exists: each revision and inline-edit burst is snapshotted in
   version history; comments record the user's stated intent. No new capture needed.
2. **Classify.** Sort each diff into *style* (voice), *fact/preference* (context), or
   *one-off* (ignore). Typo and reordering noise is filtered out.
3. **Infer candidates.** A batched Claude pass over recent diffs proposes
   *generalizable* lessons, each as `{observation, evidence: [diffs], target:
   voice|context, proposedEdit, confidence}`. Example: "you consistently cut 'really'
   and 'very'"; "you call the company 'the firm', not its legal name."
4. **Review (the gate).** Present candidates with their evidence: *keep / edit /
   dismiss*. Approved lessons are written into the active voice (or the context
   store). Legible and reversible.
5. **Apply and compound.** The voice profile is updated; the next draft uses it.
   Provenance links each rule to the edits that produced it, so the user can audit,
   and rules can **decay** when later contradicted.

Design rules:

- **Batch, not realtime.** The loop runs on demand in v1 ("Refine this voice from my
  recent edits"); computation may happen in the background, but nothing is surfaced
  unprompted (section 12, decision 3).
- **Attribution.** Edits made while voice = X teach voice X (per-document voice,
  decision 2). Editing with no voice selected teaches the default voice.
- **Anti-over-fit.** A lesson needs supporting evidence for high confidence;
  single-instance observations stay low-confidence suggestions, not applied.
  Confidence rises with repetition and falls when contradicted. The user can always
  delete or override a rule. **v1 is suggest-only: nothing is baked in without
  confirmation** (decision 4).

## 5. Bring my context (importers)

The user can seed a new voice (the cold-start magic moment) or enrich an existing one
from material they already have. Each source is an **importer** that produces
evidence in the shared candidate shape, runs through the same review gate, and is
baked into a chosen voice or the context layer.

Sources and what they feed:

- **Past authored documents** (a folder or pasted samples). The richest voice signal
  and the primary cold-start path: point at your old writing, get a drafted voice in
  minutes, review it.
- **Sent email** (the Mail connection already exists). Your professional register,
  from your own sent folder.
- **Chat exports (WhatsApp and similar).** A casual-register voice. The importer keeps
  only the user's own messages and never learns other participants' content or PII.
- **Taste signals (Netflix, Spotify).** A softer **persona** signal, not facts. Genres
  and themes inform tone and the kind of allusions the person reaches for. Imported
  from the platforms' own data-export files, low weight, voice-only, and clearly
  experimental (decision 6). Never used to assert facts.

Importers are one-shot or refreshable, and every import is reviewed before it changes
a voice. Raw corpora are processed locally and **distilled then discarded** by default
for chats and email; the user may opt to keep their own authored documents locally for
re-analysis (decision 5). Nothing is uploaded.

## 6. The review gate (consent and legibility)

Every change to a voice or the context layer, whether from edits or imports, passes
through one confirm surface, mirroring the Mail and publish gates:

- what was observed, in plain language;
- the evidence (the specific diffs or source excerpts), so it is never a black box;
- the exact change to the voice or context, editable inline;
- confidence, and whether it is being applied or only suggested;
- *keep / edit / dismiss*, and later *forget*, since every rule keeps its provenance.

This is the line between the flywheel and creepy personalization, and it doubles as
the over-fitting guard.

## 7. Many voices (the dropdown)

- The Style dropdown is the quick picker; the Voice tab (section 8) is its management
  home: create, name, clone/branch, edit, set default, delete.
- Voices are specialized by use, for example Blog, WhatsApp-casual, Exec-memo,
  LinkedIn. Each learns independently from edits made under it and from the sources the
  user routes to it.
- **Per-document attribution.** A document remembers which voice produced it (stored on
  the doc), so learning attributes to the right voice. There is a default voice for new
  documents (decision 2).
- **Baseline plus layer.** A global baseline (the existing anti-tic rule, no em dashes,
  precision) applies under every voice; each voice layers its own rules on top. The user
  can **promote** a learned rule to the global baseline.

## 8. Awareness and the Voice tab

The personalization loop must be felt, not buried in settings. Two layers work together
(the principle: **awareness pulls you to the tab; the tab is where you decide**).

**Layer 1, ambient, where the work happens.** Awareness does not depend on the user
remembering to visit a tab. Right after editing, a quiet, dismissible signal lives in
the editor: a small "Voice: N new observations" badge, never an interrupting popup.
Optionally a tiny inline acknowledgment tied to the actual edit ("noted: you cut
'utilize'"). The learning must feel connected to the edit that caused it.

**Layer 2, the Voice tab, a mirror and not a form.** A dedicated space beside Docs and
Mail. Opening it, Claude summarizes in plain language what it has noticed lately, then
lists the proposals with *keep / edit / dismiss*. What makes it trustworthy and worth
visiting:

1. **Show the evidence, never just the claim.** Each proposal shows the real
   before-and-after that produced it ("you made this change 4 times"). It is a mirror of
   the user's own edits, which is what keeps it from feeling like surveillance.
2. **Augment or create, and let Claude propose the split.** When new lessons cohere with
   an existing voice, the tab offers to augment it. When they cluster as a different
   register (casual edits drifting from the Blog voice), Claude proposes "this looks like
   a different voice, want to start 'Casual'?" The tool noticing the user has more than
   one voice is a feature, not an accident.
3. **Two sections: Voice and About-me (context).** The context side ("here is what I
   believe I know about you: projects, people, preferences") needs even more visibility
   and a one-click *forget*, because that is where the privacy weight sits.
4. **Total control, shown plainly.** Edit any rule, delete it, see its provenance and
   confidence, undo. Nothing applied without consent (decision 4).

**Cadence: a digest, not a stream.** "After a burst of writing, or weekly, here is what I
learned." Substantial visits, never nagging.

## 9. Voice file format (read-write, portable, legible)

The artifact stays a normal, human-readable skill, made safely machine-updatable
(decision 1, two files):

- `SKILL.md` is the human-authored, prompt-injected file: a preamble the user writes,
  plus a managed **Learned rules** section the loop maintains. This is the **portable**
  artifact other Claude Code instances read.
- `voice.json` holds metadata the prose should not carry: per-rule confidence,
  provenance (which edits or sources), timestamps, decay state, status (active or
  suggested), and source registrations.
- What gets injected into the writing prompt is the preamble plus the **active,
  high-confidence** learned rules. Low-confidence items wait in `voice.json` as
  suggestions until they earn their way in or are dismissed.

## 10. Privacy

- All corpora (documents, chat exports, sent mail, taste exports) are processed locally
  or through the user's own model. Nothing is uploaded beyond the Claude calls the user's
  own subscription already makes.
- **Distil and discard by default** for chats and email; keep-locally is opt-in and only
  for the user's own authored documents (decision 5). The durable artifact is the set of
  distilled, user-approved rules.
- Chat and email importers must avoid learning other people's content and PII.
- Consent gates every change. The more the tool knows the person, the higher the bar.

## 11. Where this touches the code

- `lib/skills.js` — extend from "list and read voices" to voice CRUD, structured read
  (preamble plus active learned rules), and the composed prompt injection.
- `lib/learn.js` (new) — diff sampling, classification, candidate inference (the batched
  Claude pass), accumulation, apply, decay.
- `lib/importers/*` (new) — one module per source (docs, sent-mail, whatsapp, netflix,
  spotify), each producing evidence in the shared candidate shape.
- `lib/docs.js` — store the per-document voice id on the doc meta.
- `server.js` — routes: voice CRUD, propose-lessons (from edits or an import), apply or
  dismiss, set per-doc voice.
- `public/*` — a **Voice tab** (manage voices, run imports, review proposals, see the
  About-me context) reachable beside Docs and Mail, plus the ambient editor badge; reuse
  the review-gate modal. The Style dropdown links into the tab.
- Reuses version history (`lib/versions.js`) as the edit-diff source.

## 12. Decisions (locked 2026-06-07)

1. **Voice format: two files.** `SKILL.md` (human, portable, prompt-injected) plus
   `voice.json` (confidence, provenance, decay, status). Keeps prose clean and makes the
   anti-over-fit machinery possible.
2. **Voice selection: per-document, with a default.** Each doc remembers its voice, so
   learning attributes correctly and the tool matches how people actually write.
3. **When the loop runs: on-demand in v1.** Compute in the background, surface only when
   asked; add a quiet automatic nudge later once quality is trusted.
4. **Apply policy: suggest-only in v1.** Everything through the gate; no silent
   auto-apply. Revisit high-confidence auto-apply (with visible logging and undo) later.
5. **Raw corpus retention: distil and discard by default.** Discard chats and email after
   extracting rules; keep-locally is opt-in and only for the user's own authored docs.
   Never uploaded.
6. **Taste signals: file-import, low weight, voice-only, experimental.** Data-export files
   first (no OAuth), lowest priority, never factual.

## 13. Scope

**v1:** cold-start a voice from pasted samples or a folder of past docs; learn from recent
edits on demand with the review gate; per-document voice with create/edit/clone/default/
delete; the sent-mail importer (Mail already exists); the Voice tab with the ambient
editor badge. Everything consented and suggest-only.

**Next:** WhatsApp importer; promotion of rules to the global baseline; the quiet automatic
nudge after N edits; decay tuning; the About-me context section maturing.

**Experimental / later:** Netflix and Spotify taste importers; OAuth-based imports;
confidence-based auto-apply.

**Out of scope:** sharing or selling a personal voice (that is the marketplace, separate);
cross-user voice blending; any upload of raw personal corpora.
