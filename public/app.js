'use strict';

// Single-page client for the doc editor. Responsibilities:
//   - hash routing between the home (composer + library) and editor views
//   - streaming a generated draft over SSE and rendering it progressively
//   - text-selection comments, the revision flow, and change highlighting
//   - the model / effort / web picker (persisted in localStorage)
//   - the collapsible conversation-history panel
// No framework — `$` is querySelector and state lives in module-level vars.

// ---- tiny helpers -------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const api = {
  async json(url, opts) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
};

function setStatus(text) {
  $('#status').textContent = text || '';
}

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function timeAgo(iso) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

const HAS_HIGHLIGHT = typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && CSS.highlights;

// ---- model / effort picker (persisted) ---------------------------------

const settings = {
  model: localStorage.getItem('de.model') || '',
  effort: localStorage.getItem('de.effort') || '',
  // Web research defaults to on (so links/lookups just work); persisted once toggled.
  web: localStorage.getItem('de.web') !== 'false',
  skill: localStorage.getItem('de.skill') || '',
};

// Populate the style picker from the user's available skills.
async function loadSkills() {
  const sel = $('#sel-style');
  let list = [];
  try {
    list = await api.json('/api/skills');
  } catch {
    return;
  }
  for (const s of list) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name + (s.source === 'project' ? ' (project)' : '');
    if (s.description) opt.title = s.description;
    sel.appendChild(opt);
  }
  // Restore the saved choice if it still exists.
  sel.value = settings.skill;
  if (sel.value !== settings.skill) {
    settings.skill = '';
    localStorage.removeItem('de.skill');
  }
}

function initPicker() {
  const m = $('#sel-model');
  const e = $('#sel-effort');
  const w = $('#chk-web');
  const s = $('#sel-style');
  m.value = settings.model;
  e.value = settings.effort;
  w.checked = settings.web;
  s.addEventListener('change', () => {
    settings.skill = s.value;
    if (s.value) localStorage.setItem('de.skill', s.value);
    else localStorage.removeItem('de.skill');
    // Voice is per-document: persist the choice on the open doc. The localStorage
    // value above is just the default applied to new docs.
    if (currentId) {
      api.json(`/api/docs/${currentId}/voice`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: s.value || null }),
      }).catch(() => {});
    }
  });
  m.addEventListener('change', () => {
    settings.model = m.value;
    localStorage.setItem('de.model', m.value);
  });
  e.addEventListener('change', () => {
    settings.effort = e.value;
    localStorage.setItem('de.effort', e.value);
  });
  w.addEventListener('change', () => {
    settings.web = w.checked;
    localStorage.setItem('de.web', String(w.checked));
  });
}

// ---- routing ------------------------------------------------------------

function route() {
  if (typeof flushSave === 'function') flushSave(); // persist any pending inline edit before leaving
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/doc\/(.+)$/);
  if (m) showEditor(m[1]);
  else if (hash === '#/mail') showMail();
  else if (hash === '#/profile') showProfile();
  else if (hash === '#/brief') showBrief();
  else showHome();
}
window.addEventListener('hashchange', route);
// Best-effort save if the tab is closed mid-edit.
window.addEventListener('beforeunload', () => {
  if (docDirty && currentId && navigator.sendBeacon) {
    navigator.sendBeacon(`/api/docs/${currentId}/content`, new Blob([JSON.stringify({ markdown: htmlToMarkdown() })], { type: 'application/json' }));
  }
});

function show(view) {
  $('#view-home').classList.toggle('hidden', view !== 'home');
  $('#view-mail').classList.toggle('hidden', view !== 'mail');
  $('#view-brief').classList.toggle('hidden', view !== 'brief');
  $('#view-editor').classList.toggle('hidden', view !== 'editor');
  $('#view-profile').classList.toggle('hidden', view !== 'profile');
  // Default the surface switch to the view; showEditor refines it for emails.
  $('#nav-mail').classList.toggle('active', view === 'mail');
  $('#nav-profile').classList.toggle('active', view === 'profile');
  $('#nav-docs').classList.toggle('active', view !== 'mail' && view !== 'profile');
}

// ---- home ---------------------------------------------------------------

async function showHome() {
  show('home');
  $('#doc-title').textContent = '';
  setStatus('');
  const list = await api.json('/api/docs').catch(() => []);
  const ul = $('#doc-list');
  ul.innerHTML = '';
  if (!list.length) {
    ul.innerHTML = '<li class="empty">No documents yet — write one above.</li>';
    return;
  }
  for (const d of list) {
    const li = document.createElement('li');
    const spend = summarizeUsage(d.usage || []).usd;
    li.innerHTML = `
      <a href="#/doc/${d.id}">${escapeHtml(d.title || 'Untitled')}</a>
      ${spend > 0 ? `<span class="cost" title="API-equivalent spend">${fmtUsd(spend)}</span>` : ''}
      <span class="meta">${timeAgo(d.updatedAt)}</span>
      <button class="del" title="Delete">✕</button>`;
    li.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`Delete “${d.title}”?`)) return;
      await api.json(`/api/docs/${d.id}`, { method: 'DELETE' });
      showHome();
    });
    ul.appendChild(li);
  }
}

$('#create-btn').addEventListener('click', async () => {
  const premise = $('#premise').value.trim();
  if (!premise) {
    $('#premise').focus();
    return;
  }
  $('#create-btn').disabled = true;
  try {
    const meta = await api.json('/api/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ premise, voice: localStorage.getItem('de.skill') || null }),
    });
    $('#premise').value = '';
    if (pendingAttachments.length) {
      $('#create-btn').textContent = 'Uploading…';
      await uploadPending(meta.id);
    }
    location.hash = `#/doc/${meta.id}`;
  } catch (e) {
    toast('Could not create document: ' + e.message);
  } finally {
    $('#create-btn').disabled = false;
    $('#create-btn').textContent = 'Draft it →';
  }
});

// ---- mail ---------------------------------------------------------------

// Discovered mail capabilities (cached for the session). Drives which actions
// the UI shows — no hardcoded provider assumptions.
let mailCaps = null;
async function getMailCaps() {
  if (mailCaps) return mailCaps;
  mailCaps = await api.json('/api/mail/capabilities').catch(() => ({ connected: false, tools: {} }));
  return mailCaps;
}

async function showMail() {
  show('mail');
  showComposerPane(); // default to the composer; reading a thread swaps it in
  $('#doc-title').textContent = '';
  setStatus('');
  $('#mail-results').innerHTML = '';
  $('#mail-search-input').value = '';

  const cap = $('#mail-cap');
  cap.textContent = 'Checking your connected mailbox…';
  getMailCaps().then((c) => {
    if (!c.connected) { cap.textContent = 'No mail account is connected. Connect a mail MCP to use Mail.'; return; }
    const can = [];
    if (c.tools.createDraft) can.push('save drafts');
    if (c.tools.send) can.push('send');
    cap.textContent = `Connected to ${c.server || 'your mailbox'}: you can ${can.join(' and ') || 'read mail'} from here.`;
  });

  loadInbox(); // async, non-blocking — the rail and composer stay usable while it loads

  const list = await api.json('/api/docs').catch(() => []);
  const emails = list.filter((d) => d.kind === 'email');
  const ul = $('#mail-list');
  ul.innerHTML = emails.length ? '' : '<li class="empty hint">No emails yet — compose one above.</li>';
  for (const d of emails) {
    const li = document.createElement('li');
    const status = (d.email && d.email.status) || 'composing';
    const main = document.createElement('div');
    main.className = 'mail-item-main';
    main.innerHTML =
      `<span class="subj">${escapeHtml(d.title || 'Untitled')}</span>` +
      `<span class="meta"><span class="tag">${status}</span> · ${timeAgo(d.updatedAt)}</span>`;
    main.addEventListener('click', () => { location.hash = `#/doc/${d.id}`; });
    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Delete this email draft';
    del.textContent = '✕';
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete “${d.title || 'Untitled'}”? This removes the draft from doc-editor; it does not touch your mailbox.`)) return;
      try {
        await api.json(`/api/docs/${d.id}`, { method: 'DELETE' });
      } catch (e) {
        toast('Delete failed: ' + e.message);
        return;
      }
      showMail();
    });
    li.appendChild(main);
    li.appendChild(del);
    ul.appendChild(li);
  }
}

// The inbox is served instantly from the server's local cache; a background
// refresh keeps it fresh. We render whatever arrives immediately and poll briefly
// for the refreshed list (rather than blocking on the slow fetch).
let mailInboxPoll = null;
async function loadInbox(force = false) {
  const ul = $('#mail-inbox');
  if (!ul.children.length) ul.innerHTML = '<li class="hint">Loading…</li>';
  try {
    const r = await api.json('/api/mail/inbox' + (force ? '?refresh=1' : ''));
    renderInbox(r);
    scheduleInboxPoll(r);
  } catch (e) {
    ul.innerHTML = `<li class="hint">Could not load inbox: ${escapeHtml(e.message)}</li>`;
  }
}

function renderInbox(r) {
  const threads = (r && r.threads) || [];
  const ul = $('#mail-inbox');
  ul.innerHTML = threads.length ? '' : `<li class="hint">${r && r.refreshing ? 'Fetching your mail…' : 'No recent Primary mail.'}</li>`;
  for (const t of threads) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="subj">${escapeHtml(t.subject || '(no subject)')}</span>` +
      `<span class="from">${escapeHtml(t.from || '')}</span>`;
    li.addEventListener('click', () => openThread(t));
    ul.appendChild(li);
  }
  const status = $('#mail-inbox-status');
  if (r && r.refreshing) status.textContent = 'refreshing…';
  else if (r && r.fetchedAt) status.textContent = 'updated ' + timeAgo(new Date(r.fetchedAt).toISOString());
  else status.textContent = '';
}

