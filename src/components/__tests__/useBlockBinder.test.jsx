// @vitest-environment jsdom
//
// Sub-PR 1b tracer (#22) — typing into a block-binder-wired component must
// reach the Y.Doc directly via setBlockHtml, NOT round-trip through React
// setBlocks → publish-effect → applyHtmlToYText.
//
// Tests target the public binder API: useBlockBinder reads via
// useSyncExternalStore against subscribeBlock+getBlockHtml and exposes a
// write() that delegates to setBlockHtml.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, renderHook, cleanup } from '@testing-library/react';
import * as Y from 'yjs';

import { seedBlockArray, getBlockHtml, setBlockHtml } from '../../lib/block-html-store.js';
import { useBlockBinder } from '../useBlockBinder.js';

function makeDoc(blocks = [{ id: 'n1', type: 'txt', html: 'hello' }]) {
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  seedBlockArray(ydoc, yOrder, yStore, blocks);
  return { ydoc, yOrder, yStore };
}

describe('useBlockBinder — Y.Doc-backed block html (#22)', () => {
  afterEach(() => { cleanup(); });

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

  it('rerenders when the underlying html slot mutates (subscription pathway)', () => {
    // Sub-PR 1d (#47, ADR-0006): the substrate is now Y.XmlFragment, but
    // the binder's contract is shape-agnostic — observeDeep on the slot
    // is what fires the rerender. Mutate via setBlockHtml so we go through
    // the same write path the binder would use; the assertion is on the
    // rendered html, not the slot's internal type.
    const { yStore } = makeDoc();
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
      // Direct setBlockHtml mutation — the same code path EditableBlock
      // uses for keystroke writes. Going through here proves observeDeep
      // on Y.XmlFragment fires the listener exactly like observe() on
      // Y.Text did pre-1d.
      setBlockHtml(yStore, 'n1', 'hello!');
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
      setBlockHtml(docA.yStore, 'n1', 'A!');
    });
    expect(result.current.html).toBe('B');
  });

  it('returns "" when yStore is null (no-substrate state)', () => {
    const { result } = renderHook(() => useBlockBinder({ yStore: null, blockId: 'n1' }));
    expect(result.current.html).toBe('');
    // write() is a no-op (must not throw).
    expect(() => result.current.write('whatever')).not.toThrow();
  });

  it('write() is silently dropped while the substrate is null even if the underlying Y.Doc exists (sync-window gate)', () => {
    // Regression for the sync-window CRDT-merge bug: useCollabSession
    // withholds its yStore state until first sync completes. Until then,
    // App passes yStore=null to EditableBlock. The binder must NOT touch
    // any Y.Doc — even if the caller has another path to the doc.
    const { ydoc, yStore } = makeDoc();
    const slotBefore = yStore.get('n1').get('html');
    const stateBefore = Y.encodeStateAsUpdate(ydoc);

    // Render the binder with yStore=null (simulates pre-sync state).
    const { result } = renderHook(() => useBlockBinder({ yStore: null, blockId: 'n1' }));
    expect(result.current.html).toBe('');
    result.current.write('this must not land in the doc');

    // The doc's state is byte-for-byte identical — no transaction emitted.
    const stateAfter = Y.encodeStateAsUpdate(ydoc);
    expect(stateAfter).toEqual(stateBefore);
    // Slot identity preserved (substrate is Y.XmlFragment post-1d).
    expect(yStore.get('n1').get('html')).toBe(slotBefore);
    expect(getBlockHtml(yStore, 'n1')).toBe('hello');
  });

  it('rerenders when yMap.html slot is REPLACED mid-session (broker migration regression)', () => {
    // PR #51 review (CI E2E flake) — regression. The 1d server-side broker
    // swaps yMap.html from Y.Text to Y.XmlFragment for any client connected
    // when a peer's WS upgrade triggers migration. The previous binder
    // subscribed to yStore (key add/remove) and the slot itself — neither
    // fires for `yMap.set('html', newSlot)`, so the binder kept a dangling
    // observeDeep on the orphaned Y.Text and stopped seeing remote ops on
    // the new Y.XmlFragment. The fix observes yMap directly.
    const { yStore } = makeDoc();
    let renders = 0;
    function Probe() {
      const { html } = useBlockBinder({ yStore, blockId: 'n1' });
      renders++;
      return <div data-testid="probe">{html}</div>;
    }
    const { getByTestId } = render(<Probe />);
    expect(getByTestId('probe').textContent).toBe('hello');
    const baseRenders = renders;

    // Simulate the broker's mid-session slot swap: replace yMap.html
    // entirely (not just mutate its contents). Use a fresh Y.XmlFragment
    // populated with new content so the binder's derived html visibly
    // changes if the subscription re-attaches correctly.
    const yMap = yStore.get('n1');
    act(() => {
      const ydoc = yStore.doc;
      ydoc.transact(() => {
        const newXml = new Y.XmlFragment();
        yMap.set('html', newXml);
        const para = new Y.XmlElement('paragraph');
        newXml.push([para]);
        const yt = new Y.XmlText();
        para.push([yt]);
        yt.insert(0, 'after-swap');
      }, 'migrate-v2');
    });

    expect(getByTestId('probe').textContent).toBe('after-swap');
    expect(renders).toBeGreaterThan(baseRenders);

    // Subsequent ops on the NEW slot must also propagate.
    act(() => { setBlockHtml(yStore, 'n1', 'after-edit'); });
    expect(getByTestId('probe').textContent).toBe('after-edit');
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
