# doc-editor: Vision and Strategy

*The north star and the competitive thesis. For what the tool does today see [`product-spec.md`](product-spec.md); for how output/publishing works see [`output-skills-spec.md`](output-skills-spec.md); for the engine that powers the flywheel (learn-from-edits plus bring-your-context) see [`personalization-spec.md`](personalization-spec.md).*

## The thesis: bring the person to the AI

doc-editor is not a document editor. The editor is the workbench in the middle.
The value lives at the two edges: a personal model of **how you write** going in,
and your finished, on-brand artifact going **out to the channel you actually use**.

The deeper idea underneath both edges: **bring the person to the AI.** Let the user
keep teaching the tool who they are, so it shows up in their writing, a little more
every day. Generic AI writing is a commodity. Writing that sounds like *you*,
because you taught it, is not.

## The flywheel (the moat)

```
initial voice  ->  better draft  ->  user edits / comments  ->  learn from the edits
       ^                                                                |
       |                                                          skillify (capture)
       +-----  voice + context get better  <-----  improved skills  <---+
```

Each turn of the loop makes the next draft need less editing, which earns the user's
trust to hand over more, which produces more signal to learn from. Usage compounds
into a personal asset. Over time the tool becomes un-detachable from the user's
workflow, not because their data is held hostage (the incumbent move) but because
**leaving means re-teaching a new tool who they are.** That is switching cost the
user is happy to pay.

### The highest-signal input is the diff

The gold is not the draft Claude produced. It is the delta between what Claude wrote
and what the user kept. Every inline edit, comment, and revision is a labeled
example of the user's taste and judgment. The tool already *captures* this surface
(inline editing, comments, version history); it does not yet *mine* it. The feature
at the literal center of the flywheel is **"learn from my edits, propose a skill
update."** Until that exists, "skillify" is a manual chore and the loop spins
slowly. This is the most important thing to build.

### Two assets, compounding differently

- **Voice** — how the user writes (cadence, diction, the tics they hate). Converges
  fast, then plateaus. Captured as a voice skill.
- **Context** — what the user knows: their people, projects, facts, history,
  preferences. Grows without bound. The deeper long-term moat (an AI that knows your
  world) and the heavier privacy responsibility. Treat it as its own layer, not as
  part of voice.

### Consented and legible

The learning loop must be reviewable, the same principle as the publish/mail review
gate: "Here is what I noticed about how you edit. Want me to remember it?" The user
sees, prunes, and corrects what the tool learned. Skills-as-editable-files is the
right substrate for exactly this reason. This is what separates the flywheel from
creepy personalization, and it guards against over-fitting (a one-off edit must not
permanently warp the voice; skills need confidence, decay, and easy correction).

## Should it compete with Google Workspace / MS Office?

Not head-on. Do not try to out-Docs Docs or out-Word Word. That is a fight on the
incumbents' strongest ground: storage, real-time collaboration, format ubiquity,
and free distribution to billions. "AI inside a document" is table stakes and will
be bundled (Gemini, Copilot).

Compete where they are **structurally unable to follow**:

1. **The last mile is anti-lock-in.** Google will never help you publish cleanly to
   your own blog, send through any mail provider, or render into a non-Google
   template. Their model depends on keeping the artifact inside the ecosystem. Our
   neutrality (publish to anywhere, BYO mail, BYO model) is a moat *because* copying
   it would cannibalize their lock-in.
2. **Personal, portable skills.** Their AI is one-size cloud features. Ours
   accumulates a library the user owns and carries across surfaces (even other
   Claude Code instances). They have no slot for a per-user, portable, editable
   personalization asset.
3. **Local-first, BYO-model, privacy.** A real and growing segment will not put
   their drafts and inbox in a megacorp cloud. The incumbents cannot match this
   without breaking their business.

Position as the **personal production layer beside the suite, not a replacement**:
read from Docs / Drive / Notion / Word, write out to wherever. Additive, not
migratory. The analogy is **Cursor for written output**: win the AI-native *loop*
for a high-value workflow, not the file format, the way Cursor beat free bundled
Copilot-in-VS-Code.

## Go to market and beachhead

- **Beachhead: the Claude Code / builder crowd first.** Lowest friction (they have
  the subscription), they will author and share skills (they are the supply side),
  and distribution rides the Claude ecosystem. Expand next to operators and creators
  who publish (founders, execs who post, newsletter writers, consultants), who have
  the bigger TAM and the sharpest "in my voice, to all my channels" pain.
- **The skill is the viral unit and the switching cost.** A voice, a brand kit, a
  publish target: each is shareable, each improves the product for the next user, a
  network effect the incumbents cannot build inside a per-seat cloud suite.
- **Content-led.** The build-in-public blog series is the top of funnel; the meta
  story (the tool builds and ships itself) is the hook.
- **Monetization with low COGS.** Users bring their own model, so token cost is near
  zero. Sell the surface and the ecosystem, not tokens: open-core engine (the GTM),
  paid hosted sync + brand kit + non-technical onboarding, marketplace rev-share on
  premium skills.

## What not to do

- No real-time multiplayer collaboration. Tar pit, and the incumbents' home turf.
- No storage/format war. Interop in, publish out.
- Do not become a generic AI wrapper. The defensibility is the *personal* layer, not
  the model.

## Risks

- **Cold start.** The day-one voice must be good enough that the loop ever starts.
  Capture-my-voice-from-past-writing must be a five-minute magic moment.
- **Platform dependence on Anthropic** (model, distribution, policy): fastest path
  now, biggest single point of failure later. Keep the architecture model-agnostic
  at the seams so "BYO model" can mean Claude or others.
- **Privacy weight of the context layer.** The more the tool knows the user, the
  higher the bar for local-first handling and consented learning.
