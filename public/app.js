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
  const hash = location.hash || '#/';
  const m = hash.match(/^#\/doc\/(.+)$/);
  if (m) showEditor(m[1]);
  else if (hash === '#/brief') showBrief();
  else showHome();
}
window.addEventListener('hashchange', route);

function show(view) {
  $('#view-home').classList.toggle('hidden', view !== 'home');
  $('#view-brief').classList.toggle('hidden', view !== 'brief');
  $('#view-editor').classList.toggle('hidden', view !== 'editor');
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
      body: JSON.stringify({ premise }),
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
  const ul = $('#attach-chips');
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
let briefPremise = '';
$('#talk-btn').addEventListener('click', () => {
  const premise = $('#premise').value.trim();
  if (!premise) {
    $('#premise').focus();
    return;
  }
  briefPremise = premise;
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
      body: JSON.stringify({ premise, intake: intakeMessages, intakeUsage, model: settings.model, effort: settings.effort }),
    });
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

  if (!data.markdown.trim()) {
    // Freshly created — stream the first draft from its premise/brief.
    $('#length-panel').classList.add('hidden');
    startGeneration(id);
  } else {
    doc.innerHTML = data.html;
    updateLength(data.markdown);
  }
}

// ---- length readout + target adjustment --------------------------------

function countWords(md) {
  return (String(md).match(/[A-Za-z0-9’'\-]+/g) || []).length;
}

// ---- cost / usage -------------------------------------------------------

function summarizeUsage(events = []) {
  const totals = { usd: 0, tokens: 0, byOp: {} };
  for (const e of events) {
    const tok = (e.input || 0) + (e.output || 0) + (e.cacheRead || 0) + (e.cacheCreation || 0);
    totals.usd += e.usd || 0;
    totals.tokens += tok;
    const op = e.op || 'other';
    totals.byOp[op] = totals.byOp[op] || { usd: 0, tokens: 0, count: 0 };
    totals.byOp[op].usd += e.usd || 0;
    totals.byOp[op].tokens += tok;
    totals.byOp[op].count += 1;
  }
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
  const ul = $('#cost-breakdown');
  ul.innerHTML = '';
  for (const [op, v] of Object.entries(s.byOp)) {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="op">${op}${v.count > 1 ? ' ×' + v.count : ''}</span>` +
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
    const res = await api.json(`/api/docs/${currentId}/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction, model: settings.model, effort: settings.effort, web: false, skill: settings.skill }),
    });
    $('#doc').innerHTML = res.html;
    if (res.history) {
      history = res.history;
      renderHistory();
    }
    updateLength(res.markdown);
    if (res.usage) renderCost(res.usage);
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
  doc.innerHTML = '';
  doc.classList.add('empty-state');
  doc.textContent = 'Claude is drafting…';
  setStatus('● drafting');
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
    doc.classList.remove('empty-state');
    doc.innerHTML = d.html;
    $('#doc-title').textContent = d.title || 'Untitled';
    if (d.history) {
      history = d.history;
      renderHistory();
    }
    updateLength(d.markdown);
    if (d.usage) renderCost(d.usage);
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
    const res = await api.json(`/api/docs/${currentId}/revise`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const doc = $('#doc');
    doc.innerHTML = res.html;
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

// boot
initPicker();
loadSkills();
route();
