// Pure reducer + selectors for the Comments module.
//
// State shape:
//   { byId: Map<commentId, Comment>, seenRemoteIds: Set<commentId> }
//
// `seenRemoteIds` is the tombstone discriminator used by mergeRemote (M2.5).
// Any commentId we have ever observed in a remote payload is considered
// "known to peers" — if it later disappears from a remote payload we drop
// it locally, treating peer absence as authoritative deletion. Local drafts
// (never seen remote) are preserved across merges so the originator's
// in-flight create doesn't get wiped by the first remote echo.
//
// Verbs return `{ state, publish }`. `publish` is null for no-ops or for
// `createDraft` (publishing is deferred until updateCreate fills in the
// initial text). The caller drives the outbound side of the publish path
// by handing each non-null envelope to `dispatchComment` on the collab
// session.

const STATUS_OPEN = 'open';
const STATUS_RESOLVED = 'resolved';

export function createInitial() {
  return { byId: new Map(), seenRemoteIds: new Set() };
}

function generateEntryId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `e-${crypto.randomUUID()}`;
  }
  return `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildEntry(type, identity, ts, text) {
  return {
    id: generateEntryId(),
    type,
    text: text != null ? text : '',
    authorId: identity?.id || '',
    authorName: identity?.name || '',
    authorColor: identity?.color || '',
    ts,
  };
}

function withById(state, byId) {
  return { byId, seenRemoteIds: state.seenRemoteIds };
}

// ─── Verbs ──────────────────────────────────────────────────────────────────

export function createDraft(state, { commentId, blockId, highlightText, identity, ts }) {
  const byId = new Map(state.byId);
  const createEntry = buildEntry('create', identity, ts, '');
  byId.set(commentId, {
    id: commentId,
    blockId,
    status: STATUS_OPEN,
    highlightText: highlightText || '',
    createdAt: ts,
    authorId: identity?.id || '',
    authorName: identity?.name || '',
    authorColor: identity?.color || '',
    entries: [createEntry],
  });
  return { state: withById(state, byId), publish: null };
}

export function updateCreate(state, { commentId, text, identity, ts }) {
  const c = state.byId.get(commentId);
  if (!c) return { state, publish: null };
  const entries = c.entries.slice();
  if (entries[0]?.type === 'create') {
    entries[0] = { ...entries[0], text, authorName: identity?.name || entries[0].authorName, authorId: identity?.id || entries[0].authorId, authorColor: identity?.color || entries[0].authorColor, ts };
  }
  const next = { ...c, entries };
  const byId = new Map(state.byId);
  byId.set(commentId, next);
  const publish = {
    kind: 'create',
    commentId,
    payload: {
      blockId: c.blockId,
      status: c.status,
      highlightText: c.highlightText,
      createdAt: c.createdAt,
      author: identity,
      initialText: text,
    },
  };
  // #216: our own create is filtered by the 'local-*' origin guard in
  // handleAfterTx, so it never echoes back through onRemoteComments and never
  // enters seenRemoteIds. Add it here at publish time so a later peer deletion
  // is correctly tombstoned by mergeRemote instead of being preserved as a
  // "local draft" ghost. Amends ADR-0010 item 4 (M2.5). Only published comments
  // reach this verb — drafts stay out of seenRemoteIds via createDraft.
  const seenRemoteIds = new Set(state.seenRemoteIds);
  seenRemoteIds.add(commentId);
  return { state: { byId, seenRemoteIds }, publish };
}

export function reply(state, { commentId, text, identity, ts }) {
  const c = state.byId.get(commentId);
  if (!c) return { state, publish: null };
  const replyEntry = buildEntry('reply', identity, ts, text);
  const next = { ...c, entries: [...c.entries, replyEntry] };
  const byId = new Map(state.byId);
  byId.set(commentId, next);
  const publish = {
    kind: 'reply',
    commentId,
    reply: { author: identity, text, ts },
  };
  return { state: withById(state, byId), publish };
}

export function resolve(state, { commentId, identity, ts }) {
  const c = state.byId.get(commentId);
  if (!c) return { state, publish: null };
  const entry = buildEntry('resolve', identity, ts, '');
  const next = { ...c, status: STATUS_RESOLVED, entries: [...c.entries, entry] };
  const byId = new Map(state.byId);
  byId.set(commentId, next);
  const publish = {
    kind: 'status',
    commentId,
    status: STATUS_RESOLVED,
    meta: { author: identity, ts },
  };
  return { state: withById(state, byId), publish };
}

export function reopen(state, { commentId, identity, ts }) {
  const c = state.byId.get(commentId);
  if (!c) return { state, publish: null };
  const entry = buildEntry('reopen', identity, ts, '');
  const next = { ...c, status: STATUS_OPEN, entries: [...c.entries, entry] };
  const byId = new Map(state.byId);
  byId.set(commentId, next);
  const publish = {
    kind: 'status',
    commentId,
    status: STATUS_OPEN,
    meta: { author: identity, ts },
  };
  return { state: withById(state, byId), publish };
}

export function remove(state, { commentId }) {
  // Always emit the delete envelope — peers may still hold the entry even
  // if we don't, and the underlying *ToDoc operation is idempotent on receipt.
  const publish = { kind: 'delete', commentId };
  if (!state.byId.has(commentId)) return { state, publish };
  const byId = new Map(state.byId);
  byId.delete(commentId);
  return { state: withById(state, byId), publish };
}

// M2.5 mergeRemote — union with seenRemoteIds tombstone discriminator.
//
// For every id in (remote ∪ prev.byId):
//   - in remote                  → remote wins
//   - else if in seenRemoteIds   → tombstone, drop
//   - else                       → preserved local draft
// seenRemoteIds monotonically grows.
export function mergeRemote(state, remoteCommentsObj) {
  const remote = remoteCommentsObj && typeof remoteCommentsObj === 'object'
    ? remoteCommentsObj
    : {};
  const remoteIds = new Set(Object.keys(remote));
  const nextById = new Map();
  for (const id of remoteIds) {
    nextById.set(id, remote[id]);
  }
  for (const [id, comment] of state.byId) {
    if (remoteIds.has(id)) continue;
    if (state.seenRemoteIds.has(id)) continue;
    nextById.set(id, comment);
  }
  const nextSeen = new Set(state.seenRemoteIds);
  for (const id of remoteIds) nextSeen.add(id);
  return { byId: nextById, seenRemoteIds: nextSeen };
}

// ─── Selectors ──────────────────────────────────────────────────────────────

export function size(state) {
  return state.byId.size;
}

export function get(state, commentId) {
  return state.byId.get(commentId);
}

export function all(state) {
  return Array.from(state.byId.values());
}

export function isDraft(comment) {
  if (!comment || !Array.isArray(comment.entries)) return false;
  if (comment.entries.length !== 1) return false;
  const e = comment.entries[0];
  return e?.type === 'create' && !e.text;
}

export function getCreateEntry(comment) {
  if (!comment || !Array.isArray(comment.entries)) return undefined;
  return comment.entries.find((e) => e?.type === 'create');
}

// ─── reconcileBlocks ────────────────────────────────────────────────────────
//
// For each editable block (b.html present, contains 'mark-comment'):
//   - Walk every <span data-comment-id="X">.
//   - If X is not in state.byId → unwrap (orphan or local-deleted).
//   - Else ensure className matches state.byId.get(X).status:
//       open     → 'mark-comment'
//       resolved → 'mark-comment-resolved'
// Idempotent: returns the original `blocks` reference when nothing changed.
export function reconcileBlocks(blocks, state, { shouldSkip = () => false } = {}) {
  if (typeof document === 'undefined') return blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return blocks;
  let anyChanged = false;
  const next = blocks.map((b) => {
    if (shouldSkip(b.id)) return b;
    if (!b || typeof b.html !== 'string' || !b.html.includes('mark-comment')) return b;
    const div = document.createElement('div');
    div.innerHTML = b.html;
    const spans = div.querySelectorAll('span[data-comment-id]');
    let blockChanged = false;
    spans.forEach((span) => {
      const cls = span.getAttribute('class') || '';
      if (!cls.includes('mark-comment')) return;
      const id = span.getAttribute('data-comment-id');
      if (!id) return;
      const comment = state.byId.get(id);
      if (!comment) {
        // Orphan or locally deleted — unwrap.
        const parent = span.parentNode;
        if (!parent) return;
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
        blockChanged = true;
        return;
      }
      const target = comment.status === STATUS_RESOLVED ? 'mark-comment-resolved' : 'mark-comment';
      if (cls !== target) {
        span.setAttribute('class', target);
        blockChanged = true;
      }
    });
    if (!blockChanged) return b;
    anyChanged = true;
    return { ...b, html: div.innerHTML };
  });
  return anyChanged ? next : blocks;
}

// ─── Render-time selectors for ref/table block highlights ──────────────────
//
// Ref and table blocks store their text outside of `block.html` (in
// `block.ref` / `block.table` respectively), so `reconcileBlocks` is a
// no-op for them. To keep the highlight in sync with metadata across
// remote sync, undo/redo, and any re-render, the components derive
// `mark-comment` / `mark-comment-resolved` wrappings at render time
// from the comments state itself.

export function getBlockComments(state, blockId) {
  const out = [];
  if (!state || !(state.byId instanceof Map)) return out;
  for (const c of state.byId.values()) {
    if (c && c.blockId === blockId) out.push(c);
  }
  return out;
}

// Slice `text` into `[{ text, comment }, ...]` segments. Segments with a
// non-null `comment` are the substrings the caller should wrap with
// `mark-comment` / `mark-comment-resolved`. Match strategy: first
// occurrence per comment, scanning left to right; comments whose match
// would overlap an already-claimed range fall back to their next
// occurrence (and are dropped if no non-overlapping occurrence exists).
// Returns `[{ text, comment: null }]` when there is no work to do, so
// callers can map without a length check.
export function computeCommentSegments(text, blockComments) {
  if (typeof text !== 'string') return [{ text: '', comment: null }];
  if (text === '') return [{ text: '', comment: null }];
  const safe = Array.isArray(blockComments) ? blockComments : [];
  if (safe.length === 0) return [{ text, comment: null }];

  const matches = [];
  for (const c of safe) {
    const needle = c?.highlightText;
    if (typeof needle !== 'string' || needle === '') continue;
    let from = 0;
    while (from <= text.length) {
      const idx = text.indexOf(needle, from);
      if (idx < 0) break;
      const end = idx + needle.length;
      const overlaps = matches.some((m) => !(end <= m.start || idx >= m.end));
      if (!overlaps) {
        matches.push({ start: idx, end, comment: c });
        break;
      }
      from = idx + 1;
    }
  }
  if (matches.length === 0) return [{ text, comment: null }];
  matches.sort((a, b) => a.start - b.start);
  const segs = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) segs.push({ text: text.slice(cursor, m.start), comment: null });
    segs.push({ text: text.slice(m.start, m.end), comment: m.comment });
    cursor = m.end;
  }
  if (cursor < text.length) segs.push({ text: text.slice(cursor), comment: null });
  return segs;
}

// ─── normalizeForLoad ───────────────────────────────────────────────────────
//
// Load-boundary shim: convert legacy `author` (string) + `timestamp` (ISO
// string) entry fields into the canonical `authorName` + `ts` (number)
// fields. Canonical fields take priority — legacy fields only fill in
// missing ones. Returns a new raw comments object; never mutates the input.
export function normalizeForLoad(rawCommentsObj) {
  if (!rawCommentsObj || typeof rawCommentsObj !== 'object') return rawCommentsObj;
  const out = {};
  for (const [id, c] of Object.entries(rawCommentsObj)) {
    if (!c || typeof c !== 'object') {
      out[id] = c;
      continue;
    }
    const entries = Array.isArray(c.entries) ? c.entries.map(normalizeEntry) : c.entries;
    out[id] = entries === c.entries ? c : { ...c, entries };
  }
  return out;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  let next = entry;
  if (next.authorName == null && typeof next.author === 'string') {
    next = { ...next, authorName: next.author };
  }
  if (typeof next.ts !== 'number' && typeof next.timestamp === 'string') {
    const parsed = Date.parse(next.timestamp);
    if (Number.isFinite(parsed)) {
      next = { ...next, ts: parsed };
    }
  }
  return next;
}
