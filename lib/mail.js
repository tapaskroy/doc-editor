// Mail engine. Drives a connected mail MCP (Gmail now, Outlook later, …) through
// constrained `claude -p` turns. Provider-agnostic: capabilities are DISCOVERED
// at runtime (no hardcoded tool names), and read/draft/send ops flow from the
// discovered descriptor. The app reaches the MCP only via Claude (the MCP is
// bound to the CLI, not to Node).
//
// Phase 1: capability discovery + read ops (search / read thread). Writes
// (draft/send) come in a later phase, gated behind the same descriptor.

const { spawn } = require('child_process');
const { firstJsonObject, extractUsage } = require('./claude');

// Run one `claude -p` turn for a mail op. Runs in the project cwd (where the
// connected MCP is reachable — validated by the read-only spike). `tools` (when
// given) are PRE-APPROVED via --allowedTools; everything else stays available but
// unapproved, so headless mode denies it if the model strays. NOTE: we must NOT
// use `--tools` to restrict — that flag drops MCP tools entirely (the model reports
// them "not available"), so MCP tools are reachable only when left unrestricted.
function runClaude({ system, prompt, tools = null, model = 'sonnet' }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--system-prompt', system, '--model', model];
    if (tools && tools.length) args.push('--allowedTools', ...tools);
    const child = spawn('claude', args, { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => reject(new Error('failed to launch claude: ' + e.message)));
    child.on('close', (code) => {
      if (!out.trim()) return reject(new Error(err.trim() || `claude exited with code ${code}`));
      let w;
      try {
        w = JSON.parse(out);
      } catch {
        return reject(new Error('could not parse claude output envelope'));
      }
      if (w.is_error) return reject(new Error(w.result || 'claude returned an error'));
      resolve(w); // full envelope: .result + token/cost usage
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---- capability discovery (cached) -------------------------------------

const DISCOVER_SYSTEM = `You can see the tools available in this session, including any connected mail MCP (Gmail, Outlook, etc.). Classify those mail tools by what they do — names vary by provider, so map by PURPOSE, not by name. Respond with ONLY a JSON object (no prose, no code fence):

{"connected": true|false,
 "server": "<mcp server name or null>",
 "identityAddress": "<the connected account's email address if you can determine it, else null>",
 "tools": {
   "searchThreads": "<exact tool name or null>",
   "readThread":    "<exact tool name or null>",
   "listDrafts":    "<exact tool name or null>",
   "createDraft":   "<exact tool name or null>",
   "send":          "<exact tool name or null>"
 },
 "canAttachToDraft": true|false|null}

Use null when a capability isn't present. Set "connected" false if there is no mail MCP at all. Do NOT call any tool — only inspect and classify.`;

let _capCache = null;

// A descriptor is "usable" if a mail MCP was found and at least one read tool was
// classified. Model-driven classification is non-deterministic and occasionally
// returns an unparseable / empty result; we retry a couple of times and only cache
// a usable descriptor, so a transient miss never disables Mail for the session.
function usable(d) {
  return !!(d && d.connected && d.tools && (d.tools.searchThreads || d.tools.readThread));
}

async function capabilities({ refresh = false, model = 'sonnet', attempts = 3 } = {}) {
  if (_capCache && !refresh) return _capCache;
  let last = { connected: false, tools: {} };
  for (let i = 0; i < attempts; i++) {
    try {
      const w = await runClaude({ system: DISCOVER_SYSTEM, prompt: 'Classify the connected mail tools now.', model });
      const parsed = firstJsonObject(w.result) || { connected: false, tools: {} };
      parsed.tools = parsed.tools || {};
      last = parsed;
      if (usable(parsed)) {
        _capCache = parsed;
        return parsed;
      }
    } catch (e) {
      last = { connected: false, tools: {}, error: e.message };
    }
  }
  return last; // not cached — a later call will retry discovery
}

function clearCapabilityCache() {
  _capCache = null;
}

// ---- read ops ----------------------------------------------------------

// Search threads. Returns [{ id, subject, from, snippet, date, unread }].
async function searchThreads(query, { limit = 15, model = 'sonnet' } = {}) {
  const caps = await capabilities();
  const tool = caps.tools.searchThreads;
  if (!tool) throw new Error('the connected mailbox cannot search threads');
  const system =
    `You search the user's mail using the ${tool} tool, then return ONLY JSON (no prose, no code fence):\n` +
    `{"threads":[{"id":"…","subject":"…","from":"…","snippet":"…","date":"…","unread":true|false}]}\n` +
    `Return at most ${limit}, newest first. Use only headers/snippets — do not open full bodies. Do not modify anything.`;
  const w = await runClaude({ system, prompt: `Search the mailbox for: ${query || 'newer_than:7d'}`, tools: [tool], model });
  const o = firstJsonObject(w.result);
  return (o && Array.isArray(o.threads)) ? o.threads : [];
}

// Read one thread. Returns { subject, messages: [{ from, to, date, body }] }.
// Minimal/transient by design: small threads in full, large ones capped to the
// most recent messages.
async function readThread(id, { model = 'sonnet' } = {}) {
  const caps = await capabilities();
  const tool = caps.tools.readThread;
  if (!tool) throw new Error('the connected mailbox cannot read threads');
  const system =
    `You read ONE mail thread using the ${tool} tool and return ONLY JSON (no prose, no code fence):\n` +
    `{"subject":"…","messages":[{"id":"<message id>","from":"…","to":"…","date":"…","body":"…"}]}\n` +
    `Include each message's id. Bodies as plain text. If the thread is very long, include only the most recent messages and note that. Do not modify anything.`;
  const w = await runClaude({ system, prompt: `Read the mail thread with id: ${id}`, tools: [tool], model });
  return firstJsonObject(w.result) || { subject: '', messages: [] };
}

// ---- write ops ---------------------------------------------------------

// Extract a bare email address from "Name <addr>" or a plain string. The Gmail
// create_draft tool rejects the "Name <addr>" form, and search/read "from"
// fields often carry it, so we always normalize to the bare address.
function bareEmail(s) {
  const angled = String(s || '').match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : s).trim();
  const m = candidate.match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/);
  return m ? m[0] : '';
}

// Split an email doc's markdown into subject (the first H1) + body (the rest).
function splitDraft(md) {
  const m = String(md || '').match(/^#\s+(.+)$/m);
  const subject = m ? m[1].trim() : '';
  let body = String(md || '');
  if (m) body = body.slice(0, m.index) + body.slice(m.index + m[0].length);
  return { subject, body: body.trim() };
}

// Save a draft to the connected mailbox via the discovered createDraft tool.
// WRITE op: the turn allows ONLY the createDraft tool, and the staged payload is
// passed through verbatim. Returns { draftId, usage }.
async function saveDraft(message = {}, { model = 'sonnet' } = {}) {
  const caps = await capabilities();
  const tool = caps.tools.createDraft;
  if (!tool) throw new Error('the connected mailbox cannot save drafts');

  const payload = {
    to: (message.to || []).map(bareEmail).filter(Boolean),
    cc: (message.cc || []).map(bareEmail).filter(Boolean),
    bcc: (message.bcc || []).map(bareEmail).filter(Boolean),
    subject: message.subject || '',
    body: message.body || '',
  };
  if (message.htmlBody) payload.htmlBody = message.htmlBody;
  if (message.replyToMessageId) payload.replyToMessageId = message.replyToMessageId;
  if (!payload.to.length) throw new Error('a draft needs at least one valid recipient in To');

  const system =
    `You create EXACTLY ONE email draft by calling the ${tool} tool with the fields in the user message, verbatim. ` +
    `Do NOT alter, rephrase, summarize, translate, or add to the subject, body, or recipients — pass them through exactly as given. ` +
    `Call the tool once only. Then return ONLY JSON (no prose, no code fence): ` +
    `{"ok":true,"draftId":"<the id the tool returned>"} on success, or {"ok":false,"error":"<reason>"} on failure.`;
  const prompt =
    `Create one draft with these exact fields (JSON):\n\n${JSON.stringify(payload, null, 2)}\n\n` +
    `"body" is the plain-text content; "htmlBody" (if present) is the rich version. Preserve every line break and word.`;

  const w = await runClaude({ system, prompt, tools: [tool], model });
  const o = firstJsonObject(w.result) || {};
  if (!o.ok || !o.draftId) throw new Error(o.error || 'the draft was not created (no draft id returned)');
  return { draftId: o.draftId, usage: extractUsage(w) };
}

module.exports = { capabilities, clearCapabilityCache, searchThreads, readThread, saveDraft, splitDraft, bareEmail };