// While the server refreshes (or we have nothing yet), poll so the fresh list
// swaps in on its own. Stops once fresh, after a cap, or on leaving the view.
function scheduleInboxPoll(r) {
  if (mailInboxPoll) { clearInterval(mailInboxPoll); mailInboxPoll = null; }
  const needs = r && (r.refreshing || !(r.threads && r.threads.length));
  if (!needs) return;
  let tries = 0;
  mailInboxPoll = setInterval(async () => {
    if (location.hash !== '#/mail') { clearInterval(mailInboxPoll); mailInboxPoll = null; return; }
    tries += 1;
    try {
      const r2 = await api.json('/api/mail/inbox');
      renderInbox(r2);
      if ((!r2.refreshing && r2.threads && r2.threads.length) || tries > 15) { clearInterval(mailInboxPoll); mailInboxPoll = null; }
    } catch {
      if (tries > 15) { clearInterval(mailInboxPoll); mailInboxPoll = null; }
    }
  }, 3000);
}
$('#mail-inbox-refresh').addEventListener('click', () => loadInbox(true));

// Create an email doc (optionally seeded with an envelope/context) and open it.
async function composeEmail(init = {}) {
  try {
    const meta = await api.json('/api/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'email', premise: init.premise || '', email: init.email || {} }),
    });
    location.hash = `#/doc/${meta.id}`;
  } catch (e) {
    toast('Could not create email: ' + e.message);
  }
}

// Draft it → create the email and stream the first draft (mirrors the home flow).
$('#mail-draft').addEventListener('click', async () => {
  const premise = $('#mail-premise').value.trim();
  if (!premise) { $('#mail-premise').focus(); return; }
  const btn = $('#mail-draft');
  btn.disabled = true;
  try {
    const meta = await api.json('/api/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'email', premise }),
    });
    $('#mail-premise').value = '';
    if (pendingAttachments.length) { btn.textContent = 'Uploading…'; await uploadPending(meta.id); }
    location.hash = `#/doc/${meta.id}`;
  } catch (e) {
    toast('Could not create email: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Draft it →';
  }
});

// Let's talk about it first → the intake interview, flagged to draft an email.
$('#mail-talk').addEventListener('click', () => {
  const premise = $('#mail-premise').value.trim();
  if (!premise) { $('#mail-premise').focus(); return; }
  briefPremise = premise;
  briefKind = 'email';
  briefEmailInit = null;
  $('#mail-premise').value = '';
  location.hash = '#/brief';
});

$('#mail-attach-btn').addEventListener('click', () => $('#mail-attach-input').click());
$('#mail-attach-input').addEventListener('change', (e) => {
  pendingAttachments.push(...e.target.files);
  e.target.value = '';
  renderChips();
});

// Each search is a slow Claude+MCP call, so debounce generously, require a couple
// of characters, and let Enter fire it immediately.
let mailSearchTimer = null;
$('#mail-search-input').addEventListener('input', (e) => {
  clearTimeout(mailSearchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { $('#mail-results').innerHTML = ''; return; }
  mailSearchTimer = setTimeout(() => searchThreads(q), 600);
});
$('#mail-search-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  clearTimeout(mailSearchTimer);
  const q = e.target.value.trim();
  if (q) searchThreads(q);
});

async function searchThreads(q) {
  const ul = $('#mail-results');
  ul.innerHTML = '<li class="hint">Searching…</li>';
  try {
    const { threads = [] } = await api.json('/api/mail/threads?q=' + encodeURIComponent(q));
    ul.innerHTML = threads.length ? '' : '<li class="hint">No threads found.</li>';
    for (const t of threads) {
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="subj">${escapeHtml(t.subject || '(no subject)')}</span>` +
        `<span class="from">${escapeHtml(t.from || '')}</span>`;
      li.addEventListener('click', () => openThread(t));
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = `<li class="hint">Search failed: ${escapeHtml(e.message)}</li>`;
  }
}

// Reading a thread: clicking a thread shows it read-only in the right pane with
// reply actions. Drafting happens only when the user chooses one — no auto-draft.
let currentThread = null;

function showReader() { $('.mail-composer').classList.add('hidden'); $('.mail-reader').classList.remove('hidden'); }
function showComposerPane() { $('.mail-reader').classList.add('hidden'); $('.mail-composer').classList.remove('hidden'); }

async function openThread(t) {
  showReader();
  $('#reader-subject').textContent = t.subject || '…';
  $('#reader-messages').innerHTML = '<p class="hint">Loading the thread…</p>';
  currentThread = null;
  try {
    const thread = await api.json('/api/mail/threads/' + encodeURIComponent(t.id));
    thread.id = t.id;
    currentThread = thread;
    renderReader(thread);
  } catch (e) {
    $('#reader-messages').innerHTML = `<p class="hint">Could not load this thread: ${escapeHtml(e.message)}</p>`;
  }
}

function renderReader(thread) {
  $('#reader-subject').textContent = thread.subject || '(no subject)';
  const box = $('#reader-messages');
  box.innerHTML = '';
  if (thread.truncated) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent = 'Showing the most recent messages in this thread.';
    box.appendChild(note);
  }
  for (const m of thread.messages || []) {
    const div = document.createElement('div');
    div.className = 'reader-msg';
    const meta = document.createElement('div');
    meta.className = 'reader-meta';
    meta.innerHTML = `<span class="reader-from">${escapeHtml(m.from || '')}</span><span class="reader-date">${escapeHtml(timeAgo(m.date) || '')}</span>`;
    div.appendChild(meta);
    if (m.html && m.html.trim()) {
      // Render the email's own HTML faithfully, isolated in a sandboxed iframe
      // (no scripts, its CSS can't leak into the app).
      const frame = document.createElement('iframe');
      frame.className = 'reader-frame';
      frame.setAttribute('sandbox', '');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.srcdoc = m.html;
      div.appendChild(frame);
    } else {
      const body = document.createElement('div');
      body.className = 'reader-body';
      body.textContent = m.body || '(no text)';
      div.appendChild(body);
    }
    box.appendChild(div);
  }
}

// Build the reply seed from the thread already open in the reader. Sender-only
// (literal reply scope; never silently reply-all).
function buildReplySeed() {
  const t = currentThread || { messages: [] };
  const msgs = t.messages || [];
  const last = msgs[msgs.length - 1] || {};
  const quoted = msgs.map((m) => `From: ${m.from || ''}\nDate: ${m.date || ''}\n\n${m.body || ''}`).join('\n\n-----\n\n');
  const subject = t.subject ? `Re: ${t.subject.replace(/^re:\s*/i, '')}` : '';
  return {
    email: {
      envelope: { to: last.from ? [last.from] : [], subject, threadId: t.id, replyToMessageId: last.id || null },
      replyScope: 'sender',
      context: { text: `Thread being replied to:\n\n${quoted}` },
    },
    to: last.from || '',
    subject,
    quoted,
  };
}

// Start a reply: draft it now (open the editor, which streams the reply) or plan
// it first via the interview. Staged attachments ride along on a draft-it-now.
async function startReply({ talk }) {
  if (!currentThread) return;
  const seed = buildReplySeed();
  if (talk) {
    briefPremise = `Help me write a reply to this email thread.\n\nFrom: ${seed.to || 'the sender'}\nSubject: ${seed.subject}\n\n${seed.quoted.slice(0, 1500)}`;
    briefKind = 'email';
    briefEmailInit = seed.email;
    location.hash = '#/brief';
    return;
  }
  try {
    const meta = await api.json('/api/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'email',
        premise: 'Draft a reply to the sender of this email thread. Reply to the sender only (not reply-all), consistent with the conversation.',
        email: seed.email,
      }),
    });
    if (pendingAttachments.length) await uploadPending(meta.id);
    location.hash = `#/doc/${meta.id}`;
  } catch (e) {
    toast('Could not start the reply: ' + e.message);
  }
}

$('#reader-back').addEventListener('click', showComposerPane);
$('#reader-draft').addEventListener('click', () => startReply({ talk: false }));
$('#reader-talk').addEventListener('click', () => startReply({ talk: true }));
$('#reader-attach').addEventListener('click', () => $('#reader-attach-input').click());
$('#reader-attach-input').addEventListener('change', (e) => { pendingAttachments.push(...e.target.files); e.target.value = ''; renderChips(); });

// Show/hide email chrome (envelope + capability footer) in the editor, and swap
// the Export panel (docs) for mailbox commit actions (emails).
async function applyMailChrome(data) {
  const isEmail = data.kind === 'email';
  $('#envelope').classList.toggle('hidden', !isEmail);
  $('#mail-foot').classList.toggle('hidden', !isEmail);
  const exportH = [...document.querySelectorAll('.panel h3')].find((h) => h.textContent.trim() === 'Export');
  if (exportH) exportH.closest('.panel').classList.toggle('hidden', isEmail);
  $('#nav-mail').classList.toggle('active', isEmail);
  $('#nav-docs').classList.toggle('active', !isEmail);
  if (!isEmail) return;

  const env = (data.email && data.email.envelope) || {};
  $('#env-to').value = (env.to || []).join(', ');
  $('#env-cc').value = (env.cc || []).join(', ');
  $('#env-bcc').value = (env.bcc || []).join(', ');
  $('#env-subject').textContent = data.title || '—';

  const caps = await getMailCaps();
  const canDraft = !!(caps.tools && caps.tools.createDraft);
  const canSend = !!(caps.tools && caps.tools.send);
  $('#save-draft-btn').classList.toggle('hidden', !canDraft);
  $('#send-btn').classList.toggle('hidden', !canSend);
  const saved = (data.email && data.email.status) === 'draft-saved';
  if (canDraft) $('#save-draft-btn').textContent = saved ? 'Update draft' : 'Save to Drafts';
  $('#mail-identity').textContent = caps.connected
    ? `Mailbox: ${caps.server || 'connected'}${canSend ? '' : ' · draft-only'}${saved ? ' · saved to Drafts ✓' : ''}`
    : 'No mailbox connected';
}

// Persist envelope edits (comma-separated → arrays).
['to', 'cc', 'bcc'].forEach((f) => {
  $('#env-' + f).addEventListener('change', () => {
    if (!currentId) return;
    const vals = $('#env-' + f).value.split(',').map((x) => x.trim()).filter(Boolean);
    api.json(`/api/docs/${currentId}/email`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelope: { [f]: vals } }),
    }).catch(() => {});
  });
});

