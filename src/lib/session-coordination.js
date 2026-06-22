// Pure reducer + selectors for the collab session's coordination state.
//
// Architecture-review entry #10 (docs/architecture-review.md): before this
// module existed, the publish-path coordination lived as seven scattered
// refs inside useCollabSession.js. Five of those refs encode a small
// lifecycle/status state machine ("first blocks sync seen? first meta
// sync seen? schema compatible? room migration-partial? doc over the
// publish cap?"). Each ref was mutated in a different callback and read
// from a different publish effect; the implicit invariants (e.g. "once
// schema-incompatible, no publish path may fire") lived as scattered
// `if (...Ref.current) return` guards.
//
// This module owns those five fields as a single immutable state shape,
// with pure verbs for every transition and selectors that name the
// publish-readiness questions the hook actually asks.
//
// Scope (option d, design lock 2026-05-19):
//   - In reducer state: sessionReady, metaReady, schemaIncompatible,
//     migrationPartial, publishOvercap.
//   - OUT of reducer state (stay as plain refs in the hook):
//       lastRemoteBlocksRef    — identity cache for `blocks === last`
//                                 echo skip on the blocks publish effect.
//       lastPublishedTcSeqRef  — counter cache for the TC publish-seq
//                                 echo gate; the hook mutates it
//                                 inside the publish effect AND via the
//                                 imperative markTcSeqApplied API.
//       sessionRef             — handle to the collab session itself.
//     These are not state-machine nodes; modelling them as reducer
//     fields would force the hook through React commits for what are
//     fundamentally synchronous identity / counter caches.
//
// Storage strategy (option b, design lock 2026-05-19): the hook applies
// these verbs to a `coordRef.current` (NOT React useState). The reducer
// is pure and property-testable in isolation; the hook reads the state
// imperatively inside its publish effects so a coord transition does
// not invalidate the meta / TC publish effects' dep lists (which would
// otherwise cause re-publish storms when `publishOvercap` yo-yos around
// the cap, or when `schemaIncompatible` trips between meta edits).
//
// The unit invariants in src/lib/__tests__/session-coordination.test.js
// pin: terminal `schemaIncompatible`, gate implications, the sticky
// status filter, and the schema-version gate ordering.

// Maximum schemaVersion the current client understands. Bumped to 2 in
// sub-PR 1d (#47, ADR-0006) — this client speaks the Y.XmlFragment
// substrate. A future v3 client/server pair will bump this; the reducer's
// terminal-trip behavior is unchanged.
export const MAX_SUPPORTED_SCHEMA_VERSION = 2;

export function createInitial() {
  return {
    sessionReady: false,
    metaReady: false,
    schemaIncompatible: false,
    migrationPartial: false,
    publishOvercap: false,
    statusIncompatible: false,
  };
}

// ── Verbs ────────────────────────────────────────────────────────────────

// Flips sessionReady=true on the first remote-blocks sync. Idempotent
// (callers always invoke once per onRemoteBlocks(meta.initial=true), but
// the no-op-when-set return preserves identity for downstream `===` checks).
export function onBlocksSync(state) {
  if (state.sessionReady) return state;
  return { ...state, sessionReady: true };
}

// Flips metaReady=true on the first remote-meta sync, AND folds the
// remote payload's schemaVersion + migrationPartial into the schema
// gate. The schema check is exclusive: a schema-incompatible payload
// trips schemaIncompatible and leaves migrationPartial untouched (the
// banner the operator needs to see is the incompatible one).
//
// Once schemaIncompatible has tripped, this verb still updates
// metaReady — but selectors gate every publish path on
// !schemaIncompatible, so the gate-open does not unlock anything. The
// flip is preserved for symmetry with the pre-reducer behavior (the
// metaReadyRef was set unconditionally at line 313 of the hook).
export function onMetaSync(state, { schemaVersion, migrationPartial } = {}) {
  let next = state;
  const incompatible =
    typeof schemaVersion === 'number' &&
    schemaVersion > MAX_SUPPORTED_SCHEMA_VERSION;
  if (incompatible && !next.schemaIncompatible) {
    next = { ...next, schemaIncompatible: true };
  } else if (migrationPartial === true && !next.migrationPartial) {
    next = { ...next, migrationPartial: true };
  }
  if (!next.metaReady) {
    next = { ...next, metaReady: true };
  }
  return next === state ? state : next;
}

// Trips the over-cap latch. Idempotent.
export function onPublishOvercap(state) {
  if (state.publishOvercap) return state;
  return { ...state, publishOvercap: true };
}

// Clears the over-cap latch. Idempotent. Callers diff prev.publishOvercap
// against the returned state's publishOvercap to decide whether to push
// the "sync resumed" toast (per design lock — toast is a hook-side side
// effect, not a reducer concern).
export function onPublishSucceeded(state) {
  if (!state.publishOvercap) return state;
  return { ...state, publishOvercap: false };
}

// Trips the statusIncompatible latch. Idempotent. Called by the hook's
// onStatusChange trampoline when an 'incompatible' status arrives (e.g.
// from onAuthenticationFailed in collab.js). Terminal-sticky like
// schemaIncompatible — once tripped, every subsequent status collapses to
// 'incompatible' so a trailing HocuspocusProvider reconnect cycle cannot
// clobber the banner. Session-scoped: coordRef is rebuilt (createInitial)
// in the session lifecycle cleanup so a room-switch or remount starts clean.
export function onStatusIncompatible(state) {
  if (state.statusIncompatible) return state;
  return { ...state, statusIncompatible: true };
}

// ── Selectors ────────────────────────────────────────────────────────────

export function canPublishBlocks(state) {
  return state.sessionReady && !state.schemaIncompatible;
}

export function canPublishMeta(state) {
  return state.sessionReady && state.metaReady && !state.schemaIncompatible;
}

export function canPublishTc(state) {
  return state.sessionReady && !state.schemaIncompatible;
}

export function canDispatchComment(state) {
  return !state.schemaIncompatible;
}

export function canBroadcastCursor(state) {
  return !state.schemaIncompatible;
}

// Applies the sticky status filters that the hook's onStatusChange
// trampoline previously implemented inline:
//   - schemaIncompatible is terminal: every incoming status collapses
//     to 'incompatible' so the banner cannot be clobbered by a later
//     'connected' / 'connecting' / 'disconnected' transition.
//   - migrationPartial replaces 'connected' with 'migration-partial'
//     so the operator-actionable banner survives reconnects. Other
//     incoming statuses pass through (a real disconnect should still
//     read as 'disconnected').
//
// Returns the effective status string the consumer should observe.
export function effectiveStatus(state, rawStatus) {
  if (state.schemaIncompatible || state.statusIncompatible) return 'incompatible';
  if (state.migrationPartial && rawStatus === 'connected') {
    return 'migration-partial';
  }
  return rawStatus;
}
