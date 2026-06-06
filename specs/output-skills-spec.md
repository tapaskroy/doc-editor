# doc-editor: Output Skills Spec and Handoff Snapshot

*Status: design only, spec-first. No implementation is wired into the app yet. The open decisions are now settled; read "Handoff status" and Section 9 ("Decisions (locked)") first.*

---

## Handoff status (2026-06-06)

**Goal.** Make the Export surface skill-driven. Instead of four hardcoded export buttons, the app discovers "output skills" the user has and incorporates them dynamically, so a capability like "Publish to blog" only appears for someone who has a publishing skill. The same mechanism lets a skill improve a built-in (for example a better PowerPoint theme).

**Decisions locked with the user (full list and the contract in Section 9):**
1. **Spec-first.** Align on this document before writing code in the tree. (Mirrors how the Mail feature was built.)
2. **Skills are portable CLIs the app shells out to.** A skill carries its own procedure as an executable; doc-editor invokes it as a subprocess (`plan` then `run`) the way it already shells out to `claude`, Chrome, pandoc, and `aws`. The app never holds output or deploy logic and never knows what "publish a blog" means; it knows only that a skill *can* be invoked and *how*. See Section 9.
3. **The app uses, but does not install, skills.** It discovers and runs skills already present under the skill roots (primarily `~/.claude/skills`); it never installs them. This keeps trust, privacy, and any third-party-marketplace concerns out of scope for now.
4. **Content/convention-based detector, rules first.** A skill does not declare its type; the app infers the kind from the folder's contents (Section 4), with a one-time Claude classification as the fallback for genuinely ambiguous folders.
5. **Built-ins stay app-internal for v1.** Reframing HTML / PDF / Word / PowerPoint as portable skills (Section 7) is a *later* step, and because the app does not install skills, the user would install them. v1 layers dynamic discovery on top of today's `export.js`.

**Settled (2026-06-07):** all of Section 9. The load-bearing one is the execution contract: skills are portable CLIs the app shells out to; the procedure lives in the skill, never in doc-editor.

**What exists on disk right now:**
- A real, usable first output skill at `~/.claude/skills/blog-tapaskroy/` containing `SKILL.md`, `template.html` (the teal/Fraunces blog shell with `{{TITLE}}`, `{{DECK_BLOCK}}`, `{{BODY}}`, `{{SIGNOFF_*}}`, `{{DATE}}`, `{{CANONICAL}}`, `{{DESCRIPTION}}`, `{{KICKER}}`, `{{YEAR_RANGE}}` placeholders), and `publish.json` (deploy config: landing repo path, S3 bucket `tapaskroy-me-landing`, CloudFront `E3F2P2QSY677F0`, base URL, blog root, index file, kicker, start year). This is the concrete example the detector and the publish action should target first.
- This spec.

**What was prototyped and then deliberately reverted** (so the repo tree is clean and you are not building on top of half-wired code):
- `lib/publish.js` was written and then deleted. The full prototype is preserved in Appendix B below for reference. It is a working deterministic implementation of: parse a doc's Markdown into title / deck / body / colophon, fill the template, build and upsert the blog index entry, and deploy via `aws s3 sync` + CloudFront invalidation.
- `server.js` had a `publish` require plus three routes (`GET /api/publishers`, `GET /api/docs/:id/publish/plan`, `POST /api/docs/:id/publish`); removed.
- `public/index.html` had a Publish panel; removed.
- The repo tree currently contains only the user's own uncommitted work (mail inbox prefetch in `server.js`, plus `lib/mail.js`, `lib/mailstore.js`, `public/app.js`, `public/styles.css`). Do not revert or step on those.

