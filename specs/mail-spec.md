# doc-editor — Mail Spec (v2 draft)

_User-facing specification for the **Mail** feature: composing, refining, and
replying to email in the doc-editor surface, through the user's own connected
mail account. Companion to [`product-spec.md`](product-spec.md); design in
[`../design/mail-design.md`](../design/mail-design.md)._

> Status: **design only — iterating (v2).** No implementation yet.

## 1. What it is

Email at work is mostly writing and refining, but the compose box is a poor place
to do it. Mail brings email into doc-editor's writing surface: stream a first
draft, refine it by selecting text and commenting, edit inline, apply a voice —
then save it to your mailbox's drafts or send it, **through whatever mail account
you've connected**.

**An email is a document with an envelope and (optionally) a thread behind it.**
- **Body** — the existing writing surface, verbatim.
- **Envelope** — To / Cc / Bcc / Subject (new chrome).
- **Thread** — when replying, read-only context Claude reads; you never author it.

## 2. Works with whatever mail you've connected (the core promise)

Mail does **not** assume Gmail, Outlook, or any specific provider. It **discovers
the connected mail account's capabilities at runtime** and adapts:

- The actions you see are exactly what your account supports. If it can save
  drafts, you get **Save to Drafts**. If it can send, you get **Send**. If it
  can't do one of those, that button simply isn't there.
- Connect a different mail account later (e.g. a work Outlook) and Mail adjusts
  automatically — no new version of the app required.
- If no mail account is connected, the Mail space explains how to connect one.

> Example: with a Gmail account connected today, you can compose, refine, and
> **Save to Drafts** in Gmail; you press Send from Gmail. Connect an account that
> also supports sending, and an in-app **Send** appears.

The app only ever talks to your mail through the connected account's own APIs. It
never stores your mail password and never runs its own mail server.

## 3. Scope of v1

**In:** compose a new email; reply to a thread you find by search; **provide
context** (text / documents / links) and regenerate; refine with the full writing
surface; choose a voice; attach files or a library document as an outgoing file;
review and commit (Save to Drafts and/or Send, per capability).

**Out (deliberately):** a full inbox / triage list, a morning briefing, per-contact
voices, labels/filters, multi-account juggling. _Triage and morning briefing are
planned for later; v1 leaves room for them but doesn't build them._

## 4. Surfaces

A top-level **Docs | Mail** toggle in the header. Mail is its own space.

**Layout (decided):** two panes. A **left rail** holds **Compose new** and a
**thread search box** whose results list below it; the **composer** fills the right
pane. Footer actions are capability-gated.

- **Compose new** — a blank composer.
- **Reply** — the rail's search box finds a thread; selecting it shows the messages
  stacked, read-only, and the primary action is **Draft reply**.

The **composer** is the doc-editor canvas (streamed draft, comment-revise, inline
edit, voice, length) wrapped with:
- an **envelope bar** — To / Cc / Bcc chips + Subject (Claude-suggested, editable);
- the **quoted thread** collapsed above the body, when replying;
- a **Provide more context** panel (§6);
- an **outgoing attachments** row — files + library documents (§10);
- a **voice chip** showing the active voice (editable per email);
- footer actions, shown per capability: **Save to Drafts**, **Send**, **Discard**.

**An email has no _Export_.** Export is a document action; an email's only outputs
are **Save to Drafts** and **Send** (whichever your connected account supports).

## 5. Drafting an email

As with documents, you choose how much to plan before Claude writes:

- **Draft it** — Claude returns a subject + body immediately.
- **Let's talk about it first** — Claude briefly interviews you (who it's to, the
  intent, key points, tone, length) before drafting, for a more targeted email.
  The same planning paradigm used for documents applies here, explicitly.

Either way, recipients are suggested as chips for confirmation (§7), and you refine
exactly as you would a document — and that's where the tool earns its keep for
email.

When **replying**, Claude has read the thread (read-only context) and the reply
streams into the composer with the quote collapsed above it. **Reply scope is
literal:** "Reply" goes to the sender; "Reply all" goes to everyone. The app never
silently turns a Reply into a reply-all.

## 6. Provide more context

