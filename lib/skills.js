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

// Pull name + description out of the leading --- YAML --- block (light parse).
function parseFrontmatter(text) {
  const fm = {};
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (block) {
    const name = block[1].match(/^name:\s*(.+)$/m);
    const desc = block[1].match(/^description:\s*(.+)$/m);
    if (name) fm.name = name[1].trim();
    if (desc) fm.description = desc[1].trim();
  }
  return fm;
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

module.exports = { list, read, parseFrontmatter, stripFrontmatter };
