// Discovers Claude "skills" so the user can pick a voice/style to write in.
// A skill is a directory containing SKILL.md (with YAML frontmatter holding a
// name + description). We list them for browsing and read a chosen one's body
// to append to the writing system prompt.
//
// Roots scanned (in order; first match wins on id collisions):
//   $DOC_EDITOR_SKILLS_DIR (optional, used by tests)
//   ~/.claude/skills        (the user's personal skills)
//   <cwd>/.claude/skills    (project skills)

const fs = require('fs');
const os = require('os');
const path = require('path');

function roots() {
  return [
    process.env.DOC_EDITOR_SKILLS_DIR,
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(process.cwd(), '.claude', 'skills'),
  ].filter(Boolean);
}

// Pull simple scalar fields out of the leading --- YAML --- block (light parse).
function parseFrontmatter(text) {
  const fm = {};
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (block) {
    const grab = (k) => {
      const m = block[1].match(new RegExp('^' + k + ':\\s*(.+)$', 'm'));
      return m ? m[1].trim() : undefined;
    };
    const name = grab('name'); if (name) fm.name = name;
    const desc = grab('description'); if (desc) fm.description = desc;
    const output = grab('output'); if (output) fm.output = output.toLowerCase(); // optional kind hint
    const command = grab('command'); if (command) fm.command = command.replace(/^["']|["']$/g, ''); // CLI entrypoint
  }
  return fm;
}

// Classify a skill folder into an output kind. The frontmatter `output:` hint is
// the strongest signal; otherwise infer from the files present (convention).
// Returns 'publish' | 'export' | 'transform' | 'voice'. (A Claude-classification
// fallback for genuinely ambiguous folders is a locked future addition; v1 is
// rules + the frontmatter hint, which covers the real cases.)
function detectKind(dir, fm) {
  const has = (f) => { try { return fs.existsSync(path.join(dir, f)); } catch { return false; } };
  const hint = (fm.output || '').toLowerCase();
  if (['publish', 'export', 'transform', 'voice'].includes(hint)) return hint;
  if (has('publish.json')) return 'publish';
  if (has('template.html')) return 'export';
  if (has('reference.docx') || has('reference.pptx')) return 'export';
  return 'voice';
}

function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? text.slice(m[0].length) : text).trim();
}

// List available skills: [{ id, name, description, source }].
function list() {
  const out = [];
  const seen = new Set();
  const home = os.homedir();
  for (const root of roots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root doesn't exist
    }
    for (const e of entries) {
      if (!e.isDirectory() || seen.has(e.name)) continue;
      const file = path.join(root, e.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      seen.add(e.name);
      let fm = {};
      try {
        fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      } catch {
        /* unreadable frontmatter — fall back to dir name */
      }
      // The Style picker is voice-only; output skills belong to the Export panel.
      if (detectKind(path.join(root, e.name), fm) !== 'voice') continue;
      out.push({
        id: e.name,
        name: fm.name || e.name,
        description: fm.description || '',
        source: root.startsWith(path.join(home, '.claude')) ? 'user' : 'project',
      });
    }
  }
  return out;
}

// Output skills (anything that produces or publishes output), with how to run
// each. `dir` + `command` are server-only (used to shell out); never send `dir`
// to the browser. Returns [{ id, name, description, kind, command, dir, source }].
function listOutputs() {
  const out = [];
  const seen = new Set();
  const home = os.homedir();
  for (const root of roots()) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || seen.has(e.name)) continue;
      const dir = path.join(root, e.name);
      const file = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      let fm = {};
      try {
        fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      } catch {
        /* fall back to dir name */
      }
      const kind = detectKind(dir, fm);
      seen.add(e.name);
      if (kind === 'voice') continue; // not an output skill
      out.push({
        id: e.name,
        name: fm.name || e.name,
        description: fm.description || '',
        kind, // 'publish' | 'export' | 'transform'
        command: fm.command || null,
        dir,
        source: root.startsWith(path.join(home, '.claude')) ? 'user' : 'project',
      });
    }
  }
  return out;
}

// Resolve a single output skill by id (basename-guarded), with its dir + command.
function outputSkill(id) {
  const safe = path.basename(String(id || ''));
  if (!safe || safe === '.' || safe === '..') return null;
  return listOutputs().find((s) => s.id === safe) || null;
}

