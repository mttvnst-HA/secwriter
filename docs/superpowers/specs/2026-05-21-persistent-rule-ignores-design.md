# Persistent rule ignores — design spec

**Issue:** [#140](https://github.com/mttvnst-HA/secwriter/issues/140) — `linting: persistent rule ignores (UI + reducer + sidecar)`
**Status:** Approved through 5 sections of brainstorming + 5 rounds of independent agent critique (final whole-doc pass: 13 findings applied)
**Date:** 2026-05-21
**Related:**
- [#138](https://github.com/mttvnst-HA/secwriter/issues/138) — `.lint.json` sidecar (shipped, prerequisite)
- [#157](https://github.com/mttvnst-HA/secwriter/pull/157) — `yLint` Y.Map (shipped, reused pattern)
- [#161](https://github.com/mttvnst-HA/secwriter/issues/161) — owner-controlled dismissal policy (follow-up, deferred)
- [ADR-0015](../../adr/0015-linting-stays-block-granular.md) — block-granular cache decision (compatible)

## 1. Problem statement

Three linter engines run inline in SecWriter: Static UFS (regex, citation-backed), Harper grammar (WASM), and compromise NLP (passive voice + indicative mood, noisiest tier). Today there is no durable way for a user to suppress a false-positive flag. Pressing Esc closes the tooltip; editing the text changes the fingerprint; closing the panel does nothing. The flag returns every reload.

Trust in the linter erodes when persistent false positives keep firing. The fix is a Dismiss affordance that survives reload and (where appropriate) syncs to peers.

## 2. Design summary (Option 5)

- **Per-finding persistent dismiss across all three tiers**, keyed by `(ruleId, blockHash, match)` SHA-prefix.
- **NLP-only "Mute rule in this document"** as an escape hatch for heuristic noise.
- **Persisted in the `.lint.json` sidecar (v2)** alongside the existing finding cache from #138.
- **Synced via two sibling Y.Maps** (`lintIgnored`, `lintMutedNlp`), CRDT-safe under concurrent peer writes.
- **No owner / ACL** — deferred to [#161](https://github.com/mttvnst-HA/secwriter/issues/161). Every peer in the room can dismiss anything; everything syncs to everyone.

## 3. Architecture

### 3.1 Reducer state — `src/lib/linting.js`

Add one field to existing state shape:

```js
{
  enabled, suspended, byBlock,                                    // unchanged
  ignored: {
    findings: Map<ignoreKey, IgnoreEntry>,                        // new
    mutedRules: Map<ruleId, MuteEntry>,                           // new
  }
}
```

Where:

- `ignoreKey` = `SHA-256(JSON.stringify([ruleId, blockHash, match]))` truncated to 24 hex chars. Matches the `fingerprintBlock` primitive at `src/lib/lint-sidecar.js:72-89`.
- `IgnoreEntry` = `{ ruleId: string, blockHash: string, match: string, ts: number, authorId: string, tombstone?: true }`
- `MuteEntry` = `{ ts: number, authorId: string, tombstone?: true }`

`Map` (not `Set`) so tombstones can carry metadata. Tombstoned entries stay in the structure — un-dismiss writes a tombstone, not a delete (matches phase-1 yLint "set-only never-delete" discipline from #157).

### 3.2 Yjs substrate

Two new top-level Y.Maps, siblings to the existing `yLint`, `yComments`, etc.:

- `ydoc.getMap('lintIgnored')` — keys are ignore-keys, values are `IgnoreEntry`.
- `ydoc.getMap('lintMutedNlp')` — keys are rule IDs, values are `MuteEntry`.

**Why two new maps, not array slots on `yLint`:** Y.Map values of type Array are LWW per-key — concurrent writes by two peers lose one peer's data at the substrate level (not just a race window; steady state). Per-key Y.Map writes are CRDT-safe. Mirrors the `yComments` precedent.

**Echo origin:** all client writes use `'local-lint-ignored'`. Caught by `handleAfterTx`'s `'local-'` prefix filter at `src/lib/collab.js:944`; never re-enters `applyRemoteIgnored`.

**Not in UndoManager `trackedOrigins`.** `collab.js:1040` lists `['local-publish', ySyncPluginKey]`; `'local-lint'` is deliberately absent so lint cache writes stay off the undo stack (lines 524-525). `'local-lint-ignored'` follows the same precedent — Ctrl+Z does NOT un-dismiss. Dismissal is meta on the linter view, not document content; users undo it via Reset in ⚙ Settings. Pinned by `collab-lint-ignored.test.js` regression assertion (writes with this origin do not appear on `undoManager.undoStack`).

### 3.3 Sidecar payload

`.lint.json` bumps v1 → v2. v2 is fully backward-compatible.

**Existing decoder behavior change required.** `lint-sidecar.js:199` currently does `if (payload.v !== PAYLOAD_VERSION) return { empty }` and `lint-sidecar.test.js:173` pins that contract (`v: 999` → empty). This must be loosened:

- `payload.v < 1` (missing / negative / non-number) → return empty.
- `payload.v >= 1` → decode known fields (`good`, `bad`, `ignoredFindings`, `mutedNlpRules`); silently drop unknown top-level keys.

The existing v1 test that asserts `v: 999` → empty must be rewritten to assert `v: 999` decodes known fields as v2 does (forward-compat). Without this loosening, the same v2 client/server fleet cannot read a future v3 payload — rollback would corrupt rooms whose sidecar advanced.

**Rollout order:** v2 decoder ships to frontend AND server-side `room-serializer.cjs` in the same release before the v2 encoder activates. v1 encoder shape stays the default when both new fields are empty (preserves existing tests' byte-stable round-trip).

```json
{
  "v": 2,
  "good": "...",
  "bad": { "<fp>": { "g": [...], "n": [...], "c": [...] } },
  "ignoredFindings": [
    {
      "ruleId": "TERM-suitable",
      "blockHash": "<24-char>",
      "match": "as suitable",
      "ts": 1716326400000,
      "authorId": "user-abc",
      "tombstone": false
    }
  ],
  "mutedNlpRules": [
    { "ruleId": "NLP-passive", "ts": 1716326400000, "authorId": "user-abc" }
  ]
}
```

Encoder emits v2 only when either new field is non-empty. Otherwise v1-shaped, preserving existing tests' byte-stable round-trip.

### 3.4 No new files outside tests

All non-test work lands in:

- `src/lib/linting.js` (verbs + selectors + state)
- `src/lib/lint-sidecar.js` (encode/decode v2)
- `src/lib/collab.js` (`readLintIgnored`, `publishLintIgnoredToDoc`)
- `src/hooks/useCollabSession.js` (observers, publish effects)
- `src/App.jsx` (callbacks + test seam)
- `src/components/InlineTooltip.jsx` (Dismiss + Mute buttons)
- `src/components/CompliancePanel.jsx` (group/item Dismiss buttons)
- `src/components/ComplianceSettings.jsx` (Reset section)
- `server/room-serializer.cjs` (extract Y.Maps → sidecar)

## 4. Components

### 4.1 New verbs in `linting.js` (all pure, all no-op on invalid)

| Verb | Behavior |
|---|---|
| `ignoreFinding(state, { ruleId, blockHash, match, identity, ts })` | Computes `computeIgnoreKey`. Adds `IgnoreEntry` to `ignored.findings`. No-op on duplicate. |
| `unignoreFinding(state, { ruleId, blockHash, match, ts })` | Writes `{...existing, tombstone: true, ts}`. No-op if key absent. |
| `applyRemoteIgnored(state, { key, entry })` | Per-key remote add or tombstone — overwrites local entry if remote `ts` is newer (LWW-by-timestamp; ties broken by `authorId` lexicographic order for determinism). |
| `mergeRemoteIgnored(state, remoteMap)` | Bulk variant for the `initial: true` `handleSync` payload. Walks `remoteMap` ∪ `state.ignored.findings`: remote-present → LWW per-key via `applyRemoteIgnored`; local-only with no `seenRemoteIds` mark → preserved (offline-dismissed entry, not yet published); local-only previously seen-remote → tombstone (peer deletion via never-delete discipline would still send a tombstone, so absence on initial sync implies local-only). Mirrors `comments.mergeRemote` pattern (`src/lib/comments.js:157`). Identical bulk merge `mergeRemoteMutedRules` for the `lintMutedNlp` map. |
| `resetIgnored(state, { ts })` | Tombstones all entries (preserves keys for collab convergence). Best-effort tombstone-all: if a peer publishes a new ignore concurrently with the reset transaction, that ignore lands AFTER the reset and is NOT retroactively cleared. Documented behavior. |
| `muteNlpRule(state, { ruleId, identity, ts })` | Adds `MuteEntry` if `ruleId.startsWith('NLP-')`. Silent no-op otherwise. |
| `unmuteNlpRule(state, { ruleId, ts })` | Writes tombstone. No-op on missing. |
| `applyRemoteMutedRule(state, { ruleId, entry })` | Per-rule remote update; LWW-by-timestamp with `authorId` tiebreak. |
| `prefillIgnored(state, { findings, mutedRules })` | **Merge** (NOT replace) sidecar payload into state. For each sidecar entry, LWW-by-timestamp against the existing in-memory entry (`applyRemoteIgnored` semantics per-key). Local-only entries with no sidecar match are preserved — covers the offline-dismiss + collab-join sequence (mirrors `comments.mergeRemote` rather than overwriting). Sidecar is authoritative for entries it contains; not for entries absent. |

### 4.2 New selectors

| Selector | Purpose |
|---|---|
| `computeIgnoreKey(ruleId, blockHash, match)` | Async exported helper (Web Crypto SHA-256). Not called from projection layer — `ignoreKey` is pre-computed by the engine pipeline and cached on each finding as `f.ignoreKey` (see §6.2). |
| `isFindingIgnored(state, ignoreKey)` | Sync; `state.ignored.findings.get(key)?.tombstone !== true` and entry exists. |
| `isNlpRuleMuted(state, ruleId)` | `state.ignored.mutedRules.get(ruleId)?.tombstone !== true` and entry exists. |
| `getIgnoredCount(state)` | Counts non-tombstoned findings + non-tombstoned muted rules. |

**`getRangesByTier(state)` signature.** Unchanged shape (`{ compliance: Range[], grammar: Range[], nlp: Range[] }`), but the implementation now iterates `state.byBlock.entries()` to access per-block `blockHash` and per-finding `violation.ruleId` + `f.ignoreKey`. Pipeline described in §4.3.

### 4.3 Filter sites

- `getRangesByTier(state)` becomes the single projection authority — it must iterate `(blockId, finding)` pairs (not just Range objects). Returns `{ compliance: Range[], grammar: Range[], nlp: Range[] }`. Pipeline per call:
  1. **Read cached findings + per-block `blockHash`** from `state.byBlock`.
  2. **Skip findings whose `f.ignoreKey === null`** (block-hash cache not yet populated — see §6.2). Engine emits a finding before its hash is computed; filtering is a no-op until the next debounce cycle.
  3. **Apply ignore + mute filters** via `isFindingIgnored(state, f.ignoreKey)` and `isNlpRuleMuted(state, ruleId)`.
  4. **Run `dedupNlpAgainstCompliance` and `dedupGrammarAgainstFindings` on the post-filter result** — cross-tier dedup moves from the engine layer (`useBlockLinting.js`) into the projection layer. Required for §6.6's "dismiss-static-surfaces-NLP" behavior: if dedup ran upstream in `byBlock`, the suppressed NLP finding would never reach the projection.
  5. **Push surviving Ranges into per-tier arrays.**
- `useBlockLinting.js` stops calling `dedupNlpAgainstCompliance` / `dedupGrammarAgainstFindings` before writing `byBlock`. The hook stores all engine output verbatim (plus `blockHash` + per-finding `ignoreKey`); projection alone enforces dedup + dismiss + mute.
- `compliance.js getFilteredGroups` — same ignore-filter; wrapped in `useMemo` at the `CompliancePanel` call site, keyed on `(complianceState, lintingState.ignored)`.
- **No engine-layer short-circuit.** All three engines always run and cache their findings in `byBlock`. Filtering AND dedup are uniform across tiers, exclusively at projection time. This ensures peer-published sidecar payloads reflect the full set of cached findings regardless of dismissal state, dedup decisions reflect the post-dismiss view, and un-mute does not produce stale `byBlock` entries.

### 4.4 New App test seam

Extend `window.__simEditorTestUtils` (`src/App.jsx`):

```js
getIgnoredKeys()                     // active (non-tombstoned) ignore-keys
isFindingIgnored(ruleId, blockHash, match)
dispatchLintIgnore(envelope)         // mirrors dispatchComment envelope pattern
```

Envelope shape (mirrors `dispatchComment`):

```js
{
  kind: 'ignore' | 'unignore' | 'mute-nlp' | 'unmute-nlp' | 'reset',
  ruleId?: string,                   // required for ignore/unignore/mute/unmute
  blockHash?: string,                // required for ignore/unignore
  match?: string,                    // required for ignore/unignore
  identity?: { id, name, color },    // optional override; defaults to effectiveIdentity()
  ts?: number,                       // optional override; defaults to Date.now()
}
```

Required for E2E tests; the existing seam exposes block html / PM selection but no linting state.

## 5. Data flow

### 5.1 Local dismiss (InlineTooltip)

```
User clicks Dismiss
  → onSuppress(ruleId, blockHash, match) callback to App
  → App reads blockHash from cached byBlock entry (sync; see §6.2)
  → App calls setLintingState(s => linting.ignoreFinding(s, { ruleId, blockHash, match, identity: effectiveIdentity(), ts: Date.now() }))
  → re-projection: getRangesByTier filters out the dismissed range
  → CSS.highlights drops the range
  → publish effect detects state.ignored.findings change
  → writes new entry to ydoc.getMap('lintIgnored') with origin 'local-lint-ignored'
  → handleAfterTx filters echo via 'local-' prefix
  → server flush writes sidecar v2
```

### 5.2 Local dismiss (CompliancePanel group)

```
User clicks "Dismiss all" on group
  → onSuppressGroup(group) → no confirmation (match Reject All precedent)
  → App computes { ruleId, blockHash, match } per instance
  → App calls setLintingState(s => instances.reduce((acc, v) =>
      linting.ignoreFinding(acc, { ...v, identity, ts }), s))  ← single state update
  → single publish effect run
```

### 5.3 Peer receives dismiss

**Steady-state path (per-key observer):**
```
ydoc.getMap('lintIgnored') observer fires per affected key
  → For each added/updated key: onLintIgnoredReceived(key, entry) callback to App
  → App calls setLintingState(s => linting.applyRemoteIgnored(s, { key, entry }))
  → projection re-runs
  → peer B's squiggle drops
```

**Initial-sync path (handleSync `initial: true`, fresh client joins existing room):**
```
useCollabSession sees meta.initial === true
  → reads full ydoc.getMap('lintIgnored') and ydoc.getMap('lintMutedNlp')
  → onLintIgnoredInitial({ ignoredMap, mutedMap }) callback to App
  → App calls setLintingState(s => linting.mergeRemoteIgnored(s, ignoredMap))
                          .then(s => linting.mergeRemoteMutedRules(s, mutedMap))
  → bulk merge preserves local offline-dismissed entries that haven't yet been published; LWW per-key for overlaps
```

### 5.4 Mute NLP rule (InlineTooltip on NLP finding)

```
User clicks "Mute NLP-passive"
  → window.confirm("Mute NLP-passive in this document?")  ← matches AI cost precedent
  → on accept: onMuteNlpRule(ruleId)
  → App calls setLintingState(s => linting.muteNlpRule(s, { ruleId, identity: effectiveIdentity(), ts: Date.now() }))
  → state.ignored.mutedRules updates → React re-render
  → getRangesByTier re-runs (selector input changed); all NLP findings with this ruleId filtered out
  → App's CSS.highlights effect (keyed on lintingState) replaces the nlp highlight set
  → all NLP-passive findings disappear from CSS.highlights immediately (engines themselves remain running — projection-only filter)
  → publish to ydoc.getMap('lintMutedNlp')
  → server flush writes sidecar v2
```

**Unmute path is symmetric** — the next debounce cycle's engine output already contains the suppressed findings (engines never stopped), so the very next `getRangesByTier` run (triggered by `state.ignored.mutedRules` tombstone write) re-includes them. No engine restart needed. Pinned by the E2E mute → unmute → flag-reappears assertion (§8.4 case 2).

### 5.5 Load-time prefill (.SEC import)

```
parseSEC → drag-drop reads sibling .lint.json
  → decodeSidecar(payload) v2-aware (loosened version-gate, §3.3)
  → projectDecoded fills byBlock (unchanged from #138)
  → App calls setLintingState(s => linting.prefillFromSidecar(s, projection))  (unchanged)
  → App calls setLintingState(s => linting.prefillIgnored(s, { findings, mutedRules }))
       ↑ MERGE semantics (LWW-by-timestamp per-key, NOT replace). Local entries absent from
         the sidecar are preserved — covers the file-mode dismiss-then-reload case where
         the in-memory state may have entries the sidecar lacks (e.g., entries from a
         later in-memory dismiss that hasn't yet been flushed).
  → render: getRangesByTier already filters via ignored state
```

### 5.6 Reset (ComplianceSettings modal)

```
User opens ⚙ Settings → Ignored findings section
  → Click "Reset ignored findings" → confirm dialog
  → App calls setLintingState(s => linting.resetIgnored(s, { ts: Date.now() }))  ← tombstones all entries
  → re-projection: all dismissed findings reappear
  → publish: each key gets a tombstone write to lintIgnored
  → peers' observers apply each tombstone
```

## 6. Error handling & edge cases

### 6.1 Load-boundary tolerance

`decodeSidecar` (`src/lib/lint-sidecar.js:195`) treats malformed v2 entries as silent drops, mirrors `comments.normalizeForLoad` (`src/lib/comments.js:318`). Returns empty arrays rather than throwing. v3+ payloads preserve known fields, drop unknowns.

### 6.2 Sync `blockHash` cache + per-finding `ignoreKey` cache

Two new fields are populated by `useBlockLinting.js`, both async at compute time, both sync at projection-read time:

```js
// BlockFindings (new field)
{ compliance, nlp, grammar, grammarText, blockHash: string | null }

// Finding (new field on each f)
{ range, violation, ignoreKey: string | null }
```

**Wiring (new in `useBlockLinting.js`):** After the three engines emit findings on each debounce cycle, the hook performs:

1. `const blockHash = await fingerprintBlock(blockHtml)` — single SHA-256 per block per debounce cycle.
2. For each finding, `f.ignoreKey = await computeIgnoreKey(violation.ruleId, blockHash, violation.match)` — one SHA-256 per finding. Computed in parallel via `Promise.all` mirroring `lint-sidecar.js`'s encode-time pattern (`:157-165`).
3. Write `byBlock[blockId] = { compliance, nlp, grammar, grammarText, blockHash, ...with each finding carrying its ignoreKey }`.

**`useBlockLinting.js` does not compute block fingerprints today;** the existing fingerprint code lives in `lint-sidecar.js`'s encode path. This is new wiring.

**Projection reads are sync.** `getRangesByTier` reads `bf.blockHash` and `f.ignoreKey` directly. It does NOT call `computeIgnoreKey` (Web Crypto is async). Two implications:

- **Null-`ignoreKey` skip.** During the async-hash compute window (typically <5ms after engines emit), findings exist in `byBlock` with `ignoreKey: null` (placeholder). Projection treats `f.ignoreKey === null` as "do not filter" — the finding renders unfiltered for one debounce cycle, then the next cycle's complete output overwrites it. Net effect: a dismissed finding may briefly re-flash for ~5ms after a block edit, before the new hash is computed. Acceptable; pinned by `blockhash-cache.test.js`.
- **No projection-layer SHA recompute.** `getRangesByTier` is guaranteed not to issue any `await` — `linting-ignored.test.js` includes a structural assertion (return value is not a Promise).

Cache invalidates when the block html mutates — the next engine run overwrites both `byBlock` findings and all `ignoreKey` values. Stale cache is a 250ms-debounce-plus-hash-compute window; acceptable.

### 6.3 Collab race scenarios

**Simultaneous same-key dismiss (peer A and B dismiss the same finding):**
- Both write to `ydoc.getMap('lintIgnored').set(key, entry)` with origin `'local-lint-ignored'`.
- Y.Map LWW by-clientId picks one entry; the other peer's observer sees the surviving entry.
- `applyRemoteIgnored` LWW-by-timestamp keeps the newer `ts` if both observers cross. Idempotent in steady state.

**Concurrent different-key dismisses:** Both keys land in `lintIgnored`. No race.

**Dismiss + unignore in quick succession on same peer:** First write sets entry; second write writes tombstone (same key, new `ts`). Peers see the tombstoned final state.

**Dismiss while peer B is editing the same block:** B's edits use `ySyncPlugin` origin, write to the block's html slot. Dismissal keyed by `blockHash` of pre-edit text. After B's edit, `blockHash` changes; the dismissal key no longer matches the finding's recomputed key — finding resurfaces. **Correct behavior** — dismissal was scoped to the specific text, which no longer exists.

**Unignore under network partition:** A unignores at T=0; A's local state has tombstone for the key. A publishes the tombstone. B comes online → observer fires, B's `applyRemoteIgnored` writes the tombstone locally. ✓

### 6.4 PM html byte-stability across undo

PM serialization is deterministic for byte-identical doc states. Ctrl+Z producing a byte-identical prior state restores the original `blockHash` and the dismissal resumes. But intermediate states (paste→backspace→retype paths) can produce semantically-equivalent-but-byte-different html (mark coalescing, whitespace normalization). The dismissal silently stops matching in those cases.

**Acceptable behavior** — undo is not expected to preserve dismissal beyond exact content scope. Documented limitation.

### 6.5 Storage backend failures

- File mode: `.lint.json` write best-effort (matches #138 PR #153 discipline). Logged, not surfaced. Regenerable.
- Collab mode: Y.Map writes are CRDT; flushed on next successful sync.
- Server crash mid-write does not corrupt the Y.Doc.

### 6.6 Cross-engine dedup interaction

When user dismisses a static finding that was suppressing an NLP overlap, the NLP finding **resurfaces**. Mechanism: cross-tier dedup runs in `getRangesByTier` AFTER ignore-filter (§4.3 pipeline steps 3 then 4). Sequence: (a) static finding filtered out by `isFindingIgnored`; (b) `dedupNlpAgainstCompliance` runs against the remaining (now empty-of-this-static) compliance set; (c) NLP finding has no overlap to lose to and survives. User can dismiss/mute the new NLP finding independently. No lineage tracking. Pinned by unit test in `linting-ignored.test.js` (§8.2).

### 6.7 Identity rotation (deferred)

`authorId` on the entry value (not the key) — ignore-key stays content-addressable so two users dismissing the same finding deduplicate. v1 of #140 does not surface "yours vs. team" in UI. Deferred to [#161](https://github.com/mttvnst-HA/secwriter/issues/161).

## 7. UI surfaces

### 7.1 InlineTooltip (`src/components/InlineTooltip.jsx`)

Add to existing button row:

- **`[Dismiss]`** — gray secondary button, every tier. `title="Dismiss this specific finding (use 'Add to dictionary' to allow the word everywhere)"`.
- **`[Mute NLP-passive]`** — NLP only. Confirmation via `window.confirm` (matches `CompliancePanel.jsx:148` precedent). Full rule ID; only two NLP rules so length is bounded.

Click handler dispatches via `onSuppress` / `onMuteNlpRule` props from App. The existing `onDismiss` prop (which means "close tooltip") stays unchanged; the rename to `onSuppress` for the new action is intentional to avoid collision.

### 7.2 CompliancePanel (`src/components/CompliancePanel.jsx`)

Group header row:

```
[Accept All N] [Reject All] [Dismiss all] [View All N ▸]
                            ↑ NEW, gray, no confirm (match Reject All precedent)
```

Individual instance row:

```
[✓ Accept] [✗ Reject] [Dismiss]
                      ↑ NEW, gray, plain text, no icon (visually distinct from Reject)
```

`title` attrs clarify scope: "Persistent — survives reload" on Dismiss; existing semantics on Accept/Reject.

### 7.3 ComplianceSettings (`src/components/ComplianceSettings.jsx`)

New section, modeled on existing "Clear Key" pattern (`:155-167`):

```
[Ignored findings] ────────────────────
N findings dismissed across this document.
[Reset ignored findings]   ← disabled when N=0

[Muted rules]   ────────────────────
M rules muted in this document.
[Reset muted rules]        ← disabled when M=0
```

### 7.4 Onboarding

`localStorage` flag `sim-dismiss-onboarded`. First-time inline tooltip pop-down on Dismiss button only (panel surfaces piggyback on existing `sim-compliance-onboarded`):

> "Persistent — survives reload. Reset from ⚙ Settings."

Cleanup in `tests/e2e/global-setup.js` so it doesn't persist across runs.

### 7.5 Explicit non-additions

- No badge/counter near toggle button.
- No "ignored findings" review pane (reset is the recovery path).
- No keyboard shortcut.
- No undo toast (no infra exists).
- No ARIA improvements (matches existing tooltip a11y; filed as known debt, not regressed).

## 8. Testing strategy

### 8.1 File splits (CLAUDE.md item 3 — ≤30 tests/file)

`linting.test.js` (46) and `lint-sidecar.test.js` (25) are already at/near cap. New tests land in new files:

- `src/lib/__tests__/linting-ignored.test.js` (new, ≤20 tests)
- `src/lib/__tests__/lint-sidecar-ignored-encode.test.js` (new, ≤15)
- `src/lib/__tests__/lint-sidecar-ignored-decode.test.js` (new, ≤15 — includes adversarial / forward-compat / v1-still-decodes)
- `src/lib/__tests__/collab-lint-ignored.test.js` (new, ≤15)
- `src/lib/__tests__/blockhash-cache.test.js` (new, ≤10)

### 8.2 Unit tests

**`linting-ignored.test.js`:**
- Verbs: add, tombstone, reset, mute, prefill, mergeRemoteIgnored, projection-filter integration.
- `muteNlpRule` no-ops on non-`NLP-*`.
- `prefillIgnored` merge (NOT replace) semantics: local-only entries preserved when sidecar payload lacks them; sidecar wins per-key when timestamps agree on LWW.
- `mergeRemoteIgnored` bulk-merge: local offline-dismissed entries survive `initial: true` payload from a room that doesn't know about them.
- `getRangesByTier` structural assertion: return value is NOT a Promise (covers Fix 8 sync-projection invariant).
- `getRangesByTier` null-`ignoreKey` skip: findings with `f.ignoreKey === null` are NOT filtered (async cache not yet populated). Pinned per §6.2.
- Property tests via hand-rolled `makeRng(seed)` pattern (`linting.test.js:381-390`). 200 randomized verb sequences. Invariants: replaying any event sequence yields same state (commutativity); no duplicate keys; tombstones never resurrect without explicit `ignoreFinding`; `mergeRemoteIgnored` is idempotent under repeated application of the same remoteMap.
- Cross-engine dedup pin: dismiss static finding overlapping NLP → after the next projection, NLP appears in the output (pins decision §6.6; tests the post-filter dedup ordering in `getRangesByTier`).

**`lint-sidecar-ignored-encode.test.js`:**
- `computeIgnoreKey` deterministic.
- Pre-hash JSON string differs for pipe-edge inputs (tests JSON encoding, not SHA-256).
- `encodeSidecar` v1-shape when ignores empty (byte-stable round-trip preserved).
- `encodeSidecar` v2-shape when ignoredFindings or mutedNlpRules non-empty.
- Arrays sorted for deterministic encoding (byte-stable across runs).
- Tombstones preserved through encode → decode → encode.

**`lint-sidecar-ignored-decode.test.js`:**
- `decodeSidecar(v1)` returns empty `ignoredFindings` + `mutedNlpRules`.
- `decodeSidecar(v2)` round-trips known fields.
- `decodeSidecar(v3+ future shape)` preserves v1+v2 fields it understands; drops unknown top-level keys. Replaces the existing `lint-sidecar.test.js:170-189` strict-version test.
- `decodeSidecar(v2 with malformed entry)` filters silently (load-boundary tolerance, §6.1).
- Adversarial: oversized arrays; nested objects in `match` field; non-string `ruleId`; floats in `ts`.
- Pipe-edge inputs in `match` field don't collide with other findings (JSON encoding regression test).

**`collab-lint-ignored.test.js`:**
- Round-trip per-key.
- Tombstone preserves key.
- Echo no-op for origin `'local-lint-ignored'`.
- Concurrent same-key + different-key writes converge.

**`blockhash-cache.test.js`:**
- Cache populated on engine run.
- `isFindingIgnored` returns synchronously (assertion: not a Promise).
- Cache invalidates on html mutation.

### 8.3 Server tests

`server/__tests__/room-serializer.test.mjs` extend:
- `yLintIgnored` → sidecar v2 round-trip; tombstones preserved in JSON.
- Empty Y.Maps → v1-shaped sidecar.

`server/__tests__/storage-contract.test.mjs`: one new assertion inside `for (const {name, factory} of BACKENDS)` (auto-propagates to 3 tests).

### 8.4 E2E tests (Playwright, `--project=chromium`)

`tests/e2e/editor.spec.js`:
1. Dismiss → reload → still dismissed.
2. Mute NLP rule → engines still run, confirmed via behavioral indirect assertion (unmute → flag reappears within one debounce cycle). Confirm dialog mocked via `page.on('dialog', d => d.accept())`.
3. Reset from Settings: dismiss 3, mute 1; open Settings; click both reset buttons; verify reset buttons disabled afterward.

`tests/e2e/collab.spec.js`:
4. Two-tab dismiss sync, including tombstone reset path. Mirror PR #157's "lint sidecar: Peer A publishes" test pattern. `{ timeout: 60000 }` per CLAUDE.md item 10 flake mitigation.

### 8.5 Property + adversarial

- Property tests in `linting-ignored.test.js` (described in §8.2).
- Adversarial in `lint-sidecar-ignored.test.js`: malformed v2 payload variants (mixed valid+invalid, oversized arrays, nested objects in `match` field). Mirror the assertion shape at `lint-sidecar.test.js:170-189`.

### 8.6 Performance — no CI timing gate

Drop any throughput timing assertion (CI-flaky, no existing pattern). Replace with **structural assertion** in `linting-ignored.test.js`: `getRangesByTier` returns a non-Promise. Manual throughput measurement via `tools/bench-ignore-filter.mjs` if needed; not in CI.

### 8.7 Corpus regression pass

**New tool work required** — `tools/run-corpus-test.mjs` does not currently support `--with-ignores`. Scoped as part of Phase 8 (PR B), not assumed extant. The flag:

- Loads a fixture of "known FP" `ignoredFindings` entries from `corpus/fixtures/ignored-fixture.json` (new file, hand-curated from calibration corpus FPs).
- Plumbs the fixture through to the corpus runner so the rule engine output gets filtered by the projection layer before metrics are computed.
- Outputs comparison against the 0.31% calibration baseline.

Asserts: post-dismiss FP rate monotonically decreases below 0.31%. Output appended to `corpus/results/REPORT.md`. Load-bearing measurement for the feature's claim that dismissal reduces noise.

### 8.8 Not tested

- Identity rotation (deferred to #161).
- Per-author UI (out of scope).
- v1→v2 migration script (decoder handles in flight).
- CI throughput timing.

## 9. Acceptance criteria

Mapped from issue [#140](https://github.com/mttvnst-HA/secwriter/issues/140) AC, plus design additions:

- [ ] Dismiss affordance on `InlineTooltip` (single-finding dismiss).
- [ ] Dismiss affordance in `CompliancePanel` group menu (group-level dismiss).
- [ ] Dismiss affordance on `CompliancePanel` individual instance row.
- [ ] `ignoredFindings` field persisted in `.lint.json` v2.
- [ ] `mutedNlpRules` field persisted in `.lint.json` v2.
- [ ] Dismissed findings filtered out of inline highlights AND `CompliancePanel` projection.
- [ ] Muted NLP rules filtered identically (engines still run; uniform projection filter).
- [ ] Collab path syncs ignored set + muted rules; peers see same dismissals.
- [ ] "Reset ignored findings" affordance restores all dismissals.
- [ ] "Reset muted rules" affordance restores all mutes.
- [ ] Unit tests for the ignore-filter selectors (property test: dismissing then tombstoning is identity under reset).
- [ ] E2E test: dismiss → reload → still dismissed.
- [ ] E2E test: two-tab dismiss sync with tombstone reset.
- [ ] Corpus regression: post-dismiss FP rate < 0.31% baseline.
- [ ] No throughput regression in CI (structural assertion, not timing).

## 10. Implementation phases

The plan is for the writing-plans skill to decompose. Natural cut-points below; PR-grouping reflects that **phases 1-4 produce no user-visible behavior** and are not separately shippable per CLAUDE.md's "PR-shippable phases" discipline. They merge as a single bundle.

**PR A (internal foundation — merged together):**
1. **Reducer + sidecar v2 + tests.** Pure-code. Includes the loosened decoder version-gate (§3.3).
2. **`blockHash` + `ignoreKey` async cache wiring in `useBlockLinting.js` + projection filter integration.** Wires `getRangesByTier` to read cached keys; cross-tier dedup moves from engine to projection.
3. **Yjs substrate (`lintIgnored` / `lintMutedNlp`) + collab tests.** Per-key observers + bulk `mergeRemoteIgnored` on `initial: true` sync.
4. **Server-side serializer extraction + storage contract tests.** Closes the persistence loop.

**PR B (first user-visible — only mergeable after PR A):**
5. **UI: InlineTooltip Dismiss + Mute buttons.**
6. **UI: CompliancePanel group/item Dismiss + Settings reset section.**
7. **E2E tests + onboarding.**
8. **Corpus regression measurement** — requires new `--with-ignores` flag in `tools/run-corpus-test.mjs` (scoped here as work, not assumed extant; see §8.7).

## 11. Out of scope

- Owner-controlled dismissal policy (filed as [#161](https://github.com/mttvnst-HA/secwriter/issues/161)).
- AI-tier negative-constraint + post-filter (filed as [#141](https://github.com/mttvnst-HA/secwriter/issues/141), builds on this).
- Sentence-level dismissal granularity (forbidden by [ADR-0015](../../adr/0015-linting-stays-block-granular.md)).
- Identity rotation surfacing.
- Per-author UI ("yours vs. team").
- Undo toast / snackbar infrastructure.

## 12. Risks

- **Single-rule mass-dismissal anti-pattern.** A fatigued reviewer dismisses 40 NLP-passive flags in 5 minutes. All sync to peers. Mitigation: the issue [#161](https://github.com/mttvnst-HA/secwriter/issues/161) follow-up will add owner-controlled per-author propagation policy. v1 lives with the risk.
- **PM byte-stability across undo.** Documented limitation (§6.4). May surprise users who expect Ctrl+Z to "undo a dismiss."
- **Sidecar growth.** Each ignore adds ~120 bytes (key + JSON entry). 1000 ignored findings ≈ 120 KB. Acceptable; well within the 50 KB AC budget for typical specs (which have <100 dismissals).
