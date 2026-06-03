// Bridges the app to the local `claude` CLI (headless / -p mode).
// Reuses the user's existing Claude Code authentication — no API key needed.
//
// Two operations:
//   generate() — streams a fresh document (SSE-friendly delta callbacks)
//   revise()   — returns a minimal set of find/replace edits for the document

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Writing calls run in a neutral, empty working directory so the `claude` CLI
// does NOT auto-load the project's CLAUDE.md (or other project context) into
// every prompt — that was inflating cache-creation tokens ~25x and cost ~7x.
// Attachment files (under the project) are granted explicitly via --add-dir.
const RUN_DIR = path.join(os.tmpdir(), 'doc-editor-run');
try {
  fs.mkdirSync(RUN_DIR, { recursive: true });
} catch {
  /* best effort */
}

const GENERATE_SYSTEM = `You are an expert writing engine that produces polished, well-structured documents.

The user gives you a premise or request. Respond with ONLY the complete document in GitHub-flavored Markdown:
- Begin with a single H1 title (# Title).
- Use headings, lists, tables, bold/italic, blockquotes, and code blocks where they genuinely help.
- Write the full document, not an outline, unless an outline is explicitly requested.

Do NOT include any preamble, commentary, or explanation of what you did. Do NOT wrap the document in a code fence.`;

const REVISE_SYSTEM = `You are a precise document editor. You are given a document in Markdown and one or more edit requests. Each request quotes a passage from the document and gives an instruction.

Apply the requested changes as a MINIMAL set of find/replace edits. Return ONLY a JSON object (no code fence, no commentary) of the form:

{"edits":[{"find":"<exact verbatim substring of the current document>","replace":"<new text>"}]}

Rules:
- "find" MUST be copied verbatim from the document, character-for-character, and be long enough to occur EXACTLY ONCE. Include surrounding words if needed for uniqueness.
- Keep each change localized; do not rewrite unrelated parts of the document.
- Preserve Markdown formatting.
- To delete text, set "replace" to an empty string (include enough surrounding context in "find" so the result reads cleanly).
- Produce one edit per distinct change; you may return multiple edits.
- If a request cannot be satisfied, omit it rather than guessing.`;

// Wrap a chosen skill/voice guide for appending to a writing system prompt.
// It governs HOW the text reads (tone, rhythm, word choice), never the facts.
function styleNote(style) {
  if (!style || !String(style).trim()) return '';
  return (
    '\n\n----- VOICE & STYLE GUIDE -----\n' +
    'Write in the following voice. It governs tone, rhythm, structure, and word ' +
    'choice — i.e. HOW you write — never the facts or the request itself (WHAT you ' +
    'write). Follow it closely.\n\n' +
    String(style).trim()
  );
}

// Appended to the system prompt depending on whether web research is enabled.
const NO_TOOLS_NOTE = '\n\nYou have no tools; rely solely on your own knowledge.';
const WEB_TOOLS_NOTE =
  '\n\nYou may use the WebSearch and WebFetch tools to research facts and to read any URLs mentioned in the request. Use them whenever the task depends on external, current, or linked information, then base your writing on what you find. Do not narrate your research — the output must contain only the requested document/edits.';

// Expose only the read-only tools that are needed, and pre-approve them (so
// headless mode doesn't silently deny them). `web` adds WebFetch/WebSearch;
// `read` adds Read (for attached reference files/images). Write/Bash/Edit are
// never exposed. With neither, no tools at all — fast, offline writing.
function toolArgs({ web, read } = {}) {
  const tools = [];
  if (read) tools.push('Read');
  if (web) tools.push('WebFetch', 'WebSearch');
  if (!tools.length) return ['--tools', 'none'];
  return ['--tools', ...tools, '--allowedTools', ...tools];
}

// Appended to the writing system prompt when the user has attached references.
const ATTACH_NOTE =
  '\n\n----- ATTACHED REFERENCES -----\n' +
  'The user has attached reference materials; their paths are listed in the prompt. ' +
  'Read each one first — including images — with your Read tool, and treat them as source/input. ' +
  'Use your own judgment about how to use them: draw facts, structure, or detail from documents where relevant, ' +
  'and include an image in the document ONLY if it genuinely strengthens it (otherwise leave it out). ' +
  'When you do include an image, embed it using the EXACT Markdown URL given for that image. ' +
  'Your output must still be only the document/edits — no commentary about the references.';

