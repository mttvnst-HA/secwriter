import { describe, it, expect } from 'vitest';
import * as tc from '../track-changes.js';

// Q35 (#47 sub-PR 1h) — track-changes.js retirement.
//
// Per-keystroke marking is now performed by PmEditableBlock's
// dispatchTransaction intercept (Q33). This reducer's only remaining
// responsibility is:
//   - the enabled flag (gates the PM marking pipeline + revision flags)
//   - the publishSeq counter that drives the publish effect inside
//     useCollabSession
//
// The snapshots Map and all snapshot-refresh verbs (acceptInline /
// rejectInline / applyResolveAtBlock / markBlockCreated) are gone.
// The wire payload (Q37) shrinks correspondingly to { enabled }.

describe('state shape (Q35 retirement)', () => {
  it('createInitial returns { enabled:false, publishSeq:0 } with NO snapshots field', () => {
    const s = tc.createInitial();
    expect(s.enabled).toBe(false);
    expect(s.publishSeq).toBe(0);
    expect('snapshots' in s).toBe(false);
  });

  it('enable returns { enabled:true, publishSeq:n+1 } with NO snapshots field', () => {
    const s0 = tc.createInitial();
    const s1 = tc.enable(s0);
    expect(s1.enabled).toBe(true);
    expect(s1.publishSeq).toBe(s0.publishSeq + 1);
    expect('snapshots' in s1).toBe(false);
  });

  it('disable returns { enabled:false, publishSeq:n+1 } with NO snapshots field', () => {
    const s0 = tc.enable(tc.createInitial());
    const s1 = tc.disable(s0);
    expect(s1.enabled).toBe(false);
    expect(s1.publishSeq).toBe(s0.publishSeq + 1);
    expect('snapshots' in s1).toBe(false);
  });

  it('enable ignores any extra args (blocks no longer needed)', () => {
    // Callers in App.jsx pass blocks today; the retired reducer accepts
    // and ignores them so call sites can be swept incrementally.
    const s = tc.enable(tc.createInitial(), [{ id: 'a', html: 'x' }]);
    expect(s.enabled).toBe(true);
    expect('snapshots' in s).toBe(false);
  });
});

describe('retired verbs are no longer exported', () => {
  it('acceptInline is gone', () => {
    expect(tc.acceptInline).toBeUndefined();
  });

  it('rejectInline is gone', () => {
    expect(tc.rejectInline).toBeUndefined();
  });

  it('applyResolveAtBlock is gone', () => {
    expect(tc.applyResolveAtBlock).toBeUndefined();
  });

  it('markBlockCreated is gone', () => {
    expect(tc.markBlockCreated).toBeUndefined();
  });

  it('markBlockDeleted is gone (was a no-op kept for symmetry; no need post-Q35)', () => {
    expect(tc.markBlockDeleted).toBeUndefined();
  });

  it('getSnapshot is gone', () => {
    expect(tc.getSnapshot).toBeUndefined();
  });
});

describe('acceptAll / rejectAll (snapshot-refresh removed)', () => {
  it('acceptAll bumps publishSeq when enabled and ignores any blocks arg', () => {
    const s0 = tc.enable(tc.createInitial());
    const s1 = tc.acceptAll(s0, [{ id: 'a', html: 'x' }]);
    expect(s1.enabled).toBe(true);
    expect(s1.publishSeq).toBe(s0.publishSeq + 1);
    expect('snapshots' in s1).toBe(false);
  });

  it('rejectAll bumps publishSeq when enabled and ignores any blocks arg', () => {
    const s0 = tc.enable(tc.createInitial());
    const s1 = tc.rejectAll(s0);
    expect(s1.enabled).toBe(true);
    expect(s1.publishSeq).toBe(s0.publishSeq + 1);
  });

  it('acceptAll is a no-op when disabled', () => {
    const s0 = tc.createInitial();
    const s1 = tc.acceptAll(s0);
    expect(s1).toBe(s0);
  });

  it('rejectAll is a no-op when disabled', () => {
    const s0 = tc.createInitial();
    const s1 = tc.rejectAll(s0);
    expect(s1).toBe(s0);
  });
});

