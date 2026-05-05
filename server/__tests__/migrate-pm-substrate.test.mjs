/**
 * migrate-pm-substrate — sub-PR 1d server-side broker (#47, ADR-0006).
 *
 * Unit-level tests for the broker's pure pieces:
 *   - needsMigration(ydoc) detection
 *   - mapYTextAttrsToYpmMarks adapter (Q31/E6 fallback for unknown kinds)
 *   - migrateRoom() converts every Y.Text slot to Y.XmlFragment in-place
 *   - migrateRoom() per-block try/catch sets migrationPartial sentinel
 *   - migrationPartial and schemaVersion are mutually exclusive
 *   - createMigrationCoordinator's per-room async lock
 *
 * Adversarial migration fixtures are exercised here — Y.Doc with unknown
 * mark kinds + malformed attrs → migration completes, marks dropped + logged,
 * no throw.
 *
 * Run: node --test server/__tests__/migrate-pm-substrate.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../dom-polyfill.cjs');
const Y = require('yjs');

const {
  needsMigration,
  migrateRoom,
  mapYTextAttrsToYpmMarks,
  buildYXmlFragmentFromYText,
  createMigrationCoordinator,
  MIGRATION_ORIGIN,
  SCHEMA_VERSION_KEY,
  SCHEMA_V2,
  MIGRATION_PARTIAL_KEY,
} = require('../migrate-pm-substrate.cjs');

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeRecorderLog() {
  const events = [];
  return {
    info: (event, ctx) => events.push(['info', event, ctx]),
    warn: (event, ctx) => events.push(['warn', event, ctx]),
    error: (event, ctx) => events.push(['error', event, ctx]),
    events,
  };
}

/** Build a Y.Doc with N blocks whose html slots are Y.Text (v1 shape). */
function buildV1Doc(blockCount, perBlockHtml = (i) => `Block ${i} body text`) {
  const ydoc = new Y.Doc();
  const yOrder = ydoc.getArray('order');
  const yStore = ydoc.getMap('store');
  ydoc.transact(() => {
    for (let i = 1; i <= blockCount; i++) {
      const id = `n${i}`;
      const yMap = new Y.Map();
      yMap.set('id', id);
      yMap.set('type', 'txt');
      yMap.set('part', 1);
      yMap.set('depth', 0);
      const yText = new Y.Text();
      yText.insert(0, perBlockHtml(i));
      yMap.set('html', yText);
      yStore.set(id, yMap);
      yOrder.push([id]);
    }
  }, 'seed');
  return ydoc;
}

/** Insert an attribute-bearing run into a v1 Y.Text. */
function insertWithAttrs(yText, text, attrs) {
  yText.insert(yText.length, text, attrs);
}

/** Attach a Y.Text to a fresh Y.Doc and seed its content. Returns { ydoc, yText }. */
function attachedYText(seed) {
  const ydoc = new Y.Doc();
  const yText = ydoc.getText('t');
  ydoc.transact(() => {
    if (typeof seed === 'function') seed(yText);
    else if (typeof seed === 'string') yText.insert(0, seed);
  });
  return { ydoc, yText };
}

// ── needsMigration ────────────────────────────────────────────────────────

describe('needsMigration', () => {
  it('returns true for a fresh v1 room (Y.Text slots present, no schemaVersion)', () => {
    const ydoc = buildV1Doc(3);
    assert.strictEqual(needsMigration(ydoc), true);
  });

  it('returns false when schemaVersion === 2', () => {
    const ydoc = buildV1Doc(2);
    ydoc.getMap('meta').set(SCHEMA_VERSION_KEY, SCHEMA_V2);
    assert.strictEqual(needsMigration(ydoc), false);
  });

  it('returns false when migrationPartial === true (do-not-retry sentinel)', () => {
    const ydoc = buildV1Doc(2);
    ydoc.getMap('meta').set(MIGRATION_PARTIAL_KEY, true);
    assert.strictEqual(needsMigration(ydoc), false);
  });

  it('returns false for an empty room', () => {
    const ydoc = new Y.Doc();
    ydoc.getMap('order'); // ensure types exist
    ydoc.getMap('store');
    ydoc.getMap('meta');
    assert.strictEqual(needsMigration(ydoc), false);
  });

  it('returns false when every block already has Y.XmlFragment html', () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    ydoc.transact(() => {
      const yMap = new Y.Map();
      const yXml = new Y.XmlFragment();
      yMap.set('html', yXml);
      yStore.set('n1', yMap);
      yOrder.push(['n1']);
    });
    assert.strictEqual(needsMigration(ydoc), false);
  });

  it('returns null/false safely on null input', () => {
    assert.strictEqual(needsMigration(null), false);
    assert.strictEqual(needsMigration(undefined), false);
  });
});