Sometimes you already know the background and just want to hand it over rather than
be interviewed. A **Provide more context** panel lets you add, together:

- **Textual context** — paste notes, requirements, the gist of a call, background.
- **Attach documents** — files Claude reads as **reference/input**.
- **Attach links** — URLs for Claude to read.

Then **Regenerate** produces a fresh draft that uses all of it. This is the direct
alternative to "Let's talk about it first" — dump what you know, instead of being
interviewed. The two can be combined.

> These are **inputs/reference** for writing the email — distinct from attaching a
> document as an **outgoing file** the recipient receives (§10).

**Email-only for v1.** This panel lives in the Mail composer for now; we'll see how
it feels there before deciding whether to bring the same context bundle to the
document creation window.

## 7. Recipients — "Claude suggests, you confirm"
- Claude may pre-fill recipients it infers (thread participants, or people you
  named in the premise).
- Each is a **removable chip with a provenance tag** — "from thread," or "you named
  *Priya* → priya@acme.com." Provenance catches a wrong-Priya before it ships.
- Recipients are **finally confirmed at the review step** (§8), so there's one
  human commit point.

## 8. The review gate
Every push to your mailbox — a draft or a send — passes through **one confirm
screen**, the single commit point:
- **Recipients** broken out (To / Cc / Bcc), each with provenance, each removable;
  external / non-company addresses flagged.
- **Subject + body preview**, as it will appear.
- **Outgoing attachments** — name · format · size.
- **Non-blocking lint** — "mentions an attachment but none attached," empty
  subject, large reply-all ("going to 9 people").
- **Identity** — "Acting as tapas.roy@…", unmissable.
- The available action(s): **Save to Drafts** and/or **Send**.

**Send is the heavier, irreversible commit.** **Claude never sends on its own** —
it reads, drafts, suggests, and refines; only after you confirm does the app carry
out the send. Even if you type "send it," it stages the message and waits for you.

## 9. Voice (v1)
The email uses the same **Style** picker as documents — pick a voice and the draft
and revisions come out in it, editable per email. (Per-contact / per-group voices
that resolve automatically from recipients are a planned follow-up, not v1.)

## 10. Attach a document as an outgoing file
Send a library document *with* an email as a **rendered** file (recipients can't
open `.md`), via the existing render pipeline.
- Two entry points: **"Email this"** from a document (opens a composer with the doc
  attached + a Claude-drafted cover note), and **"Attach → a library document"** in
  the composer.
- **Format on the chip:** `Q3 Plan · DOCX ▾ · remove`. **DOCX default**; toggle to
  PDF or HTML. Filename from the doc title.
- **Cover note writes itself** from the doc's content, then you refine it.
- **Snapshot at commit:** the attachment is rendered from the doc's state when you
  save/send and frozen into the record; editing the doc later doesn't change an
  already-sent email.
- **Capability-aware:** attachments ride whatever write path your account supports.
  If the connected account can't carry an attachment on the chosen path, Mail tells
  you plainly rather than silently dropping it.

## 11. Where things live (source of truth)
- **Your emails live in your mailbox**, not in doc-editor. Drafts and sent
  messages are the real ones in Gmail/Outlook; the app points to them rather than
  keeping a second copy.
- What doc-editor keeps is the **drafting context** — a short per-thread summary of
  why you wrote what you wrote and the connections involved. This summary is also
  **available when you talk to Claude in the CLI**, so your normal Claude sessions
  can draw on it.
- After **Send**, the email is a read-only record (a pointer to the sent message).
  A **saved draft** stays editable — re-saving updates it.

## 12. Privacy
- Thread content and context links are read **transiently** for drafting; not
  hoarded.
- Everything goes through your own connected mail account's APIs; no mail
  credentials are stored by the app, and nothing is sent without your confirmation.

## 13. Requirements
- A connected mail MCP (e.g. Gmail today; a work Outlook later).
- For DOCX attachments: pandoc (same dependency as document `.docx` export).

## 14. Known limits (v1)
- Minimal Mail surface (no triage list / briefing yet).
- Single connected mailbox.
- Voice is global per email, not per recipient.
- Available actions are bounded by what your connected account exposes (e.g. no
  in-app Send if the account can't send via its API).
