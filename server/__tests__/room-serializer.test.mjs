/**
 * Tests for server/room-serializer.cjs
 *
 * Uses Node's built-in test runner.
 * Run: node --test server/__tests__/room-serializer.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// DOMParser polyfill MUST load before any ESM that uses it
const require_ = createRequire(import.meta.url);
require_('../dom-polyfill.cjs');

const { serializeRoom } = require_('../room-serializer.cjs');

/** Build a minimal Y.Doc with a title + txt block and optional metadata. */
async function buildTestDoc() {
  const Y = await import('yjs');
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  const yMeta = ydoc.getMap('meta');

  ydoc.transact(() => {
    const b1 = new Y.Map();
    b1.set('id', 'b1');
    b1.set('type', 'title');
    b1.set('part', 1);
    b1.set('depth', 0);
    const html1 = new Y.Text();
    html1.insert(0, 'GENERAL');
    b1.set('html', html1);
    yStore.set('b1', b1);

    const b2 = new Y.Map();
    b2.set('id', 'b2');
    b2.set('type', 'txt');
    b2.set('part', 1);
    b2.set('depth', 0);
    b2.set('section', 'b1');
    const html2 = new Y.Text();
    html2.insert(0, 'Test paragraph content.');
    b2.set('html', html2);
    yStore.set('b2', b2);

    yOrder.push(['b1', 'b2']);
    yMeta.set('sectionNumber', '01 00 00');
    yMeta.set('sectionTitle', 'TEST SECTION');
  });

  return ydoc;
}

describe('serializeRoom', () => {
  it('produces ydocBytes, secBytes, and commentsJson', async () => {
    const ydoc = await buildTestDoc();
    const result = await serializeRoom(ydoc);

    assert.ok(result.ydocBytes instanceof Uint8Array, 'ydocBytes is Uint8Array');
    assert.ok(result.ydocBytes.length > 0, 'ydocBytes is non-empty');

    assert.ok(result.secBytes instanceof Uint8Array, 'secBytes is Uint8Array');
    assert.ok(result.secBytes.length > 0, 'secBytes is non-empty');

    assert.equal(typeof result.commentsJson, 'string', 'commentsJson is string');
    const parsed = JSON.parse(result.commentsJson);
    assert.equal(parsed.version, 1);
    assert.ok(Array.isArray(parsed.comments));
  });

  it('SEC output contains block text', async () => {
    const ydoc = await buildTestDoc();
    const { secBytes } = await serializeRoom(ydoc);

    // Decode as latin1 (windows-1252 superset) to check text content
    const secText = Buffer.from(secBytes).toString('latin1');
    assert.ok(secText.includes('GENERAL'), 'SEC contains title text');
    assert.ok(secText.includes('Test paragraph content.'), 'SEC contains paragraph text');
    assert.ok(secText.includes('01 00 00'), 'SEC contains section number');
  });

  it('includes comments in commentsJson', async () => {
    const Y = await import('yjs');
    const ydoc = await buildTestDoc();
    const yComments = ydoc.getMap('comments');

    ydoc.transact(() => {
      const c1 = new Y.Map();
      c1.set('blockId', 'b2');
      c1.set('status', 'open');
      c1.set('highlightText', 'Test paragraph');
      c1.set('createdAt', 1700000000000);
      c1.set('authorId', 'user-1');
      c1.set('authorName', 'Alice');
      c1.set('authorColor', '#ff0000');

      const entries = new Y.Array();
      const e1 = new Y.Map();
      e1.set('id', 'entry-1');
      e1.set('type', 'reply');
      e1.set('authorId', 'user-1');
      e1.set('authorName', 'Alice');
      e1.set('authorColor', '#ff0000');
      e1.set('text', 'Needs revision');
      e1.set('ts', 1700000001000);
      entries.push([e1]);
      c1.set('entries', entries);

      yComments.set('comment-1', c1);
    });

    const { commentsJson } = await serializeRoom(ydoc);
    const parsed = JSON.parse(commentsJson);

    assert.equal(parsed.comments.length, 1, 'one comment');
    assert.equal(parsed.comments[0].blockId, 'b2');
    assert.equal(parsed.comments[0].status, 'open');
    assert.equal(parsed.comments[0].highlightText, 'Test paragraph');
    assert.equal(parsed.comments[0].entries.length, 1);
    assert.equal(parsed.comments[0].entries[0].text, 'Needs revision');
  });
});