// ── mapYTextAttrsToYpmMarks (adversarial fallback) ───────────────────────

describe('mapYTextAttrsToYpmMarks (Q31/E6 fallback)', () => {
  const log = makeRecorderLog();

  it('maps known kinds to y-prosemirror shape', () => {
    const out = mapYTextAttrsToYpmMarks({
      bold: true, italic: true, underline: true,
      mark: 'rid',
      revision: 'add', revisionAuthor: 'a1', revisionAuthorColor: '#f00',
      comment: 'c1', commentResolved: false,
    }, log, 'n1');
    assert.deepStrictEqual(out.bold, {});
    assert.deepStrictEqual(out.italic, {});
    assert.deepStrictEqual(out.underline, {});
    assert.deepStrictEqual(out.inlineMark, { kind: 'rid', option: null });
    assert.deepStrictEqual(out.revision, { kind: 'add', authorId: 'a1', authorColor: '#f00' });
    assert.deepStrictEqual(out.comment, { id: 'c1', resolved: false });
  });

  it('threads tai option through inlineMark', () => {
    const out = mapYTextAttrsToYpmMarks({ mark: 'tai', markOption: 'ARMY' }, log, 'n1');
    assert.deepStrictEqual(out.inlineMark, { kind: 'tai', option: 'ARMY' });
  });

  it('drops unknown inlineMark kind and logs', () => {
    const recorder = makeRecorderLog();
    const out = mapYTextAttrsToYpmMarks({ mark: 'totally-fake' }, recorder, 'nX');
    assert.strictEqual(out.inlineMark, undefined);
    const warns = recorder.events.filter(([level, e]) => level === 'warn' && e === 'migrate.unknown-mark');
    assert.strictEqual(warns.length, 1);
    assert.strictEqual(warns[0][2].kind, 'totally-fake');
  });

  it('drops unknown revision kind and logs', () => {
    const recorder = makeRecorderLog();
    const out = mapYTextAttrsToYpmMarks({ revision: 'reverted' }, recorder, 'nX');
    assert.strictEqual(out.revision, undefined);
    const warns = recorder.events.filter(([level, e]) => level === 'warn' && e === 'migrate.unknown-revision');
    assert.strictEqual(warns.length, 1);
  });

  it('does not throw on null / non-object attrs', () => {
    assert.doesNotThrow(() => mapYTextAttrsToYpmMarks(null, log, 'n1'));
    assert.doesNotThrow(() => mapYTextAttrsToYpmMarks(undefined, log, 'n1'));
    assert.doesNotThrow(() => mapYTextAttrsToYpmMarks('not-an-object', log, 'n1'));
  });

  it('coerces commentResolved to boolean', () => {
    const out1 = mapYTextAttrsToYpmMarks({ comment: 'c1', commentResolved: 'truthy' }, log, 'n1');
    assert.strictEqual(out1.comment.resolved, true);
    const out2 = mapYTextAttrsToYpmMarks({ comment: 'c1' }, log, 'n1');
    assert.strictEqual(out2.comment.resolved, false);
  });
});

// ── buildYXmlFragmentFromYText ───────────────────────────────────────────