// ---- the review gate (single commit point before a draft/send) ---------

const parseList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// Split an email doc's markdown into subject (first H1) + body (the rest).
function splitEmailMd(md) {
  const m = String(md || '').match(/^#\s+(.+)$/m);
  const subject = m ? m[1].trim() : '';
  let body = String(md || '');
  if (m) body = body.slice(0, m.index) + body.slice(m.index + m[0].length);
  return { subject, body: body.trim() };
}

let gateCtx = null;

async function openGate() {
  if (!currentId) return;
  await flushSave(); // persist the latest body before we read it back
  let data;
  try {
    data = await api.json(`/api/docs/${currentId}`);
  } catch (e) {
    toast('Could not load this email: ' + e.message);
    return;
  }
  const env = (data.email && data.email.envelope) || {};
  $('#gate-to').value = (env.to || []).join(', ');
  $('#gate-cc').value = (env.cc || []).join(', ');
  $('#gate-bcc').value = (env.bcc || []).join(', ');
  const { subject, body } = splitEmailMd(data.markdown || '');
  $('#gate-subject').textContent = subject || '(no subject)';
  $('#gate-preview').innerHTML = typeof marked !== 'undefined' ? marked.parse(body) : escapeHtml(body);
  $('#gate-provenance').textContent =
    data.email && data.email.replyScope === 'sender'
      ? 'Reply to the sender of the thread (not reply-all). Confirm or edit the recipients.'
      : 'Confirm or edit the recipients before saving.';
  const caps = await getMailCaps();
  $('#gate-identity').textContent = caps.identityAddress ? `Saving as ${caps.identityAddress}` : `Saving to ${caps.server || 'your mailbox'}`;
  $('#gate-send').classList.toggle('hidden', !(caps.tools && caps.tools.send));
  gateCtx = { subject, body, data };
  gateLint();
  $('#gate-modal').classList.remove('hidden');
}

// Non-blocking warnings — surfaced, never enforced.
function gateLint() {
  if (!gateCtx) return;
  const { subject, body, data } = gateCtx;
  const warns = [];
  const to = parseList($('#gate-to').value);
  const total = to.length + parseList($('#gate-cc').value).length + parseList($('#gate-bcc').value).length;
  if (!to.length) warns.push('No “To” recipient — add at least one.');
  if (!subject.trim()) warns.push('The subject is empty.');
  const hasOutgoing = ((data.email && data.email.outgoing) || []).length > 0;
  if (/\battach(ed|ment|ments|ing)?\b/i.test(body) && !hasOutgoing) warns.push('The email mentions an attachment, but none is attached.');
  if (total >= 8) warns.push(`This will go to ${total} recipients.`);
  $('#gate-lint').innerHTML = warns.map((w) => `<div class="lint-item">⚠︎ ${escapeHtml(w)}</div>`).join('');
}

['gate-to', 'gate-cc', 'gate-bcc'].forEach((idd) => $('#' + idd).addEventListener('input', gateLint));
$('#gate-close').addEventListener('click', () => $('#gate-modal').classList.add('hidden'));
$('#gate-send').addEventListener('click', () => toast('Sending from the app is not available for this mailbox.'));

$('#gate-save').addEventListener('click', async () => {
  const btn = $('#gate-save');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Saving to Drafts…';
  try {
    const r = await api.json(`/api/docs/${currentId}/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: parseList($('#gate-to').value),
        cc: parseList($('#gate-cc').value),
        bcc: parseList($('#gate-bcc').value),
        model: settings.model,
      }),
    });
    $('#gate-modal').classList.add('hidden');
    toast(`Saved to Drafts in your mailbox (draft ${String(r.draftId).slice(0, 14)}…).`);
    const data = await api.json(`/api/docs/${currentId}`);
    applyMailChrome(data);
    renderCost(data.usage || []);
  } catch (e) {
    toast('Could not save draft: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// Footer actions open the gate (Save) or are gated out (Send, when unsupported).
$('#save-draft-btn').addEventListener('click', openGate);
$('#send-btn').addEventListener('click', () => toast('Sending from the app is not available for this mailbox.'));

// ---- attachments --------------------------------------------------------

const ATT_ICON = { image: '🖼', pdf: '📄', text: '📝', doc: '📃', other: '📎' };

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('could not read ' + file.name));
    r.readAsDataURL(file);
  });
}

async function uploadAttachment(docId, file) {
  const dataBase64 = await fileToBase64(file);
  return api.json(`/api/docs/${docId}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, type: file.type, dataBase64 }),
  });
}

// Home composer: pictures/documents chosen before drafting (held until a doc
// exists, then uploaded to it).
let pendingAttachments = [];

function renderChips() {
  // Shared pending-attachment list, mirrored into every composer's chip tray
  // (home and mail) so either entry point shows the same picks.
  document.querySelectorAll('.js-chips').forEach((ul) => {
    ul.innerHTML = '';
    pendingAttachments.forEach((f, i) => {
      const li = document.createElement('li');
      li.textContent = `${ATT_ICON[guessKind(f)] || '📎'} ${f.name}`;
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '✕';
      x.addEventListener('click', () => {
        pendingAttachments.splice(i, 1);
        renderChips();
      });
      li.appendChild(x);
      ul.appendChild(li);
    });
  });
}

function guessKind(file) {
  const t = file.type || '';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (t.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (t.startsWith('text/') || ['md', 'txt', 'csv'].includes(ext)) return 'text';
  return 'doc';
}

$('#attach-btn').addEventListener('click', () => $('#attach-input').click());
$('#attach-input').addEventListener('change', (e) => {
  pendingAttachments.push(...e.target.files);
  e.target.value = '';
  renderChips();
});

// Upload all pending home attachments to a freshly-created doc.
async function uploadPending(docId) {
  for (const f of pendingAttachments) {
    try {
      await uploadAttachment(docId, f);
    } catch (e) {
      toast('Upload failed for ' + f.name + ': ' + e.message);
    }
  }
  pendingAttachments = [];
  renderChips();
}

// "Let's talk about it first" — stash the starting idea, open the intake chat.
// briefKind carries whether the resulting draft is a document or an email.
let briefPremise = '';
let briefKind = '';
let briefEmailInit = null; // when planning a reply via the interview, carries its envelope/context
$('#talk-btn').addEventListener('click', () => {
  const premise = $('#premise').value.trim();
  if (!premise) {
    $('#premise').focus();
    return;
  }
  briefPremise = premise;
  briefKind = '';
  briefEmailInit = null;
  $('#premise').value = '';
  location.hash = '#/brief';
});

// ---- briefing (intake interview) ---------------------------------------

let intakeMessages = []; // [{ role: 'user' | 'assistant', content }]
let intakeUsage = []; // usage events from each interviewer turn (billed to the doc on draft)

function renderThread() {
  const t = $('#brief-thread');
  t.innerHTML = '';
  for (const m of intakeMessages) {
    const div = document.createElement('div');
    div.className = 'msg ' + m.role;
    div.textContent = m.content;
    t.appendChild(div);
  }
  t.scrollTop = t.scrollHeight;
}

function showThinking(on) {
  const existing = $('#brief-thread .thinking');
  if (on && !existing) {
    const div = document.createElement('div');
    div.className = 'msg assistant thinking';
    div.textContent = 'Claude is thinking…';
    $('#brief-thread').appendChild(div);
    $('#brief-thread').scrollTop = $('#brief-thread').scrollHeight;
  } else if (!on && existing) {
    existing.remove();
  }
}

async function intakeTurn() {
  showThinking(true);
  $('#brief-send').disabled = true;
  try {
    const { reply, usage } = await api.json('/api/intake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: intakeMessages, model: settings.model, effort: settings.effort }),
    });
    intakeMessages.push({ role: 'assistant', content: reply });
    if (usage) intakeUsage.push(usage);
  } catch (e) {
    intakeMessages.push({ role: 'assistant', content: '(Sorry — I hit an error: ' + e.message + '. You can still hit “Draft it now”.)' });
  } finally {
    showThinking(false);
    $('#brief-send').disabled = false;
    renderThread();
  }
}

async function showBrief() {
  show('brief');
  $('#doc-title').textContent = '';
  setStatus('');
  if (!briefPremise) {
    // No starting idea (e.g. reloaded straight onto #/brief) — send them home.
    location.hash = '#/';
    return;
  }
  intakeMessages = [{ role: 'user', content: briefPremise }];
  intakeUsage = [];
  briefPremise = ''; // consumed
  renderThread();
  $('#brief-input').focus();
  await intakeTurn(); // Claude asks its first questions
}

$('#brief-send').addEventListener('click', sendBriefMessage);
$('#brief-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    sendBriefMessage();
  }
});

async function sendBriefMessage() {
  const text = $('#brief-input').value.trim();
  if (!text) return;
  intakeMessages.push({ role: 'user', content: text });
  $('#brief-input').value = '';
  renderThread();
  await intakeTurn();
}

