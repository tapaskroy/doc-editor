# mail-design.md

Design note for adding **email** to doc-editor: composing, refining, and sending
email through the user's connected Gmail (MCP), with library documents attachable
to outgoing mail.

> Status: **design only.** No implementation yet. This is the spec a future build
> works against. CX/UI decisions are settled; the implementation section lists the
> known seams and open technical questions, not a plan.

## Why

doc-editor is already a strong *writing and refinement* surface: streamed drafts,
select-text-and-comment surgical edits, inline editing, and voice/style skills.
Email at work is mostly writing and refinement too, but Gmail's compose box is a
poor place to do it. The goal is to let the user write, refine, and send email
(and reply in-thread) using the same surface, drawing on the same voice skills,
and to attach documents created in the app.

## Mental model

**An email is a document with an envelope and (optionally) a thread behind it.**

- The **body** reuses the existing writing surface verbatim: streamed first draft,
  comment-to-surgical-edit revision, inline editing, voice, length readout.
- The **envelope** (To / Cc / Bcc / Subject) is new chrome around the body.
- The **thread** (when replying) is a new *input*, analogous to today's
  attachments: Claude reads it as reference context; the user does not author it.

A guiding invariant falls out of this: **reads are free and safe; writes are
gated.** Reading threads and drafting locally touch nothing in the mailbox. Only
two actions reach Gmail — *Save to drafts* and *Send* — and those get ceremony.

Email is treated as its **own writing mode**, not the document engine with an
envelope: lighter formatting (short paragraphs, few headings), and a different
default voice/register than long-form documents.

## Connected capability surface (Gmail MCP)

What the connected Gmail MCP actually exposes shapes the design:

| Capability | Tool | Notes |
|------------|------|-------|
| Search threads | `search_threads` | Gmail query syntax; snippets + headers only, no full bodies. |
| Read a thread | `get_thread` | Full message bodies (`FULL_CONTENT`). |
| List drafts | `list_drafts` | |
| Create a draft | `create_draft` | Supports `replyToMessageId` for threaded replies. **Draft attachments are not reliably supported.** |
| Labels | `list_labels`, `label_*`, `unlabel_*`, `create/update/delete_label` | Not used in v1 (see scope). |

**The MCP cannot send.** It only creates drafts. Sending is therefore a
capability the app must own itself (see Implementation). This is the most
important constraint in the whole design: because the app owns sending, the app
owns all the safety around it — Gmail's own nets do not apply.

## Surfaces

### Separate Mail space

A top-level **Docs | Mail** toggle. Docs and Mail are distinct spaces with one
deliberate bridge (doc-as-attachment). Mail is a two-pane client:

- **Left — triage list.** Recent threads via `search_threads`, with a search box
  on top. Unread in bold; sender · subject · snippet · time. Just enough to reach
  the message worth acting on.
- **Right — reading pane or composer.** Selecting a thread shows its messages
  stacked, read-only (`get_thread`), with a primary **Draft reply** action (plus
  plain Reply / Forward). **New email** opens a blank composer.

Triage is **read-only**: read, then reply / draft / forward. No archive, star, or
label management in v1.

### Composer

The composer **is** the doc-editor canvas (streamed draft, comment-revise, inline
edit, voice, length), wrapped with:

- an **envelope bar** — To / Cc / Bcc chips + Subject (Claude-suggested, editable);
- the **quoted thread** collapsed above the body as read-only context, when replying;
- an **attachments** row (file uploads and library documents — see bridge);
- a **voice chip** showing the resolved voice (see Voice), editable per email;
- footer actions: **Save to Gmail drafts**, **Send**, **Discard**.

## Flows

### Reply to a thread (the primary flow)

1. **Triage list** — search or scan, click a thread.
2. **Reading pane** — messages stack, read-only. Primary action: **Draft reply**.
3. **Draft streams in** — Claude has read the full thread; the reply streams into
   the composer with the quote collapsed above it. Recipients arrive pre-filled as
   chips with provenance tags (see Recipients).
4. **Refine** — select-to-comment ("less defensive"), inline edits, "tighten to 80
   words." Surgical and cheap on a short email.
5. **Send** — passes the confirm modal (see Send gate).
6. **Library state** — the email moves to a **Sent** state in the Mail library,
   read-only and stamped. Save-to-drafts remains the safe escape hatch.

### Compose a new email

Like today's "Draft it," but the premise is an email intent ("email Priya
proposing we push the launch to Q3, apologetic but firm"). Claude returns subject
+ body; recipients suggested as chips for confirmation.

### Refine

Unchanged from the document flow, and where the tool earns its keep for email.

## Recipients ("Claude suggests, you confirm")

- Claude may **pre-fill recipients** it infers — thread participants, or people the
  user named in the premise.
- Each recipient is a **removable chip with a provenance tag**: "from thread," or
  "you named *Priya* → priya@acme.com." Provenance is what catches a wrong-Priya
  before it ships.
- Final confirmation of recipients happens in the **send confirm modal** — the
  same screen that gates sending — so there is one human-commit point, not two.

## Voice (per-contact / per-contact-group)

The differentiator over Gmail. Builds on the existing skills mechanism.

- A **voice = a skill + optional tone notes**, mapped to a **contact** or a
  **group** ("Leadership," "My team," "External clients").
