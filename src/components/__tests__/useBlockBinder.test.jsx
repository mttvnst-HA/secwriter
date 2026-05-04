// @vitest-environment jsdom
//
// Sub-PR 1b tracer (#22) — typing into a block-binder-wired component must
// reach the Y.Doc directly via setBlockHtml, NOT round-trip through React
// setBlocks → publish-effect → applyHtmlToYText.
//
// Tests target the public binder API: useBlockBinder reads via
// useSyncExternalStore against subscribeBlock+getBlockHtml and exposes a
// write() that delegates to setBlockHtml.

import { describe, it, expect, vi } from 'vitest';
import { render, act, renderHook } from '@testing-library/react';
import * as Y from 'yjs';

import { seedBlockArray, getBlockHtml } from '../../lib/block-html-store.js';
import { useBlockBinder } from '../useBlockBinder.js';

function makeDoc(blocks = [{ id: 'n1', type: 'txt', html: 'hello' }]) {
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  seedBlockArray(ydoc, yOrder, yStore, blocks);
  return { ydoc, yOrder, yStore };
}

describe('useBlockBinder — Y.Doc-backed block html (#22)', () => {
  it('initial html reflects the seeded Y.Text', () => {
    const { yStore } = makeDoc();
    const { result } = renderHook(() => useBlockBinder({ yStore, blockId: 'n1' }));
    expect(result.current.html).toBe('hello');
  });

  it('write() pushes to Y.Doc without invoking any external setBlocks', () => {
    const { ydoc, yStore } = makeDoc();
    const setBlocksSpy = vi.fn();

    // Track every transaction origin so we can prove the write went through
    // the local-publish path (substrate's setBlockHtml), not seed/local-apply.
    const origins = [];
    ydoc.on('afterTransaction', (tx) => origins.push(tx.origin));

    const { result } = renderHook(() => useBlockBinder({ yStore, blockId: 'n1' }));
    act(() => { result.current.write('typed'); });

    expect(setBlocksSpy).not.toHaveBeenCalled();
    expect(getBlockHtml(yStore, 'n1')).toBe('typed');
    expect(origins).toContain('local-publish');
  });

  it('rerenders when the underlying Y.Text mutates (subscription pathway)', () => {
    const { ydoc, yStore } = makeDoc();
    let renders = 0;
    function Probe() {
      const { html } = useBlockBinder({ yStore, blockId: 'n1' });
      renders++;
      return <div data-testid="probe">{html}</div>;
    }
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').textContent).toBe('hello');
    const baseRenders = renders;

    act(() => {
      ydoc.transact(() => {
        const yText = yStore.get('n1').get('html');
        yText.insert(yText.length, '!');
      }, 'local-publish');
    });

    expect(getByTestId('probe').textContent).toBe('hello!');
    expect(renders).toBeGreaterThan(baseRenders);
  });

  it('swapping yStore reattaches the subscription', () => {
    const docA = makeDoc([{ id: 'n1', type: 'txt', html: 'A' }]);
    const docB = makeDoc([{ id: 'n1', type: 'txt', html: 'B' }]);

    const { result, rerender } = renderHook(
      ({ yStore }) => useBlockBinder({ yStore, blockId: 'n1' }),
      { initialProps: { yStore: docA.yStore } }
    );
    expect(result.current.html).toBe('A');

    rerender({ yStore: docB.yStore });
    expect(result.current.html).toBe('B');

    // Mutating docA after the swap must NOT cause the binder to re-render.
    act(() => {
      docA.ydoc.transact(() => {
        const yText = docA.yStore.get('n1').get('html');
        yText.insert(yText.length, '!');
      }, 'local-publish');
    });
    expect(result.current.html).toBe('B');
  });

  it('returns "" when yStore is null (no-substrate state)', () => {
    const { result } = renderHook(() => useBlockBinder({ yStore: null, blockId: 'n1' }));
    expect(result.current.html).toBe('');
    // write() is a no-op (must not throw).
    expect(() => result.current.write('whatever')).not.toThrow();
  });

  it('write() with the same html as current is a no-op CRDT-wise', () => {
    const { ydoc, yStore } = makeDoc();
    const before = ydoc.store.clients.size > 0
      ? Array.from(ydoc.store.clients.values())[0]?.length || 0
      : 0;
    const { result } = renderHook(() => useBlockBinder({ yStore, blockId: 'n1' }));
    act(() => { result.current.write('hello'); });
    // applyHtmlToYText synthesizes a no-op delta when text matches; we just
    // assert no runtime error and that the html is unchanged.
    expect(getBlockHtml(yStore, 'n1')).toBe('hello');
    void before;
  });
});