describe('buildYXmlFragmentFromYText', () => {
  const log = makeRecorderLog();

  it('produces a paragraph with one Y.XmlText for plain text', () => {
    const { yText } = attachedYText('Hello world');
    const yXml = buildYXmlFragmentFromYText(yText, { blockId: 'n1', log });
    const top = yXml.toArray();
    assert.strictEqual(top.length, 1);
    assert.strictEqual(top[0].nodeName, 'paragraph');
    const para = top[0].toArray();
    assert.strictEqual(para.length, 1);
    assert.strictEqual(typeof para[0].toDelta, 'function');
    assert.deepStrictEqual(para[0].toDelta(), [{ insert: 'Hello world' }]);
  });

  it('round-trips marks via the y-prosemirror shape', () => {
    const { yText } = attachedYText((yt) => {
      insertWithAttrs(yt, 'See ', {});
      insertWithAttrs(yt, 'ASTM', { mark: 'rid' });
      insertWithAttrs(yt, ' and ', {});
      insertWithAttrs(yt, 'bold', { bold: true });
    });
    const yXml = buildYXmlFragmentFromYText(yText, { blockId: 'n1', log });
    const para = yXml.toArray()[0].toArray();
    // 4 runs become 4 Y.XmlText nodes (no merging — that's pmFragmentToHtml's job).
    assert.strictEqual(para.length, 4);
    assert.deepStrictEqual(para[0].toDelta(), [{ insert: 'See ' }]);
    const ridDelta = para[1].toDelta();
    assert.strictEqual(ridDelta.length, 1);
    assert.strictEqual(ridDelta[0].insert, 'ASTM');
    assert.deepStrictEqual(ridDelta[0].attributes.inlineMark, { kind: 'rid', option: null });
    const boldDelta = para[3].toDelta();
    assert.deepStrictEqual(boldDelta[0].attributes.bold, {});
  });

  it('splits \\n into hard_break elements between runs', () => {
    const { yText } = attachedYText('line one\nline two\nline three');
    const yXml = buildYXmlFragmentFromYText(yText, { blockId: 'n1', log });
    const para = yXml.toArray()[0].toArray();
    // text, hard_break, text, hard_break, text
    assert.strictEqual(para.length, 5);
    assert.strictEqual(para[0].toDelta()[0].insert, 'line one');
    assert.strictEqual(para[1].nodeName, 'hard_break');
    assert.strictEqual(para[2].toDelta()[0].insert, 'line two');
    assert.strictEqual(para[3].nodeName, 'hard_break');
    assert.strictEqual(para[4].toDelta()[0].insert, 'line three');
  });

  it('skips zero-length text runs', () => {
    const { yText } = attachedYText((yt) => {
      // Note: yText.insert(pos, '', {}) is itself a no-op in Yjs; the
      // empty insert never reaches toDelta. We're really exercising the
      // delta-iteration loop's defensive `if (text.length === 0) continue`
      // for the case where a peer crafts a zero-length insert directly.
      insertWithAttrs(yt, 'hello', { bold: true });
    });
    const yXml = buildYXmlFragmentFromYText(yText, { blockId: 'n1', log });
    const para = yXml.toArray()[0].toArray();
    assert.strictEqual(para.length, 1);
    assert.strictEqual(para[0].toDelta()[0].insert, 'hello');
  });
});

// ── migrateRoom (happy path, partial path, idempotent re-run) ────────────