// Valid model aliases and effort levels accepted by the CLI. Anything else is
// ignored (falls back to the user's configured defaults) rather than passed
// through, so the browser can never inject arbitrary flags.
const MODELS = new Set(['opus', 'sonnet', 'haiku']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function modelEffortArgs({ model, effort } = {}) {
  const args = [];
  if (model && MODELS.has(model)) args.push('--model', model);
  if (effort && EFFORTS.has(effort)) args.push('--effort', effort);
  return args;
}

// Spawn claude in print mode, feeding the prompt over stdin (avoids argv limits).
// Runs in RUN_DIR (no CLAUDE.md). `addDir` grants Read access to a project path
// (e.g. a doc's attachments) since we're no longer in the project cwd.
function spawnClaude(args, prompt, { addDir } = {}) {
  const finalArgs = ['-p', ...args, ...(addDir ? ['--add-dir', addDir] : [])];
  const child = spawn('claude', finalArgs, {
    cwd: RUN_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(prompt);
  child.stdin.end();
  return child;
}

// Normalize the usage/cost fields the CLI reports (same shape for the stream
// `result` event and the `--output-format json` envelope).
const ZERO_USAGE = { model: null, usd: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

function extractUsage(o = {}) {
  const u = (o && o.usage) || {};
  const model = o && o.modelUsage ? Object.keys(o.modelUsage)[0] : (o && o.model) || null;
  return {
    model: model || null,
    usd: (o && o.total_cost_usd) || 0,
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreation: u.cache_creation_input_tokens || 0,
  };
}

function sumUsage(a, b) {
  return {
    model: (b && b.model) || (a && a.model) || null,
    usd: (a.usd || 0) + (b.usd || 0),
    input: (a.input || 0) + (b.input || 0),
    output: (a.output || 0) + (b.output || 0),
    cacheRead: (a.cacheRead || 0) + (b.cacheRead || 0),
    cacheCreation: (a.cacheCreation || 0) + (b.cacheCreation || 0),
  };
}

// Stream a fresh document. Calls onDelta(textChunk) as tokens arrive,
// then onDone(fullMarkdown, usage). onError(message) on failure.
function generate(premise, { onDelta, onDone, onError, onReset, model, effort, web, style, references, addDir }) {
  const hasRefs = !!(references && references.trim());
  const system =
    GENERATE_SYSTEM + (web ? WEB_TOOLS_NOTE : NO_TOOLS_NOTE) + styleNote(style) + (hasRefs ? ATTACH_NOTE : '');
  const prompt = hasRefs ? `${references}\n\n----- REQUEST -----\n${premise}` : premise;
  const child = spawnClaude(
    [
      '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--system-prompt', system,
      ...toolArgs({ web, read: hasRefs }),
      ...modelEffortArgs({ model, effort }),
    ],
    prompt,
    { addDir: hasRefs ? addDir : null }
  );

  let buf = '';
  let full = '';
  let stderr = '';
  let finished = false;

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON noise
      }
      if (evt.type === 'stream_event' && evt.event?.type === 'message_start') {
        // New assistant turn (e.g. after a web-research tool call). Discard any
        // interim text so only the final document's turn is shown/kept.
        full = '';
        if (onReset) onReset();
      } else if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta' && evt.event.delta?.type === 'text_delta') {
        const t = evt.event.delta.text || '';
        full += t;
        if (onDelta) onDelta(t);
      } else if (evt.type === 'result') {
        finished = true;
        if (evt.is_error) {
          if (onError) onError(evt.result || 'Claude returned an error');
        } else {
          // Prefer the authoritative final result; fall back to accumulated deltas.
          if (onDone) onDone((evt.result != null ? evt.result : full).trim(), extractUsage(evt));
        }
      }
    }
  });

  child.stderr.on('data', (d) => (stderr += d.toString()));

  child.on('error', (err) => {
    if (onError) onError(`Failed to launch claude: ${err.message}`);
  });

  child.on('close', (code) => {
    if (!finished && onError) {
      onError(stderr.trim() || `claude exited with code ${code}`);
    }
  });

  return child;
}

