// @vitest-environment jsdom
//
// Unit tests for `dispatchToolbarVerb` in pm-toolbar.js. Covers the protocol
// shared by every FloatingToolbar PM verb (sub-PR 1f.9 consolidation,
// 2026-05-19): relpos restore -> compute -> forceFrame -> dispatch -> snapshot
// -> flush-or-cancel per settlement.
//
// Uses a fake EditorView object — the dispatcher never reaches into PM
// internals beyond `view.state` and `view.dispatch(tr)`, so a hand-rolled
// fake is sufficient and avoids spinning up a real ProseMirror in jsdom.
//
// The block-registry flush/cancel helpers are imported once and re-imported
// per test via the vi.mock infrastructure so we can spy on them.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock block-registry BEFORE importing pm-toolbar so the spied helpers
// replace the real ones throughout the module under test.
vi.mock('../block-registry.js', () => ({
  flushPendingUpdateById: vi.fn(),
  cancelPendingUpdateById: vi.fn(),
  // The dispatcher doesn't read these but other pm-toolbar imports might
  // pull them transitively — keep the surface complete.
  getBlockView: vi.fn(),
  getBlockHandle: vi.fn(),
}));

// Stub pm-relpos.restoreSelection — the dispatcher catches throws but we
// want to assert call shape.
vi.mock('../pm-relpos.js', () => ({
  saveSelection: vi.fn(),
  restoreSelection: vi.fn(),
}));

import { dispatchToolbarVerb } from '../pm-toolbar.js';
import {
  flushPendingUpdateById,
  cancelPendingUpdateById,
} from '../block-registry.js';
import { restoreSelection as restorePmRelpos } from '../pm-relpos.js';

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * Build a minimal fake EditorView. `state` is mutable — `dispatch(tr)`
 * advances it to `state.apply(tr)` so post-dispatch reads see the new
 * state. Real PM behavior; just plumbing without the DOM.
 */
function makeFakeView(initialState) {
  const fake = {
    state: initialState,
    dispatched: [],
    dispatch(tr) {
      this.dispatched.push(tr);
      // Real PM: applying a tr produces a new immutable state.
      this.state = this.state.apply(tr);
    },
  };
  return fake;
}

/**
 * Build a minimal fake EditorState. The dispatcher only needs `tr` (so
 * the compute callback can produce something) and an `apply(tr)` method.
 * For these tests `tr` is just a sentinel — the dispatcher passes it
 * verbatim to view.dispatch.
 */
function makeFakeState(label = 'initial') {
  return {
    label,
    tr: { kind: 'fake-tr', from: label },
    apply(tr) {
      // After dispatch: produce a "next" state so view.state advances.
      return { label: `${label} -> after ${tr.kind}`, apply: this.apply };
    },
  };
}

