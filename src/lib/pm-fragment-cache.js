/**
 * pm-fragment-cache — shared per-html-slot derivation cache.
 *
 * The per-block html slot (Y.XmlFragment post-1d, or Y.Text for
 * migrationPartial leftovers) is expensive to serialize: `pmFragmentToHtml`
 * walks the whole fragment. Two read paths derive html from the SAME slot:
 *
 *   1. `block-html-store.getBlockHtml` — single-block reads (React render,
 *      PmEditableBlock subscription).
 *   2. `collab.yMapToBlock` — whole-document snapshots (`yBlocksToArray`),
 *      fired per keystroke by `handleAfterTx` for `ySyncPluginKey`-origin
 *      transactions.
 *
 * Before #222 only path 1 was cached, so every in-room keystroke re-derived
 * ALL N blocks through path 2 (O(N) `pmFragmentToHtml` calls — measured
 * 18.8 ms at 1200 blocks). Sharing one WeakMap keyed on the slot makes path 2
 * a cache hit for every UNCHANGED block: a single keystroke re-derives only
 * the one mutated slot. The cache is invalidated by an `observeDeep`/`observe`
 * dirty bit that the slot's own mutations flip.
 *
 * WeakMap so entries die with the shared-type instance — a removed block's
 * orphaned slot is GC'd along with its cache entry and observer closure.
 */

import { pmFragmentToHtml } from './pmdoc-html.js';
import { yTextToHtml } from './ytext-html.js';

const cache = new WeakMap();

function deriveHtml(yHtml) {
  if (typeof yHtml.toArray === 'function' && typeof yHtml.nodeName !== 'string') {
    // Y.XmlFragment — duck-type matches pmdoc-html.js's serializer
    // (toArray + no nodeName, since YXmlElement has both).
    return pmFragmentToHtml(yHtml);
  }
  if (typeof yHtml.toDelta === 'function') {
    // Y.Text fallback (migrationPartial blocks; pre-1d rooms during the
    // broker's pre-archive read window).
    return yTextToHtml(yHtml);
  }
  return '';
}

/**
 * Cached html derivation for a Y.XmlFragment / Y.Text html slot. Registers a
 * dirty-bit observer on first read; subsequent reads with no intervening
 * mutation return the memoized string without re-walking the fragment.
 */
export function getCachedHtml(yHtml) {
  let entry = cache.get(yHtml);
  if (!entry) {
    entry = { html: '', dirty: true };
    cache.set(yHtml, entry);
    if (typeof yHtml.observeDeep === 'function') {
      yHtml.observeDeep(() => {
        const e = cache.get(yHtml);
        if (e) e.dirty = true;
      });
    } else if (typeof yHtml.observe === 'function') {
      yHtml.observe(() => {
        const e = cache.get(yHtml);
        if (e) e.dirty = true;
      });
    }
  }
  if (entry.dirty) {
    entry.html = deriveHtml(yHtml);
    entry.dirty = false;
  }
  return entry.html;
}

/**
 * Force the next `getCachedHtml(yHtml)` to re-derive. Yjs fires observeDeep
 * callbacks in registration order, so a subscriber that must read fresh html
 * BEFORE the lazily-registered dirty observer runs (block-html-store's
 * subscribeBlock) invalidates manually.
 */
export function invalidateHtmlCache(yHtml) {
  const e = cache.get(yHtml);
  if (e) e.dirty = true;
}
