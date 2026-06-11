# ADR-0006: Server-side broker migrates v1 (Y.Text) rooms to v2 (Y.XmlFragment) on first v2 connect

**Status:** Accepted
**Date:** 2026-05-05

## Context

Issue [#47](https://github.com/mttvnst-HA/secwriter/issues/47) is the y-prosemirror migration that replaces snapshot-diff inside the substrate write with a real character-level binding. Sub-PRs 1a (#45) and 1b (#46) put the Y.Doc-as-substrate adapter and per-block binder in place; sub-PR 1c (#50) landed the ProseMirror schema (`src/lib/pm-schema.js`) and the byte-stable `pmFragmentToHtml` / `htmlToPmFragment` serializer (`src/lib/pmdoc-html.js`). 1c is pure code — it doesn't change any room's persisted state.

Sub-PR 1d (this ADR) is the substrate swap: per-block html slots move from `Y.Text` (with attribute deltas as the inline-mark carrier, as seen in [`ytext-html.js`](../../src/lib/ytext-html.js)) to `Y.XmlFragment` (with paragraph + Y.XmlText children, the y-prosemirror canonical shape).

The v2 plan ([issue #47 comment](https://github.com/mttvnst-HA/secwriter/issues/47#issuecomment-4374671950)) flagged five blockers that have to be addressed *inside* this PR or the production rollout breaks:

- **B1 (Q22) — concurrent migration race.** Two v2 clients connecting simultaneously to a fresh v1 room would both run the same `Y.Map.set('html', newYXmlFragment)`. `Y.Map` resolves concurrent set by client ID; one wins, the loser's `Y.XmlFragment` is orphaned and the room is left half-migrated.
- **B2 (Q23) — pre-migration archive must be server-driven.** `backupRoom` is a server-only API (the client has no storage handle); a client-driven archive design from v1 of the plan can't hold.
- **B3 (Q24) — `yMapToBlock` must branch inside this PR.** The `.SEC` flush path goes through `room-serializer.cjs` → `yBlocksToArray` → `yMapToBlock` (`src/lib/collab.js`). Without a Y.XmlFragment branch in `yMapToBlock`, every server flush after 1d coerces `String(yXmlFragment)` into the export and silently corrupts `.SEC` for the entire room.
- **B4 (Q25) — adoption window.** Currently-deployed v1 clients don't know about `schemaVersion`. Sub-PR 1b.1 (#49) shipped a transitional v1.5 release that reads `yMeta.schemaVersion` and refuses with a banner if `> 1`. The 7-day adoption window between 1b.1 and 1d means very few v1 sessions still need to be supported when 1d lands.
- **E6 (Q31) — schema-invalid input must drop, never throw.** Peers running future schemas could otherwise wedge the editor on first sync.

## Decision

Migration runs **server-side**, in a per-room broker invoked from the WebSocket upgrade handler **after** the existing preload + eviction-guard block. The broker:

1. **Detects** v1 rooms by reading `yMeta.get('schemaVersion') !== 2` AND scanning `yStore` for any block whose `html` slot is still a `Y.Text` (duck-typed via `.toDelta`). Rooms already at v2, and rooms that previously failed migration (`yMeta.migrationPartial === true`), short-circuit.
2. **Awaits** `storage.backupRoom(tenant, roomId)` before mutating the doc — a NON-DESTRUCTIVE copy into the archive namespace (the active room, including its `.acl.json`, stays in place; the original move-style `archiveRoom` destroyed the active ACL that no flush ever rewrites, bricking migrated rooms under auth). The snapshot gives the operator a recoverable rollback if something goes wrong post-migration. Backup failure aborts the migration; the room stays v1 untouched.
3. **Walks `yStore`** inside a single `'migrate-v2'` transaction, replacing each Y.Text slot with a freshly-built `Y.XmlFragment(paragraph(YXmlText...))`. The Y.Text-delta → Y.XmlFragment adapter is hand-coded against the same `INLINE_MARK_KINDS` / `REVISION_KINDS` enums declared in `pm-schema.js` — it does *not* route through y-prosemirror's `prosemirrorToYXmlFragment`, which would compound the existing dual-package "Yjs was already imported" warning by transitively re-importing yjs from the ESM tree (Q22 hazard mitigation).
4. **Per-block error handling.** A block whose `Y.Text` is corrupt (or whose marks don't conform to the schema) is skipped: the legacy `Y.Text` stays in place, `yMeta.migrationPartial = true` is set, and a server-log warning records the block id. The migration continues for the other blocks.
5. **Schema-version stamping.**
   - All blocks migrated successfully → `yMeta.set('schemaVersion', 2)`. `migrationPartial` stays absent.
   - Any per-block failure → `yMeta.set('migrationPartial', true)`. `schemaVersion` stays at v1. **The two sentinels are mutually exclusive** — a v2 client surfacing the "migration had issues" banner is the only signal that some blocks remain on Y.Text.
6. **Per-room async lock.** A `Map<docName, Promise>` collapses concurrent broker calls onto a single migration promise; the second WebSocket upgrade for a v1 room awaits the first's result. The promise stays cached after settle so `needsMigration` short-circuiting (schemaVersion=2 OR migrationPartial=true) becomes the long-term gate.
7. **Origin separation.** Migration writes use the `'migrate-v2'` transaction origin, distinct from `'local-publish'` (which the client-side UndoManager tracks per CLAUDE.md). A v2 client joining a freshly-migrated room cannot Ctrl+Z a peer's pre-migration content; the migration is invisible to the undo stack.

The `migrationPartial` banner is wired through `useCollabSession`'s `onRemoteMeta` hook (the same callback already used for the 1b.1 schema-version gate). It surfaces as a non-blocking `'migration-partial'` `ConnectionBanner` state — the room is still editable, but the user knows some blocks are in legacy mode.

## Consequences

- **Positive:**
  - **No client-side migration code paths.** v2 clients connecting to a v1 room see nothing of the migration except the schema bump; they can't race each other.
  - **Pre-migration archive is automatic.** Operator support workflow is "look in the archive bucket for this room id" — same shape as the 30-day idle archive that already exists in `collab-server.cjs:506`.
  - **Half-migrated rooms remain editable.** v1 clients see Y.Text on every block (status quo); v2 clients see Y.XmlFragment on migrated blocks and Y.Text on skipped blocks (the `block-html-store.js` read path handles both shapes; the write path also handles both, falling back to `applyHtmlToYText` for legacy slots).
  - **`.SEC` flush stays correct.** The Y.XmlFragment branch in `yMapToBlock` ships in the same PR as the substrate swap, closing the B3 corruption window before it could open.
  - **Server bundle stays CJS.** The broker's mark-attr adapter is hand-coded; no dynamic-import to ESM y-prosemirror — the dual-package warning doesn't grow.
- **Negative / cost:**
  - The hand-coded `INLINE_MARK_KINDS` / `REVISION_KINDS` enums in `migrate-pm-substrate.cjs` duplicate the canonical declarations in `pm-schema.js`. New mark kinds added to the ESM schema must also be added to the CJS broker — the migration-adversarial test fixtures catch the drop case but not the add case (a new schema kind without a matching CJS entry would be silently dropped during migration). A `npm run lint:schema-parity` future check could close this gap; for now, the duplication is acknowledged.
  - The WS upgrade handler now has *two* awaits between accepting the request and `setupWSConnection` (preload + migration). The eviction guard is re-installed after the second await; the existing `collab-server.test.mjs` "stale closeConn" test is a 200ms timing fixture that already covers the longer window. A `migrate-pm-substrate` integration test is added that explicitly forces the eviction during the migration await.
  - First connect to a v1 room is slower by the cost of `backupRoom` + `migrateRoom` — typically tens of ms for a 100-block room, dominated by the archive copy. Subsequent connects skip the broker. The cost is bounded; we don't re-archive on every connect.
- **Re-litigation risk:**
  - **"Why not migrate on the client?"** Two reasons. (1) `backupRoom` is server-only — clients have no storage handle. (2) Concurrent v2 clients on a fresh v1 room would race each other through `Y.Map.set`; the per-room async lock that solves this is naturally server-side because the server is the single point that sees every WS upgrade.
  - **"Why a separate `migrate-v2` origin?"** Two reasons. (1) The client-side UndoManager tracks only `'local-publish'`; using that origin for the broker would let a v2 client undo a migration step. (2) The `handleAfterTx` filter in `collab.js:752` skips any origin starting with `'local-'`; using a non-`local-` origin makes the migration write *visible* to the remote-blocks callback, so the first v2 client to join sees the migrated state via the normal sync path instead of via a special channel.
  - **"Why not bump `schemaVersion` after every successful per-block migration?"** Because the broker writes the entire migration in one transaction. Either all blocks succeed (and `schemaVersion: 2` is set in the same transaction) or some fail (and `migrationPartial: true` is set instead). A per-block schema bump would be observable to peers in an inconsistent state.

## Alternatives considered

- **Client-side migration (v1 plan).** Rejected per Q22 (race) and Q23 (no archive handle on client). The original v1 plan didn't survive the independent review.
- **Migrate via y-prosemirror's `prosemirrorToYXmlFragment` on the server.** Rejected per Q22 — y-prosemirror transitively re-imports yjs via ESM, compounding the dual-package warning. The hand-coded delta-to-fragment adapter is small enough (one file, ~60 LOC of conversion) that the dependency cost wins.
- **Lazy / on-demand migration (per-block when first written).** Rejected — would leave the room indefinitely half-migrated with no clear "done" signal. Operators couldn't tell which rooms had been migrated and which hadn't. Also makes the `.SEC` flush path branch on every block on every flush.
- **Drop pre-migration archive entirely.** Rejected — even with per-block try/catch, a yjs-internal failure mid-migration (OOM, doc corruption) could leave a room in a state with no easy rollback. The archive cost is bounded and the operator recovery story is clean.
- **Set `migrationPartial: true` AND `schemaVersion: 2` together.** Rejected — would make the schema-version gate (1b.1) unreliable. v1.5 clients would refuse a partially-migrated room thinking it's fully v2. The mutual-exclusion invariant keeps both gates honest.

## When to revisit

- A v3 schema lands. ADR-0006's broker-on-upgrade pattern should generalize, but the `migrationPartial` sentinel becomes ambiguous (partial-from-v1 vs partial-from-v2). At that point, replace the boolean with a richer `{ from, to, partialBlocks: [] }` map.
- The "migration had issues" banner has to escalate to a hard stop (e.g. if an audit reveals that mixed v1/v2 rooms produce subtly wrong `.SEC` exports under some edge case). At that point, add a `migrationPartial` → `'incompatible'` mapping in `useCollabSession`.
- The CJS / ESM dual-package hazard is fixed (the server moves to ESM, or yjs ships an interop shim). At that point, the hand-coded mark-attr adapter could route through y-prosemirror and the duplicated kind enums in `migrate-pm-substrate.cjs` could be deleted. ADR-0001 currently pins the server to CJS, so this is gated on revisiting ADR-0001 first.

Until then, the server-side broker pattern stays.
