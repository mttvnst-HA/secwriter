import { describe, it, expect } from 'vitest';
import * as sc from '../session-coordination.js';

// Architecture-review entry #10 (docs/architecture-review.md) lands the
// useCollabSession coordination-refs cluster as a pure reducer. The six
// invariants (I1-I6) below were locked at design time and pin the
// behaviors the hook's publish gates + status filter depend on.

describe('state shape', () => {
  it('createInitial returns five false flags', () => {
    const s = sc.createInitial();
    expect(s).toEqual({
      sessionReady: false,
      metaReady: false,
      schemaIncompatible: false,
      migrationPartial: false,
      publishOvercap: false,
    });
  });

  it('MAX_SUPPORTED_SCHEMA_VERSION is 2 (post 1d ADR-0006)', () => {
    expect(sc.MAX_SUPPORTED_SCHEMA_VERSION).toBe(2);
  });
});

describe('verbs', () => {
  it('onBlocksSync flips sessionReady=true', () => {
    const s0 = sc.createInitial();
    const s1 = sc.onBlocksSync(s0);
    expect(s1.sessionReady).toBe(true);
    expect(s1).not.toBe(s0);
  });

  it('onMetaSync flips metaReady=true on a compatible payload', () => {
    const s = sc.onMetaSync(sc.createInitial(), { schemaVersion: 2 });
    expect(s.metaReady).toBe(true);
    expect(s.schemaIncompatible).toBe(false);
    expect(s.migrationPartial).toBe(false);
  });

  it('onMetaSync without schema info still flips metaReady=true', () => {
    const s = sc.onMetaSync(sc.createInitial(), {});
    expect(s.metaReady).toBe(true);
  });

  it('onMetaSync with no args treats missing fields as compatible', () => {
    const s = sc.onMetaSync(sc.createInitial());
    expect(s.metaReady).toBe(true);
    expect(s.schemaIncompatible).toBe(false);
  });

  it('onPublishOvercap trips publishOvercap=true', () => {
    const s = sc.onPublishOvercap(sc.createInitial());
    expect(s.publishOvercap).toBe(true);
  });

  it('onPublishSucceeded clears publishOvercap', () => {
    const s = sc.onPublishSucceeded(sc.onPublishOvercap(sc.createInitial()));
    expect(s.publishOvercap).toBe(false);
  });
});

describe('I1 — schemaIncompatible is terminal', () => {
  // Once schemaIncompatible is true, NO verb other than createInitial can
  // return state with schemaIncompatible=false. This is the load-bearing
  // guarantee that lets the hook's lifecycle-effect cleanup be the only
  // path out of the incompatible banner.
  const incompatible = sc.onMetaSync(sc.createInitial(), { schemaVersion: 999 });

  it('onMetaSync cannot un-trip schemaIncompatible (even with a compatible payload later)', () => {
    const next = sc.onMetaSync(incompatible, { schemaVersion: 2 });
    expect(next.schemaIncompatible).toBe(true);
  });

  it('onBlocksSync does not un-trip', () => {
    expect(sc.onBlocksSync(incompatible).schemaIncompatible).toBe(true);
  });

  it('onPublishOvercap does not un-trip', () => {
    expect(sc.onPublishOvercap(incompatible).schemaIncompatible).toBe(true);
  });

  it('onPublishSucceeded does not un-trip', () => {
    expect(sc.onPublishSucceeded(incompatible).schemaIncompatible).toBe(true);
  });

  it('createInitial is the only way back to schemaIncompatible=false', () => {
    expect(sc.createInitial().schemaIncompatible).toBe(false);
  });
});

describe('I2 — every canPublish* selector implies sessionReady && !schemaIncompatible', () => {
  // Generates the 2^5 = 32 possible state shapes and asserts the
  // implication for every one. Cheap brute-force property test.
  const bools = [false, true];
  const states = [];
  for (const sessionReady of bools)
    for (const metaReady of bools)
      for (const schemaIncompatible of bools)
        for (const migrationPartial of bools)
          for (const publishOvercap of bools)
            states.push({ sessionReady, metaReady, schemaIncompatible, migrationPartial, publishOvercap });

  it.each(states)('state %o', (s) => {
    for (const fn of [sc.canPublishBlocks, sc.canPublishMeta, sc.canPublishTc]) {
      if (fn(s)) {
        expect(s.sessionReady).toBe(true);
        expect(s.schemaIncompatible).toBe(false);
      }
    }
    if (sc.canPublishMeta(s)) expect(s.metaReady).toBe(true);
  });
});

