// Pure reducer + selectors for Track Changes state.
//
// State shape: { enabled, publishSeq }
//
// Per-keystroke marking is performed by PmEditableBlock's
// dispatchTransaction intercept (Q33). This reducer's only remaining
// responsibility is:
//   - the `enabled` flag (gates the PM marking pipeline + revision flags
//     applied to block-level create/delete in App.jsx)
//   - the `publishSeq` counter that drives the publish effect inside
//     useCollabSession (replaces the imperative `tcDirtyRef` flag).
//
// User-driven verbs bump publishSeq; `applyRemote` does not, so the
// publish effect can detect "do we need to push this to peers?" by
// comparing against the last published seq. The wire payload is
// `{ enabled }` (Q37); a legacy `snapshots` field is tolerated and
// ignored for backward compat with pre-1h rooms.

export function createInitial() {
  return { enabled: false, publishSeq: 0 };
}

// Block list is accepted but ignored — call sites in App.jsx pass it
// for compatibility with the pre-Q35 signature. Drop the arg at the
// callers when convenient; do not rely on it here.
export function enable(state /* , blocks */) {
  return { enabled: true, publishSeq: state.publishSeq + 1 };
}

export function disable(state) {
  return { enabled: false, publishSeq: state.publishSeq + 1 };
}

export function acceptAll(state /* , blocks */) {
  if (!state.enabled) return state;
  return { ...state, publishSeq: state.publishSeq + 1 };
}

export function rejectAll(state /* , blocks */) {
  if (!state.enabled) return state;
  return { ...state, publishSeq: state.publishSeq + 1 };
}

export function applyRemote(state, payload) {
  const enabled = !!(payload && payload.enabled);
  return { enabled, publishSeq: state.publishSeq };
}

// ─── Selectors ──────────────────────────────────────────────────────────────

export function isEnabled(state) {
  return !!state.enabled;
}

export function getPublishableState(state) {
  return { enabled: !!state.enabled };
}

export function revisionFlagForCreate(state) {
  return state.enabled ? 'add' : undefined;
}

// Returns 'del' when the block should be marked as a pending deletion,
// or null when the block should be removed outright (TC off, or it was
// itself a pending add).
export function revisionFlagForDelete(state, block) {
  if (!state.enabled) return null;
  if (block && block.revision === 'add') return null;
  return 'del';
}