$('#brief-draft').addEventListener('click', async () => {
  if (!intakeMessages.length) return;
  const btn = $('#brief-draft');
  btn.disabled = true;
  btn.textContent = 'Preparing the brief…';
  try {
    // The original idea is the first user message; send the whole transcript.
    const premise = intakeMessages[0].content;
    const meta = await api.json('/api/docs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ premise, intake: intakeMessages, intakeUsage, model: settings.model, effort: settings.effort, kind: briefKind || undefined, email: briefEmailInit || undefined, voice: localStorage.getItem('de.skill') || null }),
    });
    briefEmailInit = null;
    if (pendingAttachments.length) {
      btn.textContent = 'Uploading attachments…';
      await uploadPending(meta.id);
    }
    location.hash = `#/doc/${meta.id}`;
  } catch (e) {
    toast('Could not start drafting: ' + e.message);
    btn.disabled = false;
    btn.textContent = 'Draft it now →';
  }
});

// ---- editor -------------------------------------------------------------

let currentId = null;
let currentBrief = null; // the doc's compiled brief, if it came from intake
let currentAttachments = []; // [{ id, name, kind, url, storedName }]

function renderAttachments() {
  $('#att-count').textContent = currentAttachments.length;
  const ul = $('#att-list');
  ul.innerHTML = '';
  for (const a of currentAttachments) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span>${ATT_ICON[a.kind] || '📎'}</span>` +
      `<span class="nm" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>` +
      `<span class="kind">${a.kind}</span>`;
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.title = 'Remove attachment';
    x.addEventListener('click', async () => {
      try {
        const res = await api.json(`/api/docs/${currentId}/attachments/${encodeURIComponent(a.storedName)}`, { method: 'DELETE' });
        currentAttachments = res.attachments || [];
        renderAttachments();
      } catch (e) {
        toast('Could not remove: ' + e.message);
      }
    });
    li.appendChild(x);
    ul.appendChild(li);
  }
}

$('#att-add').addEventListener('click', () => $('#att-input').click());
$('#att-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!currentId || !files.length) return;
  setStatus('● uploading');
  try {
    for (const f of files) {
      const att = await uploadAttachment(currentId, f);
      currentAttachments.push(att);
    }
    renderAttachments();
  } catch (e2) {
    toast('Upload failed: ' + e2.message);
  } finally {
    setStatus('');
  }
});
let comments = []; // { id, quote, note, range }
let commentSeq = 0;
let history = []; // [{ role, content }] — the conversation memory for this doc

function renderHistory() {
  const ol = $('#history');
  $('#hist-count').textContent = history.length;
  ol.innerHTML = '';
  history.forEach((h, i) => {
    const li = document.createElement('li');
    if (i === 0) li.className = 'premise';
    li.innerHTML = `<div class="label">${i === 0 ? 'Premise' : 'Revision ' + i}</div>` +
      `<div class="content">${escapeHtml(h.content)}</div>`;
    if (i > 0) {
      const btn = document.createElement('button');
      btn.className = 'prune';
      btn.textContent = '✕';
      btn.title = 'Forget this request (does not change the document)';
      btn.addEventListener('click', async () => {
        try {
          const res = await api.json(`/api/docs/${currentId}/history/${i}`, { method: 'DELETE' });
          history = res.history || history;
          renderHistory();
        } catch (e) {
          toast('Could not remove: ' + e.message);
        }
      });
      li.appendChild(btn);
    }
    ol.appendChild(li);
  });
}

$('#hist-toggle').addEventListener('click', () => {
  const hidden = $('#history-wrap').classList.toggle('hidden');
  const btn = $('#hist-toggle');
  btn.textContent = hidden ? 'show' : 'hide';
  btn.setAttribute('aria-expanded', String(!hidden));
});

async function showEditor(id) {
  show('editor');
  currentId = id;
  comments = [];
  renderComments();
  $('#instruction').value = '';
  const doc = $('#doc');
  doc.classList.remove('empty-state');

  let data;
  try {
    data = await api.json(`/api/docs/${id}`);
  } catch (e) {
    toast('Could not load document: ' + e.message);
    location.hash = '#/';
    return;
  }
  $('#doc-title').textContent = data.title || 'Untitled';
  history = data.history || [];
  currentBrief = data.brief || null;
  currentAttachments = data.attachments || [];
  renderHistory();
  renderAttachments();
  renderCost(data.usage || []);
  renderVersions(data.versions || []);
  applyMailChrome(data);
  loadPublishSkills(data);

  // Voice is strictly per-document: show this doc's own voice, or None if it has
  // none. No global fallback (that made every unset doc look the same, and let one
  // doc's voice bleed onto others). New docs inherit the default at creation, so a
  // first draft still uses your usual voice.
  settings.skill = data.voice || '';
  $('#sel-style').value = settings.skill;

  renderDocMemory(id, data);

  if (!data.markdown.trim()) {
    // Freshly created — stream the first draft from its premise/brief.
    $('#length-panel').classList.add('hidden');
    startGeneration(id);
  } else {
    renderDoc(data.html, true);
    updateLength(data.markdown);
  }
}

// ---- inline editing (WYSIWYG → Markdown autosave) ----------------------

const td =
  typeof TurndownService !== 'undefined'
    ? new TurndownService({
        headingStyle: 'atx',
        hr: '---',
        bulletListMarker: '-',
        codeBlockStyle: 'fenced',
        emDelimiter: '*',
        strongDelimiter: '**',
        linkStyle: 'inlined',
      })
    : null;
if (td && window.turndownPluginGfm) td.use(window.turndownPluginGfm.gfm);

let saveTimer = null;
let docDirty = false;

function setSaveState(text) {
  $('#save-state').textContent = text || '';
}

// Set the document HTML and optionally make it editable. Cancels any pending
// autosave so a stale timer can't overwrite programmatic (Claude/load) content.
function renderDoc(html, editable = true) {
  clearTimeout(saveTimer);
  docDirty = false;
  const doc = $('#doc');
  doc.classList.remove('empty-state');
  doc.innerHTML = html;
  // Only allow editing if the HTML→Markdown converter loaded (else read-only,
  // so we never let edits happen that we can't persist).
  doc.contentEditable = editable && td ? 'true' : 'false';
  setSaveState('');
}

function htmlToMarkdown() {
  return td.turndown($('#doc').innerHTML).trim();
}

async function doSave() {
  if (!currentId || !docDirty) return;
  docDirty = false;
  setSaveState('Saving…');
  try {
    const res = await api.json(`/api/docs/${currentId}/content`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: htmlToMarkdown() }),
    });
    if (res.title) {
      $('#doc-title').textContent = res.title;
      if (!$('#envelope').classList.contains('hidden')) $('#env-subject').textContent = res.title;
    }
    setSaveState('Saved');
    refreshVersions(); // reflect the (coalesced) manual-edit snapshot
    setTimeout(() => { if (!docDirty) setSaveState(''); }, 1500);
  } catch (e) {
    docDirty = true; // allow a retry on the next edit
    setSaveState('Save failed');
    toast('Autosave failed: ' + e.message);
  }
}

// Flush any pending edit immediately — call before a Claude op reads the doc.
async function flushSave() {
  clearTimeout(saveTimer);
  if (docDirty) await doSave();
}

$('#doc').addEventListener('input', () => {
  if ($('#doc').getAttribute('contenteditable') !== 'true') return;
  docDirty = true;
  setSaveState('Editing…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 1000);
});

// ---- version history + undo --------------------------------------------

let currentVersions = [];

function renderVersions(list) {
  if (list) currentVersions = list;
  $('#ver-count').textContent = currentVersions.length;
  $('#undo-btn').disabled = currentVersions.length < 2;
  const ul = $('#versions');
  ul.innerHTML = '';
  currentVersions.forEach((v, i) => {
    const li = document.createElement('li');
    li.className = 'kind-' + (v.kind || 'ai') + (i === 0 ? ' head' : '');
    li.innerHTML =
      `<span class="v-label"><span class="v-dot">●</span> ${escapeHtml(v.label)}</span>` +
      `<span class="v-time">${timeAgo(v.at)}</span>`;
    li.addEventListener('click', () => openDiff(v));
    ul.appendChild(li);
  });
}

async function refreshVersions() {
  if (!currentId) return;
  try {
    const { versions } = await api.json(`/api/docs/${currentId}/versions`);
    renderVersions(versions);
  } catch {
    /* non-fatal */
  }
}

$('#undo-btn').addEventListener('click', async () => {
  if (!currentId || currentVersions.length < 2) return;
  $('#undo-btn').disabled = true;
  try {
    await flushSave(); // ensure the change being undone is actually the latest
    const res = await api.json(`/api/docs/${currentId}/undo`, { method: 'POST' });
    renderDoc(res.html, true);
    $('#doc-title').textContent = res.title || 'Untitled';
    renderVersions(res.versions);
    updateLength(res.markdown);
    toast('Undid last change');
  } catch (e) {
    toast('Undo failed: ' + e.message);
    $('#undo-btn').disabled = false;
  }
});

// --- diff modal ---
let diffVid = null;

async function openDiff(v) {
  diffVid = v.vid;
  $('#diff-title').textContent = `${v.label} · ${timeAgo(v.at)}`;
  $('#diff-body').innerHTML = '<span class="none">Loading…</span>';
  $('#diff-modal').classList.remove('hidden');
  try {
    // Show what THIS snapshot changed: it vs the snapshot before it (both stored
    // Markdown — same lineage, so no turndown re-serialization noise).
    const { before, after } = await api.json(`/api/docs/${currentId}/versions/${v.vid}/diff`);
    renderDiff(before || '', after || '');
  } catch (e) {
    $('#diff-body').innerHTML = `<span class="none">Could not load: ${escapeHtml(e.message)}</span>`;
  }
}

function closeDiff() {
  $('#diff-modal').classList.add('hidden');
  diffVid = null;
}
$('#diff-close').addEventListener('click', closeDiff);
$('#diff-modal').addEventListener('click', (e) => {
  if (e.target.id === 'diff-modal') closeDiff();
});

$('#diff-restore').addEventListener('click', async () => {
  if (!diffVid) return;
  $('#diff-restore').disabled = true;
  try {
    await flushSave(); // snapshot the current state before replacing it
    const res = await api.json(`/api/docs/${currentId}/versions/${diffVid}/restore`, { method: 'POST' });
    renderDoc(res.html, true);
    $('#doc-title').textContent = res.title || 'Untitled';
    renderVersions(res.versions);
    updateLength(res.markdown);
    closeDiff();
    toast('Restored version');
  } catch (e) {
    toast('Restore failed: ' + e.message);
  } finally {
    $('#diff-restore').disabled = false;
  }
});

function renderDiff(oldText, newText) {
  const rows = lineDiff(oldText, newText);
  if (!rows.some((r) => r.t !== 'same')) {
    $('#diff-body').innerHTML = '<span class="none">No differences — this version matches the current document.</span>';
    return;
  }
  $('#diff-body').innerHTML = rows
    .map((r) => {
      const cls = r.t === 'add' ? 'add' : r.t === 'del' ? 'del' : 'same';
      const pfx = r.t === 'add' ? '+ ' : r.t === 'del' ? '- ' : '  ';
      return `<span class="${cls}">${escapeHtml(pfx + r.s) || '&nbsp;'}</span>`;
    })
    .join('');
}

// lineDiff() is loaded from /linediff.js (shared with the unit tests).

// ---- length readout + target adjustment --------------------------------

function countWords(md) {
  return (String(md).match(/[A-Za-z0-9’'\-]+/g) || []).length;
}

// ---- cost / usage -------------------------------------------------------

// Reduce an actual model id (e.g. claude-haiku-4-5-20251001) to a family name.
function modelFamily(m) {
  if (!m) return '';
  if (/opus/i.test(m)) return 'opus';
  if (/sonnet/i.test(m)) return 'sonnet';
  if (/haiku/i.test(m)) return 'haiku';
  return m;
}

function summarizeUsage(events = []) {
  const totals = { usd: 0, tokens: 0, byOp: {}, downgrades: [] };
  const dg = {};
  for (const e of events) {
    const tok = (e.input || 0) + (e.output || 0) + (e.cacheRead || 0) + (e.cacheCreation || 0);
    totals.usd += e.usd || 0;
    totals.tokens += tok;
    const op = e.op || 'other';
    const fam = modelFamily(e.model);
    const b = totals.byOp[op] || (totals.byOp[op] = { usd: 0, tokens: 0, count: 0, models: new Set() });
    b.usd += e.usd || 0;
    b.tokens += tok;
    b.count += 1;
    if (fam) b.models.add(fam);
    // Downgrade = an explicitly requested model that didn't match what actually ran.
    const req = (e.requested || '').toLowerCase();
    if (req && fam && req !== fam) {
      const k = req + '→' + fam;
      dg[k] = dg[k] || { requested: req, actual: fam, count: 0 };
      dg[k].count += 1;
    }
  }
  for (const op of Object.keys(totals.byOp)) totals.byOp[op].models = [...totals.byOp[op].models];
  totals.downgrades = Object.values(dg);
  return totals;
}

function fmtUsd(n) {
  if (n > 0 && n < 0.001) return '<$0.001';
  return '$' + (n < 1 ? n.toFixed(3) : n.toFixed(2));
}

function renderCost(events) {
  const panel = $('#cost-panel');
  if (!events || !events.length) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const s = summarizeUsage(events);
  $('#cost-usd').textContent = fmtUsd(s.usd);
  $('#cost-tokens').textContent = s.tokens.toLocaleString();

  // Warn when a requested model was silently downgraded (e.g. Opus rate limit).
  const warn = $('#cost-warn');
  if (s.downgrades.length) {
    warn.classList.remove('hidden');
    warn.innerHTML =
      '⚠ ' +
      s.downgrades
        .map((d) => `Requested <b>${d.requested}</b> but ran <b>${d.actual}</b> on ${d.count} call${d.count > 1 ? 's' : ''}`)
        .join('; ') +
      ' — likely a rate-limit downgrade on your subscription.';
  } else {
    warn.classList.add('hidden');
  }

  const ul = $('#cost-breakdown');
  ul.innerHTML = '';
  for (const [op, v] of Object.entries(s.byOp)) {
    const model = v.models.length ? v.models.join('/') : '—';
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="op">${op}${v.count > 1 ? ' ×' + v.count : ''} <span class="model">${model}</span></span>` +
      `<span>${fmtUsd(v.usd)} · ${v.tokens.toLocaleString()} tok</span>`;
    ul.appendChild(li);
  }
}