describe('dispatchToolbarVerb', () => {
  describe('bail paths (dispatched: false)', () => {
    it('bails when view is null', () => {
      const compute = vi.fn();
      const result = dispatchToolbarVerb({
        view: null,
        saved: { blockId: 'b1' },
        compute,
      });
      expect(result).toEqual({ dispatched: false });
      expect(compute).not.toHaveBeenCalled();
      expect(flushPendingUpdateById).not.toHaveBeenCalled();
      expect(cancelPendingUpdateById).not.toHaveBeenCalled();
    });

    it('bails when saved is null', () => {
      const view = makeFakeView(makeFakeState());
      const compute = vi.fn();
      const result = dispatchToolbarVerb({
        view,
        saved: null,
        compute,
      });
      expect(result).toEqual({ dispatched: false });
      expect(compute).not.toHaveBeenCalled();
    });

    it('bails when compute is not a function', () => {
      const view = makeFakeView(makeFakeState());
      const result = dispatchToolbarVerb({
        view,
        saved: { blockId: 'b1' },
        compute: null,
      });
      expect(result).toEqual({ dispatched: false });
      expect(view.dispatched).toHaveLength(0);
    });

    it('bails when compute returns null (verb declined)', () => {
      const view = makeFakeView(makeFakeState());
      const onForceFrame = vi.fn();
      const compute = vi.fn(() => null);
      const result = dispatchToolbarVerb({
        view,
        saved: { blockId: 'b1' },
        compute,
        onForceFrame,
      });
      expect(result).toEqual({ dispatched: false });
      expect(compute).toHaveBeenCalledTimes(1);
      // Crucially: forceFrame is NOT called when the verb declines — we
      // must not pollute the undo stack with empty frames.
      expect(onForceFrame).not.toHaveBeenCalled();
      expect(view.dispatched).toHaveLength(0);
      expect(flushPendingUpdateById).not.toHaveBeenCalled();
      expect(cancelPendingUpdateById).not.toHaveBeenCalled();
    });
  });

  describe('successful dispatch', () => {
    it('restores relpos BEFORE invoking compute (verbs see corrected selection)', () => {
      const initialState = makeFakeState('S0');
      const view = makeFakeView(initialState);
      let computeSawState = null;
      const compute = (state) => {
        computeSawState = state;
        return { tr: state.tr, settlement: 'self', range: { from: 1, to: 5 } };
      };
      // Order assertion: restorePmRelpos is invoked, then compute runs.
      // Easiest way to pin "before" is to set a flag inside the
      // restoreSelection mock and assert compute observed it.
      let restoreFired = false;
      restorePmRelpos.mockImplementation(() => { restoreFired = true; });
      const computeWithOrderAssert = (state) => {
        expect(restoreFired).toBe(true);  // restore happened first
        return compute(state);
      };

      dispatchToolbarVerb({
        view,
        saved: { blockId: 'b1', savedRelpos: { kind: 'relpos' } },
        compute: computeWithOrderAssert,
      });

      expect(restorePmRelpos).toHaveBeenCalledTimes(1);
      expect(restorePmRelpos).toHaveBeenCalledWith(view, { kind: 'relpos' });
      expect(computeSawState).toBe(initialState);
    });

    it('skips relpos restore when savedRelpos is missing (pre-1g.7 caller)', () => {
      const view = makeFakeView(makeFakeState());
      dispatchToolbarVerb({
        view,
        saved: { blockId: 'b1' /* no savedRelpos */ },
        compute: (state) => ({ tr: state.tr, settlement: 'self', range: { from: 0, to: 0 } }),
      });
      expect(restorePmRelpos).not.toHaveBeenCalled();
    });

    it('swallows relpos restore errors (defensive — cross-fragment / no binding)', () => {
      restorePmRelpos.mockImplementation(() => { throw new Error('boom'); });
      const view = makeFakeView(makeFakeState());
      let computeFired = false;
      const result = dispatchToolbarVerb({
        view,
        saved: { blockId: 'b1', savedRelpos: { kind: 'relpos' } },
        compute: (state) => {
          computeFired = true;
          return { tr: state.tr, settlement: 'self', range: { from: 0, to: 0 } };
        },
      });
      // Despite the throw, dispatch proceeded with the pre-restore selection.
      expect(computeFired).toBe(true);
      expect(result.dispatched).toBe(true);
    });

    it('calls onForceFrame BEFORE view.dispatch (closes the prior undo capture window)', () => {
      const view = makeFakeView(makeFakeState());
      const callOrder = [];
      const onForceFrame = vi.fn(() => callOrder.push('forceFrame'));
      const origDispatch = view.dispatch.bind(view);
      view.dispatch = (tr) => { callOrder.push('dispatch'); origDispatch(tr); };

      dispatchToolbarVerb({
        view,
        saved: { blockId: 'b1' },
        compute: (state) => ({ tr: state.tr, settlement: 'self', range: { from: 0, to: 0 } }),
        onForceFrame,
      });

      expect(callOrder).toEqual(['forceFrame', 'dispatch']);
    });

    it('omitting onForceFrame is safe (optional defensive callers)', () => {
      const view = makeFakeView(makeFakeState());
      const result = dispatchToolbarVerb({
        view,
        saved: { blockId: 'b1' },
        compute: (state) => ({ tr: state.tr, settlement: 'self', range: { from: 0, to: 0 } }),
      });
      expect(result.dispatched).toBe(true);
    });

    it('calls flushPendingUpdateById for settlement="self"', () => {
      const view = makeFakeView(makeFakeState());
      dispatchToolbarVerb({
        view,
        saved: { blockId: 'b1' },
        compute: (state) => ({ tr: state.tr, settlement: 'self', range: { from: 1, to: 5 } }),
      });
      expect(flushPendingUpdateById).toHaveBeenCalledTimes(1);
      expect(flushPendingUpdateById).toHaveBeenCalledWith('b1');
      expect(cancelPendingUpdateById).not.toHaveBeenCalled();
    });

    it('calls cancelPendingUpdateById for settlement="caller-owned"', () => {
      const view = makeFakeView(makeFakeState());
      dispatchToolbarVerb({
        view,
        saved: { blockId: 'b1' },
        compute: (state) => ({ tr: state.tr, settlement: 'caller-owned', range: { from: 1, to: 5 } }),
      });
      expect(cancelPendingUpdateById).toHaveBeenCalledTimes(1);
      expect(cancelPendingUpdateById).toHaveBeenCalledWith('b1');
      expect(flushPendingUpdateById).not.toHaveBeenCalled();
    });

    it('returns the POST-dispatch state snapshot (frozen against later peer ops)', () => {
      const initial = makeFakeState('S0');
      const view = makeFakeView(initial);
      const result = dispatchToolbarVerb({
        view,
        saved: { blockId: 'b1' },
        compute: (state) => ({ tr: state.tr, settlement: 'self', range: { from: 1, to: 5 } }),
      });
      // After dispatch, view.state has advanced. The snapshot returned by
      // the dispatcher MUST match view.state at the moment of dispatch
      // (i.e. the post-apply state), not the original `initial`.
      expect(result.state).not.toBe(initial);
      expect(result.state).toBe(view.state);

      // Pin the "frozen reference" property: a later mutation to view.state
      // does NOT affect what the dispatcher returned.
      const beforeMutation = result.state;
      view.state = makeFakeState('mutated-after-dispatch');
      expect(result.state).toBe(beforeMutation);
    });

    it('returns blockId + range from the verb descriptor verbatim', () => {
      const view = makeFakeView(makeFakeState());
      const result = dispatchToolbarVerb({
        view,
        saved: { blockId: 'b-xyz' },
        compute: (state) => ({ tr: state.tr, settlement: 'self', range: { from: 7, to: 12 } }),
      });
      expect(result.dispatched).toBe(true);
      expect(result.blockId).toBe('b-xyz');
      expect(result.range).toEqual({ from: 7, to: 12 });
    });
  });
});