describe('I2-converse — the gate predicates must actually unlock when their preconditions hold', () => {
  // Without this, an "always returns false" canPublishBlocks would pass
  // I2 silently. Asserts the gate fires whenever its sufficient
  // preconditions hold across all 32 boolean state shapes — i.e. the
  // selectors are not over-strict.
  const bools = [false, true];
  const states = [];
  for (const sessionReady of bools)
    for (const metaReady of bools)
      for (const schemaIncompatible of bools)
        for (const migrationPartial of bools)
          for (const publishOvercap of bools)
            states.push({ sessionReady, metaReady, schemaIncompatible, migrationPartial, publishOvercap });

  it.each(states)('state %o', (s) => {
    if (s.sessionReady && !s.schemaIncompatible) {
      expect(sc.canPublishBlocks(s)).toBe(true);
      expect(sc.canPublishTc(s)).toBe(true);
      if (s.metaReady) expect(sc.canPublishMeta(s)).toBe(true);
    }
    if (!s.schemaIncompatible) {
      expect(sc.canDispatchComment(s)).toBe(true);
      expect(sc.canBroadcastCursor(s)).toBe(true);
    }
  });
});

describe('I3 — effectiveStatus collapses connected → migration-partial', () => {
  it('returns migration-partial when migrationPartial AND raw is connected AND not incompatible', () => {
    const s = sc.onMetaSync(sc.createInitial(), { schemaVersion: 2, migrationPartial: true });
    expect(sc.effectiveStatus(s, 'connected')).toBe('migration-partial');
  });

  it('passes through when migrationPartial but raw is NOT connected', () => {
    const s = sc.onMetaSync(sc.createInitial(), { schemaVersion: 2, migrationPartial: true });
    expect(sc.effectiveStatus(s, 'connecting')).toBe('connecting');
    expect(sc.effectiveStatus(s, 'disconnected')).toBe('disconnected');
    expect(sc.effectiveStatus(s, 'syncing')).toBe('syncing');
  });

  it('passes through when migrationPartial is false', () => {
    const s = sc.onMetaSync(sc.createInitial(), { schemaVersion: 2 });
    expect(sc.effectiveStatus(s, 'connected')).toBe('connected');
  });
});

describe('I4 — effectiveStatus returns "incompatible" for any input once schemaIncompatible', () => {
  const incompatible = sc.onMetaSync(sc.createInitial(), { schemaVersion: 999 });

  it.each([
    'connected', 'connecting', 'disconnected', 'syncing',
    'migration-partial', 'incompatible', 'unknown-future-status',
  ])('input %s → "incompatible"', (raw) => {
    expect(sc.effectiveStatus(incompatible, raw)).toBe('incompatible');
  });

  it('terminal even when migrationPartial would otherwise replace connected', () => {
    // Schema-incompatible always wins over migration-partial. (In
    // practice the hook trips one branch or the other per onMetaSync,
    // never both — but the selector must still be safe if both somehow
    // sit true together.)
    const s = { ...incompatible, migrationPartial: true };
    expect(sc.effectiveStatus(s, 'connected')).toBe('incompatible');
  });
});

describe('I5 — onMetaSync with schemaVersion > MAX trips schemaIncompatible AND still flips metaReady', () => {
  // Mirrors the pre-reducer hook behavior at line 313: metaReadyRef was
  // set unconditionally. The schema gate only stops PUBLISH; it does
  // not stop the meta payload from being marked as observed. Selectors
  // then enforce that canPublishMeta is still false because of
  // schemaIncompatible.
  it('schemaVersion=3 sets both schemaIncompatible and metaReady', () => {
    const s = sc.onMetaSync(sc.createInitial(), { schemaVersion: 3 });
    expect(s.schemaIncompatible).toBe(true);
    expect(s.metaReady).toBe(true);
    expect(sc.canPublishMeta(s)).toBe(false);
  });

  it('schemaVersion at MAX leaves schemaIncompatible false', () => {
    const s = sc.onMetaSync(sc.createInitial(), { schemaVersion: sc.MAX_SUPPORTED_SCHEMA_VERSION });
    expect(s.schemaIncompatible).toBe(false);
    expect(s.metaReady).toBe(true);
  });

  it('schemaVersion below MAX leaves schemaIncompatible false', () => {
    const s = sc.onMetaSync(sc.createInitial(), { schemaVersion: 1 });
    expect(s.schemaIncompatible).toBe(false);
  });

  it('non-numeric schemaVersion does not trip the gate', () => {
    const s = sc.onMetaSync(sc.createInitial(), { schemaVersion: undefined });
    expect(s.schemaIncompatible).toBe(false);
  });

  it('schema-incompatible payload ignores migrationPartial=true (incompatible wins)', () => {
    const s = sc.onMetaSync(sc.createInitial(), { schemaVersion: 3, migrationPartial: true });
    expect(s.schemaIncompatible).toBe(true);
    // Per onMetaSync's exclusive branches: incompatible suppresses the
    // migrationPartial flip. The operator sees the more urgent banner.
    expect(s.migrationPartial).toBe(false);
  });
});

