// Mail engine. Drives a connected mail MCP (Gmail now, Outlook later, …) through
// constrained `claude -p` turns. Provider-agnostic: capabilities are DISCOVERED
// at runtime (no hardcoded tool names), and read/draft/send ops flow from the
// discovered descriptor. The app reaches the MCP only via Claude (the MCP is
// bound to the CLI, not to Node).
//
// Phase 1: capability discovery + read ops (search / read thread). Writes
// (draft/send) come in a later phase, gated behind the same descriptor.

const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { firstJsonObject, extractUsage } = require('./claude');

// Neutral working dir for mail spawns. Running in the project cwd auto-loads
// CLAUDE.md (~30k+ tokens of cache-creation per call, plus latency); an empty dir
// avoids it. The mail MCP is globally configured, so it stays reachable here.
const RUN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-editor-mail-'));

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
    const child = spawn('claude', args, { cwd: RUN_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
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

// Run an MCP read tool and return its RAW result object — by capturing the
// tool's own `tool_result` from the stream and killing the process the instant it
// arrives. This skips the model's (very slow, ~9s for a thread list) turn that
// would otherwise re-format the data we already have. The model still chooses the
// tool args (so query translation/relevance is preserved); we just don't wait for
// it to re-type the answer. `effort: low` trims its thinking before the call.
function mcpRead({ toolName, system, prompt, model = 'sonnet', effort = 'low', timeoutMs = 90000 }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--system-prompt', system, '--model', model, '--allowedTools', toolName,
    ];
    if (effort) args.push('--effort', effort);
    const child = spawn('claude', args, { cwd: RUN_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    let done = false;
    let targetId = null; // the id of OUR tool's call, to ignore the ToolSearch detour's result
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      fn(arg);
    };
    const timer = setTimeout(() => finish(reject, new Error('mail read timed out')), timeoutMs);
    const noteToolUse = (c) => { if (c && c.type === 'tool_use' && c.name === toolName) targetId = c.id; };

    child.stdin.write(prompt);
    child.stdin.end();
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'stream_event' && e.event && e.event.type === 'content_block_start') {
          noteToolUse(e.event.content_block);
        } else if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
          e.message.content.forEach(noteToolUse);
        } else if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
          for (const c of e.message.content) {
            if (c.type !== 'tool_result' || !targetId || c.tool_use_id !== targetId) continue;
            let txt = c.content;
            if (Array.isArray(txt)) txt = txt.map((x) => (x && x.text) || '').join('');
            let obj = firstJsonObject(txt);
            if (!obj) {
              // Large tool results are offloaded to a file and replaced by a notice
              // ("...saved to <path>"). Read the file directly to recover the data.
              const p = String(txt).match(/saved to\s+(\/\S+\.txt)/i);
              if (p) { try { obj = firstJsonObject(fs.readFileSync(p[1], 'utf8')); } catch {} }
            }
            if (obj) return finish(resolve, obj);
          }
        } else if (e.type === 'result') {
          // Model finished its turn without us capturing a usable result.
          return finish(reject, new Error('no tool result captured'));
        }
      }
    });
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => finish(reject, new Error('failed to launch claude: ' + e.message)));
    child.on('close', () => { if (!done) finish(reject, new Error(err.trim() || 'claude exited before a tool result')); });
  });
}

// Map a raw Gmail search/list result into our thread-list shape. Uses the latest
// message in each thread for sender/date/snippet/unread; subject from the thread.
function mapThreads(raw, limit) {
  const threads = (raw && Array.isArray(raw.threads)) ? raw.threads : [];
  return threads.slice(0, limit).map((t) => {
    const msgs = Array.isArray(t.messages) ? t.messages : [];
    const last = msgs[msgs.length - 1] || {};
    const first = msgs[0] || {};
    return {
      id: t.id || last.threadId || last.id || '',
      subject: last.subject || first.subject || '(no subject)',
      from: last.sender || last.from || '',
      snippet: last.snippet || '',
      date: last.date || '',
      unread: Array.isArray(last.labelIds) && last.labelIds.includes('UNREAD'),
    };
  });
}

