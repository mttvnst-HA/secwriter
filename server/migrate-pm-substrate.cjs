/**
 * migrate-pm-substrate — server-side Y.Text → Y.XmlFragment migration.
 *
 * Sub-PR 1d (#47, [ADR-0006](../docs/adr/0006-pm-substrate-migration.md)).
 * Server-side broker that converts a v1 room (block html stored as Y.Text
 * with attribute deltas) into a v2 room (Y.XmlFragment with paragraph +
 * Y.XmlText children carrying y-prosemirror-shape marks).
 *
 * Dual-package-hazard mitigation (Q22): the broker walks the legacy Y.Text
 * via `.toDelta()` and constructs the new Y.XmlFragment via the CJS-required
 * `yjs` instance directly, instead of routing through y-prosemirror's
 * `prosemirrorToYXmlFragment`. y-prosemirror transitively re-imports yjs via
 * ESM, which compounds the existing "Yjs was already imported" warning when
 * the CJS server bundle loads it. The mark-attr shape is hand-coded against
 * the same enum / kind sets that pm-schema.js declares — those are
 * canonical and one-way; copying them here is acceptable cost for keeping
 * the dual-package boundary clean.
 *
 * Adversarial-input fallback (Q31/E6): unknown inlineMark kinds and
 * malformed revision attrs are dropped with a server-log warning; the
 * surrounding text survives. Per-block conversion errors are caught and
 * the offending block is left as Y.Text — `migrationPartial: true` is set
 * on yMeta so v2 clients can show a banner.
 *
 * Atomicity: the broker is invoked from the WS upgrade handler with the
 * room's archived `.ydoc` already in place (Q23/B2). If `migrateRoom`
 * itself throws, callers retain the option to roll the doc back from the
 * archive — but in practice the per-block try/catch keeps the migration
 * forward-progressing under any per-block schema fault, so a global throw
 * indicates a more serious failure (yjs-internal corruption, OOM, etc).
 *
 * CJS on purpose (see ADR-0001).
 */
'use strict';

const Y = require('yjs');

// ── Schema enums (mirror src/lib/pm-schema.js) ───────────────────────────
// Copy-pasted so the broker doesn't dynamic-import the ESM schema module
// (which would pull in prosemirror-model + a second yjs import path).
// Q22 dual-package mitigation. Both sets are forward-additive: new kinds
// added to pm-schema must also be added here, otherwise the broker drops
// them on migration. The migration-adversarial test suite catches this.
const INLINE_MARK_KINDS = new Set([
  'rid', 'srf', 'sub', 'eng', 'met', 'tai', 'tst', 'url', 'att',
  'hls', 'hl1', 'hl2', 'hl3', 'hl4',
]);
const REVISION_KINDS = new Set(['add', 'del', 'chg']);
// Maps a legacy Y.Text `revision` attr value to the per-kind MarkType key the
// post-#92 reader expects (pmdoc-html.js yDeltaAttrsToAttrs). See #220.
const REVISION_KEY_BY_KIND = { add: 'revisionAdd', del: 'revisionDel', chg: 'revisionChg' };

// Origin used for migration writes. Distinct from 'local-publish' (which
// the client-side UndoManager tracks) so a v2 client joining a freshly-
// migrated room cannot Ctrl+Z a peer's pre-migration content (Q32).
const MIGRATION_ORIGIN = 'migrate-v2';

// Sentinels written to yMeta.
const SCHEMA_VERSION_KEY = 'schemaVersion';
const SCHEMA_V2 = 2;
const MIGRATION_PARTIAL_KEY = 'migrationPartial';

const NOOP_LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/**
 * Detect whether a Y.Doc still needs the v2 substrate migration.
 *
 *   schemaVersion === 2          → already migrated, skip.
 *   migrationPartial === true    → broker has already run and failed on
 *                                   some blocks; don't retry until the
 *                                   underlying issue is resolved (operator
 *                                   reset).
 *   Otherwise: scan yStore — if ANY block's html slot is a Y.Text, we
 *   need to migrate.
 *
 * Pure read; no mutation, no transaction.
 */
