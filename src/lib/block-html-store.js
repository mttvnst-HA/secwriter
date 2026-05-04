/**
 * block-html-store — Y.Doc-as-source-of-truth substrate for per-block html.
 *
 * Sub-PR 1a (#22) introduced the adapter. Sub-PR 1b adds the subscription
 * surface (`subscribeBlock`) and the file-load reset helper (`resetBlockArray`)
 * that the binder hook + App-side wiring require. Nothing here depends on
 * `inRoom`; the same Y.Doc shape backs single-user and collab editing alike.
 *
 * Public API:
 *   seedBlockArray(ydoc, yOrder, yStore, plainBlocks)
 *     One-shot seed inside a 'seed' transaction. Throws if yOrder/yStore
 *     non-empty — fail loud rather than silently clobber existing state.
 *   resetBlockArray(ydoc, yOrder, yStore, plainBlocks)
 *     Clears yOrder + yStore and reseeds in a single 'reset' transaction.
 *     For file-load (no-room) — peers never see a half-cleared document.
 *   getBlockHtml(yStore, blockId) → string
 *     Derived via yTextToHtml. Returns '' for missing block or non-Y.Text
 *     html slot. Memoised per Y.Text via an observer-driven dirty bit so
 *     repeat reads with no intervening mutation skip the toDelta walk.
 *   setBlockHtml(yStore, blockId, html) → void
 *     Wraps applyHtmlToYText in a 'local-publish' transaction. Preserves
 *     Y.Text instance identity. No-op for unknown id, missing yText slot,
 *     detached yStore, or non-string html (coerced to '').
 *   subscribeBlock(yStore, blockId, listener) → unsubscribe
 *     Listener is `() => void` — callers re-read via getBlockHtml. Observes
 *     both the inner Y.Text (for text mutations) and the parent yStore key
 *     (for Y.Map identity changes — e.g. a remote-driven delete+re-add of
 *     the same block id). Designed against useSyncExternalStore.
 *
 * Block scalars (id, type, part, depth, section, level, revision) and
 * table/ref nested CRDTs are handled by collab.js's blockToYMap / yMapToBlock
 * for now. This module is intentionally narrow; it owns html only.
 */

import * as Y from 'yjs';
import { applyHtmlToYText, yTextToHtml, seedYTextFromHtml } from './ytext-html.js';

// Per-Y.Text memo. Each Y.Text gets a single observer that flips `dirty`
// when the text mutates; getBlockHtml only re-derives html when dirty.
// WeakMap so entries die with the Y.Text instance.
const cache = new WeakMap();

function getCached(yText) {
  let entry = cache.get(yText);
  if (!entry) {
    entry = { html: '', dirty: true };
    cache.set(yText, entry);
    yText.observe(() => {
      const e = cache.get(yText);
      if (e) e.dirty = true;
    });
  }
  if (entry.dirty) {
    entry.html = yTextToHtml(yText);
    entry.dirty = false;
  }
  return entry.html;
}

function seedInside(yOrder, yStore, plainBlocks) {
  for (const b of plainBlocks) {
    const yMap = new Y.Map();
    const yText = new Y.Text();
    seedYTextFromHtml(yText, b.html || '');
    yMap.set('html', yText);
    yStore.set(b.id, yMap);
    yOrder.push([b.id]);
  }
}

export function seedBlockArray(ydoc, yOrder, yStore, plainBlocks) {
  if (yOrder.length > 0 || yStore.size > 0) {
    throw new Error('seedBlockArray: yOrder and yStore must be empty before seeding');
  }
  ydoc.transact(() => {
    seedInside(yOrder, yStore, plainBlocks);
  }, 'seed');
}

export function resetBlockArray(ydoc, yOrder, yStore, plainBlocks) {
  ydoc.transact(() => {
    if (yOrder.length > 0) yOrder.delete(0, yOrder.length);
    for (const id of Array.from(yStore.keys())) yStore.delete(id);
    seedInside(yOrder, yStore, plainBlocks);
  }, 'reset');
}

export function getBlockHtml(yStore, blockId) {
  const yMap = yStore.get(blockId);
  if (!yMap) return '';
  const yText = yMap.get('html');
  if (!yText || typeof yText.toDelta !== 'function') return '';
  return getCached(yText);
}

export function setBlockHtml(yStore, blockId, html) {
  const yMap = yStore.get(blockId);
  if (!yMap) return;
  const yText = yMap.get('html');
  if (!yText || typeof yText.toDelta !== 'function') return;
  const ydoc = yStore.doc;
  if (!ydoc) return;
  const next = typeof html === 'string' ? html : '';
  ydoc.transact(() => {
    applyHtmlToYText(yText, next);
  }, 'local-publish');
}

export function subscribeBlock(yStore, blockId, listener) {
  let yText = null;
  const onText = () => listener();

  const attachText = () => {
    const yMap = yStore.get(blockId);
    const next = yMap && typeof yMap.get === 'function' ? yMap.get('html') : null;
    if (next === yText) return;
    if (yText && typeof yText.unobserve === 'function') yText.unobserve(onText);
    yText = next && typeof next.toDelta === 'function' ? next : null;
    if (yText) yText.observe(onText);
  };

  attachText();

  const onStore = (event) => {
    if (!event?.changes?.keys?.has?.(blockId)) return;
    attachText();
    listener();
  };
  yStore.observe(onStore);

  return () => {
    if (yText && typeof yText.unobserve === 'function') yText.unobserve(onText);
    yText = null;
    yStore.unobserve(onStore);
  };
}