- **Auto-applied, always visible, always overridable.** On compose/reply the app
  resolves the recipient(s) to a voice and shows it as an editable chip ("Writing
  for: Priya → Manager voice").
- **Precedence:** a contact's personal voice beats a group voice.
- **Mixed audiences always prompt.** When one email's recipients map to more than
  one voice, the app does **not** guess — it asks the user to pick. (Matches the
  conservative, no-silent-action spirit of the send gate.)
- **Start explicit, grow into learned.** v1: the user assigns voices to
  contacts/groups in a small "Voices" settings area (reusing the skills list).
  Later: learn how the user writes to a person from their sent mail.

## Docs → Mail bridge (attach a document)

Docs and Mail stay separate, joined by one bridge. A document attached to an email
goes out as a **rendered** file (recipients can't open `.md`), reusing the existing
export pipeline (`lib/export.js`).

- **Two entry points:** "Email this" from a doc (opens a composer with the doc
  attached + a Claude-drafted cover note), and "Attach → a document from your
  library" inside the composer (alongside plain file upload).
- **Format is part of the attachment chip:** `Q3 Plan · DOCX ▾ · remove`.
  **DOCX is the default** (work attachments get edited and commented on); toggle to
  PDF or HTML. Filename derives from the doc title.
- **Cover note writes itself from the doc.** Because the doc's content is present,
  Claude drafts the note from it ("Here's the Q3 plan; the one change since we
  spoke is the timeline"), then the user refines it normally.
- **Snapshot semantics.** The attachment is rendered from the doc's current state
  **at send time** and frozen into the sent record. Editing the doc afterward does
  not mutate an already-sent email.
- **Draft caveat (MCP limitation).** `create_draft` cannot reliably carry
  attachments. If an email has attachments, the **Save to Gmail drafts** action
  **warns** ("attachments are included only on send") rather than silently dropping
  them. Attachments are fully supported on the app's own Send path.

## Send gate (the centerpiece)

Sending is irreversible and app-owned, so the gate is the most important screen in
the feature. **Every send passes through a mandatory confirm modal** — the single
human-commit point, doing triple duty as send gate, recipient confirmation, and
pre-send lint.

The modal shows:

- **Recipients broken out** — To / Cc / Bcc as distinct chips, each with its
  provenance tag, each removable. External / non-company addresses flagged
  visually. (This is where "Claude suggests, you confirm" resolves.)
- **Subject + body preview** — rendered as it will send.
- **Attachments** — name · format · size.
- **Inline lint (non-blocking nudges):** "mentions an attachment but none is
  attached," empty subject, reply-all recipient count ("going to 9 people").
- **Identity** — "Sending as tapas.roy@…", unmissable.
- One deliberate **Send** button.

No undo-send window: the mandatory modal already provides the deliberate pause, and
stacking an undo toast on top is friction without added safety. (Revisit if the
modal feels heavy on routine replies.)

**Principle: Claude never sends.** Claude reads, drafts, suggests recipients, and
refines. The confirm modal is the one door it cannot open. Even if the user types
"send it," the app stages the message and the user commits.

## Scope — what v1 does NOT build

Deliberate non-goals, to keep the feature focused on writing and sending well:

- A full inbox / mail client (triage is read-only and minimal).
- Label management, filters, threading visualizations.
- Multi-account juggling (single connected mailbox to start).
- An undo-send window (the confirm modal replaces it).
- Reliable draft attachments (MCP limitation; attachments are a send-path feature).

## Implementation notes (seams + open questions, not a plan)

Captured so the design isn't lost; **not** a build plan.

- **Email = document + envelope.** Likely a document "kind" with envelope metadata
  (`to`/`cc`/`bcc`/`subject`/`threadId`/`replyToMessageId`/`status`) on the meta,
  reusing `docs.js` persistence and the editor canvas. Keep the Mail library
  listing separate from Docs.
- **Writing mode.** Email needs its own system prompt (lighter formatting, email
  register) distinct from `GENERATE_SYSTEM`; voice injection (`styleNote`) and the
  anti-tic baseline still apply.
- **Reading.** `search_threads` for triage, `get_thread` (FULL_CONTENT) to seed a
  reply's context block — analogous to `attachments.referenceBlock()`.
- **Drafting to Gmail.** `create_draft` with `replyToMessageId` for threaded
  replies; HTML body maps from the existing Markdown→HTML render, plaintext as the
  alternative.
- **Sending — the net-new capability.** The MCP cannot send. **Open question:**
  which send path (Gmail API send, or SMTP)? This decision also determines auth
  (the MCP's auth may not cover send) and is a prerequisite for the whole Send
  flow. Until resolved, only Save-to-drafts is wireable.
- **Attachments.** Reuse `lib/export.js` to render the doc to DOCX/PDF/HTML at send
  time; DOCX leans on pandoc being installed (same dependency as docx export
  today). MIME-encode onto the outgoing message on the app's send path.
- **Voice registry.** A contacts/groups → skill mapping (new small store). Resolve
  recipients to a voice at compose; prompt on mixed audiences.
- **Safety.** External-recipient detection (compare domains), attachment-mention
  lint, and the principle that no Claude turn ever triggers send.
