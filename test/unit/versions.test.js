'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-editor-versions-'));
process.env.DOC_EDITOR_VERSIONS_DIR = TMP;

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const versions = require('../../lib/versions');

const DOC = 'doc-v-test';
beforeEach(() => fs.rmSync(path.join(TMP, DOC + '.json'), { force: true }));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('add() appends snapshots; list() is newest-first metadata without markdown', () => {
  versions.add(DOC, { label: 'Draft', kind: 'ai', markdown: '# A' });
  versions.add(DOC, { label: 'Revision: x', kind: 'ai', markdown: '# A\n\nmore' });
  const list = versions.list(DOC);
  assert.equal(list.length, 2);
  assert.equal(list[0].label, 'Revision: x'); // newest first
  assert.equal(list[1].label, 'Draft');
  assert.equal('markdown' in list[0], false); // metadata only
  assert.ok(list[0].vid && list[0].at);
});

test('get() returns the full markdown of a snapshot', () => {
  versions.add(DOC, { label: 'Draft', kind: 'ai', markdown: '# Hello' });
  const vid = versions.list(DOC)[0].vid;
  assert.equal(versions.get(DOC, vid).markdown, '# Hello');
});

test('consecutive manual edits coalesce into one snapshot', () => {
  versions.add(DOC, { label: 'Draft', kind: 'ai', markdown: '# A' });
  versions.add(DOC, { label: 'Manual edit', kind: 'manual', markdown: '# A x' });
  versions.add(DOC, { label: 'Manual edit', kind: 'manual', markdown: '# A xy' });
  versions.add(DOC, { label: 'Manual edit', kind: 'manual', markdown: '# A xyz' });
  const list = versions.list(DOC);
  assert.equal(list.length, 2); // Draft + ONE coalesced manual edit
  // the coalesced snapshot holds the latest text
  assert.equal(versions.get(DOC, list[0].vid).markdown, '# A xyz');
});

test('an AI snapshot between manual edits prevents coalescing', () => {
  versions.add(DOC, { label: 'Manual edit', kind: 'manual', markdown: 'a' });
  versions.add(DOC, { label: 'Revision', kind: 'ai', markdown: 'b' });
  versions.add(DOC, { label: 'Manual edit', kind: 'manual', markdown: 'c' });
  assert.equal(versions.list(DOC).length, 3);
});

test('previous() returns the snapshot before the head (for single-step undo)', () => {
  assert.equal(versions.previous(DOC), null); // none yet
  versions.add(DOC, { label: 'Draft', kind: 'ai', markdown: 'one' });
  assert.equal(versions.previous(DOC), null); // only one
  versions.add(DOC, { label: 'Revision', kind: 'ai', markdown: 'two' });
  assert.equal(versions.previous(DOC).markdown, 'one');
});