// Quick HTML→text for reply context: get_thread bodies come as `htmlBody`. We
// don't need perfect formatting, just readable text for Claude to reply against.
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Best available body text for a message: prefer the provider's plaintext part,
// fall back to stripped HTML, then the snippet.
function messageBody(m) {
  const pt = String(m.plaintextBody || m.textBody || m.body || '').trim();
  const text = pt || htmlToText(m.htmlBody) || (m.snippet || '').trim();
  // Cap per message so a long quoted chain doesn't bloat the reply context.
  return text.length > 4000 ? text.slice(0, 4000) + '\n…[truncated]' : text;
}

// Map a raw get_thread result into { subject, messages:[{id,from,to,date,body}] }.
// Caps to the most recent messages so a long thread doesn't bloat reply context.
function mapThread(raw, maxMessages = 12) {
  const all = Array.isArray(raw && raw.messages) ? raw.messages : [];
  const msgs = all.slice(-maxMessages);
  return {
    subject: (all[0] && all[0].subject) || (msgs[0] && msgs[0].subject) || '',
    truncated: all.length > msgs.length,
    messages: msgs.map((m) => ({
      id: m.id || '',
      from: m.sender || m.from || '',
      to: Array.isArray(m.toRecipients) ? m.toRecipients.join(', ') : (m.toRecipients || ''),
      date: m.date || '',
      body: messageBody(m),
    })),
  };
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
// We capture the search tool's raw result and skip the model's reformatting turn;
// the model still translates the request into a focused, relevant query.
async function searchThreads(query, { limit = 10, model = 'sonnet' } = {}) {
  const caps = await capabilities();
  const tool = caps.tools.searchThreads;
  if (!tool) throw new Error('the connected mailbox cannot search threads');
  const system =
    `Call the ${tool} tool ONCE to find the mail the user is asking for, then stop. ` +
    `Build a focused query: a person's name → from:/to: that person; otherwise match their keywords. ` +
    `Scope to the important inbox by default — for Gmail include "in:inbox category:primary" in the query so promotional / ` +
    `social / bulk newsletters are excluded — UNLESS the user clearly wants promotions, archived, or all mail. ` +
    `Request about ${limit} results, newest first. Do not call any other tool and do not write a summary.`;
  const raw = await mcpRead({ toolName: tool, system, prompt: `Find mail matching: ${query || 'recent inbox'}`, model });
  return mapThreads(raw, limit);
}

// Read one thread. Returns { subject, messages: [{ from, to, date, body }] }.
// Minimal/transient by design: small threads in full, large ones capped to the
// most recent messages.
async function readThread(id, { model = 'sonnet' } = {}) {
  const caps = await capabilities();
  const tool = caps.tools.readThread;
  if (!tool) throw new Error('the connected mailbox cannot read threads');
  const system =
    `Call the ${tool} tool ONCE to fetch the thread with the given id, then stop. ` +
    `Do not call any other tool and do not write a summary.`;
  const raw = await mcpRead({ toolName: tool, system, prompt: `Fetch the thread with id: ${id}`, model });
  return mapThread(raw);
}

// List the most recent PRIMARY inbox threads — important personal mail, with
// promotions/social/bulk/spam excluded where the provider distinguishes them.
// Provider-agnostic: the model picks the right query (Gmail: in:inbox
// category:primary). Uses a fast model since it's a mechanical list+format.
async function inbox({ limit = 10, model = 'sonnet' } = {}) {
  const caps = await capabilities();
  const tool = caps.tools.searchThreads;
  if (!tool) throw new Error('the connected mailbox cannot list threads');
  const system =
    `Call the ${tool} tool ONCE to list the user's most recent PRIMARY inbox threads — important personal mail, ` +
    `EXCLUDING promotional / social / bulk / notification / spam categories where the provider distinguishes them. ` +
    `For Gmail, call it with the query "in:inbox category:primary" and about ${limit} results, newest first. ` +
    `Then stop — do not call any other tool and do not write a summary.`;
  const raw = await mcpRead({ toolName: tool, system, prompt: `List my ${limit} most recent Primary inbox threads.`, model });
  return mapThreads(raw, limit);
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

module.exports = { capabilities, clearCapabilityCache, searchThreads, inbox, readThread, saveDraft, splitDraft, bareEmail };
