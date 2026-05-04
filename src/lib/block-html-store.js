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

export function seedBlockArray(ydoc, yOrder, yStore, plainBlocks) {
  if (yOrder.length > 0 || yStore.size > 0) {
    throw new Error('seedBlockArray: yOrder and yStore must be empty before seeding');
  }
  ydoc.transact(() => {
    for (const b of plainBlocks) {
      const yMap = new Y.Map();
      const yText = new Y.Text();
      seedYTextFromHtml(yText, b.html || '');
      yMap.set('html', yText);
      yStore.set(b.id, yMap);
      yOrder.push([b.id]);
    }
  }, 'seed');
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