$('#cost-toggle').addEventListener('click', () => {
  const hidden = $('#cost-breakdown').classList.toggle('hidden');
  const btn = $('#cost-toggle');
  btn.textContent = hidden ? 'details' : 'hide';
  btn.setAttribute('aria-expanded', String(!hidden));
});

function updateLength(markdown) {
  const words = countWords(markdown);
  const minutes = Math.max(1, Math.round(words / 225));
  const panel = $('#length-panel');
  panel.classList.remove('hidden');
  $('#length-readout').textContent = `≈ ${words.toLocaleString()} words · ~${minutes} min read`;

  const target = currentBrief && currentBrief.targetWords;
  const targetEl = $('#length-target');
  if (!target) {
    targetEl.classList.add('hidden');
    return;
  }
  const off = Math.abs(words - target) / target;
  if (off <= 0.15) {
    targetEl.classList.add('hidden');
    return;
  }
  targetEl.classList.remove('hidden');
  const over = words > target;
  $('#length-target-text').textContent = `Target ~${target.toLocaleString()} words — ${over ? 'a bit long' : 'a bit short'}`;
  const btn = $('#length-adjust');
  btn.textContent = over ? 'Trim' : 'Expand';
  btn.onclick = () => adjustLength(target, over);
}

async function adjustLength(target, over) {
  const instruction = over
    ? `Tighten the document to approximately ${target} words. Cut redundancy, padding, and tangents; preserve every key point, the structure, and the tone.`
    : `Expand the document to approximately ${target} words. Add genuine depth, examples, and detail where it strengthens the piece — do not pad. Keep the structure, tone, and all existing points.`;
  $('#length-adjust').disabled = true;
  setStatus('● adjusting length');
  try {
    await flushSave(); // persist any manual edits before Claude reads the doc
    const res = await api.json(`/api/docs/${currentId}/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction, model: settings.model, effort: settings.effort, web: false, skill: settings.skill }),
    });
    renderDoc(res.html, true);
    if (res.history) {
      history = res.history;
      renderHistory();
    }
    updateLength(res.markdown);
    if (res.usage) renderCost(res.usage);
    refreshVersions();
    toast('Adjusted length.');
  } catch (e) {
    toast('Could not adjust: ' + e.message);
  } finally {
    $('#length-adjust').disabled = false;
    setStatus('');
  }
}

function startGeneration(id) {
  const doc = $('#doc');
  clearTimeout(saveTimer);
  docDirty = false;
  doc.contentEditable = 'false'; // not editable while being written
  doc.innerHTML = '';
  doc.classList.add('empty-state');
  doc.textContent = 'Claude is drafting…';
  setStatus('● drafting');
  setSaveState('');
  $('#revise-btn').disabled = true;

  let buf = '';
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    doc.classList.remove('empty-state');
    doc.innerHTML = marked.parse(buf);
  };

  const qs = new URLSearchParams();
  if (settings.model) qs.set('model', settings.model);
  if (settings.effort) qs.set('effort', settings.effort);
  qs.set('web', String(settings.web));
  if (settings.skill) qs.set('skill', settings.skill);
  const es = new EventSource(`/api/docs/${id}/generate?${qs}`);
  es.addEventListener('reset', () => {
    // Claude started a new turn (e.g. after web research) — drop interim text.
    buf = '';
    doc.textContent = settings.web ? 'Researching…' : 'Claude is drafting…';
    doc.classList.add('empty-state');
  });
  es.addEventListener('delta', (e) => {
    buf += JSON.parse(e.data).text;
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(flush);
    }
  });
  es.addEventListener('done', (e) => {
    const d = JSON.parse(e.data);
    renderDoc(d.html, true); // now editable
    $('#doc-title').textContent = d.title || 'Untitled';
    if (d.history) {
      history = d.history;
      renderHistory();
    }
    updateLength(d.markdown);
    if (d.usage) renderCost(d.usage);
    refreshVersions();
    setStatus('');
    $('#revise-btn').disabled = comments.length === 0 && !$('#instruction').value.trim();
    es.close();
  });
  es.addEventListener('error', (e) => {
    const msg = e.data ? JSON.parse(e.data).message : 'connection lost';
    setStatus('');
    doc.classList.remove('empty-state');
    if (!buf) doc.textContent = '';
    toast('Generation failed: ' + msg);
    es.close();
  });
}

$('#regen-btn').addEventListener('click', () => {
  if (!currentId) return;
  if (!confirm('Regenerate the whole document from its original premise? Current content will be replaced.')) return;
  comments = [];
  renderComments();
  startGeneration(currentId);
});

// ---- export -------------------------------------------------------------

document.querySelectorAll('.export-btn').forEach((btn) => {
  btn.addEventListener('click', () => exportDoc(btn.dataset.format, btn));
});

async function exportDoc(format, btn) {
  if (!currentId) return;
  btn.disabled = true;
  setStatus('● exporting ' + format);
  try {
    await flushSave(); // export the latest, including unsaved manual edits
    const qs = new URLSearchParams({ format });
    if (settings.model) qs.set('model', settings.model);
    if (settings.effort) qs.set('effort', settings.effort);
    const r = await fetch(`/api/docs/${currentId}/export?${qs}`);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || r.statusText);
    }
    const blob = await r.blob();
    const m = (r.headers.get('Content-Disposition') || '').match(/filename="(.+?)"/);
    const name = m ? m[1] : `document.${format}`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Exported ' + name);
  } catch (e) {
    toast('Export failed: ' + e.message);
  } finally {
    btn.disabled = false;
    setStatus('');
  }
}

// ---- publish (output skills) -------------------------------------------
// Discover installed output skills and offer them in the Publish panel. The app
// knows nothing about what each skill does; it shells out to the skill's plan/run.

async function loadPublishSkills(data) {
  const panel = $('#publish-panel');
  const list = $('#publish-list');
  list.innerHTML = '';
  // Publishing is a document action; hide it for emails (like Export).
  if (data && data.kind === 'email') { panel.classList.add('hidden'); return; }
  let skills = [];
  try {
    skills = (await api.json('/api/output-skills')).skills || [];
  } catch {
    skills = [];
  }
  if (!skills.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  for (const s of skills) {
    const btn = document.createElement('button');
    btn.className = 'export-btn publish-btn';
    btn.textContent = s.name || s.id;
    btn.title = s.description || '';
    btn.addEventListener('click', () => openPublishGate(s));
    list.appendChild(btn);
  }
}

let currentPublish = null; // { skillId, plan }

async function openPublishGate(skill) {
  if (!currentId) return;
  await flushSave(); // publish the latest, including unsaved edits
  currentPublish = { skillId: skill.id };
  $('#pub-title').textContent = `Review before publishing — ${skill.name || skill.id}`;
  $('#pub-inputs').innerHTML = '';
  $('#pub-inputs').dataset.sig = '';
  $('#pub-files').innerHTML = '<p class="hint">Preparing…</p>';
  $('#pub-commands').innerHTML = '';
  $('#pub-lint').innerHTML = '';
  $('#pub-preview').innerHTML = '';
  $('#pub-url-line').hidden = true;
  $('#pub-modal').classList.remove('hidden');
  await refreshPublishPlan({}); // first plan with the skill's defaults
}

// Read the current values of the skill-declared input controls.
function collectPublishParams() {
  const params = {};
  $('#pub-inputs').querySelectorAll('[data-key]').forEach((el) => { params[el.dataset.key] = el.value; });
  return params;
}

// Render the inputs the skill's plan declared (text / select). Rebuilds only when
// the input *set* changes, so re-planning (on a value change) never steals focus.
function renderPublishInputs(inputs) {
  const box = $('#pub-inputs');
  const sig = (inputs || []).map((i) => `${i.key}:${i.type}`).join('|');
  if (box.dataset.sig === sig && box.children.length) return;
  box.dataset.sig = sig;
  box.innerHTML = '';
  for (const inp of inputs || []) {
    const label = document.createElement('label');
    label.className = 'pub-input';
    label.appendChild(document.createTextNode(inp.label || inp.key));
    let ctrl;
    if (inp.type === 'select') {
      ctrl = document.createElement('select');
      for (const o of inp.options || []) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label || o.value;
        if (o.value === inp.value) opt.selected = true;
        ctrl.appendChild(opt);
      }
      ctrl.addEventListener('change', () => refreshPublishPlan(collectPublishParams()));
    } else {
      ctrl = document.createElement('input');
      ctrl.type = 'text';
      ctrl.value = inp.value || '';
      if (inp.placeholder) ctrl.placeholder = inp.placeholder;
      let t = null;
      ctrl.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => refreshPublishPlan(collectPublishParams()), 500); });
    }
    ctrl.dataset.key = inp.key;
    label.appendChild(ctrl);
    box.appendChild(label);
  }
}

// (Re)compute the plan and render the gate generically — the skill's plan is
// deterministic and side-effect-free, so we can re-plan on any input change.
async function refreshPublishPlan(params) {
  if (!currentPublish) return;
  let r;
  try {
    r = await api.json(`/api/docs/${currentId}/output/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillId: currentPublish.skillId, params: params || {} }),
    });
  } catch (e) {
    $('#pub-files').innerHTML = `<p class="hint">Could not prepare: ${escapeHtml(e.message)}</p>`;
    return;
  }
  const p = r.plan || {};
  currentPublish.plan = p;
  renderPublishInputs(p.inputs);
  $('#pub-url-line').hidden = !p.url;
  if (p.url) $('#pub-url').textContent = p.url;
  $('#pub-files').innerHTML = (p.files || [])
    .map((f) => `<div class="pub-file"><span class="pub-action pub-${escapeHtml(f.action)}">${escapeHtml(f.action)}</span> ${escapeHtml(f.path)}</div>`)
    .join('');
  $('#pub-commands').innerHTML = (p.commands || []).length
    ? '<div class="pub-cmd-h">Commands that will run</div>' + p.commands.map((c) => `<code class="pub-cmd">${escapeHtml(c)}</code>`).join('')
    : '';
  $('#pub-lint').innerHTML = (p.lint || []).map((w) => `<div class="lint-item">⚠︎ ${escapeHtml(w)}</div>`).join('');
  $('#pub-preview').innerHTML = p.previewHtml || '';
  $('#pub-target').textContent = p.target || (p.deploy && p.deploy.bucket ? `Deploys to ${p.deploy.bucket}` : '');
  $('#pub-go').textContent = p.overwrite ? 'Publish (overwrite)' : 'Publish';
}