describe('I6 — verbs are idempotent', () => {
  it('onBlocksSync', () => {
    const s = sc.onBlocksSync(sc.createInitial());
    expect(sc.onBlocksSync(s)).toBe(s);
  });

  it('onMetaSync with same payload', () => {
    const s = sc.onMetaSync(sc.createInitial(), { schemaVersion: 2 });
    expect(sc.onMetaSync(s, { schemaVersion: 2 })).toBe(s);
  });

  it('onMetaSync with schema-incompatible payload', () => {
    const s = sc.onMetaSync(sc.createInitial(), { schemaVersion: 3 });
    expect(sc.onMetaSync(s, { schemaVersion: 3 })).toBe(s);
  });

  it('onMetaSync with migrationPartial payload', () => {
    const s = sc.onMetaSync(sc.createInitial(), { schemaVersion: 2, migrationPartial: true });
    expect(sc.onMetaSync(s, { schemaVersion: 2, migrationPartial: true })).toBe(s);
  });

  it('onPublishOvercap', () => {
    const s = sc.onPublishOvercap(sc.createInitial());
    expect(sc.onPublishOvercap(s)).toBe(s);
  });

  it('onPublishSucceeded when already cleared', () => {
    const s = sc.createInitial();
    expect(sc.onPublishSucceeded(s)).toBe(s);
  });
});

describe('canDispatchComment / canBroadcastCursor — schemaIncompatible is the only gate', () => {
  it('both true on initial state', () => {
    const s = sc.createInitial();
    expect(sc.canDispatchComment(s)).toBe(true);
    expect(sc.canBroadcastCursor(s)).toBe(true);
  });

  it('both false once schemaIncompatible', () => {
    const s = sc.onMetaSync(sc.createInitial(), { schemaVersion: 999 });
    expect(sc.canDispatchComment(s)).toBe(false);
    expect(sc.canBroadcastCursor(s)).toBe(false);
  });

  it('publishOvercap does not block comment dispatch or cursor', () => {
    const s = sc.onPublishOvercap(sc.createInitial());
    expect(sc.canDispatchComment(s)).toBe(true);
    expect(sc.canBroadcastCursor(s)).toBe(true);
  });

  it('migrationPartial does not block comment dispatch or cursor', () => {
    const s = sc.onMetaSync(sc.createInitial(), { schemaVersion: 2, migrationPartial: true });
    expect(sc.canDispatchComment(s)).toBe(true);
    expect(sc.canBroadcastCursor(s)).toBe(true);
  });
});

describe('overcap diff pattern (caller-side toast trigger)', () => {
  // Pinned because the design lock keeps the toast push at the dispatch
  // site (NOT in a {state, effects} verb descriptor). If a future
  // refactor moves the verb to return a descriptor, this test fails
  // and the hook-side diff at the publish-effect call site must change
  // together.
  it('prev.publishOvercap=true && next.publishOvercap=false signals the resumed toast', () => {
    const prev = sc.onPublishOvercap(sc.createInitial());
    const next = sc.onPublishSucceeded(prev);
    expect(prev.publishOvercap).toBe(true);
    expect(next.publishOvercap).toBe(false);
  });

  it('prev.publishOvercap=false && next.publishOvercap=false does NOT signal a toast', () => {
    const prev = sc.createInitial();
    const next = sc.onPublishSucceeded(prev);
    expect(prev.publishOvercap).toBe(false);
    expect(next.publishOvercap).toBe(false);
  });
});