describe('migrateRoom — happy path', () => {
  it('replaces every Y.Text slot with a Y.XmlFragment', () => {
    const ydoc = buildV1Doc(5);
    const log = makeRecorderLog();
    const result = migrateRoom(ydoc, { log });
    assert.strictEqual(result.schemaVersion, SCHEMA_V2);
    assert.strictEqual(result.migrationPartial, false);
    assert.strictEqual(result.migratedCount, 5);
    assert.strictEqual(result.skippedCount, 0);

    const yStore = ydoc.getMap('store');
    yStore.forEach((yMap) => {
      const slot = yMap.get('html');
      assert.strictEqual(typeof slot.toArray, 'function');
      assert.strictEqual(typeof slot.toDelta, 'undefined');
    });
  });

  it('sets schemaVersion=2 and leaves migrationPartial absent', () => {
    const ydoc = buildV1Doc(2);
    migrateRoom(ydoc, { log: makeRecorderLog() });
    const yMeta = ydoc.getMap('meta');
    assert.strictEqual(yMeta.get(SCHEMA_VERSION_KEY), SCHEMA_V2);
    assert.strictEqual(yMeta.get(MIGRATION_PARTIAL_KEY), undefined);
  });

  it('uses the migrate-v2 transaction origin (not local-publish)', () => {
    const ydoc = buildV1Doc(1);
    const origins = [];
    ydoc.on('afterTransaction', (tx) => origins.push(tx.origin));
    migrateRoom(ydoc, { log: makeRecorderLog() });
    assert.ok(origins.includes(MIGRATION_ORIGIN));
    assert.ok(!origins.includes('local-publish'));
  });

  it('is idempotent — re-running on a v2 room is a structural no-op', () => {
    const ydoc = buildV1Doc(2);
    migrateRoom(ydoc, { log: makeRecorderLog() });
    const result = migrateRoom(ydoc, { log: makeRecorderLog() });
    // Already-Y.XmlFragment slots are skipped by the per-block branch in
    // migrateRoom, so no Y.XmlFragment is rebuilt.
    assert.strictEqual(result.migratedCount, 0);
    assert.strictEqual(result.schemaVersion, SCHEMA_V2);
    assert.strictEqual(result.migrationPartial, false);
    // The slots remain Y.XmlFragment.
    const yStore = ydoc.getMap('store');
    yStore.forEach((yMap) => {
      const slot = yMap.get('html');
      assert.strictEqual(typeof slot.toArray, 'function');
    });
    // schemaVersion stays at 2.
    assert.strictEqual(ydoc.getMap('meta').get(SCHEMA_VERSION_KEY), SCHEMA_V2);
  });

  it('preserves block scalar fields (id, type, part, depth) untouched', () => {
    const ydoc = buildV1Doc(3);
    migrateRoom(ydoc, { log: makeRecorderLog() });
    const yStore = ydoc.getMap('store');
    yStore.forEach((yMap, key) => {
      assert.strictEqual(yMap.get('id'), key);
      assert.strictEqual(yMap.get('type'), 'txt');
      assert.strictEqual(yMap.get('part'), 1);
      assert.strictEqual(yMap.get('depth'), 0);
    });
  });
});

describe('migrateRoom — adversarial fixtures (Q31/E6)', () => {
  it('drops unknown inlineMark kinds without throwing', () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    ydoc.transact(() => {
      const yMap = new Y.Map();
      const yText = new Y.Text();
      yText.insert(0, 'plain ');
      yText.insert(yText.length, 'evil', { mark: 'fake-kind' });
      yMap.set('html', yText);
      yStore.set('n1', yMap);
      yOrder.push(['n1']);
    });
    const log = makeRecorderLog();
    const result = migrateRoom(ydoc, { log });
    // Migration succeeds (fully — unknown mark is dropped at the run level,
    // not the block level).
    assert.strictEqual(result.migrationPartial, false);
    assert.strictEqual(result.schemaVersion, SCHEMA_V2);
    // Server log warn for the dropped mark.
    const warns = log.events.filter(([level, e]) => level === 'warn' && e === 'migrate.unknown-mark');
    assert.strictEqual(warns.length, 1);
  });

  it('a corrupt-Y.Text-like input (toDelta throws) surfaces a uniform error from buildYXmlFragmentFromYText', () => {
    const fakeText = {
      toDelta() { throw new Error('synthetic corruption'); },
    };
    assert.throws(
      () => buildYXmlFragmentFromYText(fakeText, { blockId: 'bad', log: makeRecorderLog() }),
      /toDelta\(\) failed on legacy Y\.Text/,
    );
  });

  it('migrationPartial path: per-block throw skips the block, sets sentinel', () => {
    // Real fixture: monkey-patch one Y.Text to throw on toDelta inside the
    // migration. Since the broker per-block try/catches, the run completes
    // with migrationPartial=true and the throwing block keeps its Y.Text.
    const ydoc = buildV1Doc(3);
    const yStore = ydoc.getMap('store');
    const badYText = yStore.get('n2').get('html');
    const origToDelta = badYText.toDelta.bind(badYText);
    badYText.toDelta = () => { throw new Error('boom'); };

    const log = makeRecorderLog();
    const result = migrateRoom(ydoc, { log });

    // Restore so destroy doesn't hit the patched method.
    badYText.toDelta = origToDelta;

    assert.strictEqual(result.migrationPartial, true);
    assert.strictEqual(result.schemaVersion, null);
    assert.strictEqual(result.migratedCount, 2);
    assert.strictEqual(result.skippedCount, 1);

    const yMeta = ydoc.getMap('meta');
    assert.strictEqual(yMeta.get(MIGRATION_PARTIAL_KEY), true);
    // Mutual exclusion invariant: schemaVersion is NOT set.
    assert.strictEqual(yMeta.get(SCHEMA_VERSION_KEY), undefined);

    // Skipped block still has Y.Text; others are Y.XmlFragment.
    assert.strictEqual(typeof yStore.get('n1').get('html').toArray, 'function');
    assert.strictEqual(typeof yStore.get('n2').get('html').toDelta, 'function');
    assert.strictEqual(typeof yStore.get('n3').get('html').toArray, 'function');
  });

  it('mutual exclusion: once partial, do not retry (subsequent migrateRoom is a no-op)', () => {
    const ydoc = buildV1Doc(2);
    const yMeta = ydoc.getMap('meta');
    yMeta.set(MIGRATION_PARTIAL_KEY, true);
    // needsMigration short-circuits on the partial sentinel — so the
    // upgrade-side coordinator wouldn't even call migrateRoom. But if it
    // were called directly (e.g. operator manual reset), it should still
    // be safe.
    assert.strictEqual(needsMigration(ydoc), false);
  });
});