$('#pub-close').addEventListener('click', () => $('#pub-modal').classList.add('hidden'));

$('#pub-go').addEventListener('click', async () => {
  if (!currentPublish) return;
  const btn = $('#pub-go');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Working…';
  try {
    const r = await api.json(`/api/docs/${currentId}/output/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillId: currentPublish.skillId, params: collectPublishParams() }),
    });
    $('#pub-modal').classList.add('hidden');
    const url = r.result && r.result.url;
    toast(url ? `Done: ${url}` : 'Done.');
  } catch (e) {
    toast('Failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
});

// ---- text selection → comment ------------------------------------------

const popover = $('#sel-popover');
let pendingRange = null;

document.addEventListener('selectionchange', () => {
  // Hide popover if selection is cleared.
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    popover.classList.add('hidden');
  }
});

$('#doc').addEventListener('mouseup', () => {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return;
  const text = sel.toString().trim();
  const docEl = $('#doc');
  if (!text || !docEl.contains(sel.anchorNode)) return;

  pendingRange = sel.getRangeAt(0).cloneRange();
  const rect = pendingRange.getBoundingClientRect();
  popover.style.top = `${rect.top + window.scrollY}px`;
  popover.style.left = `${rect.left + rect.width / 2 + window.scrollX}px`;
  popover.classList.remove('hidden');
});

// Make links in the document clickable. The document is contentEditable, so browsers
// place the text cursor instead of following a link on click; we open it ourselves,
// in a new tab. Only http(s)/mailto are opened (never javascript:/data:), and not
// while the user is drag-selecting text (that's a comment selection, not a click).
$('#doc').addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || !$('#doc').contains(a)) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim()) return; // selecting, not clicking
  const href = a.getAttribute('href') || '';
  if (!/^(https?:|mailto:)/i.test(href.trim())) return; // safe schemes only
  e.preventDefault();
  window.open(href.trim(), '_blank', 'noopener,noreferrer');
});

$('#sel-comment-btn').addEventListener('click', () => {
  if (!pendingRange) return;
  const quote = pendingRange.toString().trim();
  comments.push({ id: ++commentSeq, quote, note: '', range: pendingRange });
  popover.classList.add('hidden');
  window.getSelection().removeAllRanges();
  renderComments();
  // Focus the note field of the comment just added.
  setTimeout(() => {
    const last = document.querySelector('.comment:last-child textarea');
    if (last) last.focus();
  }, 0);
});

function renderComments() {
  const ul = $('#comments');
  ul.innerHTML = '';
  $('#comment-count').textContent = comments.length;
  $('#comments-hint').classList.toggle('hidden', comments.length > 0);

  for (const c of comments) {
    const li = document.createElement('li');
    li.className = 'comment';
    li.innerHTML = `
      <div class="quote">“${escapeHtml(c.quote)}”</div>
      <textarea placeholder="What should change here?">${escapeHtml(c.note)}</textarea>
      <div class="row"><button class="remove">remove</button></div>`;
    const ta = li.querySelector('textarea');
    ta.addEventListener('input', () => {
      c.note = ta.value;
      refreshReviseEnabled();
    });
    li.querySelector('.remove').addEventListener('click', () => {
      comments = comments.filter((x) => x.id !== c.id);
      renderComments();
    });
    ul.appendChild(li);
  }
  highlightComments();
  refreshReviseEnabled();
}

function highlightComments() {
  if (!HAS_HIGHLIGHT) return;
  const h = new Highlight();
  for (const c of comments) {
    try {
      h.add(c.range);
    } catch {}
  }
  CSS.highlights.set('comment-quote', h);
}

$('#instruction').addEventListener('input', refreshReviseEnabled);

function refreshReviseEnabled() {
  const hasWork = comments.some((c) => c.note.trim()) || $('#instruction').value.trim();
  $('#revise-btn').disabled = !hasWork;
}

// ---- revise -------------------------------------------------------------

$('#revise-btn').addEventListener('click', async () => {
  if (!currentId) return;
  const payload = {
    comments: comments.filter((c) => c.note.trim()).map((c) => ({ quote: c.quote, note: c.note.trim() })),
    instruction: $('#instruction').value.trim(),
    model: settings.model,
    effort: settings.effort,
    web: settings.web,
    skill: settings.skill,
  };
  if (!payload.comments.length && !payload.instruction) return;

  $('#revise-btn').disabled = true;
  setStatus('● revising');
  if (HAS_HIGHLIGHT) CSS.highlights.delete('comment-quote');

  try {
    await flushSave(); // persist any manual edits before Claude reads the doc
    const res = await api.json(`/api/docs/${currentId}/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const doc = $('#doc');
    renderDoc(res.html, true);
    doc.classList.remove('flash');
    void doc.offsetWidth; // restart animation
    doc.classList.add('flash');
    $('#doc-title').textContent = res.title || 'Untitled';

    comments = [];
    $('#instruction').value = '';
    renderComments();
    if (res.history) {
      history = res.history;
      renderHistory();
    }
    updateLength(res.markdown);
    if (res.usage) renderCost(res.usage);
    refreshVersions();

    if (res.groundingDegraded) toast('Revised, but planning-context grounding was unavailable this time.', 5000);
    const ok = res.applied.filter((a) => a.ok).length;
    const failed = res.applied.filter((a) => !a.ok);
    highlightChanges(res.applied.filter((a) => a.ok && a.replace));
    if (failed.length) {
      toast(`Applied ${ok} edit${ok === 1 ? '' : 's'}; ${failed.length} couldn’t be located.`);
    } else if (ok) {
      toast(`Applied ${ok} edit${ok === 1 ? '' : 's'}.`);
    } else {
      toast('Claude suggested no changes.');
    }
  } catch (e) {
    toast('Revision failed: ' + e.message);
  } finally {
    setStatus('');
    refreshReviseEnabled();
  }
});

// Briefly highlight freshly-changed text in the re-rendered document.
function highlightChanges(appliedEdits) {
  if (!HAS_HIGHLIGHT || !appliedEdits.length) return;
  const h = new Highlight();
  for (const a of appliedEdits) {
    const needle = (a.replace || '').trim().split('\n')[0].trim();
    if (needle.length < 3) continue;
    for (const r of findTextRanges($('#doc'), needle)) h.add(r);
  }
  CSS.highlights.set('recent-change', h);
  setTimeout(() => CSS.highlights.delete('recent-change'), 4000);
}

// Find ranges where `text` appears within a single text node under root.
function findTextRanges(root, text) {
  const ranges = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const idx = node.nodeValue.indexOf(text);
    if (idx !== -1) {
      const r = document.createRange();
      r.setStart(node, idx);
      r.setEnd(node, idx + text.length);
      ranges.push(r);
    }
  }
  return ranges;
}