**Suggested first slice (v1):** the detector, the dynamic Export panel (built-ins plus discovered skills, grouped Export vs Publish), and the **blog publish action** driving `~/.claude/skills/blog-tapaskroy/` through its `plan` / `run` CLI behind the review gate. The four built-ins stay app-internal (today's `export.js`) for v1; reframing them as installed portable skills (Section 7) is a later, user-installs-them step.

**Start here:** build from this spec, not from a wholesale paste of Appendix B. Use the prototype only as a concrete reference for the deterministic render and deploy steps. Keep all changes additive and clear of the user's mail work.

---

## 1. What it is, and why

doc-editor already has **voice skills**: a folder under `~/.claude/skills` whose `SKILL.md` shapes *how Claude writes* (the Style picker appends it to the system prompt). This spec adds the symmetric idea, **output skills**: a folder that shapes *how a finished document leaves the tool*.

Today export is four buttons (HTML, PDF, Word, PowerPoint) baked into the app. Two problems with that: every output is offered to everyone whether it is relevant or not, and adding or improving an output means editing the app. Output skills make the export surface **discovered and per-user**. The Export panel shows whatever output skills are present, and nothing brand-specific, blog-specific, or deploy-specific is baked into the app.

What this buys us:

- "Publish to blog" is **not** a default feature. It appears only for someone who has a publishing skill installed. No skill, no button.
- Different users, and different machines, see different export options. The capability travels with the skill, not the app.
- A skill can **add** a new target (post to a blog) or **improve** an existing one (a nicer PowerPoint theme, a branded Word style).
- Because output skills are ordinary Claude Code skills, they are usable by **other Claude Code instances**, not only inside this app (see section 7).

## 2. Two skill families, one set of roots

Both families live under the roots already scanned today: `$DOC_EDITOR_SKILLS_DIR`, `~/.claude/skills`, and the project's `.claude/skills`.

- **Voice skill** shapes the writing. Consumed by the Style picker; appended to the system prompt. (Exists today.)
- **Output skill** shapes the output. Consumed by the Export panel; turns the finished doc into a file or a published artifact.

The app tells them apart with a detector (section 4) rather than a hand-written type field. `SKILL.md` frontmatter still supplies the human-readable name and description for the button, exactly as it does for voice skills.

## 3. Kinds of output skill

Three execution kinds, distinguished by what the skill produces:

1. **Themed file export (deterministic).** The skill carries a template or a reference asset; the app fills it with the document and hands back a file to download. Examples: a blog-styled standalone HTML, a branded Word document via a pandoc reference. No model call, fully reproducible.
2. **Transform export (Claude-assisted).** The skill carries instructions; the app runs one Claude pass through the existing transform seam, then renders the result. Example: a "better PowerPoint" skill that restructures the document into a richer deck and theme. One model call.
3. **Publish action (render plus side effect).** A themed render followed by writing to a location and/or deploying, behind a review gate. Example: post to a blog, which writes into the site repo, updates an index, syncs to S3, and invalidates the CDN.

The current built-ins map cleanly onto these: HTML and Word are kind 1, PDF is kind 1 (print the themed HTML), PowerPoint is kind 2.

## 4. The detector (content-based, no declared type)

A skill does not announce its kind. The app infers it by inspecting the folder, in priority order:

1. A deploy manifest (e.g. `publish.json`) is present, so this is a **publish action**: render via the skill's template, then perform the side effect it describes (target repo path, bucket, distribution, URL pattern).
2. A `template.html` with placeholders is present, so this is a **themed HTML / PDF export**.
3. A reference document (`reference.docx`, `reference.pptx`) or a deck/theme spec is present, so this is a **themed Word / PowerPoint export**.
4. The `SKILL.md` body describes a document-to-output transformation (and there is no template asset), so this is a **transform export**.
5. None of the above: a `SKILL.md` describing a writing voice with no output assets, so this is a **voice skill** (today's behavior, shown in the Style picker, not the Export panel).

Detection is **rule-based first**: fast, predictable, no surprises. For genuinely ambiguous folders it falls back to a **one-time Claude classification** from the `SKILL.md` (cached, so it costs at most once per skill). Rules-plus-Claude-fallback is locked (Section 9).

A note on the "no declared type" stance: in practice the rules key off known files (`publish.json`, `template.html`, `reference.pptx`), so detection is really *convention*-based. A skill may still add an explicit hint in `SKILL.md` frontmatter (it is honored as the strongest signal); file-presence is the fallback when no hint is given.

## 5. The Export panel

- On opening a document, the panel lists the available output skills: the bundled built-ins first, then the user's discovered skills.
- Entries are grouped or labeled by what they do: a quiet **Export** group (produces a file) and a distinct **Publish** group (performs a side effect).
- Publish actions are visually set apart and always pass through the review gate (section 6).
- Buttons respect document type, the way export is already hidden for emails.
- When a discovered skill overlaps a built-in (a better pptx), **both are shown side by side**; no skill marks itself as a preferred replacement. The user prunes redundant skills by deleting them (locked; Section 9).

## 6. The review gate (for anything with a side effect)

Any output skill that writes or deploys routes through one confirm screen before anything happens, mirroring the Mail commit point:

- The exact target: file path(s) to be written, the URL that will go live, and whether this is new or an overwrite.
- Index or listing changes, shown as a summary or diff.
- Deploy targets (bucket, distribution) and the exact commands that will run.
- Non-blocking lint, for example "this overwrites an existing post" or "the body contains an em dash".
- An editable destination (slug) where it applies.
- Nothing runs until you confirm. Even if the instruction says "publish", it stages and waits, the same principle as Mail's send.

The gate is populated entirely by the skill's **`plan`** output (Section 9): the skill, which owns the procedure, declares exactly what will happen (files, URL, commands, index changes, lint); the app renders it generically and waits. Only after you confirm does the app call the skill's **`run`**. doc-editor never computes the side effects itself, so the gate works for any skill, blog or otherwise.

## 7. Built-ins as portable skills (later phase, not v1)

The long-term aim is to reframe the four built-ins as **portable output skills** authored as ordinary Claude Code skills, so any Claude Code instance can run them, not just doc-editor. The execution contract that makes this possible is now settled (the `plan` / `run` CLI, Section 9).

**Sequencing (decided): this is deferred past v1.** For v1 the four built-ins stay **app-internal** (today's `export.js`), and dynamic discovery is layered on top for user-installed skills like the blog one. Because the app does not install skills (Section 9), reframing the built-ins means the *user* installs them under `~/.claude/skills` later; the app would then discover and run them through the same CLI contract as any other skill.

When that phase comes:

- Each built-in becomes a skill folder: a `SKILL.md` plus the assets or commands it needs. Likely set: `html-standalone`, `pdf-print` (headless Chrome), `docx-pandoc` (pandoc gfm to docx), `pptx-deck` (Claude restructures to a deck, then pptxgenjs).
- The app's `export.js` collapses into the **thin runner** that already drives discovered skills, instead of holding the format logic itself.

## 8. Privacy and safety

- Output skills can carry deploy targets and credentials in their own config. They live on the user's machine; nothing is added to the app.
- Side effects only run after the review gate. The server still binds to loopback.
- A skill carries a script, so running it runs code on your machine. For v1 every skill is **your own**, installed by you, so trust is a non-issue. The **review gate already shows the exact files, URL, and commands** a skill will touch, which is the real safety surface. Supporting third-party skills later is therefore mostly a one-time trust prompt before a never-run skill's first `run`, in front of an otherwise-unchanged contract (see Section 9, "Third-party readiness").

## 9. Decisions (locked)

The previously-open decisions are settled. The summary first, then the execution contract (the load-bearing part).

1. **Execution contract: skills are portable CLIs the app shells out to.** A skill carries its own procedure as an executable; doc-editor invokes it as a subprocess, the way it already shells out to `claude`, Chrome, pandoc, and `aws`. doc-editor never holds output or deploy logic and never knows what "publish a blog" means; it knows only that a skill *can* be invoked and *how*. No in-process module loading. This is what keeps skills portable to any Claude Code instance and keeps the app generic.
2. **The app uses, but does not install, skills.** It discovers and runs skills already present under the skill roots; it never installs them. Trust, privacy, and third-party-marketplace concerns stay out of scope for now.
3. **Detector: rules first, Claude classification for ambiguous folders** (Section 4), cached.
4. **Overlaps are shown side by side.** No skill marks itself as a preferred replacement; the user prunes redundant skills by deleting them.
5. **Skills live in `~/.claude/skills`** (and the other existing roots), usable by every Claude Code instance.
6. **Trust is a non-issue for v1** (every skill is the user's own). The architecture stays ready for third-party install/export later without redesign; we do not build it now.

### The invocation contract (the part to get right)

The app stays output-agnostic, but the app and every output skill agree on one generic protocol.

- **Entrypoint.** `SKILL.md` frontmatter declares the command to run from the skill's directory, e.g. `command: "node publish.js"`. *(Open detail: the exact frontmatter key.)*
- **Two subcommands.**
  - **`plan`** performs NO side effects. It reads the document on stdin and returns JSON describing exactly what `run` would do: files to be written (new vs overwrite), the URL that will go live, the exact shell commands it will run, listing/index changes, and non-blocking lint. This populates the review gate.
  - **`run`** performs the side effect and returns a JSON summary (url, what was written/deployed).
- **I/O shape (JSON over stdin/stdout).**
  - Input: `{ markdown, title, params: { slug, ... }, media: [...] }` — the document's Markdown and title, user-supplied params (such as an editable slug), and a way to reach embedded media.
  - `plan` output: `{ kind: "export" | "publish", files: [...], url?, commands: [...], indexChanges?, lint: [...], overwrite: bool }`.
  - `run` output: `{ url?, written: [...], deployed?: {...} }`.
- **The gate renders whatever `plan` describes**, generically. The skill decides the side effects; the app only shows and confirms them. `run` is called only after confirmation.
- **plan ↔ run consistency.** The user may edit params (e.g. the slug) in the gate; `run` receives the confirmed params and reproduces the plan deterministically from the same inputs.
- **Media.** Embedded images live at `/media/<docId>/…`; the input passes their paths (or inlined bytes) so a skill that renders HTML can include them. *(Open detail: paths vs inline, settle when building.)*
- **Same invocation everywhere.** Because the contract is a documented CLI (not an app-internal API), a standalone Claude Code session runs the identical command per the skill's `SKILL.md`. That is what makes the skill portable.

### Third-party readiness (seam, not built)

The review gate already shows the exact files, URL, and commands a skill will touch — that *is* the safety surface. So supporting third-party skills later is mostly: add a one-time trust prompt before a never-before-run skill's first `run`, in front of an otherwise-unchanged contract. Keep the contract clean and the gate honest now, and that future is cheap. (Skill install/export itself remains out of scope, Section 10.)

### v1 scope

First slice: the detector, the dynamic Export panel (built-ins plus discovered skills, grouped Export vs Publish), and the **blog publish action** driving `~/.claude/skills/blog-tapaskroy/` through its `plan` / `run` CLI behind the review gate. The four built-ins stay app-internal (today's `export.js`); reframing them as installed portable skills (Section 7) is a later, user-installs-them step.

### Open implementation details (decide while building, not blockers)

- The exact `SKILL.md` frontmatter key for the entrypoint.
- Media delivery to a skill: paths under `/media` vs inlined bytes.
- Whether `plan`/`run` read the doc on stdin or from a temp file path (large docs).

## 10. Out of scope for v1

- A skill marketplace or installer.
- Multi-output pipelines (one document to several outputs at once).
- Per-skill auth flows beyond what a skill's own config carries.

## Appendix A: where this touches the code

- `lib/skills.js` lists voice skills and reads `SKILL.md` bodies today. It gains the detector and an output-skill listing.
- `lib/export.js` becomes the thin runner over output skills; current format logic migrates into bundled skills.
- `server.js` export route generalizes; new plan and publish routes for side-effecting skills.
- `public/app.js` and `public/index.html` render the Export panel dynamically and host the review gate.

## Appendix B: reverted prototype (`lib/publish.js`) — reference only

This was written, demonstrated, and then reverted to do spec-first. It is **not** wired in. Use it as a concrete reference for the deterministic render (Markdown to template), the blog index upsert, and the AWS deploy.

**Per the locked execution contract (Section 9), this logic belongs inside the blog skill's own `plan` / `run` CLI** (`~/.claude/skills/blog-tapaskroy/`), **not in the app.** doc-editor shells out to it and never hosts this code. So `plan()` / `run()` here map directly onto the skill CLI's `plan` / `run` subcommands; the app-side pieces (routes, the gate) only invoke them and render the result. Do not paste this back into the app.

```js
// Publishing skills: themed export targets that turn a finished document into a
// live blog post. Where a voice skill (lib/skills.js) shapes *how Claude writes*,
// a publishing skill shapes *how a finished doc is published* -- it carries its
// own HTML template plus a publish.json (repo path, S3 bucket, CloudFront id).
//
// A publishing skill is a directory under the same skill roots as voice skills,
// containing template.html + publish.json. The render is deterministic (Markdown
// -> the template), so it costs nothing and is reproducible. The deploy shells
// out to the `aws` CLI, mirroring how the rest of the app shells out.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { marked } = require('marked');
const skills = require('./skills');

marked.setOptions({ gfm: true, breaks: false });

function roots() {
  return [
    process.env.DOC_EDITOR_SKILLS_DIR,
    path.join(os.homedir(), '.claude', 'skills'),
    path.join(process.cwd(), '.claude', 'skills'),
  ].filter(Boolean);
}

function isPublisher(dir) {
  return fs.existsSync(path.join(dir, 'template.html')) && fs.existsSync(path.join(dir, 'publish.json'));
}

function skillDir(id) {
  const safe = path.basename(String(id || ''));
  if (!safe || safe === '.' || safe === '..') return null;
  for (const root of roots()) {
    const dir = path.join(root, safe);
    if (isPublisher(dir)) return dir;
  }
  return null;
}

// [{ id, name, description }] -- directories that have a template + publish.json.
function listPublishers() {
  const out = [];
  const seen = new Set();
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
      if (!isPublisher(dir)) continue;
      seen.add(e.name);
      let fm = {};
      try {
        fm = skills.parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
      } catch {
        /* no SKILL.md / unreadable -- fall back to dir name */
      }
      out.push({ id: e.name, name: fm.name || e.name, description: fm.description || '' });
    }
  }
  return out;
}

function loadConfig(dir) {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'publish.json'), 'utf8'));
  if (cfg.repoDir && cfg.repoDir.startsWith('~')) {
    cfg.repoDir = path.join(os.homedir(), cfg.repoDir.slice(1));
  }
  return cfg;
}

// ---- text helpers -------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// Curly-quote plain text. Operates only on text between HTML tags (see
// smartenHtml), never on attributes, so links and raw HTML survive intact.
function smartenText(s) {
  return s
    .replace(/"(?=[^\s])/g, '“')
    .replace(/"/g, '”')
    .replace(/(\w)'(\w)/g, '$1’$2')
    .replace(/'(?=[^\s])/g, '‘')
    .replace(/'/g, '’');
}

// Smarten quotes in rendered HTML text nodes only (skip tags + code/pre).
function smartenHtml(html) {
  let inCode = 0;
  return html.split(/(<[^>]+>)/).map((part) => {
    if (part.startsWith('<')) {
      if (/^<(code|pre)\b/i.test(part)) inCode++;
      else if (/^<\/(code|pre)>/i.test(part)) inCode = Math.max(0, inCode - 1);
      return part;
    }
    return inCode ? part : smartenText(part);
  }).join('');
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateParts(d) {
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return { yyyy, mm, display: `${d.getDate()} ${MONTHS[d.getMonth()]} ${yyyy}` };
}

// Peel a trailing colophon block (after the last `---` rule, made only of
// emphasis lines) into { line, name, place }. Leaves real thematic breaks in body.
function extractColophon(text) {
  const re = /\n-{3,}[ \t]*\n/g;
  const cuts = [];
  let m;
  while ((m = re.exec(text))) cuts.push({ start: m.index, end: m.index + m[0].length });
  for (let i = cuts.length - 1; i >= 0; i--) {
    const lines = text.slice(cuts[i].end).trim().split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) continue;
    const colophonLike = lines.every((l) => /^\*\*.+\*\*$/.test(l) || /^[*_].+[*_]$/.test(l));
    if (!colophonLike) break;
    const signoff = { line: '', name: '', place: '' };
    for (const l of lines) {
      const bold = l.match(/^\*\*(.+?)\*\*$/);
      const ital = l.match(/^[*_](.+?)[*_]$/);
      if (bold) signoff.name = bold[1].trim();
      else if (ital) { if (!signoff.line) signoff.line = ital[1].trim(); else signoff.place = ital[1].trim(); }
    }
    return { body: text.slice(0, cuts[i].start), signoff };
  }
  return { body: text, signoff: { line: '', name: '', place: '' } };
}

// Split a document's Markdown into title / deck / body HTML / colophon.
function parseDoc(md) {
  let text = (md || '').replace(/\r\n/g, '\n');

  let title = 'Untitled';
  const tm = text.match(/^[ \t]*#\s+(.+?)\s*$/m);
  if (tm) { title = tm[1].trim(); text = text.slice(0, tm.index) + text.slice(tm.index + tm[0].length); }

  const colo = extractColophon(text);
  text = colo.body;

  let deck = '';
  const lines = text.split('\n');
  let k = 0;
  while (k < lines.length && !lines[k].trim()) k++;
  if (k < lines.length) {
    const dm = lines[k].trim().match(/^[*_](.+?)[*_]$/);
    if (dm) { deck = dm[1].trim(); lines.splice(k, 1); text = lines.join('\n'); }
  }

  const bodyMd = text.trim();
  const bodyHtml = smartenHtml(marked.parse(bodyMd));
  const bodyText = bodyHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { title, deck, bodyHtml, bodyText, signoff: colo.signoff };
}

function firstSentence(text) {
  const m = String(text || '').match(/^(.*?[.!?])(\s|$)/);
  return (m ? m[1] : String(text || '')).slice(0, 180);
}

function fillTemplate(tpl, d) {
  const deckBlock = d.deck ? `<p class="deck">${escapeHtml(d.deck)}</p>` : '';
  const map = {
    '{{TITLE}}': escapeHtml(d.title),
    '{{KICKER}}': escapeHtml(d.kicker),
    '{{DATE}}': escapeHtml(d.date),
    '{{CANONICAL}}': escapeAttr(d.canonical),
    '{{DESCRIPTION}}': escapeAttr(d.description),
    '{{DECK_BLOCK}}': deckBlock,
    '{{BODY}}': d.bodyHtml,
    '{{SIGNOFF_LINE}}': escapeHtml(d.signoff.line || ''),
    '{{SIGNOFF_NAME}}': escapeHtml(d.signoff.name || 'Tapas Kanti Roy'),
    '{{SIGNOFF_PLACE}}': escapeHtml(d.signoff.place || ''),
    '{{YEAR_RANGE}}': d.yearRange,
  };
  let out = tpl;
  for (const key of Object.keys(map)) out = out.split(key).join(map[key]);
  return out;
}

function buildIndexEntry({ display, urlPath, title, tagline }) {
  return `<article class="entry">
    <div class="entry-date">${escapeHtml(display)}</div>
    <div>
      <a href="${escapeAttr(urlPath)}" class="entry-title">${escapeHtml(title)}</a>
      <div class="entry-tagline">${escapeHtml(tagline)}</div>
    </div>
  </article>`;
}

// Insert (or replace, if the URL already exists) an entry in the blog index.
function upsertIndex(html, { year, entryBlock, urlPath }) {
  const hrefIdx = html.indexOf(`href="${urlPath}"`);
  if (hrefIdx !== -1) {
    const start = html.lastIndexOf('<article class="entry">', hrefIdx);
    const end = html.indexOf('</article>', hrefIdx);
    if (start !== -1 && end !== -1) {
      return html.slice(0, start) + entryBlock + html.slice(end + '</article>'.length);
    }
  }
  const yearTag = `<div class="year">${year}</div>`;
  const yi = html.indexOf(yearTag);
  if (yi !== -1) {
    const at = yi + yearTag.length;
    return html.slice(0, at) + '\n\n  ' + entryBlock + html.slice(at);
  }
  const firstYear = html.indexOf('<div class="year">');
  if (firstYear !== -1) {
    return html.slice(0, firstYear) + `${yearTag}\n\n  ${entryBlock}\n\n  ` + html.slice(firstYear);
  }
  throw new Error('Could not place the index entry: no <div class="year"> found in the index.');
}

// ---- plan + publish -----------------------------------------------------

// Build everything needed to publish, without writing anything. Drives the
// review gate; run() reuses it via the returned _internal.
function plan(skillId, { markdown, slug, now } = {}) {
  const dir = skillDir(skillId);
  if (!dir) throw new Error(`publishing template not found: ${skillId}`);
  const cfg = loadConfig(dir);
  const template = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
  let fm = {};
  try { fm = skills.parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')); } catch {}

  const doc = parseDoc(markdown || '');
  const { yyyy, mm, display } = dateParts(now || new Date());
  const blogRoot = cfg.blogRoot || 'blog';
  const finalSlug = slug && slug.trim() ? slugify(slug) : slugify(doc.title);
  const urlPath = `/${blogRoot}/${yyyy}/${mm}/${finalSlug}/`;
  const url = String(cfg.baseUrl || '').replace(/\/$/, '') + urlPath;
  const relFile = `${blogRoot}/${yyyy}/${mm}/${finalSlug}/index.html`;
  const absFile = path.join(cfg.repoDir, relFile);
  const relIndex = cfg.indexFile || `${blogRoot}/index.html`;
  const absIndex = path.join(cfg.repoDir, relIndex);

  const tagline = doc.deck || firstSentence(doc.bodyText);
  const description = (doc.deck || firstSentence(doc.bodyText) || doc.title).slice(0, 180);
  const yearRange = `${cfg.startYear || 2007}–${yyyy}`;

  const html = fillTemplate(template, {
    title: doc.title, deck: doc.deck, bodyHtml: doc.bodyHtml,
    kicker: cfg.kicker || 'Essay', date: display, canonical: url, description,
    signoff: doc.signoff, yearRange,
  });
  const entryBlock = buildIndexEntry({ display, urlPath, title: doc.title, tagline });

  let fileExists = false;
  try { fileExists = fs.existsSync(absFile); } catch {}
  let indexAction = 'none';
  try {
    if (fs.existsSync(absIndex)) {
      const idx = fs.readFileSync(absIndex, 'utf8');
      if (idx.includes(`href="${urlPath}"`)) indexAction = 'update';
      else if (idx.includes(`<div class="year">${yyyy}</div>`)) indexAction = 'add';
      else indexAction = 'create-year';
    }
  } catch { indexAction = 'none'; }

  const lint = [];
  if (/[—–]/.test(doc.bodyText)) lint.push('The body contains an em or en dash.');
  if (!doc.deck) lint.push('No italic standfirst after the title; the index tagline falls back to the first sentence.');
  if (fileExists) lint.push('A post already exists at this URL. Publishing overwrites it.');

  return {
    skill: { id: skillId, name: fm.name || skillId },
    title: doc.title,
    slug: finalSlug,
    deck: doc.deck || '',
    url,
    urlPath,
    relFile,
    relIndex,
    fileExists,
    indexAction,
    deploy: {
      repoDir: cfg.repoDir,
      bucket: (cfg.s3 && cfg.s3.bucket) || '',
      distributionId: (cfg.cloudfront && cfg.cloudfront.distributionId) || '',
    },
    previewHtml: doc.bodyHtml,
    lint,
    _internal: { html, absFile, absIndex, entryBlock, yyyy, mm, finalSlug, urlPath, cfg, blogRoot },
  };
}

function execFileP(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || '').toString().trim() || `${cmd} exited ${err.code}`));
      resolve(stdout);
    });
  });
}

async function deployToAws({ repoDir, bucket, distributionId, blogRoot, yyyy, mm, slug }) {
  if (!bucket) throw new Error('No S3 bucket configured in publish.json.');
  if (!fs.existsSync(repoDir)) throw new Error(`Site repo not found: ${repoDir}`);
  await execFileP('aws', ['s3', 'sync', '.', `s3://${bucket}/`, '--delete'], { cwd: repoDir });
  let invalidationId = null;
  if (distributionId) {
    const paths = [`/${blogRoot}/`, `/${blogRoot}/index.html`, `/${blogRoot}/${yyyy}/${mm}/${slug}/*`];
    const out = await execFileP(
      'aws',
      ['cloudfront', 'create-invalidation', '--distribution-id', distributionId, '--paths', ...paths, '--output', 'json'],
      { cwd: repoDir }
    );
    try { invalidationId = JSON.parse(out).Invalidation.Id; } catch {}
  }
  return { bucket, distributionId, invalidationId };
}

// Write the post + index entry, then (optionally) deploy. Returns a summary.
async function run(skillId, { markdown, slug, deploy = true, now } = {}) {
  const p = plan(skillId, { markdown, slug, now });
  const { html, absFile, absIndex, entryBlock, yyyy, mm, finalSlug, urlPath, cfg, blogRoot } = p._internal;

  fs.mkdirSync(path.dirname(absFile), { recursive: true });
  fs.writeFileSync(absFile, html);

  let indexUpdated = false;
  if (fs.existsSync(absIndex)) {
    const idx = fs.readFileSync(absIndex, 'utf8');
    const next = upsertIndex(idx, { year: yyyy, entryBlock, urlPath });
    if (next !== idx) { fs.writeFileSync(absIndex, next); indexUpdated = true; }
  }

  let deployResult = null;
  if (deploy) {
    deployResult = await deployToAws({
      repoDir: cfg.repoDir,
      bucket: (cfg.s3 && cfg.s3.bucket) || '',
      distributionId: (cfg.cloudfront && cfg.cloudfront.distributionId) || '',
      blogRoot, yyyy, mm, slug: finalSlug,
    });
  }

  return { url: p.url, relFile: p.relFile, indexUpdated, deployed: !!deployResult, deploy: deployResult };
}

module.exports = { listPublishers, plan, run };
```

## Appendix C: the existing blog publishing skill

On disk at `~/.claude/skills/blog-tapaskroy/`. This is the first real output skill; treat it as the worked example the detector and publish action should handle.

- `SKILL.md` — frontmatter `name: "Blog · tapaskroy.me"` plus the conventions (how title / deck / body / colophon map, slug and URL pattern, the no-em-dash rule).
- `template.html` — the full teal/Fraunces post shell with the placeholders listed under "Handoff status".
- `publish.json`:

```json
{
  "baseUrl": "https://tapaskroy.me",
  "repoDir": "~/code/watchagent/terraform-simple/landing-page",
  "blogRoot": "blog",
  "indexFile": "blog/index.html",
  "kicker": "Personal Software",
  "startYear": 2007,
  "s3": { "bucket": "tapaskroy-me-landing" },
  "cloudfront": { "distributionId": "E3F2P2QSY677F0" }
}
```
