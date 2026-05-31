// Bridges the app to the local `claude` CLI (headless / -p mode).
// Reuses the user's existing Claude Code authentication — no API key needed.
//
// Two operations:
//   generate() — streams a fresh document (SSE-friendly delta callbacks)
//   revise()   — returns a minimal set of find/replace edits for the document

const { spawn } = require('child_process');

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

// Appended to the system prompt depending on whether web research is enabled.
const NO_TOOLS_NOTE = '\n\nYou have no tools; rely solely on your own knowledge.';
const WEB_TOOLS_NOTE =
  '\n\nYou may use the WebSearch and WebFetch tools to research facts and to read any URLs mentioned in the request. Use them whenever the task depends on external, current, or linked information, then base your writing on what you find. Do not narrate your research — the output must contain only the requested document/edits.';

// When web research is on, expose ONLY the read-only web tools and pre-approve
// them (so headless mode doesn't deny them). Filesystem/shell tools stay out of
// reach entirely. When off, no tools at all — fast, offline writing.
function toolArgs(web) {
  return web
    ? ['--tools', 'WebFetch', 'WebSearch', '--allowedTools', 'WebFetch', 'WebSearch']
    : ['--tools', 'none'];
}

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
function spawnClaude(args, prompt) {
  const child = spawn('claude', ['-p', ...args], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(prompt);
  child.stdin.end();
  return child;
}

// Stream a fresh document. Calls onDelta(textChunk) as tokens arrive,
// then onDone(fullMarkdown). onError(message) on failure.
function generate(premise, { onDelta, onDone, onError, onReset, model, effort, web }) {
  const child = spawnClaude(
    [
      '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
      '--system-prompt', GENERATE_SYSTEM + (web ? WEB_TOOLS_NOTE : NO_TOOLS_NOTE),
      ...toolArgs(web),
      ...modelEffortArgs({ model, effort }),
    ],
    premise
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
          if (onDone) onDone((evt.result != null ? evt.result : full).trim());
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

// Tolerantly pull the {"edits":[...]} object out of a model reply. Resuming a
// prose-writing session can bias the model toward wrapping the JSON in stray
// text, so fall back to scanning for the first balanced {...} block.
function extractEdits(text) {
  const cleaned = stripFence(text || '');
  const tryParse = (s) => {
    try {
      const o = JSON.parse(s);
      return Array.isArray(o.edits) ? o : null;
    } catch {
      return null;
    }
  };
  let parsed = tryParse(cleaned);
  if (parsed) return parsed;

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

// Run one revise turn against the CLI; resolves to the raw result text.
function runReviseTurn(prompt, { model, effort, web }) {
  return new Promise((resolve, reject) => {
    const child = spawnClaude(
      [
        '--output-format', 'json',
        '--system-prompt', REVISE_SYSTEM + (web ? WEB_TOOLS_NOTE : NO_TOOLS_NOTE),
        ...toolArgs(web),
        ...modelEffortArgs({ model, effort }),
      ],
      prompt
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
      resolve(wrapper.result || '');
    });
  });
}

// Ask Claude for find/replace edits given the current doc, prior conversation,
// and this turn's requests. Stateless (reliable JSON mode) — memory comes from
// the supplied history rather than a resumed session. Resolves to { edits, raw }.
async function revise({ markdown, comments = [], instruction = '', history = [], model, effort, web }) {
  const request = formatRequest(comments, instruction);
  const parts = [];

  // Prior intent, so Claude remembers earlier requests (e.g. premise-only facts).
  if (history.length) {
    const log = history.map((h, i) => `${i + 1}. ${h.content}`).join('\n\n');
    parts.push(`CONVERSATION SO FAR (the user's earlier requests, in order — for context, already applied):\n${log}\n`);
  }

  parts.push(`CURRENT DOCUMENT (authoritative — edit against this exact text):\n${markdown}\n`);
  parts.push(`NEW EDIT REQUESTS (apply only these now):\n${request}`);
  const prompt = parts.join('\n');
  const opts = { model, effort, web };

  let raw = await runReviseTurn(prompt, opts);
  let parsed = extractEdits(raw);

  // Belt-and-suspenders: nudge once if the reply wasn't valid edit JSON.
  if (!parsed) {
    const sterner =
      prompt +
      '\n\nYour reply MUST be only the JSON object {"edits":[{"find":"...","replace":"..."}]} — no prose, no explanation, no code fence.';
    raw = await runReviseTurn(sterner, opts);
    parsed = extractEdits(raw);
  }

  if (!parsed) throw new Error('Claude did not return valid edit JSON. Raw reply: ' + JSON.stringify((raw || '').slice(0, 400)));
  return { edits: parsed.edits, request, raw };
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

module.exports = { generate, revise, applyEdits };