// Read a skill's SKILL.md body (frontmatter stripped) by id. Returns null if not
// found. The id is reduced to a basename so it can't escape the skill roots.
function read(id) {
  const safe = path.basename(String(id || ''));
  if (!safe || safe === '.' || safe === '..') return null;
  for (const root of roots()) {
    const file = path.join(root, safe, 'SKILL.md');
    try {
      if (fs.existsSync(file)) return stripFrontmatter(fs.readFileSync(file, 'utf8'));
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// ---- Voice store: learned rules (voice.json) + composed read ----------------
// A voice's learned rules live in <dir>/voice.json (app-managed metadata). The
// portable, prompt-injected artifact stays SKILL.md, whose managed block mirrors
// the ACTIVE rules so other Claude Code instances see them too. compose() is the
// seam generation reads through. (Personalization spec sections 4, 9; decision 1.)

const LEARN_START = '<!-- learned:start -->';
const LEARN_END = '<!-- learned:end -->';

// Directory of a voice's SKILL.md (first root that has it), basename-guarded.
function voiceDir(id) {
  const safe = path.basename(String(id || ''));
  if (!safe || safe === '.' || safe === '..') return null;
  for (const root of roots()) {
    const dir = path.join(root, safe);
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  }
  return null;
}

function loadVoiceJson(id) {
  const dir = voiceDir(id);
  const file = dir && path.join(dir, 'voice.json');
  if (file && fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fall through */ }
  }
  return { id: path.basename(String(id || '')), rules: [] };
}

function saveVoiceJson(id, data) {
  const dir = voiceDir(id);
  if (!dir) return false;
  fs.writeFileSync(path.join(dir, 'voice.json'), JSON.stringify(data, null, 2));
  return true;
}

function learnedRules(id) {
  return loadVoiceJson(id).rules || [];
}

function newRuleId() {
  return 'r_' + Math.random().toString(36).slice(2, 8);
}

// Add a learned rule. Suggest-only by default (decision 4): the review gate
// promotes it to 'active', which is when it reaches the prompt.
function addLearnedRule(id, { text, layer = 'voice', source = 'edits', evidence = [], status = 'suggested', confidence = 1 } = {}) {
  if (!text || !String(text).trim()) return null;
  const data = loadVoiceJson(id);
  const rule = {
    id: newRuleId(),
    text: String(text).trim(),
    layer,            // 'voice' | 'context'
    status,           // 'suggested' | 'active' | 'dismissed'
    confidence,
    support: evidence,
    source,           // 'edits' | 'docs' | 'sent-mail' | ...
    createdAt: new Date().toISOString(),
  };
  data.rules = [...(data.rules || []), rule];
  saveVoiceJson(id, data);
  if (status === 'active') regenerateLearnedBlock(id);
  return rule;
}

// Change a rule's status and keep the SKILL.md managed block in sync.
function setRuleStatus(id, ruleId, status) {
  const data = loadVoiceJson(id);
  const rule = (data.rules || []).find((r) => r.id === ruleId);
  if (!rule) return null;
  rule.status = status;
  rule.updatedAt = new Date().toISOString();
  saveVoiceJson(id, data);
  regenerateLearnedBlock(id);
  return rule;
}

// Render the ACTIVE voice rules into SKILL.md's managed block (created if absent).
// voice.json is the source of metadata; SKILL.md stays the portable artifact.
function regenerateLearnedBlock(id) {
  const dir = voiceDir(id);
  if (!dir) return false;
  const file = path.join(dir, 'SKILL.md');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return false; }
  const active = (loadVoiceJson(id).rules || []).filter((r) => r.status === 'active' && r.layer === 'voice');
  const block = active.length
    ? `${LEARN_START}\n## Learned rules\n\n${active.map((r) => `- ${r.text}`).join('\n')}\n${LEARN_END}`
    : `${LEARN_START}\n${LEARN_END}`;
  const re = new RegExp(`${LEARN_START}[\\s\\S]*?${LEARN_END}`);
  const next = re.test(raw) ? raw.replace(re, block) : `${raw.replace(/\s*$/, '')}\n\n${block}\n`;
  fs.writeFileSync(file, next);
  return true;
}

// The text generation reads through. Today: the SKILL.md body with the learned
// markers stripped (the rules text stays). The seam where confidence-based
// trimming and prompt-budget composition will live.
function compose(id) {
  const body = read(id);
  if (body == null) return null;
  return body
    .replace(new RegExp(`${LEARN_START}\\n?|${LEARN_END}`, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = {
  list, read, parseFrontmatter, stripFrontmatter, detectKind, listOutputs, outputSkill,
  // voice store
  compose, voiceDir, loadVoiceJson, saveVoiceJson, learnedRules, addLearnedRule, setRuleStatus, regenerateLearnedBlock,
};
