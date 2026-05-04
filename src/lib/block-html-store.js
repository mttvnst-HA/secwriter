import * as Y from 'yjs';
import { yTextToHtml, seedYTextFromHtml } from './ytext-html.js';

export function seedBlockArray(ydoc, yOrder, yStore, plainBlocks) {
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
  return yTextToHtml(yText);
}

export function setBlockHtml(_yStore, _blockId, _html) {
  // stub
}
