// src/lib/__tests__/set-block-html-silent.test.js
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { seedBlockArray, setBlockHtml, setBlockHtmlSilent, getBlockHtml, seedYTextFromHtml } from '../block-html-store.js';

/** Build a yMap with a legacy Y.Text html slot (migrationPartial fallback fixture). */
function seedLegacyYTextBlock(ydoc, yOrder, yStore, blockId, html) {
  ydoc.transact(() => {
    const yMap = new Y.Map();
    const yText = new Y.Text();
    seedYTextFromHtml(yText, html);
    yMap.set('html', yText);
    yStore.set(blockId, yMap);
    yOrder.push([blockId]);
  }, 'seed');
}

describe('setBlockHtmlSilent', () => {
  it('writes the same content as setBlockHtml', () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'old' }]);
    setBlockHtmlSilent(yStore, 'n1', '<p>new</p>');
    expect(getBlockHtml(yStore, 'n1')).toContain('new');
  });

  it('does NOT enter the local UndoManager (origin is non-tracked)', () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'old' }]);
    const um = new Y.UndoManager([yOrder, yStore], {
      trackedOrigins: new Set(['local-publish', ySyncPluginKey]),
    });
    const before = um.undoStack.length;
    setBlockHtmlSilent(yStore, 'n1', '<p>new</p>');
    expect(um.undoStack.length).toBe(before);
  });

  it('setBlockHtml (the tracked variant) STILL enters the UndoManager', () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    seedBlockArray(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'old' }]);
    const um = new Y.UndoManager([yOrder, yStore], {
      trackedOrigins: new Set(['local-publish', ySyncPluginKey]),
    });
    setBlockHtml(yStore, 'n1', '<p>new</p>');
    expect(um.undoStack.length).toBe(1);
  });

  it('the silent write IS replicated to peers (broadcast-not-skipped)', () => {
    // S2 from the critique — verify the 'local-reconcile' origin doesn't
    // accidentally trip a "skip broadcast" filter somewhere. Yjs has no
    // such filter (origin is metadata for observers, not a transport
    // gate), but pin the invariant so a future tweak to handleAfterTx
    // can't silently break peer-visible reconciles.
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const orderA = docA.getArray('order'); const storeA = docA.getMap('store');
    const orderB = docB.getArray('order'); const storeB = docB.getMap('store');
    seedBlockArray(docA, orderA, storeA, [{ id: 'n1', type: 'txt', html: 'old' }]);
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    setBlockHtmlSilent(storeA, 'n1', '<p>silent</p>');
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    expect(getBlockHtml(storeB, 'n1')).toContain('silent');
  });

  it('routes through applyHtmlToYText on a legacy Y.Text slot, off the UndoManager', () => {
    // Closes the silent + Y.Text origin-pairing gap: setBlockHtml's legacy
    // tests pin Y.Text + local-publish; this pins Y.Text + local-reconcile.
    // Together they prove the shared applyHtmlToSlot helper's Y.Text branch
    // (the migrationPartial deletion target) under BOTH origins.
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    seedLegacyYTextBlock(ydoc, yOrder, yStore, 'legacy', 'a');
    const um = new Y.UndoManager([yOrder, yStore], {
      trackedOrigins: new Set(['local-publish', ySyncPluginKey]),
    });
    const before = um.undoStack.length;
    setBlockHtmlSilent(yStore, 'legacy', 'b');
    // Content roundtrips, slot stays Y.Text (no auto-upgrade), origin non-tracked.
    expect(getBlockHtml(yStore, 'legacy')).toBe('b');
    const slot = yStore.get('legacy').get('html');
    expect(typeof slot.toDelta).toBe('function');
    expect(typeof slot.toArray).toBe('undefined');
    expect(um.undoStack.length).toBe(before);
  });
});
