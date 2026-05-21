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

const { serializeRoom, seedRoomFromBlocks, serializeLintSidecar } = require_('../room-serializer.cjs');

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

/**
 * Build a Y.Doc with one Y.XmlFragment-backed block (post-1d substrate).
 *
 * The fragment is constructed by hand against the y-prosemirror shape
 * (paragraph → Y.XmlText with mark attrs), mirroring what the broker
 * produces. This proves that yMapToBlock's Y.XmlFragment branch (Q24/B3)
 * handles the post-migration substrate without coercing to "[object Object]".
 */
async function buildV2Doc() {
  const Y = await import('yjs');
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');

  ydoc.transact(() => {
    // Block 1: title with bold + plain text via Y.XmlFragment.
    const b1 = new Y.Map();
    b1.set('id', 'b1');
    b1.set('type', 'title');
    b1.set('part', 1);
    b1.set('depth', 0);
    const xml1 = new Y.XmlFragment();
    const para1 = new Y.XmlElement('paragraph');
    const t1 = new Y.XmlText();
    t1.insert(0, 'GENERAL');
    para1.push([t1]);
    xml1.push([para1]);
    b1.set('html', xml1);
    yStore.set('b1', b1);

    // Block 2: txt with an inline mark-rid + plain text (the y-prosemirror
    // shape: marks live on Y.XmlText insert attrs as { kind, option }).
    const b2 = new Y.Map();
    b2.set('id', 'b2');
    b2.set('type', 'txt');
    b2.set('part', 1);
    b2.set('depth', 0);
    b2.set('section', 'b1');
    const xml2 = new Y.XmlFragment();
    const para2 = new Y.XmlElement('paragraph');
    const t2a = new Y.XmlText();
    t2a.insert(0, 'See ');
    para2.push([t2a]);
    const t2b = new Y.XmlText();
    t2b.insert(0, 'ASTM C33', { inlineMark: { kind: 'rid', option: null } });
    para2.push([t2b]);
    const t2c = new Y.XmlText();
    t2c.insert(0, ' for details.');
    para2.push([t2c]);
    xml2.push([para2]);
    b2.set('html', xml2);
    yStore.set('b2', b2);

    yOrder.push(['b1', 'b2']);
    ydoc.getMap('meta').set('sectionNumber', '01 00 00');
    ydoc.getMap('meta').set('sectionTitle', 'TEST SECTION');
    ydoc.getMap('meta').set('schemaVersion', 2);
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

  // #150 — yLint round-trips into lintJson on flush.
  it('includes yLint entries in lintJson', async () => {
    const Y = await import('yjs');
    const ydoc = await buildTestDoc();
    const yLint = ydoc.getMap('lint');
    const fpGood = '0000000000000000000000aa';
    const fpBad  = '0000000000000000000000bb';

    ydoc.transact(() => {
      yLint.set(fpGood, { kind: 'good' });
      yLint.set(fpBad, {
        kind: 'bad',
        g: [{ violation: { ruleId: 'GRAM-X' } }],
        n: [],
        c: [],
      });
    });

    const { lintJson } = await serializeRoom(ydoc);
    assert.equal(typeof lintJson, 'string', 'lintJson is a string when yLint is non-empty');
    const parsed = JSON.parse(lintJson);
    assert.equal(parsed.v, 1);
    assert.ok(parsed.good.includes(fpGood), 'good fingerprint is in payload');
    assert.ok(parsed.bad[fpBad], 'bad fingerprint is in payload');
    assert.equal(parsed.bad[fpBad].g[0].violation.ruleId, 'GRAM-X');
  });

  it('emits lintJson = null when yLint is empty (skips artifact write)', async () => {
    const ydoc = await buildTestDoc();
    const { lintJson } = await serializeRoom(ydoc);
    assert.equal(lintJson, null);
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

// Sub-PR 1d (#47, ADR-0006) — Q24/B3: yMapToBlock branches on
// Y.XmlFragment so post-migration .SEC flushes don't silently coerce
// String(yXmlFragment) into the export.
describe('serializeRoom — Y.XmlFragment substrate (1d)', () => {
  it('produces non-empty .SEC bytes for a Y.XmlFragment-backed doc', async () => {
    const ydoc = await buildV2Doc();
    const result = await serializeRoom(ydoc);
    assert.ok(result.secBytes instanceof Uint8Array);
    assert.ok(result.secBytes.length > 0);
  });

  it('SEC export contains block text drawn through pmFragmentToHtml', async () => {
    const ydoc = await buildV2Doc();
    const { secBytes } = await serializeRoom(ydoc);
    const secText = Buffer.from(secBytes).toString('latin1');
    assert.ok(secText.includes('GENERAL'), 'title text from Y.XmlFragment block 1');
    assert.ok(secText.includes('See '), 'plain prefix from Y.XmlFragment block 2');
    assert.ok(secText.includes('ASTM C33'), 'inline-mark text from Y.XmlFragment block 2');
    assert.ok(secText.includes(' for details.'), 'plain suffix from Y.XmlFragment block 2');
    // Crucial Q24/B3 negative assertion: the export does NOT contain the
    // coerced "[object Object]" or empty-string artifact of a missing branch.
    assert.ok(!secText.includes('[object Object]'),
      'yMapToBlock must not coerce Y.XmlFragment via String(); the html branch is missing.');
  });

  it('round-trips an inline mark span (mark-rid) through to .SEC bytes', async () => {
    const ydoc = await buildV2Doc();
    const { secBytes } = await serializeRoom(ydoc);
    const secText = Buffer.from(secBytes).toString('latin1');
    // SEC writer emits inline marks as the corresponding SGML tag (e.g. RID).
    // The exact SGML shape is owned by sec-serializer.js; here we just assert
    // the text content is recoverable from the Y.XmlFragment via the new
    // branch — proof that pmFragmentToHtml produced an html string the
    // serializer could parse.
    assert.ok(secText.includes('ASTM C33'));
  });

  it('handles a mixed-substrate doc (migrationPartial leftover)', async () => {
    // Half v1 (Y.Text) + half v2 (Y.XmlFragment). Both branches must fire
    // in the same flush.
    const Y = await import('yjs');
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    ydoc.transact(() => {
      // v2 block
      const b1 = new Y.Map();
      b1.set('id', 'b1');
      b1.set('type', 'title');
      b1.set('part', 1);
      b1.set('depth', 0);
      const xml = new Y.XmlFragment();
      const para = new Y.XmlElement('paragraph');
      const yt = new Y.XmlText();
      yt.insert(0, 'V2 TITLE');
      para.push([yt]);
      xml.push([para]);
      b1.set('html', xml);
      yStore.set('b1', b1);

      // v1 block
      const b2 = new Y.Map();
      b2.set('id', 'b2');
      b2.set('type', 'txt');
      b2.set('part', 1);
      b2.set('depth', 0);
      const yText = new Y.Text();
      yText.insert(0, 'v1 legacy paragraph');
      b2.set('html', yText);
      yStore.set('b2', b2);

      yOrder.push(['b1', 'b2']);
      ydoc.getMap('meta').set('migrationPartial', true);
    });

    const { secBytes } = await serializeRoom(ydoc);
    const secText = Buffer.from(secBytes).toString('latin1');
    assert.ok(secText.includes('V2 TITLE'), 'Y.XmlFragment branch fired');
    assert.ok(secText.includes('v1 legacy paragraph'), 'Y.Text branch fired');
    assert.ok(!secText.includes('[object Object]'));
  });
});

// PR #51 review (issue d) — regression. seedRoomFromBlocks (called from
// the HTTP /upload handler) was creating Y.Text html slots, which after
// migration leaves brand-new uploaded blocks stranded as v1 substrate
// inside an otherwise-v2 room. needsMigration short-circuits on the
// schemaVersion=2 sentinel so the broker never re-runs to convert them.
// Same bug class as fix #2 in commit 4fbc706 (blockToYMap in collab.js).
// PR #51 review (issue d) — regression. The seed path strands uploaded
// blocks as v1 (Y.Text) but MUST clear the migration sentinels so the
// broker re-runs on the next WS upgrade and promotes them to Y.XmlFragment.
// Without this, a room that previously stamped schemaVersion=2 keeps the
// sentinel after seed-wipe, needsMigration short-circuits, and the
// freshly-seeded Y.Text slots stay v1 forever in an otherwise-v2 room.
//
// (We tried seeding Y.XmlFragment directly via populateYXmlFragmentFromDelta
// — the hand-coded paragraph+YXmlText shape passed unit tests but produced
// a client-side "Invalid access" flood under CI's slower-runner timing,
// crashing the editor with `t.html.startsWith is not a function`. Y.Text +
// clear-sentinels is the simpler, broker-driven path and keeps E2E green.)
describe('seedRoomFromBlocks — broker re-run via cleared sentinels (1d, issue d)', () => {
  const Y = require_('yjs');

  it('clears yMeta.schemaVersion and yMeta.migrationPartial on seed', () => {
    const ydoc = new Y.Doc();
    ydoc.getArray('order');
    ydoc.getMap('store');
    const yMeta = ydoc.getMap('meta');
    // Pretend the broker had previously stamped this room as v2.
    yMeta.set('schemaVersion', 2);
    yMeta.set('migrationPartial', false);

    seedRoomFromBlocks(ydoc, [
      { id: 'b1', type: 'title', part: 1, depth: 0, html: 'GENERAL' },
      { id: 'b2', type: 'txt', part: 1, depth: 0, section: 'b1', html: 'Body.' },
    ]);

    assert.strictEqual(yMeta.get('schemaVersion'), undefined,
      'schemaVersion must be cleared so the broker re-evaluates the seeded doc');
    assert.strictEqual(yMeta.get('migrationPartial'), undefined,
      'migrationPartial must be cleared too');
  });

  it('seeds Y.Text slots that needsMigration() detects (so the broker promotes them)', () => {
    const { needsMigration } = require_('../migrate-pm-substrate.cjs');
    const ydoc = new Y.Doc();
    ydoc.getArray('order');
    ydoc.getMap('store');
    ydoc.getMap('meta').set('schemaVersion', 2);

    seedRoomFromBlocks(ydoc, [
      { id: 'b1', type: 'title', part: 1, depth: 0, html: 'SEEDED' },
    ]);

    // After seed, the doc looks like a v1 room with Y.Text slots and
    // no sentinel. The broker's needsMigration must return true so the
    // next WS upgrade promotes everything to Y.XmlFragment.
    const slot = ydoc.getMap('store').get('b1').get('html');
    assert.strictEqual(typeof slot.toDelta, 'function',
      'seed leaves slots as Y.Text (broker promotes to Y.XmlFragment on upgrade)');
    assert.strictEqual(needsMigration(ydoc), true);
  });

  it('seeded content survives the roundtrip through serializeRoom', async () => {
    const ydoc = new Y.Doc();
    ydoc.getArray('order');
    ydoc.getMap('store');
    ydoc.getMap('meta').set('sectionNumber', '01 00 00');
    ydoc.getMap('meta').set('sectionTitle', 'SEED TEST');

    seedRoomFromBlocks(ydoc, [
      { id: 'b1', type: 'title', part: 1, depth: 0, html: 'SEEDED TITLE' },
      { id: 'b2', type: 'txt', part: 1, depth: 0, section: 'b1', html: 'Seeded body text.' },
    ]);

    const { secBytes } = await serializeRoom(ydoc);
    const secText = Buffer.from(secBytes).toString('latin1');
    assert.ok(secText.includes('SEEDED TITLE'), 'title content survived');
    assert.ok(secText.includes('Seeded body text'), 'body content survived');
    assert.ok(!secText.includes('[object Object]'),
      'no coerced-object leakage');
  });
});

// Task 15 (#140) — serializeLintSidecar v2: yLintIgnored + yLintMutedNlp
describe('serializeLintSidecar — v2 ignored', () => {
  const Y = require_('yjs');

  it('emits v2 when yLintIgnored has entries', () => {
    const ydoc = new Y.Doc();
    const yLintIgnored = ydoc.getMap('lintIgnored');
    yLintIgnored.set('k1', { ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' });
    const yLintMutedNlp = ydoc.getMap('lintMutedNlp');
    const payload = serializeLintSidecar(ydoc.getMap('lint'), yLintIgnored, yLintMutedNlp, []);
    assert.equal(payload.v, 2);
    assert.equal(payload.ignoredFindings.length, 1);
  });

  it('emits v1 when yLintIgnored + yLintMutedNlp are empty', () => {
    const ydoc = new Y.Doc();
    const payload = serializeLintSidecar(
      ydoc.getMap('lint'),
      ydoc.getMap('lintIgnored'),
      ydoc.getMap('lintMutedNlp'),
      [],
    );
    assert.equal(payload.v, 1);
  });

  it('preserves tombstones in v2 output', () => {
    const ydoc = new Y.Doc();
    const yLintIgnored = ydoc.getMap('lintIgnored');
    yLintIgnored.set('k1', { ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a', tombstone: true });
    const payload = serializeLintSidecar(
      ydoc.getMap('lint'),
      yLintIgnored,
      ydoc.getMap('lintMutedNlp'),
      [],
    );
    assert.equal(payload.ignoredFindings[0].tombstone, true);
  });

  it('emits v2 when yLintMutedNlp has entries (ignoredFindings empty)', () => {
    const ydoc = new Y.Doc();
    const yLintMutedNlp = ydoc.getMap('lintMutedNlp');
    yLintMutedNlp.set('NLP-passive', { ts: 1234, authorId: 'u1' });
    const payload = serializeLintSidecar(
      ydoc.getMap('lint'),
      ydoc.getMap('lintIgnored'),
      yLintMutedNlp,
      [],
    );
    assert.equal(payload.v, 2);
    assert.equal(payload.ignoredFindings.length, 0);
    assert.equal(payload.mutedNlpRules.length, 1);
    assert.equal(payload.mutedNlpRules[0].ruleId, 'NLP-passive');
  });

  it('sorts ignoredFindings by ignoreKey and mutedNlpRules by ruleId', () => {
    const ydoc = new Y.Doc();
    const yLintIgnored = ydoc.getMap('lintIgnored');
    yLintIgnored.set('z-key', { ruleId: 'R1', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' });
    yLintIgnored.set('a-key', { ruleId: 'R2', blockHash: 'bh', match: 'm', ts: 2, authorId: 'b' });
    const payload = serializeLintSidecar(
      ydoc.getMap('lint'),
      yLintIgnored,
      ydoc.getMap('lintMutedNlp'),
      [],
    );
    assert.equal(payload.ignoredFindings[0].ignoreKey, 'a-key');
    assert.equal(payload.ignoredFindings[1].ignoreKey, 'z-key');
  });
});
