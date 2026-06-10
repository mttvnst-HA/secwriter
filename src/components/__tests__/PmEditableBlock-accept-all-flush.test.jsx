// @vitest-environment jsdom
//
// PmEditableBlock-accept-all-flush.test.jsx — PR #109 M4 regression pin.
//
// BUG: in-room (or out-of-room) with Track Changes enabled, type into a block
// then immediately click "Accept All" before the 400ms onUpdate debounce
// fires. The block's React-state html in App.blocksRef.current is still the
// PRE-typing html — the PM substrate has revisionAdd marks over the typed
// text, but App can't see them through blocks[]. So:
//   1. acceptAllRevisions(stalePrev) is a no-op for the typed block (no
//      <ins>/<del> tags to strip in the stale html).
//   2. setBlockHtml is not called (before.html === b.html for every block).
//   3. TC is disabled via setTcState.
//   4. ~400ms later the debounce flushes, serializing the PM doc (which
//      STILL has the revisionAdd marks) → '<p>… <ins class="mark-add">ZZTOP
//      </ins></p>' lands in React state.
// Result: a stale <ins> survives the "Accept All" with no UI to clear it
// since TC is off.
//
// ROOT CAUSE: handleAcceptAll reads blocksRef.current synchronously without
// first flushing every registered PM block's pending onUpdate debounce.
//
// FIX: call flushAllPendingUpdates() (block-registry.js) before reading
// blocksRef.current in handleAcceptAll AND handleRejectAll.
//
// This file pins:
//   - Test A (BUG SHAPE): without flush, an Accept-All-shaped simulation
//     reads stale html and leaves <ins> marks alive in the substrate. Pins
//     current pre-fix behavior so a future regression of removing the flush
//     would resurface and be caught.
//   - Test B (FIX): with flushAllPendingUpdates() called first, the simulated
//     Accept-All sees current html and successfully clears the marks from
//     both React state and the substrate.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

import { htmlToPmFragment, pmFragmentToHtml } from '../../lib/pmdoc-html.js';
import {
  getBlockView,
  flushAllPendingUpdates,
  __resetBlockRegistry,
} from '../../lib/block-registry.js';
import { setBlockHtml } from '../../lib/block-html-store.js';
import { acceptAllRevisions } from '../../lib/revisions.js';
import { serializeSEC } from '../../lib/sec-serializer.js';
import { generateExportHtml } from '../../lib/doc-export.js';
import * as linting from '../../lib/linting.js';
import PmEditableBlock from '../PmEditableBlock.jsx';

function setupYStore(blockId, html) {
  const ydoc = new Y.Doc();
  const yStore = ydoc.getMap('blocks');
  const yMap = new Y.Map();
  const yXml = new Y.XmlFragment();
  yMap.set('html', yXml);
  yStore.set(blockId, yMap);
  prosemirrorToYXmlFragment(htmlToPmFragment(html), yXml);
  return { ydoc, yStore };
}

async function renderBlock(container, { trackChanges, identity, yStore, html, onUpdate }) {
  const block = { id: 'b1', type: 'txt', html, isNew: false };
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <PmEditableBlock
        block={block}
        yStore={yStore}
        onUpdate={onUpdate}
        identity={identity}
        showTags={false}
        lintingState={linting.createInitial({ enabled: false })}
        lintingDispatch={vi.fn()}
        onEnterKey={vi.fn()}
        isFocused={false}
        onFocus={vi.fn()}
        oliLabel={null}
        onDelete={vi.fn()}
        onFocusPrev={vi.fn()}
        onFocusNext={vi.fn()}
        onConvertBlock={vi.fn()}
        onChangeOliLevel={vi.fn()}
        resolveHtml={(h) => h}
        tailorKey={null}
        trackChanges={trackChanges}
        onAcceptRevision={vi.fn()}
        onRejectRevision={vi.fn()}
        onRevisionAction={vi.fn()}
        commentsState={null}
        onCommentClick={vi.fn()}
        onInlineFix={vi.fn()}
        readOnly={false}
      />,
    );
  });
  return { root };
}

let container;
beforeEach(() => {
  __resetBlockRegistry();
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  container?.remove();
});

