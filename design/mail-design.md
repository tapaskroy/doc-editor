# doc-editor — Mail Design (v2 draft)

_Design & architecture for the **Mail** feature. User-facing behavior in
[`../specs/mail-spec.md`](../specs/mail-spec.md). Builds on the doc-editor
architecture in [`architecture.md`](architecture.md)._

> Status: **design only — iterating (v2).** No code yet. Supersedes the earlier
> Gmail-MCP-specific `mail-design.md` note.

## 1. Goals & non-goals

**Goals**
- Reuse the existing writing surface to compose/refine/reply to email.
- **Provider-agnostic by dynamic capability discovery** — work with whatever mail
  MCP is connected (Gmail now, a work Outlook later, others) with **no hardcoded
  tool names or assumed capabilities**, adapting UI and behavior to what's there.
- Simplicity: no SMTP/Exchange client, no stored mail credentials, no new auth.
  The app talks to mail **only through the connected MCP's tools**.

**Non-goals (v1):** triage/inbox client, morning briefing, per-contact voice
registry, labels/filters, multi-account, app-owned sending. (Triage & briefing are
future; the design leaves seams.)

## 2. The central idea: discover, don't hardcode

The earlier note baked in Gmail's specific tools (`search_threads`, `get_thread`,
`create_draft`) and Gmail's "can't send" constraint. That doesn't extend. Instead:

> The app treats mail as a set of **semantic capabilities** and **discovers, at
> runtime, which of them the connected MCP provides and via which tools.** The UI
> and flows are driven by that discovered descriptor — not by provider-specific
> code.

Semantic capabilities:

| Capability | Meaning |
|------------|---------|
| `searchThreads` | find threads/messages (query string) |
| `readThread` | fetch a thread's full content |
| `createDraft` | save a draft (optionally as a threaded reply) |
| `send` | send a message |
| `attach` | carry an attachment on a draft and/or send |
| `identity` | the connected account's address ("acting as …") |

Each maps to a concrete MCP tool **or to nothing**. With Gmail today the descriptor
resolves `send → none`, so the UI shows no Send button — automatically, with no
Gmail-specific branch.

## 3. Execution model (how the app reaches mail)

The Node app cannot call an MCP directly — MCP servers are bound to the user's
`claude` CLI. So **all mail I/O is mediated by `claude -p`**: the app expresses a
high-level intent and lets Claude invoke the discovered tool(s). This stays
consistent with how the app already works (it shells out to `claude`).