function needsMigration(ydoc) {
  if (!ydoc) return false;
  const yMeta = ydoc.getMap('meta');
  if (yMeta.get(SCHEMA_VERSION_KEY) === SCHEMA_V2) return false;
  if (yMeta.get(MIGRATION_PARTIAL_KEY) === true) return false;
  const yStore = ydoc.getMap('store');
  let foundLegacy = false;
  yStore.forEach((yMap) => {
    if (foundLegacy) return;
    if (!yMap || typeof yMap.get !== 'function') return;
    const yHtml = yMap.get('html');
    if (yHtml && typeof yHtml.toDelta === 'function') foundLegacy = true;
  });
  return foundLegacy;
}

// ── Y.Text-attrs → y-prosemirror-mark adapter ────────────────────────────
//
// Y.Text delta attrs (the 1a/1b/1c shape — see ytext-html.js NESTING_KEYS):
//   { bold, italic, underline, mark, markOption,
//     revision, revisionAuthor, revisionAuthorColor,
//     comment, commentResolved }
//
// y-prosemirror Y.XmlText insert attrs (see plugins/sync-plugin.js):
//   bold: {}                 (empty object marks the mark as set)
//   italic: {}
//   underline: {}
//   inlineMark: { kind, option }
//   revisionAdd|revisionDel|revisionChg: { authorId, authorColor }  (#220)
//   comment:    { id, resolved }
//
// Unknown / malformed inputs are dropped with a logger.warn (Q31/E6).
function mapYTextAttrsToYpmMarks(rawAttrs, log, blockId) {
  const out = {};
  if (!rawAttrs || typeof rawAttrs !== 'object') return out;

  if (rawAttrs.bold) out.bold = {};
  if (rawAttrs.italic) out.italic = {};
  if (rawAttrs.underline) out.underline = {};

  if (rawAttrs.mark) {
    if (INLINE_MARK_KINDS.has(rawAttrs.mark)) {
      const m = { kind: rawAttrs.mark, option: null };
      if (rawAttrs.mark === 'tai' && rawAttrs.markOption) m.option = rawAttrs.markOption;
      out.inlineMark = m;
    } else {
      log.warn('migrate.unknown-mark', { roomBlock: blockId || null, kind: String(rawAttrs.mark) });
    }
  }

  if (rawAttrs.revision) {
    if (REVISION_KINDS.has(rawAttrs.revision)) {
      // 1g.6 (#87/#220) — the reader (pmdoc-html.js yDeltaAttrsToAttrs) keys
      // revision marks by per-kind MarkType name (revisionAdd/Del/Chg), each
      // valued { authorId, authorColor }. PR #92 retired the base `revision`
      // key; emitting it here makes every v2 reader silently drop the mark.
      const key = REVISION_KEY_BY_KIND[rawAttrs.revision];
      out[key] = {
        authorId: rawAttrs.revisionAuthor || null,
        authorColor: rawAttrs.revisionAuthorColor || null,
      };
    } else {
      log.warn('migrate.unknown-revision', { roomBlock: blockId || null, kind: String(rawAttrs.revision) });
    }
  }

  if (rawAttrs.comment) {
    out.comment = {
      id: String(rawAttrs.comment),
      resolved: !!rawAttrs.commentResolved,
    };
  }

  return out;
}

/**
 * Populate an already-attached Y.XmlFragment with content derived from a
 * pre-read Y.Text delta. Newlines (`\n`) inside delta inserts split into
 * hard_break elements between Y.XmlText runs (matches the 1c serializer's
 * <br> round-trip).
 *
 * The fragment MUST be attached to a Y.Doc when this is called — Y children
 * inserted into a detached XmlFragment do not persist into integration.
 *
 * Pre-reading the delta separately (rather than calling yText.toDelta()
 * inside this helper) is deliberate: `migrateRoom` reads delta BEFORE
 * mutating `yMap.set('html', ...)` so a corrupt-Y.Text throw cannot
 * leave an empty Y.XmlFragment behind. The thrown error becomes the
 * migrationPartial sentinel.
 */
