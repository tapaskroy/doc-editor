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

// Directory of a voice's SKILL.md (first root that has it), basename-guarded.
// Discovery only; the read-write voice store lives in lib/voicestore.js.
function voiceDir(id) {
  const safe = path.basename(String(id || ''));
  if (!safe || safe === '.' || safe === '..') return null;
  for (const root of roots()) {
    const dir = path.join(root, safe);
    if (fs.existsSync(path.join(dir, 'SKILL.md'))) return dir;
  }
  return null;
}

module.exports = { list, read, parseFrontmatter, stripFrontmatter, detectKind, listOutputs, outputSkill, voiceDir };