> **Validated (read-only spike):** the connected claude.ai Gmail MCP *is* reachable
> from headless `claude -p` — a `list_labels` call succeeded with no permission
> prompts. The mediated model works headlessly. (Caveat retained: an MCP requiring
> interactive auth could be absent in a cron context; the app detects "no mail
> tools" and shows a connect state.)

Safety implication: "Claude never sends" becomes precise — **Claude never sends on
its own initiative; the `send` tool is withheld from every turn except the single,
post-confirmation send call** the app issues with the exact staged payload (§8).

## 4. Capability discovery — mechanism

Two layers, cached per connected server:

1. **Enumerate.** Read connected MCP servers + their tool names/descriptions from a
   `claude -p --output-format stream-json` session init (the `system` init event
   lists `mcp_servers` and the available `mcp__<server>__<tool>` tools).
2. **Classify (model-driven).** A one-time **capability probe**: a constrained
   `claude -p` call that, given a mail MCP's tools + descriptions, returns a JSON
   descriptor mapping each semantic capability to a tool name or `null`, e.g.:
   ```jsonc
   { "server": "claude_ai_Gmail",
     "identityAddress": "tapas.roy@…",
     "tools": { "searchThreads": "…__search_threads", "readThread": "…__get_thread",
                "createDraft": "…__create_draft", "send": null,
                "attachOnDraft": false, "attachOnSend": null } }
   ```
   Because classification is semantic, a differently-named Outlook tool maps without
   code changes. Cached; refreshed when connected servers change.

> **Validated (spike):** asked headless `claude -p`, the model reliably enumerated
> all connected Gmail tools with purposes — so model-driven classification is
> viable. Two concrete findings on the Gmail MCP: it exposes **no `send`** (only
> `create_draft`) → `send → null`, so Gmail is **draft-only, discovered not
> hardcoded**; and there is **no `whoami`/identity tool** → see §6 for how the
> account address is resolved instead.

## 5. The mail engine (one generic layer, descriptor-driven)

Not per-provider adapters in code — **one `lib/mail.js` engine** that:
- holds the discovered capability descriptor;
- exposes intent-level operations — `searchThreads(query)`, `readThread(id)`,
  `saveDraft(message)`, `send(message)` — each implemented by running a
  **constrained** `claude -p` turn that allows only the relevant discovered tool
  and returns structured output;
- reports `capabilities()` so the UI shows/hides actions.

Adding a provider = connecting its MCP. No new code path.

> **Built & validated (Phase 1):** `lib/mail.js` implements `capabilities()`,
> `searchThreads(query)`, `readThread(id)`, exposed at `GET /api/mail/capabilities`,
> `/api/mail/threads?q=`, `/api/mail/threads/:id`. Verified end-to-end against the
> live Gmail MCP. Two build findings: (a) MCP tools must be **pre-approved via
> `--allowedTools`, never restricted via `--tools`** (the latter drops them); (b)
> discovery is **non-deterministic** → retry + cache-only-a-usable-descriptor.

## 6. Data model & state ownership

**Principle (decided): the mailbox is the source of truth for email content; the
app does not duplicate it.** The app stores **pointers** into the mailbox plus the
genuinely valuable thing doc-editor adds — the **drafting context** — as a
**summary**, not a second copy of the mail.

- **While composing**, the email is a **document "kind"** reusing `lib/docs.js`:
  the working body (Markdown) + version snapshots + usage, with envelope + context.
- **Once committed** (Save to Drafts / Send), the canonical copy lives in the
  mailbox; the app keeps a **thread record**: pointers (`threadId` /
  `draftId` / `messageId`) + a **context summary**, and reads content back on
  demand via the MCP rather than holding a frozen duplicate.

```jsonc
{ "kind": "email",
  "envelope": { "to": [], "cc": [], "bcc": [], "subject": "",
                "threadId": null, "replyToMessageId": null },
  "context":  { "text": "", "links": [] /* reference docs reuse `attachments` */ },
  "outgoing": [ /* library docs rendered as files to send (DOCX/PDF/HTML) */ ],
  "provider": "claude_ai_Gmail",
  "status": "composing" | "draft-saved" | "sent",
  "mailbox":  { "threadId": null, "draftId": null, "messageId": null },   // pointers
  "threadSummary": "" /* the drafting context/connections, kept as a summary */ }
```

**Thread context/memory is shared with the Claude CLI.** The per-thread
`threadSummary` (purpose, connections, key decisions from the drafting process) is
persisted in a location the **`claude` CLI can also read** — so a normal CLI
conversation ("what did I tell Priya about Q3?") can draw on it. Likely the
project/user memory store the CLI already loads; exact path is a build detail. This
is the one piece of durable cross-surface state; everything else points back to the
mailbox.

**Identity.** The Gmail MCP has no `whoami` tool (spike finding), so the "acting
as …" address is **not** MCP-derived. Resolve it from config / a one-time
user-set value / or the `From` of the user's own drafts; never block on it.

Two **distinct attachment concepts** (see §9): `context`/`attachments` = reference
input Claude reads; `outgoing` = files the recipient receives. Recipients carry
provenance (`from-thread` | `named:<text>`). The Mail library lists emails (by
thread record) separately from Docs.

## 7. Drafting paths (shared with documents)

Email reuses **both** generation paths:
- **Draft it** — immediate subject + body.
- **Let's talk about it first** — the existing intake/brief interview, with
  email-appropriate prompts (recipients, intent, key points, tone, length). Made
  **explicit** for email (per review feedback), not just implied.

The reply flow seeds context from `readThread` (a reference block analogous to
`attachments.referenceBlock()`), kept minimal and transient.

## 8. Context bundle — "provide more context" (email-only for v1)

A small mechanism in the **Mail composer** (scoped to email for v1 by decision —
see whether it earns its place before generalizing to document creation):

- **`context.text`** — free-text context, fed into the generation prompt.
- **reference documents** — reuse the existing attachments pipeline
  (`attachments.*`, the Read tool) as input.
- **`context.links`** — URLs read via the discovered **web-read** capability
  (`WebFetch`), included as reference context.
- A **Regenerate** that rebuilds the draft from premise/brief + the full bundle.

It's the direct counterpart to the conversational intake — both end up as context
for the same writing pipeline. **Distinct from `outgoing` attachments** (§9), which
are rendered files for the recipient. Built generically enough that lifting it to
document creation later is a UI change, not a re-architecture.

## 9. Outgoing attachments (docs → mail bridge)

- Render the library doc to DOCX/PDF/HTML via `lib/export.js` at **commit time**;
  freeze into the record (snapshot semantics).
- Carry it onto the message **only via the discovered `attach` capability**
  (on-draft and/or on-send may differ per provider). If the connected account can't
  attach on the chosen path, the gate **warns plainly** rather than dropping it.
- DOCX default; PDF/HTML toggle; filename from the doc title; cover note
  auto-drafted from the doc's content.

> **No email Export.** Export is a document-only action. In Mail, the editor's
> Export panel is replaced by the mailbox **commit actions** (Save to Drafts /
> Send). The render pipeline is still reused internally — only to produce *outgoing
> attachments*, not as a user-facing email export.

## 10. Writing mode

Email needs its **own system prompt** (lighter formatting — short paragraphs, few
headings; email register) distinct from `GENERATE_SYSTEM`. Voice injection
(`styleNote`) and the anti-tic baseline still apply. Body renders Markdown→HTML for
the message, plaintext as the alternative part.

## 11. Commit (the gate) & send safety

The confirm screen resolves recipients + lint, then:
- **Save to Drafts** (if `createDraft`) — a `claude -p` turn allowing only the draft
  tool, with the staged payload + threading.
- **Send** (if `send`) — a **locked-down** `claude -p` turn whose **only** allowed
  tool is the `send` tool, with the exact staged payload. The send tool is never in
  the allowed set during composition, so Claude can't send mid-draft.
- **Determinism:** Claude-mediated tool calls are less deterministic than a direct
  API. Mitigation: the send payload is fully specified and the call is constrained
  to a single tool with explicit args; reads' non-determinism is harmless. (Accepted
  trade-off; revisit if send reliability disappoints.)

