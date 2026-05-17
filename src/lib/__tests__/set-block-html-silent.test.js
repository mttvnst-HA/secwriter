// src/lib/__tests__/set-block-html-silent.test.js
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { seedBlockArray, setBlockHtml, setBlockHtmlSilent, getBlockHtml } from '../block-html-store.js';

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
});