// Strip an optional ```json ... ``` fence the model may add despite instructions.
function stripFence(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : text).trim();
}

// Find and parse the first balanced {...} JSON object in text. Returns the
// parsed object, or null. Tries a direct parse first, then scans for a brace
// block — so it survives the model wrapping JSON in stray prose or a fence.
function firstJsonObject(text) {
  const cleaned = stripFence(text || '');
  const tryParse = (s) => {
    try {
      const o = JSON.parse(s);
      return o && typeof o === 'object' ? o : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(cleaned);
  if (direct) return direct;

  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      return tryParse(cleaned.slice(start, i + 1));
    }
  }
  return null;
}

// Edits envelope: a JSON object that actually carries an `edits` array.
function extractEdits(text) {
  const o = firstJsonObject(text);
  return o && Array.isArray(o.edits) ? o : null;
}

// Format this turn's comments + instruction into a single request string,
// reused both for the prompt and for what we store in conversation history.
function formatRequest(comments, instruction) {
  const lines = [];
  comments.forEach((c, i) => {
    lines.push(`${i + 1}. Passage: "${c.quote}"\n   Instruction: ${c.note}`);
  });
  if (instruction.trim()) {
    lines.push((lines.length ? '\n' : '') + `Global instruction: ${instruction.trim()}`);
  }
  return lines.join('\n');
}

// Run a single non-streaming turn with a given system prompt; resolves to the
// raw result text. Shared by revise() and toDeck().
function runTurn(systemPrompt, prompt, { model, effort, web, read, addDir } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnClaude(
      [
        '--output-format', 'json',
        '--system-prompt', systemPrompt,
        ...toolArgs({ web, read }),
        ...modelEffortArgs({ model, effort }),
      ],
      prompt,
      { addDir: read ? addDir : null }
    );
    let out = '';
    let stderr = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => reject(new Error(`Failed to launch claude: ${err.message}`)));
    child.on('close', (code) => {
      if (!out.trim()) return reject(new Error(stderr.trim() || `claude exited with code ${code}`));
      let wrapper;
      try {
        wrapper = JSON.parse(out);
      } catch {
        return reject(new Error('Could not parse claude output envelope'));
      }
      if (wrapper.is_error) return reject(new Error(wrapper.result || 'Claude returned an error'));
      resolve({ text: wrapper.result || '', usage: extractUsage(wrapper) });
    });
  });
}

// Ask Claude for find/replace edits given the current doc, prior conversation,
// and this turn's requests. Stateless (reliable JSON mode) — memory comes from
// the supplied history rather than a resumed session. Resolves to { edits, raw }.
async function revise({ markdown, comments = [], instruction = '', history = [], model, effort, web, style, references, addDir }) {
  const request = formatRequest(comments, instruction);
  const hasRefs = !!(references && references.trim());
  const parts = [];

  if (hasRefs) parts.push(`${references}\n`);

  // Prior intent, so Claude remembers earlier requests (e.g. premise-only facts).
  if (history.length) {
    const log = history.map((h, i) => `${i + 1}. ${h.content}`).join('\n\n');
    parts.push(`CONVERSATION SO FAR (the user's earlier requests, in order — for context, already applied):\n${log}\n`);
  }

  parts.push(`CURRENT DOCUMENT (authoritative — edit against this exact text):\n${markdown}\n`);
  parts.push(`NEW EDIT REQUESTS (apply only these now):\n${request}`);
  const prompt = parts.join('\n');
  const system =
    REVISE_SYSTEM + (web ? WEB_TOOLS_NOTE : NO_TOOLS_NOTE) + styleNote(style) + (hasRefs ? ATTACH_NOTE : '');
  const opts = { model, effort, web, read: hasRefs, addDir };

  let r = await runTurn(system, prompt, opts);
  let usage = r.usage;
  let parsed = extractEdits(r.text);

  // Belt-and-suspenders: nudge once if the reply wasn't valid edit JSON.
  if (!parsed) {
    const sterner =
      prompt +
      '\n\nYour reply MUST be only the JSON object {"edits":[{"find":"...","replace":"..."}]} — no prose, no explanation, no code fence.';
    r = await runTurn(system, sterner, opts);
    usage = sumUsage(usage, r.usage);
    parsed = extractEdits(r.text);
  }

  if (!parsed) throw new Error('Claude did not return valid edit JSON. Raw reply: ' + JSON.stringify((r.text || '').slice(0, 400)));
  return { edits: parsed.edits, request, raw: r.text, usage };
}

