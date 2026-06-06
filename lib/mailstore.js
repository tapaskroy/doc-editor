// Persistent local cache of mail so the UI can render threads INSTANTLY, without
// waiting on a Claude+MCP round trip. The server refreshes this in the background
// (on boot + on an interval + opportunistically on reads); the API serves whatever
// is stored immediately and never blocks on a live fetch. Survives restarts.
//
// Holds the user's mail (subjects/senders/snippets/bodies), so the cache dir is
// gitignored like docs/.

const fs = require('fs');
const path = require('path');

const DIR = process.env.DOC_EDITOR_CACHE_DIR || path.join(__dirname, '..', 'docs-cache');
const FILE = path.join(DIR, 'mail.json');
const MAX_THREADS = 80; // cap the per-thread body cache so the file can't grow unbounded
const VERSION = 2; // bump when the cached shape changes (e.g. added html) to invalidate old caches

let store = { inbox: { threads: [], fetchedAt: 0 }, threads: {} };

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.version === VERSION) {
      store.inbox = parsed.inbox || store.inbox;
      store.threads = parsed.threads || {};
    }
  } catch {
    /* no cache yet — start empty */
  }
}

let writeTimer = null;
function persist() {
  // Debounce writes; the cache is best-effort and we may set several at once.
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify({ version: VERSION, ...store }));
    } catch {
      /* best-effort */
    }
  }, 200);
}

function getInbox() {
  return store.inbox || { threads: [], fetchedAt: 0 };
}
function setInbox(threads) {
  store.inbox = { threads: threads || [], fetchedAt: Date.now() };
  persist();
}

function getThread(id) {
  return store.threads[id] || null;
}
function setThread(id, data) {
  store.threads[id] = { data, fetchedAt: Date.now() };
  // Evict the oldest if we exceed the cap.
  const ids = Object.keys(store.threads);
  if (ids.length > MAX_THREADS) {
    ids.sort((a, b) => (store.threads[a].fetchedAt || 0) - (store.threads[b].fetchedAt || 0));
    for (const old of ids.slice(0, ids.length - MAX_THREADS)) delete store.threads[old];
  }
  persist();
}

load();

module.exports = { getInbox, setInbox, getThread, setThread };