describe('PmEditableBlock — Accept All sub-debounce regression (#109 M4)', () => {
  it('A: WITHOUT flush, simulated Accept-All reads stale html and the typed <ins> survives in substrate', async () => {
    const initial = '<p>Hello world</p>';
    const { yStore } = setupYStore('b1', initial);
    let appBlocks = [{ id: 'b1', type: 'txt', html: initial }];
    const onUpdate = vi.fn((id, html) => {
      appBlocks = appBlocks.map((b) => (b.id === id ? { ...b, html } : b));
    });
    const { root } = await renderBlock(container, {
      trackChanges: true,
      identity: { id: 'alice', color: '#ff6b6b' },
      yStore,
      html: initial,
      onUpdate,
    });
    await new Promise((r) => setTimeout(r, 50));
    const view = getBlockView('b1');
    expect(view).toBeTruthy();

    // Type " ZZTOP" at end of paragraph. The TC rewriter wraps each
    // inserted character in revisionAdd.
    const insertPos = view.state.doc.content.size - 1;
    await act(async () => {
      view.dispatch(view.state.tr.insertText(' ZZTOP', insertPos));
    });

    // PM substrate immediately has revisionAdd marks; React state via the
    // debounced onUpdate is still pre-typing.
    expect(onUpdate).not.toHaveBeenCalled();
    expect(appBlocks[0].html).toBe(initial);

    // ─── Simulate handleAcceptAll WITHOUT the fix ────────────────────────
    // No flush. Read stale prev, run acceptAllRevisions, push changed html
    // via setBlockHtml. Because prev.html has no <ins>, the cleaned html
    // equals prev.html → no setBlockHtml call.
    const stalePrev = appBlocks;
    const next = acceptAllRevisions(stalePrev);
    for (const b of next) {
      const before = stalePrev.find((p) => p.id === b.id);
      if (before && before.html !== b.html) {
        setBlockHtml(yStore, b.id, b.html);
      }
    }
    expect(next[0].html).toBe(initial); // nothing was stripped — bug confirmed

    // Now flush the debounce to surface the surviving <ins> in React state.
    await new Promise((r) => setTimeout(r, 500));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(appBlocks[0].html).toMatch(/<ins[^>]*class="mark-add"/);
    // PM substrate still carries the revisionAdd mark.
    const finalHtml = pmFragmentToHtml(view.state.doc);
    expect(finalHtml).toMatch(/<ins/);

    root.unmount();
  });

  it('B: WITH flushAllPendingUpdates() before Accept-All, the marks are cleanly stripped from both React state and substrate', async () => {
    const initial = '<p>Hello world</p>';
    const { yStore } = setupYStore('b1', initial);
    let appBlocks = [{ id: 'b1', type: 'txt', html: initial }];
    const onUpdate = vi.fn((id, html) => {
      appBlocks = appBlocks.map((b) => (b.id === id ? { ...b, html } : b));
    });
    const { root } = await renderBlock(container, {
      trackChanges: true,
      identity: { id: 'alice', color: '#ff6b6b' },
      yStore,
      html: initial,
      onUpdate,
    });
    await new Promise((r) => setTimeout(r, 50));
    const view = getBlockView('b1');

    const insertPos = view.state.doc.content.size - 1;
    await act(async () => {
      view.dispatch(view.state.tr.insertText(' ZZTOP', insertPos));
    });
    expect(onUpdate).not.toHaveBeenCalled();

    // ─── Simulate handleAcceptAll WITH the fix ───────────────────────────
    flushAllPendingUpdates();
    // onUpdate fired synchronously; appBlocks now reflects the PM doc with
    // the revisionAdd marks serialized as <ins class="mark-add">.
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(appBlocks[0].html).toMatch(/<ins[^>]*class="mark-add"/);

    const fresh = appBlocks;
    const next = acceptAllRevisions(fresh);
    expect(next[0].html).not.toMatch(/<ins/); // cleaned in-memory
    for (const b of next) {
      const before = fresh.find((p) => p.id === b.id);
      if (before && before.html !== b.html) {
        setBlockHtml(yStore, b.id, b.html);
      }
    }

    // Wait for ySyncPlugin to apply the substrate write back into PM.
    await new Promise((r) => setTimeout(r, 50));

    // Substrate is now clean — no <ins> survives, but the text is intact.
    const finalHtml = pmFragmentToHtml(view.state.doc);
    expect(finalHtml).not.toMatch(/<ins/);
    expect(view.state.doc.textContent).toBe('Hello world ZZTOP');

    root.unmount();
  });

  it('C: flushAllPendingUpdates is a no-op when nothing is pending', () => {
    // Sanity: helper must be safe to call even when there are no handles or
    // no pending debounces. handleAcceptAll calls it unconditionally.
    expect(() => flushAllPendingUpdates()).not.toThrow();
  });
});