describe('selectors', () => {
  it('isEnabled reflects state.enabled', () => {
    expect(tc.isEnabled(tc.createInitial())).toBe(false);
    expect(tc.isEnabled(tc.enable(tc.createInitial()))).toBe(true);
  });

  it('getPublishableState returns { enabled } only — NO snapshots key (Q37 wire shrink)', () => {
    const s = tc.enable(tc.createInitial());
    const pub = tc.getPublishableState(s);
    expect(pub).toEqual({ enabled: true });
    expect('snapshots' in pub).toBe(false);
  });

  it('getPublishableState returns { enabled:false } when disabled', () => {
    const s = tc.disable(tc.enable(tc.createInitial()));
    const pub = tc.getPublishableState(s);
    expect(pub).toEqual({ enabled: false });
    expect('snapshots' in pub).toBe(false);
  });

  it('revisionFlagForCreate returns "add" when enabled, undefined otherwise', () => {
    expect(tc.revisionFlagForCreate(tc.createInitial())).toBeUndefined();
    expect(tc.revisionFlagForCreate(tc.enable(tc.createInitial()))).toBe('add');
  });

  it('revisionFlagForDelete returns "del" when enabled and block is not a pending add', () => {
    const enabled = tc.enable(tc.createInitial());
    expect(tc.revisionFlagForDelete(enabled, { id: 'a', html: 'x' })).toBe('del');
  });

  it('revisionFlagForDelete returns null for a pending-add block (real delete)', () => {
    const enabled = tc.enable(tc.createInitial());
    expect(tc.revisionFlagForDelete(enabled, { id: 'a', revision: 'add' })).toBeNull();
  });

  it('revisionFlagForDelete returns null when disabled (real delete)', () => {
    expect(tc.revisionFlagForDelete(tc.createInitial(), { id: 'a' })).toBeNull();
  });
});

describe('applyRemote (Q37 backward-compat)', () => {
  it('replaces enabled flag from a remote payload', () => {
    const s0 = tc.createInitial();
    const s1 = tc.applyRemote(s0, { enabled: true });
    expect(tc.isEnabled(s1)).toBe(true);
  });

  it('IGNORES a legacy snapshots field in the payload (pre-1h wire compat)', () => {
    // readTc still emits { enabled, snapshots } from pre-1h rooms; applyRemote
    // must accept that shape without keeping the snapshots key on local state.
    const s0 = tc.createInitial();
    const s1 = tc.applyRemote(s0, { enabled: true, snapshots: { a: 'aa', b: 'bb' } });
    expect(tc.isEnabled(s1)).toBe(true);
    expect('snapshots' in s1).toBe(false);
  });

  it('does NOT bump publishSeq (would round-trip back to peers)', () => {
    const s0 = tc.createInitial();
    const s1 = tc.applyRemote(s0, { enabled: true });
    expect(s1.publishSeq).toBe(s0.publishSeq);
  });

  it('coerces missing fields safely', () => {
    const s = tc.applyRemote(tc.createInitial(), null);
    expect(tc.isEnabled(s)).toBe(false);
    expect('snapshots' in s).toBe(false);
  });

  it('coerces a payload with no enabled key to false', () => {
    const s = tc.applyRemote(tc.createInitial(), {});
    expect(tc.isEnabled(s)).toBe(false);
  });
});

describe('immutability', () => {
  it('enable returns a new state object', () => {
    const s0 = tc.createInitial();
    const s1 = tc.enable(s0);
    expect(s1).not.toBe(s0);
  });

  it('disable returns a new state object', () => {
    const s0 = tc.enable(tc.createInitial());
    const s1 = tc.disable(s0);
    expect(s1).not.toBe(s0);
  });

  it('acceptAll returns a new state object when enabled', () => {
    const s0 = tc.enable(tc.createInitial());
    const s1 = tc.acceptAll(s0);
    expect(s1).not.toBe(s0);
  });
});
