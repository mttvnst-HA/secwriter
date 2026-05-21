# Persistent rule ignores — design spec

**Issue:** [#140](https://github.com/mttvnst-HA/secwriter/issues/140) — `linting: persistent rule ignores (UI + reducer + sidecar)`
**Status:** Approved through 5 sections of brainstorming + 4 rounds of independent agent critique
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

**Echo origin:** all client writes use `'local-lint-ignored'`. Caught by `handleAfterTx`'s `'local-'` prefix filter at `src/lib/collab.js:944`; never re-enters `mergeRemoteIgnored`.

### 3.3 Sidecar payload

`.lint.json` bumps v1 → v2. v2 is fully backward-compatible: decoder accepts v1 (treats new fields as empty), forward-compat (v3+ payloads preserve v1+v2 fields they understand, follow the existing pattern at `src/lib/__tests__/lint-sidecar.test.js:170-189`).

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
| `resetIgnored(state, { ts })` | Tombstones all entries (preserves keys for collab convergence). |
| `muteNlpRule(state, { ruleId, identity, ts })` | Adds `MuteEntry` if `ruleId.startsWith('NLP-')`. Silent no-op otherwise. |
| `unmuteNlpRule(state, { ruleId, ts })` | Writes tombstone. No-op on missing. |
| `applyRemoteMutedRule(state, { ruleId, entry })` | Per-rule remote update; LWW-by-timestamp with `authorId` tiebreak. |
| `prefillIgnored(state, { findings, mutedRules })` | Replace local state with sidecar payload. Authoritative at load. |

### 4.2 New selectors

| Selector | Purpose |
|---|---|
| `computeIgnoreKey(ruleId, blockHash, match)` | Exported helper. Async-free at call site (Web Crypto's SHA-256 is async, so this is *pre-cached* — see §6.2). |
| `isFindingIgnored(state, ignoreKey)` | `state.ignored.findings.get(key)?.tombstone !== true` and entry exists. |
| `isNlpRuleMuted(state, ruleId)` | `state.ignored.mutedRules.get(ruleId)?.tombstone !== true` and entry exists. |
| `getIgnoredCount(state)` | Counts non-tombstoned findings + non-tombstoned muted rules. |

### 4.3 Filter sites

- `getRangesByTier(state)` filters via `isFindingIgnored` + `isNlpRuleMuted` before pushing each Range.
- `compliance.js getFilteredGroups` — same filter; wrapped in `useMemo` at the `CompliancePanel` call site, keyed on `(complianceState, lintingState.ignored)`.
- **No engine-layer short-circuit.** All three engines always run and cache their findings in `byBlock`. Filtering is uniform across tiers, exclusively at projection time. This ensures peer-published sidecar payloads reflect the full set of cached findings regardless of dismissal state, and un-mute does not produce stale `byBlock` entries.

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

```
ydoc.getMap('lintIgnored') observer fires per affected key
  → For each added/updated key: onLintIgnoredReceived(key, entry) callback to App
  → App calls setLintingState(s => linting.applyRemoteIgnored(s, { key, entry }))
  → projection re-runs
  → peer B's squiggle drops
```

### 5.4 Mute NLP rule (InlineTooltip on NLP finding)

```
User clicks "Mute NLP-passive"
  → window.confirm("Mute NLP-passive in this document?")  ← matches AI cost precedent
  → on accept: onMuteNlpRule(ruleId)
  → App calls setLintingState(s => linting.muteNlpRule(s, { ruleId, identity: effectiveIdentity(), ts: Date.now() }))
  → all NLP-passive findings disappear from CSS.highlights immediately
  → publish to ydoc.getMap('lintMutedNlp')
  → server flush writes sidecar v2
```

### 5.5 Load-time prefill (.SEC import)

```
parseSEC → drag-drop reads sibling .lint.json
  → decodeSidecar(payload) v2-aware
  → projectDecoded fills byBlock (unchanged from #138)
  → App calls setLintingState(s => linting.prefillFromSidecar(s, projection))  (unchanged)
  → App calls setLintingState(s => linting.prefillIgnored(s, { findings, mutedRules }))
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

### 6.2 Sync `blockHash` cache

Add field to `BlockFindings`:

```js
{ compliance, nlp, grammar, grammarText, blockHash: string | null }
```

Populated on each engine run. The existing `useBlockLinting.js` debounced cycle gains one new step: after the engines emit findings, the hook runs `await fingerprintBlock(blockHtml)` and stores the result alongside `grammarText`. **This is new wiring** — `useBlockLinting.js` does not compute block fingerprints today; the existing fingerprint code lives in `lint-sidecar.js`'s encode path. `getRangesByTier` reads `bf.blockHash` synchronously and composes `computeIgnoreKey` in-process via a sync SHA-256 path that takes the pre-computed `blockHash` as a parameter (no second async hash).

Cache invalidates when the block html mutates — the next engine run overwrites both `byBlock` findings and `blockHash`. Stale cache is a 250ms-debounce window; acceptable.

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

When user dismisses a static finding that was suppressing an NLP overlap, the NLP finding **resurfaces**. Dismissal does not change dedup logic; static is filtered, NLP re-emerges via `dedupNlpAgainstCompliance` (no static finding to overlap with). User can dismiss/mute the new NLP finding independently. No lineage tracking. Simpler model.

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

- `src/lib/__tests__/linting-ignored.test.js` (new, ≤15 tests)
- `src/lib/__tests__/lint-sidecar-ignored.test.js` (new, ≤10)
- `src/lib/__tests__/collab-lint-ignored.test.js` (new)
- `src/lib/__tests__/blockhash-cache.test.js` (new)

### 8.2 Unit tests

**`linting-ignored.test.js`:**
- Verbs: add, tombstone, reset, mute, prefill, projection-filter integration.
- `muteNlpRule` no-ops on non-`NLP-*`.
- Property tests via hand-rolled `makeRng(seed)` pattern (`linting.test.js:381-390`). 200 randomized verb sequences. Invariants: replaying any event sequence yields same state (commutativity); no duplicate keys; tombstones never resurrect without explicit `ignoreFinding`.
- Cross-engine dedup pin: dismiss static → NLP resurfaces (pins decision §6.6).

**`lint-sidecar-ignored.test.js`:**
- `computeIgnoreKey` deterministic.
- Pre-hash JSON string differs for pipe-edge inputs (tests JSON encoding, not SHA-256).
- `encodeSidecar` v1-shape when ignores empty; v2-shape when non-empty; arrays sorted.
- `decodeSidecar(v1)` returns empty new fields.
- `decodeSidecar(v2 with malformed)` filters silently.
- `decodeSidecar(v3+)` preserves v1+v2 fields it understands.

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

`npm run test:corpus -- --with-ignores`: load calibration corpus + fixture of "known FP" ignores; assert post-dismiss FP rate monotonically decreases below the 0.31% calibration baseline. Output appended to `corpus/results/REPORT.md`. Load-bearing measurement for the feature's claim that dismissal reduces noise.

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

The plan is for the writing-plans skill to decompose, but the natural cut-points are:

1. **Reducer + sidecar v2 + tests.** Pure-code; lands a green build with no UI.
2. **`blockHash` sync cache + filter integration.** Wires the projection path; existing UI still has no dismiss buttons but the underlying state honors them.
3. **Yjs substrate (`lintIgnored` / `lintMutedNlp`) + collab tests.** Establishes the peer-sync wire.
4. **Server-side serializer extraction + storage contract tests.** Closes the persistence loop.
5. **UI: InlineTooltip Dismiss + Mute buttons.**
6. **UI: CompliancePanel group/item Dismiss + Settings reset section.**
7. **E2E tests + onboarding.**
8. **Corpus regression measurement.**

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
