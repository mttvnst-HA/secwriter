/**
 * block-html-store — Y.Doc-as-source-of-truth substrate for per-block html.
 *
 * Sub-PR 1d (#47, [ADR-0006](../../docs/adr/0006-pm-substrate-migration.md))
 * swaps the per-block CRDT from Y.Text to Y.XmlFragment so the substrate
 * speaks ProseMirror natively. The public API is unchanged — the binder
 * (`useBlockBinder`) continues to call `getBlockHtml` / `setBlockHtml` /
 * `subscribeBlock`, and App-side direct-substrate writes (revisions,
 * compliance fixes, search/replace, comments-reconcile, etc.) keep flowing
 * through `setBlockHtml` so the `'local-publish'` UndoManager origin stays
 * intact.
 *
 * Read pathway:
 *   getBlockHtml derives via `pmFragmentToHtml(yXml)` (1c serializer; duck-
 *   types Y.XmlFragment → HTML byte-identical to `yTextToHtml`). A per-
 *   fragment WeakMap cache + observeDeep dirty-bit skips the walk on
 *   repeat reads with no intervening mutation.
 *
 *   For migrationPartial rooms (Q22/E6): blocks whose html slot is still
 *   Y.Text (per-block conversion failure during the broker run) fall
 *   through to the legacy yTextToHtml path. A v2 client can read either
 *   shape without throwing.
 *
 * Write pathway:
 *   setBlockHtml runs `htmlToPmFragment(html)` → `prosemirrorToYXmlFragment`
 *   inside a 'local-publish' transaction. y-prosemirror's
 *   `prosemirrorToYXmlFragment` does a diff-and-merge against the existing
 *   fragment (it composes `updateYFragment` from the sync plugin), so
 *   unchanged inline runs preserve their CRDT identity — concurrent peer
 *   edits to the same paragraph survive a same-debounce-window write the
 *   way they did under Y.Text.
 *
 *   Legacy fallback: if the slot is still Y.Text (migrationPartial
 *   leftover), the legacy `applyHtmlToYText` path is taken. v1 clients
 *   keep editing the same Y.Text against this v2 client's snapshot writes.
 *
 * Public API (unchanged from 1b):
 *   seedBlockArray(ydoc, yOrder, yStore, plainBlocks)
 *   resetBlockArray(ydoc, yOrder, yStore, plainBlocks)
 *   getBlockHtml(yStore, blockId) → string
 *   setBlockHtml(yStore, blockId, html) → void
 *   subscribeBlock(yStore, blockId, listener) → unsubscribe
 *
 * Block scalars (id, type, part, depth, section, level, revision) and
 * table/ref nested CRDTs continue to flow through collab.js's
 * blockToYMap / yMapToBlock; this module owns html only.
 */

import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

import { applyHtmlToYText, yTextToHtml, seedYTextFromHtml } from './ytext-html.js';
import { htmlToPmFragment, pmFragmentToHtml } from './pmdoc-html.js';

// Per-html-slot memo. Both Y.XmlFragment and (for migrationPartial fallback)
// Y.Text are accepted shapes — each gets a single observer that flips
// `dirty` when the underlying CRDT mutates. WeakMap so entries die with
// the shared-type instance.
const cache = new WeakMap();

function deriveHtml(yHtml) {
  if (typeof yHtml.toArray === 'function' && typeof yHtml.nodeName !== 'string') {
    // Y.XmlFragment — duck-type matches the pmdoc-html.js serializer's
    // expectations (toArray + no nodeName, since YXmlElement has both).
    return pmFragmentToHtml(yHtml);
  }
  if (typeof yHtml.toDelta === 'function') {
    // Y.Text fallback (migrationPartial blocks; pre-1d rooms during the
    // broker's pre-archive read window).
    return yTextToHtml(yHtml);
  }
  return '';
}

function getCached(yHtml) {
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

function seedHtmlSlot(yMap, html) {
  // 1d default: store html as a Y.XmlFragment seeded from the plain HTML
  // string via the 1c serializer. The fragment must be attached to the
  // doc-bearing yMap before prosemirrorToYXmlFragment is called so its
  // internal transact() rides the outer 'seed'/'reset' origin.
  const yXml = new Y.XmlFragment();
  yMap.set('html', yXml);
  const pmNode = htmlToPmFragment(typeof html === 'string' ? html : '');
  prosemirrorToYXmlFragment(pmNode, yXml);
}

function seedInside(yOrder, yStore, plainBlocks) {
  for (const b of plainBlocks) {
    const yMap = new Y.Map();
    yStore.set(b.id, yMap);
    yOrder.push([b.id]);
    seedHtmlSlot(yMap, b.html || '');
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
  const yHtml = yMap.get('html');
  if (!yHtml) return '';
  // Legacy bare-string slots (extreme corruption fallback). Still gracefully
  // expose the string so the binder render path doesn't blank out.
  if (typeof yHtml === 'string') return yHtml;
  if (typeof yHtml.toArray !== 'function' && typeof yHtml.toDelta !== 'function') {
    return '';
  }
  return getCached(yHtml);
}

export function setBlockHtml(yStore, blockId, html) {
  const yMap = yStore.get(blockId);
  if (!yMap) return;
  const yHtml = yMap.get('html');
  if (!yHtml) return;
  const ydoc = yStore.doc;
  if (!ydoc) return;
  const next = typeof html === 'string' ? html : '';

  // Y.XmlFragment (post-1d, post-broker-migrated) — write via PM serializer.
  if (typeof yHtml.toArray === 'function' && typeof yHtml.nodeName !== 'string') {
    ydoc.transact(() => {
      const pmNode = htmlToPmFragment(next);
      prosemirrorToYXmlFragment(pmNode, yHtml);
    }, 'local-publish');
    return;
  }

  // Y.Text legacy (migrationPartial leftover; pre-broker doc) — keep writing
  // via the snapshot-diff path so v1 peers still see character-shape ops.
  if (typeof yHtml.toDelta === 'function') {
    ydoc.transact(() => {
      applyHtmlToYText(yHtml, next);
    }, 'local-publish');
    return;
  }
  // Unknown shape — silently drop the write rather than corrupt the doc.
}

export function subscribeBlock(yStore, blockId, listener) {
  let yHtml = null;
  const onHtml = () => listener();

  const detach = () => {
    if (!yHtml) return;
    if (typeof yHtml.unobserveDeep === 'function') {
      yHtml.unobserveDeep(onHtml);
    } else if (typeof yHtml.unobserve === 'function') {
      yHtml.unobserve(onHtml);
    }
  };
  const attachInner = (next) => {
    if (typeof next?.observeDeep === 'function') {
      next.observeDeep(onHtml);
    } else if (typeof next?.observe === 'function') {
      next.observe(onHtml);
    }
  };

  const attachHtml = () => {
    const yMap = yStore.get(blockId);
    const next = yMap && typeof yMap.get === 'function' ? yMap.get('html') : null;
    if (next === yHtml) return;
    detach();
    if (next && (typeof next.toArray === 'function' || typeof next.toDelta === 'function')) {
      yHtml = next;
      attachInner(yHtml);
    } else {
      yHtml = null;
    }
  };

  attachHtml();

  const onStore = (event) => {
    if (!event?.changes?.keys?.has?.(blockId)) return;
    attachHtml();
    listener();
  };
  yStore.observe(onStore);

  return () => {
    detach();
    yHtml = null;
    yStore.unobserve(onStore);
  };
}

// Re-export for tests / migration tooling that need to construct a v1-shape
// slot directly (e.g. building a fresh Y.Doc with Y.Text html slots to feed
// into the broker).
export { seedYTextFromHtml };