function populateYXmlFragmentFromDelta(yXml, delta, { blockId, log }) {
  if (!Array.isArray(delta)) return;

  const para = new Y.XmlElement('paragraph');
  yXml.push([para]);

  for (const item of delta) {
    if (!item || typeof item.insert !== 'string') {
      // Non-string inserts (embeds) are not part of the SecWriter schema —
      // skip silently. Q31/E6 fallback.
      continue;
    }
    const ypmAttrs = mapYTextAttrsToYpmMarks(item.attributes, log, blockId);
    const text = item.insert;
    if (text.length === 0) continue;

    // Split on \n so each newline becomes a hard_break element. The
    // marks (ypmAttrs) apply to the surrounding text runs but NOT to
    // the hard_break — pmFragmentToHtml emits <br> without marks, and
    // yTextToHtml's `\n` → <br> conversion inside escapeHtml drops the
    // run boundary, so the no-marks-on-break choice keeps the round-
    // trip stable.
    const parts = text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].length > 0) {
        const yt = new Y.XmlText();
        para.push([yt]);
        // Insert AFTER push so the YXmlText is attached and the formatting
        // attributes integrate cleanly.
        const hasAttrs = Object.keys(ypmAttrs).length > 0;
        if (hasAttrs) yt.insert(0, parts[i], ypmAttrs);
        else yt.insert(0, parts[i]);
      }
      if (i < parts.length - 1) {
        para.push([new Y.XmlElement('hard_break')]);
      }
    }
  }
}

/**
 * Read `yText.toDelta()` and surface a uniform error on corrupt state.
 * Pulled out so `migrateRoom` can catch the read failure BEFORE mutating
 * the slot.
 */
function readYTextDelta(yText) {
  let delta;
  try {
    delta = yText.toDelta();
  } catch (err) {
    throw new Error(`toDelta() failed on legacy Y.Text: ${err.message}`);
  }
  if (!Array.isArray(delta)) {
    throw new Error('toDelta() did not return an array');
  }
  return delta;
}

/**
 * Populate an already-attached Y.XmlFragment from a Y.Text — convenience
 * wrapper that combines `readYTextDelta` + `populateYXmlFragmentFromDelta`.
 * Throws if the read fails; caller is responsible for attaching the
 * fragment to a doc before calling this.
 */
function populateYXmlFragmentFromYText(yXml, yText, opts) {
  const delta = readYTextDelta(yText);
  populateYXmlFragmentFromDelta(yXml, delta, opts || {});
}

/**
 * Convenience wrapper that builds a fresh Y.XmlFragment attached to a
 * scratch Y.Doc. Used by unit tests; the production migration path goes
 * through `populateYXmlFragmentFromDelta` directly against the room's
 * live Y.Doc.
 */
function buildYXmlFragmentFromYText(yText, opts = {}) {
  const scratch = new Y.Doc();
  const yXml = scratch.get('xml-scratch', Y.XmlFragment);
  scratch.transact(() => {
    populateYXmlFragmentFromYText(yXml, yText, opts);
  });
  return yXml;
}

/**
 * Migrate a Y.Doc's per-block html slots from Y.Text to Y.XmlFragment.
 *
 * Walks `yStore`; for every block whose html slot is still a Y.Text,
 * builds a new Y.XmlFragment and replaces the slot inside a single
 * 'migrate-v2' transaction. Per-block errors are caught — the offending
 * block keeps its Y.Text and `yMeta.migrationPartial` is set to true.
 *
 * On a fully-clean run, sets `yMeta.schemaVersion = 2`. On any per-block
 * failure, leaves schemaVersion absent and sets migrationPartial=true.
 * The two flags are mutually exclusive — a v2 client surfacing the
 * "migration had issues" banner is the partial-state signal.
 *
 * Returns `{ schemaVersion, migrationPartial, migratedCount, skippedCount }`
 * for callers (test harness primarily).
 */