## 12. Voice (v1)
Reuse the existing Style picker (global `de.skill`) per email. Seam for a future
per-contact/group registry noted, not built.

## 13. Safety model
- **Reads free, writes gated.** Only `saveDraft`/`send` touch the mailbox; both pass
  the gate.
- **Send tool isolation:** enabled only in the single post-confirmation send call.
- **External-recipient detection** (domain compare) + attachment-mention lint.
- **No credentials stored**, no mail server, no auth beyond the MCP's own.
- Thread content + context links pulled transiently; not persisted beyond a minimal
  record.

## 14. Future seams (designed-for, not built)
- **Triage / morning briefing**: `searchThreads`/`readThread` are the read
  substrate; a richer Mail pane + a scheduled briefing build on them.
- **Per-contact / group voice**: a contacts→skill store resolved at compose; mixed-
  audience prompt. Slots in front of the v1 global Style picker.
- **More providers**: connect the MCP; discovery does the rest.

## 15. Decisions & remaining questions

**Decided**
- **Send mechanism:** accept the locked-down, post-confirmation Claude→MCP `send`
  call (§11). No app-owned SMTP.
- **Reply scope:** literal — "Reply" → sender only; "Reply all" → all. **Never
  silently expand to reply-all.** (The gate still flags large reply-all counts.)
- **Thread-context depth:** whole thread when small; cap to the most recent
  messages when large.
- **State ownership:** mailbox is source of truth; app keeps pointers + a
  CLI-readable `threadSummary` (§6). Single mailbox for v1.
- **Comments as durable annotations:** real dogfood finding (comments added but not
  sent aren't persisted, so a reviewer's notes can't be read later). **Not Mail
  v1** — logged as a separate app-wide enhancement.

**Resolved by the read-only spike**
- **Capability enumeration:** model-driven enumeration from headless `claude -p`
  works; Gmail resolves `send → null` (draft-only).
- **Identity:** no MCP `whoami` tool → resolve from config / user-set / own `From`
  (§6).

**Resolved during Phase 4 (write path built)**
- **Save to Drafts works end-to-end** against live Gmail: `saveDraft()` →
  `create_draft` creates a real draft (verified by reading drafts back). Recipients
  must be **bare addresses** ("Name <addr>" is rejected) → normalized via
  `bareEmail`; threaded replies use **`replyToMessageId`** (not threadId); body sent
  as `htmlBody` (rich) + `body` (plain alternative).
- **Identity** is discoverable after all: the classification turn returns
  `identityAddress` (Gmail resolved `tapas.roy@…`); the gate shows "Saving as …".
- **Attachments:** confirmed **not supported** by Gmail `create_draft` ("Creating
  drafts with attachments is not supported yet") — matches discovered
  `canAttachToDraft:false`. Phase 5's outgoing-attachment path must warn for Gmail.

**Still open**
- **Send:** no send-capable MCP connected yet, so the locked-down send call (§11)
  is designed but unbuilt/untested. The gate hides Send when `send` is null.