// ---- util ---------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- learn from my edits (the personalization loop) ---------------------
$('#learn-btn').addEventListener('click', runLearn);
$('#learn-close').addEventListener('click', () => $('#learn-modal').classList.add('hidden'));
$('#learn-modal').addEventListener('click', (e) => { if (e.target.id === 'learn-modal') $('#learn-modal').classList.add('hidden'); });

async function runLearn() {
  if (!currentId) return;
  const btn = $('#learn-btn');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Analyzing your edits…';
  try {
    await flushSave();
    const r = await api.json(`/api/docs/${currentId}/learn/propose`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: settings.model || 'haiku' }),
    });
    renderLearn(r);
    $('#learn-modal').classList.remove('hidden');
  } catch (e) {
    toast('Learn failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

function renderLearn(r) {
  $('#learn-note').textContent =
    `${r.events || 0} edit event(s) analyzed` + (r.capped ? ' (most recent capped)' : '') +
    (r.voiceId ? ` · voice: ${r.voiceId}` : ' · no voice set');
  const groups = [
    ['Voice — how you write', r.voiceCandidates || [], 'voice'],
    ['Context — about you', r.contextCandidates || [], 'context'],
    ['For Claude — fixes to how it works (not your voice)', r.feedbackCandidates || [], 'claude'],
  ];
  const total = groups.reduce((n, g) => n + g[1].length, 0);
  const body = $('#learn-body');
  if (!total) {
    body.innerHTML = '<p class="hint">No durable lessons found in these edits. That can be the right answer.</p>';
    return;
  }
  // Only VOICE lessons need a voice; context now goes to memory and claude to feedback.
  const needsVoice = !r.voiceId && (r.voiceCandidates || []).length;
  body.innerHTML =
    (needsVoice ? '<p class="hint">This document has no voice selected, so voice lessons can\'t be saved. Pick a voice in the top bar first. (Context and correction lessons still work.)</p>' : '') +
    groups.filter((g) => g[1].length).map(([title, items, target]) => (
      `<div class="learn-group"><h4>${escapeHtml(title)}</h4>` +
      items.map((c, i) => (
        `<div class="learn-card" data-target="${target}" data-i="${i}">` +
          `<div class="learn-obs">${escapeHtml(c.observation || c.text)}</div>` +
          (c.observation && c.text !== c.observation ? `<div class="learn-text">${escapeHtml(c.text)}</div>` : '') +
          (c.subtype ? `<span class="learn-sub">${escapeHtml(c.subtype)}</span>` : '') +
          `<div class="learn-actions"><button class="mini learn-keep">Keep</button><button class="mini learn-dismiss">Dismiss</button></div>` +
        `</div>`
      )).join('') + '</div>'
    )).join('');
  const pick = (target, i) => (({ voice: r.voiceCandidates, context: r.contextCandidates, claude: r.feedbackCandidates }[target]) || [])[i];
  body.querySelectorAll('.learn-card').forEach((card) => {
    const cand = pick(card.dataset.target, Number(card.dataset.i));
    card.querySelector('.learn-keep').addEventListener('click', async () => {
      try {
        const resp = await api.json(`/api/docs/${currentId}/learn/apply`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ voiceId: r.voiceId, candidate: cand }),
        });
        card.querySelector('.learn-actions').innerHTML = '<span class="hint">kept ✓</span>';
        const where = { voice: 'Added to your voice', memory: 'Added to your memory', feedback: 'Saved as a guardrail to avoid' }[resp.where] || 'Kept';
        toast(where);
      } catch (e) { toast('Could not keep: ' + e.message); }
    });
    card.querySelector('.learn-dismiss').addEventListener('click', () => {
      card.querySelector('.learn-actions').innerHTML = '<span class="hint">dismissed</span>';
      // Record the dismissal so the keep-rate has a denominator (fire-and-forget).
      api.json(`/api/docs/${currentId}/learn/dismiss`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: r.voiceId, candidate: cand }),
      }).catch(() => {});
    });
  });
}

// ---- profile / personal memory -----------------------------------------

// Strip the dangerous bits from rendered HTML before innerHTML. Memory content is
// user-authored but ALSO LLM-written (capture) and writable by other tools via the
// projected ~/.claude/USER.md, so treat it as untrusted. Not DOMPurify-grade, but it
// removes the practical vectors: script/embed tags, on* handlers, javascript:/data: URLs.
function sanitizeHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('script, style, iframe, object, embed, link, meta, form').forEach((n) => n.remove());
  tpl.content.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(a.name);
      else if ((n === 'href' || n === 'src' || n === 'xlink:href') && /^\s*(javascript|data):/i.test(a.value)) el.removeAttribute(a.name);
    }
  });
  return tpl.innerHTML;
}

function mdToHtml(md) {
  try { if (window.marked) return sanitizeHtml(window.marked.parse(md || '')); } catch { /* fall through */ }
  return `<pre>${escapeHtml(md || '')}</pre>`;
}

async function showProfile() {
  show('profile');
  setStatus('');
  try {
    renderMemory(await api.json('/api/memory'));
  } catch (e) {
    toast('Could not load memory: ' + e.message);
  }
  // Voice-learning signal (independent of memory; don't block the rest on it).
  try { renderLearnLog(await api.json('/api/learn/log')); }
  catch { $('#learn-stats').textContent = ''; $('#learn-log').innerHTML = '<li class="hint">Could not load.</li>'; }
  loadVoicePicker();
}

