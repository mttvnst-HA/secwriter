// @vitest-environment jsdom
//
// Pins the block-action wiring that App used to bury inside `dispatchBlocks`:
// each action must dispatch the CORRECT verb with the CORRECT args, and must
// thread the CURRENT yStore + undo-framing (read from refs at call time, not
// render time) into dispatchBlocksVerb. This is the locality the old
// per-handler useCallbacks could not test — the pure verbs were always
// testable, but "does App wire the right yStore/framing?" was not.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import * as Blocks from '../../lib/blocks.js';
import { useBlockActions } from '../useBlockActions.js';

function makeDeps(overrides = {}) {
  return {
    blocksRef: { current: [{ id: 'a', type: 'txt', html: 'x' }] },
    setBlocks: vi.fn(),
    yStoreRef: { current: { FAKE_YSTORE: true } },
    framingRef: { current: { FAKE_FRAMING: true } },
    setFocusedBlockId: vi.fn(),
    focusBlock: vi.fn(),
    tcStateRef: { current: { enabled: false } },
    ...overrides,
  };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('useBlockActions', () => {
  it('exposes the full 22-action set with stable identity', () => {
    const { result, rerender } = renderHook(() => useBlockActions(makeDeps()));
    const keys = Object.keys(result.current).sort();
    expect(keys).toEqual([
      'acceptAllRevisions', 'acceptRevision', 'addReference', 'applyInlineFix',
      'changeOliLevel', 'complianceAcceptGroup', 'convertBlock', 'convertBlockType',
      'convertToTitle', 'deleteBlock', 'demote', 'insertAfter', 'mergeBlockData',
      'promote', 'rejectAllRevisions', 'rejectRevision', 'removeOrphaned',
      'reorderSection', 'searchReplace', 'updateHtml', 'updateHtmlPmSync',
      'updateRefScalar',
    ]);
    const first = result.current;
    rerender();
    expect(result.current).toBe(first); // memoized — stable across renders
  });

  it('threads the current yStore + framing and delegates to the right verb', () => {
    const spy = vi.spyOn(Blocks, 'dispatchBlocksVerb').mockReturnValue({ dispatched: true });
    const verbSpy = vi.spyOn(Blocks, 'reorderSectionVerb').mockReturnValue({ state: [], effects: null });
    const deps = makeDeps();
    const { result } = renderHook(() => useBlockActions(deps));

    result.current.reorderSection('a', 'b', 'after');

    expect(spy).toHaveBeenCalledTimes(1);
    const [passedDeps, compute] = spy.mock.calls[0];
    expect(passedDeps.yStore).toBe(deps.yStoreRef.current);
    expect(passedDeps.framing).toBe(deps.framingRef.current);
    expect(passedDeps.blocksRef).toBe(deps.blocksRef);
    expect(passedDeps.setBlocks).toBe(deps.setBlocks);
    // the compute closure delegates to the reorder verb with the right args
    compute(deps.blocksRef.current);
    expect(verbSpy).toHaveBeenCalledWith(deps.blocksRef.current, 'a', 'b', 'after');
  });

  it('reads yStoreRef + framingRef at call time, not render time', () => {
    const spy = vi.spyOn(Blocks, 'dispatchBlocksVerb').mockReturnValue({ dispatched: true });
    const deps = makeDeps();
    const { result } = renderHook(() => useBlockActions(deps));

    // simulate a mid-session room swap AFTER render committed
    deps.yStoreRef.current = { SWAPPED: true };
    deps.framingRef.current = { SWAPPED_FRAMING: true };
    result.current.updateHtml('a', '<p>hi</p>');

    expect(spy.mock.calls[0][0].yStore).toEqual({ SWAPPED: true });
    expect(spy.mock.calls[0][0].framing).toEqual({ SWAPPED_FRAMING: true });
  });

  it('merges the update trio: updateHtml uses the updateBlockHtml verb', () => {
    const verbSpy = vi.spyOn(Blocks, 'updateBlockHtml').mockReturnValue({ state: [], effects: null });
    vi.spyOn(Blocks, 'dispatchBlocksVerb').mockImplementation((_d, compute) => { compute([]); return { dispatched: true }; });
    const { result } = renderHook(() => useBlockActions(makeDeps()));

    result.current.updateHtml('a', '<p>hi</p>');
    expect(verbSpy).toHaveBeenCalledWith([], 'a', '<p>hi</p>');
  });

  it('bakes preFlush:all opts into acceptAllRevisions / rejectAllRevisions', () => {
    const spy = vi.spyOn(Blocks, 'dispatchBlocksVerb').mockReturnValue({ dispatched: true });
    const { result } = renderHook(() => useBlockActions(makeDeps()));

    result.current.acceptAllRevisions();
    expect(spy.mock.calls[0][2]).toEqual({ preFlush: 'all' });
    result.current.rejectAllRevisions();
    expect(spy.mock.calls[1][2]).toEqual({ preFlush: 'all' });
  });

  it('reads tcState from the ref for insertAfter / deleteBlock / convertBlockType', () => {
    const created = vi.spyOn(Blocks, 'createBlockAfter').mockReturnValue({ state: [], effects: null });
    const deleted = vi.spyOn(Blocks, 'deleteBlock').mockReturnValue({ state: [], effects: null });
    const converted = vi.spyOn(Blocks, 'convertBlockType').mockReturnValue({ state: [], effects: null });
    vi.spyOn(Blocks, 'dispatchBlocksVerb').mockImplementation((_d, compute) => { compute([]); return { dispatched: true }; });
    const deps = makeDeps({ tcStateRef: { current: { enabled: true } } });
    const { result } = renderHook(() => useBlockActions(deps));

    // insertAfter → Blocks.createBlockAfter(b, afterId, { newId, tcState }) — options object (arg index 2)
    result.current.insertAfter('a');
    const insertOpts = created.mock.calls[0][2];
    expect(insertOpts.tcState).toEqual({ enabled: true });
    expect(insertOpts.newId).toMatch(/^new-/);

    // deleteBlock → Blocks.deleteBlock(b, blockId, tcState) — tcState is the POSITIONAL 3rd arg (arg index 2)
    result.current.deleteBlock('a');
    expect(deleted.mock.calls[0][2]).toEqual({ enabled: true });

    // convertBlockType → Blocks.convertBlockType(b, blockId, newType, { tcState }) — options object (arg index 3)
    result.current.convertBlockType('a', 'note');
    const convertOpts = converted.mock.calls[0][3];
    expect(convertOpts.tcState).toEqual({ enabled: true });
  });
});
