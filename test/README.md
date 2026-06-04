# Tests

Two layers: a fast offline unit suite, and an opt-in end-to-end smoke test.

## Unit tests — `npm test`

Plain `node:test`, no dependencies, no network, no `claude` CLI. Covers the pure
logic:

- `unit/apply-edits.test.js` — find/replace application, ambiguous/missing matches, deletion
- `unit/extract-edits.test.js` — tolerant JSON parsing (fences, stray prose, in-string braces)
- `unit/flags.test.js` — model/effort whitelisting, web-tool flag building, request formatting
- `unit/docs.test.js` — persistence, title derivation, history add/prune (run against a temp dir)
- `unit/export.test.js` — standalone HTML generation, the format registry, and the `pptxgenjs` deck renderer (`deckToPptx`) with a stub deck. The pandoc/Chrome paths and the Claude deck-builder are exercised by the smoke test, not here.
- `unit/brief.test.js` — `briefToPrompt` (intake brief → generation constraints). The interviewer and brief-compiler CLI calls are exercised by the smoke test.
- `unit/skills.test.js` — skill discovery/read against a fixture dir (`DOC_EDITOR_SKILLS_DIR`), path-traversal safety, and `styleNote` wrapping.
- `unit/attachments.test.js` — attachment classify/store/remove and the prompt `referenceBlock` (fixture dir via `DOC_EDITOR_ASSETS_DIR`).
- `unit/export-media.test.js` — `buildHtml` inlining `/media` images as data URIs for portable HTML/PDF.
- `unit/usage.test.js` — `extractUsage`/`sumUsage` (normalizing + combining the CLI's token/cost fields); `docs.addUsage` is covered in `docs.test.js`.
- `unit/versions.test.js` — version store: append, newest-first list, get, manual-edit coalescing, `previous()` for undo, and `diffPair()` (a snapshot paired with its parent — guards the diff-against-parent semantics).
- `unit/linediff.test.js` — the LCS line diff (`public/linediff.js`, shared with the browser). Includes the regression guard: an add-only edit yields only additions with every original line preserved (the bug where diffs were noisy).

These run in well under a second and are safe to run anywhere.

## Smoke test — `npm run test:smoke`

End-to-end: spawns the server on a spare port against a throwaway docs directory,
drives the real UI in headless Chrome (generate → select text → comment → revise →
conversation history), then tears everything down.

**Opt-in, because it needs:**

- the **`claude` CLI** installed and authenticated (generation actually calls it),
- **Google Chrome** installed (driven via playwright-core's `chrome` channel),
- **playwright-core**, which is *not* a project dependency — install it ad hoc:

  ```bash
  npm i --no-save playwright-core
  npm run test:smoke
  ```

It's kept out of `npm test` on purpose: it's slow and depends on the CLI + network.