// "Your voice": populate the dropdown from the available voices; selecting one loads
// its preamble (editable) + learned rules (read-only) into the editor.
async function loadVoicePicker() {
  let list = [];
  try { list = await api.json('/api/skills'); } catch { return; }
  const sel = $('#voice-pick');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Select a voice…</option>' +
    list.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name + (s.source === 'project' ? ' (project)' : ''))}</option>`).join('');
  // keep the selection if it still exists, else collapse the editor
  if (cur && list.some((s) => s.id === cur)) sel.value = cur;
  else $('#voice-editor').classList.add('hidden');
}
$('#voice-pick').addEventListener('change', async () => {
  const id = $('#voice-pick').value;
  if (!id) { $('#voice-editor').classList.add('hidden'); return; }
  try {
    const v = await api.json(`/api/voices/${encodeURIComponent(id)}`);
    $('#voice-preamble').value = v.preamble || '';
    $('#voice-rules').innerHTML = (v.rules || []).length
      ? v.rules.map((r) => `<li>${escapeHtml(r.text)}</li>`).join('')
      : '<li class="hint">No learned rules yet — they appear here as you keep voice lessons.</li>';
    $('#voice-save-state').textContent = '';
    $('#voice-editor').classList.remove('hidden');
  } catch (e) { toast('Could not load voice: ' + e.message); }
});
$('#voice-save').addEventListener('click', async () => {
  const id = $('#voice-pick').value;
  if (!id) return;
  try {
    await api.json(`/api/voices/${encodeURIComponent(id)}/preamble`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: $('#voice-preamble').value }) });
    $('#voice-save-state').textContent = 'Saved.';
    toast('Voice updated');
  } catch (e) { toast('Could not save: ' + e.message); }
});

function renderLearnLog(data) {
  const s = data.summary || { kept: 0, dismissed: 0, total: 0, keepRate: null, byClass: {} };
  $('#learn-keeprate').textContent = s.total ? `${Math.round((s.keepRate || 0) * 100)}% kept` : '—';
  $('#learn-stats').innerHTML = s.total
    ? `<div class="learn-rate">${s.kept} kept · ${s.dismissed} dismissed of ${s.total} reviewed</div>` +
      '<div class="learn-byclass">' + Object.entries(s.byClass).map(([c, v]) => {
        const t = (v.kept || 0) + (v.dismissed || 0);
        return `<span class="lc">${escapeHtml(c)}: ${v.kept || 0}/${t}</span>`;
      }).join('') + '</div>'
    : '<p class="hint">No data yet. Use "Learn from my edits" in a document, then keep or dismiss the proposals.</p>';
  const recent = data.recent || [];
  $('#learn-log').innerHTML = recent.length
    ? recent.map((e) => (
        `<li class="ll-item ll-${e.decision}">` +
          `<span class="ll-badge">${e.decision === 'kept' ? 'kept ✓' : 'dismissed ✕'}</span>` +
          `<span class="ll-class">${escapeHtml(e.target)}</span>` +
          `<span class="ll-obs">${escapeHtml(e.observation || e.text)}</span>` +
        `</li>`
      )).join('')
    : '';
}

function renderMemory(data) {
  const queue = data.queue || [];
  const kept = data.kept || [];
  $('#mem-queue-count').textContent = queue.length;
  $('#mem-kept-count').textContent = kept.length;

  $('#mem-queue').innerHTML = queue.length
    ? queue.map((it) => (
        `<li class="mem-item" data-id="${it.id}">` +
          `<div class="mem-text">${escapeHtml(it.text)}</div>` +
          `<div class="mem-meta">${escapeHtml(it.topic)}${it.topic === 'profile' && it.section ? ' · ' + escapeHtml(it.section) : ''}${it.provenance ? ' · ' + escapeHtml(it.provenance) : ''}</div>` +
          `<div class="mem-actions"><button class="mini mem-keep">Keep</button><button class="mini mem-discard">Discard</button></div>` +
        `</li>`
      )).join('')
    : '<li class="hint">Nothing waiting. Facts appear here after you plan a document with “Let\'s talk about it first.”</li>';

  $('#mem-kept').innerHTML = kept.length
    ? kept.map((it) => (
        `<li class="mem-item" data-id="${it.id}"><div class="mem-text">${escapeHtml(it.text)}</div>` +
        `<div class="mem-actions"><button class="mini mem-forget">Forget</button></div></li>`
      )).join('')
    : '<li class="hint">No facts kept yet.</li>';

  $('#mem-topics').innerHTML = (data.topics || []).length
    ? data.topics.map((t) => `<li class="chip topic-chip" data-topic="${escapeHtml(t)}" title="View or edit this topic">${escapeHtml(t)}</li>`).join('')
    : '<li class="hint">none</li>';

  $('#mem-profile-view').innerHTML = data.profile ? mdToHtml(data.profile) : '<p class="hint">No profile yet. Keep a fact, or click edit to write one.</p>';
  $('#mem-profile-text').value = data.profile || '';
  $('#mem-profile-editor').classList.add('hidden');
  $('#mem-profile-view').classList.remove('hidden');

  const act = async (url, id) => {
    try { await api.json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); showProfile(); }
    catch (e) { toast('Failed: ' + e.message); }
  };
  $('#mem-queue').querySelectorAll('.mem-item').forEach((li) => {
    li.querySelector('.mem-keep').addEventListener('click', () => act('/api/memory/keep', li.dataset.id));
    li.querySelector('.mem-discard').addEventListener('click', () => act('/api/memory/discard', li.dataset.id));
  });
  $('#mem-kept').querySelectorAll('.mem-item').forEach((li) => {
    li.querySelector('.mem-forget').addEventListener('click', async () => {
      try {
        const r = await api.json('/api/memory/forget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: li.dataset.id }) });
        if (r.item && r.item.removed === false) toast('Forgotten, but its exact line was not found in USER.md — edit the profile directly if it is still there.', 6000);
        else toast('Forgotten');
        showProfile();
      } catch (e) { toast('Could not forget: ' + e.message); }
    });
  });
  $('#mem-topics').querySelectorAll('.topic-chip').forEach((li) => {
    li.addEventListener('click', () => openTopic(li.dataset.topic));
  });
}

// Topic file viewer/editor (step 6): click a topic chip to read/edit/delete it.
let currentTopic = null;
async function openTopic(name) {
  try {
    const r = await api.json(`/api/memory/topic/${encodeURIComponent(name)}`);
    currentTopic = name;
    $('#topic-modal-title').textContent = 'Topic: ' + name;
    $('#topic-text').value = r.markdown || '';
    $('#topic-modal').classList.remove('hidden');
    $('#topic-text').focus();
  } catch (e) { toast('Could not open topic: ' + e.message); }
}
$('#topic-close').addEventListener('click', () => $('#topic-modal').classList.add('hidden'));
$('#topic-modal').addEventListener('click', (e) => { if (e.target.id === 'topic-modal') $('#topic-modal').classList.add('hidden'); });
$('#topic-save').addEventListener('click', async () => {
  if (!currentTopic) return;
  try {
    await api.json(`/api/memory/topic/${encodeURIComponent(currentTopic)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: $('#topic-text').value }) });
    toast('Topic saved');
    $('#topic-modal').classList.add('hidden');
    showProfile();
  } catch (e) { toast('Could not save: ' + e.message); }
});
$('#topic-delete').addEventListener('click', async () => {
  if (!currentTopic) return;
  try {
    await api.json(`/api/memory/topic/${encodeURIComponent(currentTopic)}`, { method: 'DELETE' });
    toast('Topic deleted');
    $('#topic-modal').classList.add('hidden');
    showProfile();
  } catch (e) { toast('Could not delete: ' + e.message); }
});

// Static profile controls (wired once).
$('#mem-profile-edit').addEventListener('click', () => {
  $('#mem-profile-view').classList.add('hidden');
  $('#mem-profile-editor').classList.remove('hidden');
  $('#mem-profile-text').focus();
});
$('#mem-profile-cancel').addEventListener('click', () => {
  $('#mem-profile-editor').classList.add('hidden');
  $('#mem-profile-view').classList.remove('hidden');
});
$('#mem-profile-save').addEventListener('click', async () => {
  try {
    await api.json('/api/memory/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: $('#mem-profile-text').value }) });
    toast('Profile saved');
    showProfile();
  } catch (e) { toast('Could not save: ' + e.message); }
});
$('#mem-sync').addEventListener('click', async () => {
  const btn = $('#mem-sync');
  btn.disabled = true;
  try {
    const r = await api.json('/api/memory/sync', { method: 'POST' });
    $('#mem-sync-state').textContent = r.alreadyImported
      ? `Linked ${r.link} (${r.linkMode}). It's already imported in ~/.claude/CLAUDE.md.`
      : `Linked ${r.link} (${r.linkMode}). To share with your other Claude sessions, add this line to ~/.claude/CLAUDE.md yourself:  ${r.importLine}`;
    toast('Profile linked into ~/.claude');
  } catch (e) {
    $('#mem-sync-state').textContent = 'Sync failed: ' + e.message;
    toast('Sync failed: ' + e.message);
  } finally { btn.disabled = false; }
});

// Per-document memory panel in the editor: the output-facts toggle + a summary of
// what this draft will use. Called from showEditor; data is the loaded doc meta.
async function renderDocMemory(id, data) {
  $('#mem-use-facts').checked = !!data.usePersonalFacts;
  const sum = $('#mem-doc-summary');
  sum.textContent = 'Checking what this draft will use…';
  try {
    const ctx = await api.json(`/api/docs/${id}/context`);
    if (currentId !== id) return; // navigated away mid-fetch
    if (!ctx.memory.enabled) {
      sum.textContent = 'No personal memory yet. Plan a doc with “Let\'s talk about it first,” then keep facts in Profile.';
      return;
    }
    const bits = [ctx.memory.profile ? 'your profile' : 'no profile'];
    if (ctx.memory.topics.length) bits.push('topics: ' + ctx.memory.topics.join(', '));
    sum.textContent = 'Grounded in ' + bits.join(' · ') + '.';
  } catch { if (currentId === id) sum.textContent = 'Could not load what this draft will use.'; }
}
$('#mem-use-facts').addEventListener('change', async () => {
  if (!currentId) return;
  try {
    await api.json(`/api/docs/${currentId}/use-personal-facts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: $('#mem-use-facts').checked }) });
  } catch (e) {
    // Revert the checkbox to server truth — a swallowed failure here would leave this
    // privacy control showing the opposite of what the server will actually do.
    $('#mem-use-facts').checked = !$('#mem-use-facts').checked;
    toast('Could not update: ' + e.message);
  }
});

// Hide model options the installed CLI can't run (e.g. Fable on an older CLI), so
// selecting one can never fail mid-draft. Best-effort: if the check fails, leave the
// dropdown untouched. If the saved choice is now unavailable, fall back to Default.
async function gateModels() {
  let models;
  try { ({ models } = await api.json('/api/models')); } catch { return; }
  if (!Array.isArray(models)) return;
  $('#sel-model').querySelectorAll('option[value]').forEach((o) => {
    if (o.value && !models.includes(o.value)) {
      o.remove();
      if (settings.model === o.value) {
        settings.model = '';
        localStorage.removeItem('de.model');
        $('#sel-model').value = '';
      }
    }
  });
}

// boot
initPicker();
loadSkills();
gateModels();
route();