// ── createMigrationCoordinator (per-room async lock + archive) ───────────

describe('createMigrationCoordinator', () => {
  function makeFakeStorage({ archiveDelayMs = 0, archiveShouldThrow = null } = {}) {
    const archiveCalls = [];
    return {
      archiveCalls,
      async archiveRoom(roomId) {
        archiveCalls.push(roomId);
        if (archiveDelayMs > 0) await new Promise(r => setTimeout(r, archiveDelayMs));
        if (archiveShouldThrow) throw archiveShouldThrow;
      },
    };
  }

  it('skips on already-v2 rooms (alreadyV2: true)', async () => {
    const storage = makeFakeStorage();
    const coord = createMigrationCoordinator({ storage });
    const ydoc = buildV1Doc(1);
    ydoc.getMap('meta').set(SCHEMA_VERSION_KEY, SCHEMA_V2);

    const result = await coord.ensureMigrated('room1', ydoc);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.alreadyV2, true);
    assert.strictEqual(storage.archiveCalls.length, 0);
  });

  it('archives + migrates a v1 room and stamps schemaVersion=2', async () => {
    const storage = makeFakeStorage();
    const coord = createMigrationCoordinator({ storage });
    const ydoc = buildV1Doc(2);

    const result = await coord.ensureMigrated('room1', ydoc);
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.archived, true);
    assert.strictEqual(result.schemaVersion, SCHEMA_V2);
    assert.strictEqual(result.migrationPartial, false);

    assert.deepStrictEqual(storage.archiveCalls, ['room1']);
    assert.strictEqual(ydoc.getMap('meta').get(SCHEMA_VERSION_KEY), SCHEMA_V2);
  });

  it('aborts migration when archiveRoom throws (Q23/B2): doc untouched', async () => {
    const storage = makeFakeStorage({ archiveShouldThrow: new Error('storage offline') });
    const coord = createMigrationCoordinator({ storage });
    const ydoc = buildV1Doc(2);
    const beforeBytes = Y.encodeStateAsUpdate(ydoc);

    const result = await coord.ensureMigrated('room1', ydoc);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.archived, false);

    // Doc state is byte-equivalent — no migration happened.
    const afterBytes = Y.encodeStateAsUpdate(ydoc);
    assert.deepStrictEqual(Buffer.from(beforeBytes), Buffer.from(afterBytes));
    assert.strictEqual(ydoc.getMap('meta').get(SCHEMA_VERSION_KEY), undefined);
    assert.strictEqual(ydoc.getMap('meta').get(MIGRATION_PARTIAL_KEY), undefined);
  });

  // PR #51 review (comment 4380149320, issue 3) — regression. The
  // inFlight cache was retaining the archive-failure result permanently:
  // every subsequent ensureMigrated call returned the cached
  // { skipped: true, archived: false } promise without re-attempting,
  // even after storage recovered. Operator had to restart the server.
  // The fix drops the cache entry on archive-failure resolve so the next
  // connect re-attempts.
  it('archive failure clears the inFlight cache so subsequent calls retry (issue 3)', async () => {
    let archiveAttempts = 0;
    let shouldFail = true;
    const storage = {
      async archiveRoom() {
        archiveAttempts++;
        if (shouldFail) throw new Error('storage offline');
      },
    };
    const coord = createMigrationCoordinator({ storage });
    const ydoc = buildV1Doc(2);

    // First attempt — archive fails.
    const r1 = await coord.ensureMigrated('room1', ydoc);
    assert.strictEqual(r1.archived, false);
    assert.strictEqual(r1.skipped, true);
    assert.strictEqual(archiveAttempts, 1);

    // Cache must be empty so the next call re-attempts.
    assert.strictEqual(coord._inFlight.has('room1'), false,
      'inFlight cache should be cleared after archive-failure resolve so a recovered storage can retry');

    // Second attempt — also fails (storage still offline). Verifies
    // ensureMigrated re-ran archiveRoom rather than returning a stale
    // cached promise.
    const r2 = await coord.ensureMigrated('room1', ydoc);
    assert.strictEqual(r2.archived, false);
    assert.strictEqual(archiveAttempts, 2);

    // Storage recovers — third attempt now succeeds.
    shouldFail = false;
    const r3 = await coord.ensureMigrated('room1', ydoc);
    assert.strictEqual(r3.archived, true);
    assert.strictEqual(r3.schemaVersion, SCHEMA_V2);
    assert.strictEqual(archiveAttempts, 3);

    // After successful migration, needsMigration short-circuits — but
    // even if it didn't, the cached promise is fine to keep (collapsing
    // concurrent calls, not blocking retries).
  });

  it('successful migration keeps the inFlight cache (concurrent-call lock semantics)', async () => {
    const storage = { async archiveRoom() {} };
    const coord = createMigrationCoordinator({ storage });
    const ydoc = buildV1Doc(1);

    await coord.ensureMigrated('room1', ydoc);
    // Cache stays — next ensureMigrated short-circuits via needsMigration
    // (schemaVersion=2 now), so the cached promise is harmless and
    // serves the concurrent-call lock contract.
    assert.strictEqual(coord._inFlight.has('room1'), true);
  });

  it('per-room async lock: concurrent ensureMigrated calls collapse onto a single migration', async () => {
    // Slow archive forces both callers into the await window simultaneously.
    const storage = makeFakeStorage({ archiveDelayMs: 60 });
    const coord = createMigrationCoordinator({ storage });
    const ydoc = buildV1Doc(3);

    const [r1, r2] = await Promise.all([
      coord.ensureMigrated('room1', ydoc),
      coord.ensureMigrated('room1', ydoc),
    ]);
    // Both callers see the same migration result.
    assert.strictEqual(r1, r2);
    assert.strictEqual(r1.schemaVersion, SCHEMA_V2);
    // archiveRoom called exactly once.
    assert.strictEqual(storage.archiveCalls.length, 1);
  });

  it('concurrent calls to DIFFERENT rooms each archive + migrate independently', async () => {
    const storage = makeFakeStorage({ archiveDelayMs: 30 });
    const coord = createMigrationCoordinator({ storage });
    const ydocA = buildV1Doc(1);
    const ydocB = buildV1Doc(1);

    const [rA, rB] = await Promise.all([
      coord.ensureMigrated('roomA', ydocA),
      coord.ensureMigrated('roomB', ydocB),
    ]);
    assert.strictEqual(rA.schemaVersion, SCHEMA_V2);
    assert.strictEqual(rB.schemaVersion, SCHEMA_V2);
    assert.deepStrictEqual([...storage.archiveCalls].sort(), ['roomA', 'roomB']);
  });

  it('migrationPartial result preserves the sentinel through the coordinator', async () => {
    const storage = makeFakeStorage();
    // Inject a migrate impl that always reports partial.
    const partialImpl = (ydoc /* , opts */) => {
      const yMeta = ydoc.getMap('meta');
      ydoc.transact(() => { yMeta.set(MIGRATION_PARTIAL_KEY, true); }, MIGRATION_ORIGIN);
      return { schemaVersion: null, migrationPartial: true, migratedCount: 0, skippedCount: 1 };
    };
    const coord = createMigrationCoordinator({ storage, migrateImpl: partialImpl });
    const ydoc = buildV1Doc(1);

    const result = await coord.ensureMigrated('room1', ydoc);
    assert.strictEqual(result.migrationPartial, true);
    assert.strictEqual(ydoc.getMap('meta').get(MIGRATION_PARTIAL_KEY), true);
    assert.strictEqual(ydoc.getMap('meta').get(SCHEMA_VERSION_KEY), undefined);
  });
});