describe('PmEditableBlock — document-wide save reads pending keystrokes (#213)', () => {
  // handleSave/handleSaveAs/handleExport/auto-save (out-of-room) serialize the
  // block array. While a block is focused, the most recent keystrokes live in
  // the PM substrate but have NOT yet synced to React `blocks` (400ms onUpdate
  // debounce). The fix: flushAllPendingUpdates() before serializing, then read
  // blocksRef.current (the flush mutates it synchronously per ADR-0008).
  it('without flush, serializeSEC over stale blocks DROPS the last keystrokes; with flush they survive', async () => {
    const initial = '<p>Hello world</p>';
    const { yStore } = setupYStore('b1', initial);
    // TC off so typed text serializes as raw words, not <ins> marks.
    let appBlocks = [{ id: 'b1', type: 'txt', part: 1, depth: 0, html: initial }];
    const onUpdate = vi.fn((id, html) => {
      appBlocks = appBlocks.map((b) => (b.id === id ? { ...b, html } : b));
    });
    const { root } = await renderBlock(container, {
      trackChanges: false,
      identity: { id: 'alice', color: '#ff6b6b' },
      yStore,
      html: initial,
      onUpdate,
    });
    await new Promise((r) => setTimeout(r, 50));
    const view = getBlockView('b1');

    const insertPos = view.state.doc.content.size - 1;
    await act(async () => {
      view.dispatch(view.state.tr.insertText(' ZZTOP', insertPos));
    });
    // Debounce still pending — React blocks are pre-keystroke.
    expect(onUpdate).not.toHaveBeenCalled();

    // BUG SHAPE: serialize the stale array (what handleSave did before #213).
    const staleXml = serializeSEC(appBlocks, { sectionNumber: '00 00 00' });
    expect(staleXml).not.toMatch(/ZZTOP/);

    // FIX: flush first, then serialize the now-current array.
    flushAllPendingUpdates();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const freshXml = serializeSEC(appBlocks, { sectionNumber: '00 00 00' });
    expect(freshXml).toMatch(/ZZTOP/);

    root.unmount();
  });

  it('Word/Print export (generateExportHtml) likewise drops pending keystrokes without flush', async () => {
    // The Word/Print onClick handlers read the closed-over `blocks`; the JSX
    // closure holds the pre-keystroke render value even after the click-blur
    // flush mutates blocksRef.current. Same fix: flushAllPendingUpdates() then
    // read blocksRef.current.
    const initial = '<p>Hello world</p>';
    const { yStore } = setupYStore('b1', initial);
    let appBlocks = [{ id: 'b1', type: 'txt', part: 1, depth: 0, html: initial }];
    const onUpdate = vi.fn((id, html) => {
      appBlocks = appBlocks.map((b) => (b.id === id ? { ...b, html } : b));
    });
    const { root } = await renderBlock(container, {
      trackChanges: false,
      identity: { id: 'alice', color: '#ff6b6b' },
      yStore,
      html: initial,
      onUpdate,
    });
    await new Promise((r) => setTimeout(r, 50));
    const view = getBlockView('b1');

    const insertPos = view.state.doc.content.size - 1;
    await act(async () => {
      view.dispatch(view.state.tr.insertText(' WORDXP', insertPos));
    });
    expect(onUpdate).not.toHaveBeenCalled();

    const meta = { sectionNumber: '00 00 00', sectionTitle: 'T', date: '' };
    // BUG SHAPE: export the stale array.
    const staleHtml = generateExportHtml(appBlocks, meta, { showNotes: true, unitDisplay: 'both' });
    expect(staleHtml).not.toMatch(/WORDXP/);

    // FIX: flush first, then export the now-current array.
    flushAllPendingUpdates();
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const freshHtml = generateExportHtml(appBlocks, meta, { showNotes: true, unitDisplay: 'both' });
    expect(freshHtml).toMatch(/WORDXP/);

    root.unmount();
  });
});