function migrateRoom(ydoc, options = {}) {
  const log = options.log || NOOP_LOG;
  const yMeta = ydoc.getMap('meta');
  const yStore = ydoc.getMap('store');

  let migratedCount = 0;
  let skippedCount = 0;
  let partial = false;

  ydoc.transact(() => {
    const blockIds = Array.from(yStore.keys());
    for (const blockId of blockIds) {
      const yMap = yStore.get(blockId);
      if (!yMap || typeof yMap.get !== 'function') continue;
      const yHtml = yMap.get('html');
      if (!yHtml) continue;
      // Already Y.XmlFragment? Skip silently — idempotent re-run support.
      if (typeof yHtml.toArray === 'function' && typeof yHtml.nodeName !== 'string') {
        continue;
      }
      // Anything other than Y.Text (legacy bare strings, unexpected types)
      // is left in place — they're outside the migration's contract.
      if (typeof yHtml.toDelta !== 'function') {
        skippedCount++;
        continue;
      }

      try {
        // Read the legacy delta FIRST. If toDelta throws, we never touch
        // the yMap — the original Y.Text stays in place and migrationPartial
        // is set without leaving an empty Y.XmlFragment behind.
        const delta = readYTextDelta(yHtml);

        // Attach a fresh Y.XmlFragment to the yMap and populate in place
        // so child inserts integrate through the live Y.Doc rather than
        // being silently dropped.
        const yXml = new Y.XmlFragment();
        yMap.set('html', yXml);
        populateYXmlFragmentFromDelta(yXml, delta, { blockId, log });
        migratedCount++;
      } catch (err) {
        partial = true;
        skippedCount++;
        log.warn('migrate.block-failed', {
          blockId,
          err: err.message,
        });
        // Leave the Y.Text in place. v1 / v2-fallback clients can keep
        // editing it.
      }
    }

    if (partial) {
      yMeta.set(MIGRATION_PARTIAL_KEY, true);
      // Important: do NOT set schemaVersion to 2 — invariant is that the
      // two sentinels are mutually exclusive.
    } else {
      yMeta.set(SCHEMA_VERSION_KEY, SCHEMA_V2);
    }
  }, MIGRATION_ORIGIN);

  if (partial) {
    log.warn('migrate.partial', { migratedCount, skippedCount });
  } else {
    log.info('migrate.complete', { migratedCount });
  }

  return {
    schemaVersion: partial ? null : SCHEMA_V2,
    migrationPartial: partial,
    migratedCount,
    skippedCount,
  };
}

/**
 * Build a per-room migration coordinator. Returns an `ensureMigrated`
 * function that the WS upgrade handler awaits: the first caller per room
 * triggers `archiveRoom` + `migrateRoom`; subsequent concurrent callers
 * await the same promise. After settle, the cached promise stays in
 * place — needsMigration returns false on the migrated doc, and a partial-
 * state room is also gated by migrationPartial so we don't retry on every
 * connect.
 *
 * Failure semantics:
 *   - archiveRoom throws → migration is aborted; the cached promise
 *     resolves successfully (room stays v1 untouched). No partial state
 *     is written. Subsequent broker calls re-attempt because schemaVersion
 *     and migrationPartial are both still absent.
 *   - migrateRoom throws (after archive succeeded) → cached promise
 *     resolves; the doc may be in a half-migrated state but yMeta tracks
 *     it via migrationPartial set by migrateRoom's per-block try/catch.
 */