const DECK_SYSTEM = `You turn a written document into a clear, well-structured slide presentation.

Respond with ONLY a JSON object (no prose, no code fence) of this exact shape:
{"title":"…","subtitle":"…","slides":[{"title":"…","bullets":["…","…"],"notes":"…"}]}

Guidelines:
- "title"/"subtitle": a concise deck title and one-line subtitle drawn from the document.
- One slide per major section or idea. Aim for 5–12 content slides.
- "bullets": 3–6 SHORT bullets per slide — terse phrases, not full sentences, ideally under ~10 words each. Capture the key points; do not copy paragraphs.
- "notes": 1–4 sentences of supporting detail for the presenter (this is where prose belongs).
- Cover the whole document faithfully; do not invent facts that aren't in it.`;

// Transform a document into a structured slide deck. Stateless JSON-mode call.
// Resolves to { deck: { title, subtitle, slides }, usage }.
async function toDeck(markdown, { model, effort } = {}) {
  const prompt = `DOCUMENT:\n${markdown}`;
  const opts = { model, effort, web: false };

  let r = await runTurn(DECK_SYSTEM + NO_TOOLS_NOTE, prompt, opts);
  let usage = r.usage;
  let deck = firstJsonObject(r.text);

  if (!deck || !Array.isArray(deck.slides)) {
    const sterner = prompt + '\n\nReply with ONLY the JSON object described — no prose, no code fence.';
    r = await runTurn(DECK_SYSTEM + NO_TOOLS_NOTE, sterner, opts);
    usage = sumUsage(usage, r.usage);
    deck = firstJsonObject(r.text);
  }

  if (!deck || !Array.isArray(deck.slides)) {
    throw new Error('Claude did not return a valid slide deck. Raw reply: ' + JSON.stringify((r.text || '').slice(0, 400)));
  }
  return { deck, usage };
}

// ---- Intake interview + brief (the "Let's talk about it first" flow) ----

const INTERVIEW_SYSTEM = `You are a thoughtful writing consultant helping the user plan a document BEFORE it is written. Your job is to interview them — never to write the document itself.

Through a natural back-and-forth, gather what's needed to write a sharply targeted document:
- the goal/purpose (what it should achieve)
- the audience (who reads it; what they already know)
- desired length (pages or words) and/or target reading time
- tone and voice
- key points or sections that must be included
- any format/structure preferences

Guidelines:
- Ask only 1–2 focused questions per turn and build on their answers. Never dump the whole list at once.
- Skip anything they've already told you; infer sensibly and confirm only what matters.
- Keep your messages short, warm, and concrete.
- Do NOT write or draft the document, or show a preview, even if asked — your role here is only to plan.
- Once you have the essentials (purpose, audience, rough length, key points), tell them you have enough to draft it well and invite them to hit "Draft it now" whenever ready (or keep refining). Don't drag it out.`;

const BRIEF_SYSTEM = `You convert a planning conversation into a concise writing brief. Respond with ONLY a JSON object (no prose, no code fence):

{"title":"…","summary":"…","audience":"…","purpose":"…","tone":"…","targetWords":<integer or null>,"keyPoints":["…"],"structure":"…"}

Rules:
- Base everything on the conversation; do not invent facts.
- targetWords: if the user gave a word count, use it; if they gave pages, estimate ~500 words/page; if they gave a reading time, estimate ~225 words/minute (use the midpoint of any range). Use null if length was never discussed.
- summary: 2–4 sentences capturing what to write, for whom, and why.
- keyPoints: the must-include points or sections (empty array if none came up).
- title: a short working title.`;

// Render a [{role, content}] transcript into a labelled block for a prompt.
function renderTranscript(messages) {
  return messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Interviewer'}: ${m.content}`)
    .join('\n\n');
}