function createMigrationCoordinator({ storage, log = NOOP_LOG, migrateImpl = migrateRoom } = {}) {
  if (!storage) throw new Error('createMigrationCoordinator: storage is required');
  const inFlight = new Map(); // docName → Promise<{ skipped: boolean, archived: boolean }>

  async function runMigration(docName, ydoc) {
    let archived = false;
    try {
      await storage.archiveRoom(docName);
      archived = true;
      log.info('migrate.archived', { roomId: docName });
    } catch (err) {
      log.warn('migrate.archive-failed', { roomId: docName, err: err.message });
      // Q23/B2: archive failure aborts migration. Do NOT touch the doc.
      return { skipped: true, archived: false, err: err.message };
    }

    try {
      const result = migrateImpl(ydoc, { log });
      return { skipped: false, archived, ...result };
    } catch (err) {
      log.error('migrate.uncaught', { roomId: docName, err: err.message });
      // Per-block catches inside migrateRoom mean a thrown migrateRoom is
      // a serious failure (yjs internal, OOM, etc). Mark the room as
      // partial so subsequent connects don't retry.
      try {
        const yMeta = ydoc.getMap('meta');
        ydoc.transact(() => { yMeta.set(MIGRATION_PARTIAL_KEY, true); }, MIGRATION_ORIGIN);
      } catch { /* ignore best-effort flag */ }
      return { skipped: false, archived, err: err.message, migrationPartial: true };
    }
  }

  async function ensureMigrated(docName, ydoc) {
    if (!needsMigration(ydoc)) return { skipped: true, alreadyV2: true };
    let p = inFlight.get(docName);
    if (!p) {
      // Wrap the migration promise so we can drop the cache entry on
      // archive failure. Without this, an archiveRoom outage would
      // permanently pin a `{ skipped: true, archived: false }` result for
      // the room: every subsequent WS upgrade would see the cached promise
      // and never retry, even after storage recovers — operator would
      // need to restart the server (PR #51 review comment 4380149320,
      // issue 3). For success / partial migrations, the cache stays —
      // needsMigration short-circuits via schemaVersion=2 or
      // migrationPartial=true so re-attempts wouldn't fire anyway, and
      // keeping the cache means concurrent broker calls during the
      // migration window collapse onto one promise.
      p = runMigration(docName, ydoc).then((result) => {
        if (result && result.skipped && !result.archived && result.err) {
          inFlight.delete(docName);
        }
        return result;
      });
      inFlight.set(docName, p);
    }
    return p;
  }

  /**
   * Drop the inFlight entry for a room. The HTTP DELETE handler MUST call
   * this when a room is deleted: otherwise, if a new room is created with
   * the same docName (e.g. operator deletes a corrupt room and re-uploads
   * a SEC under the same id), `ensureMigrated` returns the cached
   * post-migration result and the new doc is never re-evaluated. The
   * cached `{ alreadyV2: true }` short-circuits both `archiveRoom` AND
   * `migrateRoom`, so a freshly-uploaded v1 doc would silently skip
   * migration and present a mixed-substrate room to clients.
   *
   * Idempotent: safe to call for unknown docNames.
   */
  function forget(docName) {
    inFlight.delete(docName);
  }

  return {
    ensureMigrated,
    needsMigration,
    forget,
    // Test-only: expose the in-flight cache so contract tests can verify
    // the per-room lock collapses concurrent callers onto one promise.
    _inFlight: inFlight,
  };
}

module.exports = {
  needsMigration,
  migrateRoom,
  buildYXmlFragmentFromYText,
  populateYXmlFragmentFromYText,
  populateYXmlFragmentFromDelta,
  readYTextDelta,
  mapYTextAttrsToYpmMarks,
  createMigrationCoordinator,
  MIGRATION_ORIGIN,
  SCHEMA_VERSION_KEY,
  SCHEMA_V2,
  MIGRATION_PARTIAL_KEY,
  INLINE_MARK_KINDS,
  REVISION_KINDS,
};