// One interviewer turn. Given the conversation so far, returns the next message
// (prose) to show the user. Stateless — the client holds the transcript.
async function interview(messages, { model, effort } = {}) {
  const prompt = `PLANNING CONVERSATION SO FAR:\n${renderTranscript(messages)}\n\nRespond with the interviewer's next message.`;
  const r = await runTurn(INTERVIEW_SYSTEM + NO_TOOLS_NOTE, prompt, { model, effort, web: false });
  return { reply: r.text.trim(), usage: r.usage };
}

// Compile the planning conversation into a structured writing brief.
// Resolves to { brief, usage }.
async function compileBrief(messages, { model, effort } = {}) {
  const prompt = `PLANNING CONVERSATION:\n${renderTranscript(messages)}`;
  const opts = { model, effort, web: false };

  let r = await runTurn(BRIEF_SYSTEM + NO_TOOLS_NOTE, prompt, opts);
  let usage = r.usage;
  let brief = firstJsonObject(r.text);
  if (!brief) {
    r = await runTurn(BRIEF_SYSTEM + NO_TOOLS_NOTE, prompt + '\n\nReply with ONLY the JSON object — no prose, no code fence.', opts);
    usage = sumUsage(usage, r.usage);
    brief = firstJsonObject(r.text);
  }
  if (!brief) throw new Error('Could not compile a brief from the conversation.');

  // Normalize the fields we depend on.
  brief.targetWords = Number.isFinite(brief.targetWords) ? Math.round(brief.targetWords) : null;
  brief.keyPoints = Array.isArray(brief.keyPoints) ? brief.keyPoints : [];
  return { brief, usage };
}

// Turn a structured brief into a generation prompt with explicit constraints.
function briefToPrompt(brief) {
  const lines = ['Write a complete document that satisfies the following brief.\n'];
  if (brief.purpose) lines.push(`Purpose: ${brief.purpose}`);
  if (brief.audience) lines.push(`Audience: ${brief.audience}`);
  if (brief.tone) lines.push(`Tone and voice: ${brief.tone}`);
  if (brief.targetWords) {
    const mins = Math.max(1, Math.round(brief.targetWords / 225));
    lines.push(`Target length: about ${brief.targetWords} words (~${mins} min read). Stay close to this length.`);
  }
  if (brief.structure) lines.push(`Structure: ${brief.structure}`);
  if (brief.keyPoints && brief.keyPoints.length) {
    lines.push(`Key points to cover:\n${brief.keyPoints.map((p) => `- ${p}`).join('\n')}`);
  }
  if (brief.summary) lines.push(`\nContext: ${brief.summary}`);
  lines.push('\nWrite the document now, following the brief precisely.');
  return lines.join('\n');
}

// Apply find/replace edits to the markdown source.
// Returns { markdown, applied: [{find, replace, ok, reason}] }.
function applyEdits(markdown, edits) {
  let text = markdown;
  const applied = [];
  for (const edit of edits) {
    const { find, replace = '' } = edit || {};
    if (typeof find !== 'string' || find === '') {
      applied.push({ ...edit, ok: false, reason: 'empty find' });
      continue;
    }
    const first = text.indexOf(find);
    if (first === -1) {
      applied.push({ find, replace, ok: false, reason: 'not found' });
      continue;
    }
    const last = text.lastIndexOf(find);
    if (first !== last) {
      // Ambiguous — replace the first occurrence but flag it.
      text = text.slice(0, first) + replace + text.slice(first + find.length);
      applied.push({ find, replace, ok: true, reason: 'multiple matches; replaced first' });
    } else {
      text = text.slice(0, first) + replace + text.slice(first + find.length);
      applied.push({ find, replace, ok: true });
    }
  }
  return { markdown: text, applied };
}

module.exports = {
  generate,
  revise,
  toDeck,
  interview,
  compileBrief,
  briefToPrompt,
  applyEdits,
  // Pure helpers exported for unit testing.
  extractEdits,
  firstJsonObject,
  modelEffortArgs,
  toolArgs,
  formatRequest,
  stripFence,
  styleNote,
  extractUsage,
  sumUsage,
};
