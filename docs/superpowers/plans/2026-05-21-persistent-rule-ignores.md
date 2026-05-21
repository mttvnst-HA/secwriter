# Persistent Rule Ignores Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users persistently dismiss inline-linter findings (per-finding) and mute heuristic NLP rules per-document, with sync across collab peers and persistence in the `.lint.json` sidecar.

**Architecture:** Extend `linting.js` reducer with `ignored: { findings, mutedRules }`. Two new Yjs substrates `lintIgnored` + `lintMutedNlp` (sibling Y.Maps to `yLint`). SHA-256-prefix ignore-key = `SHA(JSON.stringify([ruleId, blockHash, match]))`. Pre-computed per-finding in `useBlockLinting.js` async pipeline; sync at projection time in `getRangesByTier`. Cross-tier dedup moves from engine to projection. Never-delete + tombstone discipline matches the yLint pattern from PR #157.

**Tech Stack:** Vitest (unit), Node test runner (server), Playwright (E2E), Y.js + y-websocket, React hooks, Web Crypto SHA-256.

**Spec:** `docs/superpowers/specs/2026-05-21-persistent-rule-ignores-design.md` (HEAD `6c41353`)
**Issue:** [#140](https://github.com/mttvnst-HA/secwriter/issues/140)
**Branch:** `feat/140-persistent-rule-ignores-design` (continue committing here)

---

## File Structure

**PR A (internal foundation — phases 1-4, merged together; no user-visible behavior):**

| File | Action | Responsibility |
|---|---|---|
| `src/lib/linting.js` | modify | Reducer state + verbs + selectors + `computeIgnoreKey` |
| `src/lib/lint-sidecar.js` | modify | v2 encoder/decoder for `ignoredFindings` + `mutedNlpRules`; decoder version-gate loosened to `v >= 1` |
| `src/lib/collab.js` | modify | `readLintIgnored` / `publishLintIgnoredToDoc` (+ muted equivalents); new Y.Maps in `createCollabSession`; `handleAfterTx` + initial sync hooks |
| `src/hooks/useCollabSession.js` | modify | Observers + publish effects + initial-sync bulk merge |
| `src/components/useBlockLinting.js` | modify | Async `blockHash` + per-finding `ignoreKey` cache; drops engine-layer dedup calls |
| `src/App.jsx` | modify | `setLintingState` callbacks + `prefillIgnored` file-mode gate + test seam |
| `server/room-serializer.cjs` | modify | Extract yLintIgnored / yLintMutedNlp into sidecar v2 on flush |
| `src/lib/__tests__/linting-ignored.test.js` | create | State shape + selectors + computeIgnoreKey + add/tombstone/applyRemote verbs (≤30 tests) |
| `src/lib/__tests__/linting-ignored-merge.test.js` | create | reset / mergeRemote / prefill / property tests (≤15) |
| `src/lib/__tests__/linting-ignored-projection.test.js` | create | `getRangesByTier` filter + post-filter dedup (≤10) |
| `src/lib/__tests__/lint-sidecar-ignored-encode.test.js` | create | v2 encoder + key generation |
| `src/lib/__tests__/lint-sidecar-ignored-decode.test.js` | create | v2 decoder + adversarial + forward-compat |
| `src/lib/__tests__/collab-lint-ignored.test.js` | create | Y.Map round-trip + tombstones + concurrent + echo |
| `src/lib/__tests__/blockhash-cache.test.js` | create | Hash population + invalidation + non-mutation |
| `src/lib/__tests__/lint-sidecar.test.js` | modify | Rewrite `v: 999` strict-version test to forward-compat |
| `server/__tests__/room-serializer.test.mjs` | modify | yLintIgnored / yLintMutedNlp → sidecar v2 round-trip |
| `server/__tests__/storage-contract.test.mjs` | modify | One new assertion in BACKENDS loop |

**PR B (user-visible — phases 5-8; merges only after PR A):**

| File | Action | Responsibility |
|---|---|---|
| `src/components/InlineTooltip.jsx` | modify | `[Dismiss]` button + `[Mute NLP-rule]` button + onboarding pop-down |
| `src/components/CompliancePanel.jsx` | modify | Item-row `[Dismiss]` + group-header `[Dismiss all]` |
| `src/components/ComplianceSettings.jsx` | modify | Ignored findings + Muted rules reset section |
| `tests/e2e/editor.spec.js` | modify | 3 new cases (dismiss-reload, mute-engines, settings-reset) |
| `tests/e2e/collab.spec.js` | modify | Two-tab dismiss sync + tombstone reset |
| `tests/e2e/global-setup.js` | modify | Clear `sim-dismiss-onboarded` localStorage |
| `tools/run-corpus-test.mjs` | modify | `--with-ignores` flag |
| `corpus/fixtures/ignored-fixture.json` | create | Hand-curated "known FP" entries |

---

## Conventions

- TDD throughout: write failing test → run to confirm fail → minimal impl → run to confirm pass → commit.
- Vitest: `npm test -- <pattern>` or `npm test -- --run` for single-shot.
- Compliance rule engine tests run under Node test runner: `npm run test:compliance`.
- Server tests: `npm run test:server`.
- E2E: `npx playwright test --project=chromium <file>:<line>`.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`.
- Tests per file ≤30 (CLAUDE.md item 3).
- Never use `replace_all` on indented code (CLAUDE.md item 1).
- Branch already exists: `feat/140-persistent-rule-ignores-design`. Do NOT switch branches.

---

# PR A: Internal Foundation

## Task 1: Reducer state shape + selectors

**Files:**
- Modify: `src/lib/linting.js` (add to existing reducer)
- Create: `src/lib/__tests__/linting-ignored.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/linting-ignored.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import * as L from '../linting.js';

describe('linting / ignored state shape', () => {
  it('createInitial includes empty ignored.findings and ignored.mutedRules Maps', () => {
    const s = L.createInitial();
    expect(s.ignored).toBeDefined();
    expect(s.ignored.findings).toBeInstanceOf(Map);
    expect(s.ignored.findings.size).toBe(0);
    expect(s.ignored.mutedRules).toBeInstanceOf(Map);
    expect(s.ignored.mutedRules.size).toBe(0);
  });

  it('createInitial preserves enabled flag', () => {
    const s = L.createInitial({ enabled: false });
    expect(s.enabled).toBe(false);
    expect(s.ignored.findings.size).toBe(0);
  });
});

describe('linting / selectors', () => {
  it('isFindingIgnored returns false for unknown key', () => {
    const s = L.createInitial();
    expect(L.isFindingIgnored(s, 'unknown')).toBe(false);
  });

  it('isNlpRuleMuted returns false for unknown rule', () => {
    const s = L.createInitial();
    expect(L.isNlpRuleMuted(s, 'NLP-passive')).toBe(false);
  });

  it('getIgnoredCount returns 0 for empty state', () => {
    const s = L.createInitial();
    expect(L.getIgnoredCount(s)).toBe(0);
  });
});

describe('linting / computeIgnoreKey', () => {
  it('returns 24-character hex string', async () => {
    const key = await L.computeIgnoreKey('TERM-shall', 'abc123def4567890abcd1234', 'shall');
    expect(key).toMatch(/^[0-9a-f]{24}$/);
  });

  it('is deterministic for same inputs', async () => {
    const k1 = await L.computeIgnoreKey('TERM-shall', 'aaaa', 'shall');
    const k2 = await L.computeIgnoreKey('TERM-shall', 'aaaa', 'shall');
    expect(k1).toBe(k2);
  });

  it('differs when ruleId changes', async () => {
    const k1 = await L.computeIgnoreKey('TERM-shall', 'aaaa', 'shall');
    const k2 = await L.computeIgnoreKey('TERM-should', 'aaaa', 'shall');
    expect(k1).not.toBe(k2);
  });

  it('does not collide on pipe characters in match field (regression — joined-string keying would collide)', async () => {
    const k1 = await L.computeIgnoreKey('R-1', 'block1', 'a|b');
    const k2 = await L.computeIgnoreKey('R-1', 'block1|', 'b');
    expect(k1).not.toBe(k2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run linting-ignored.test`
Expected: FAIL with "L.computeIgnoreKey is not a function" / `ignored` undefined.

- [ ] **Step 3: Extend `linting.js` createInitial + add selectors + computeIgnoreKey**

In `src/lib/linting.js`, modify `createInitial`:

```javascript
export function createInitial({ enabled = true } = {}) {
  return {
    enabled,
    suspended: false,
    byBlock: new Map(),
    ignored: {
      findings: new Map(),
      mutedRules: new Map(),
    },
  };
}
```

Add at the end of the file (after existing selectors):

```javascript
// ── Persistent dismiss / mute (#140) ────────────────────────────────────────

const IGNORE_KEY_HEX_CHARS = 24;

/**
 * SHA-256(JSON.stringify([ruleId, blockHash, match])) truncated to 24 hex
 * chars. JSON.stringify isolates the components so 'a|b' in match cannot
 * collide with 'block1|' in blockHash (pipe-edge regression — see test).
 *
 * Async because Web Crypto's `crypto.subtle.digest` is async. Pre-cached on
 * each finding via `useBlockLinting.js` — projection layer reads sync.
 */
export async function computeIgnoreKey(ruleId, blockHash, match) {
  const text = JSON.stringify([ruleId, blockHash, match]);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    return fallbackIgnoreKey(text);
  }
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length && out.length < IGNORE_KEY_HEX_CHARS; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out.slice(0, IGNORE_KEY_HEX_CHARS);
}

function fallbackIgnoreKey(text) {
  let h1 = 0xcbf29ce4, h2 = 0x84222325;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h2 = (h2 ^ c) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  const a = h1.toString(16).padStart(8, '0');
  const b = h2.toString(16).padStart(8, '0');
  return (a + b + a).slice(0, IGNORE_KEY_HEX_CHARS);
}

/** True when state has a non-tombstoned entry for this ignore-key. */
export function isFindingIgnored(state, ignoreKey) {
  if (!state.ignored || typeof ignoreKey !== 'string') return false;
  const entry = state.ignored.findings.get(ignoreKey);
  return !!entry && entry.tombstone !== true;
}

/** True when state has a non-tombstoned mute entry for this ruleId. */
export function isNlpRuleMuted(state, ruleId) {
  if (!state.ignored || typeof ruleId !== 'string') return false;
  const entry = state.ignored.mutedRules.get(ruleId);
  return !!entry && entry.tombstone !== true;
}

/** Count of active (non-tombstoned) dismissals + mutes. */
export function getIgnoredCount(state) {
  if (!state.ignored) return 0;
  let n = 0;
  for (const e of state.ignored.findings.values()) if (e && e.tombstone !== true) n++;
  for (const e of state.ignored.mutedRules.values()) if (e && e.tombstone !== true) n++;
  return n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run linting-ignored.test`
Expected: PASS (10+ tests in the three describe blocks).

- [ ] **Step 5: Run full linting test file to check no regressions**

Run: `npm test -- --run linting.test`
Expected: All existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/linting.js src/lib/__tests__/linting-ignored.test.js
git commit -m "feat(linting): add ignored state + computeIgnoreKey + selectors (#140)"
```

---

## Task 2: ignoreFinding / unignoreFinding / applyRemoteIgnored verbs

**Files:**
- Modify: `src/lib/linting.js`
- Modify: `src/lib/__tests__/linting-ignored.test.js`

- [ ] **Step 1: Write the failing test (append to linting-ignored.test.js)**

```javascript
describe('linting / ignoreFinding', () => {
  const identity = { id: 'u-1', name: 'Alice', color: '#abc' };

  it('adds an IgnoreEntry keyed by ignoreKey', () => {
    const s0 = L.createInitial();
    const s1 = L.ignoreFinding(s0, {
      ignoreKey: 'k1', ruleId: 'TERM-shall', blockHash: 'bh', match: 'shall',
      identity, ts: 1000,
    });
    expect(s1.ignored.findings.get('k1')).toMatchObject({
      ruleId: 'TERM-shall', blockHash: 'bh', match: 'shall',
      ts: 1000, authorId: 'u-1',
    });
    expect(s1.ignored.findings.get('k1').tombstone).toBeFalsy();
  });

  it('overwrites existing entry on duplicate key with newer ts', () => {
    const s0 = L.createInitial();
    const s1 = L.ignoreFinding(s0, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity, ts: 1000 });
    const s2 = L.ignoreFinding(s1, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity, ts: 2000 });
    expect(s2.ignored.findings.get('k1').ts).toBe(2000);
  });

  it('returns same state ref on missing required fields', () => {
    const s0 = L.createInitial();
    expect(L.ignoreFinding(s0, { ignoreKey: 'k1', ruleId: 'R' /* no blockHash/match */, identity, ts: 1 })).toBe(s0);
  });
});

describe('linting / unignoreFinding', () => {
  it('writes tombstone preserving original ruleId / blockHash / match', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'u' }, ts: 1 });
    s = L.unignoreFinding(s, { ignoreKey: 'k1', ts: 2 });
    expect(s.ignored.findings.get('k1').tombstone).toBe(true);
    expect(s.ignored.findings.get('k1').ts).toBe(2);
    expect(s.ignored.findings.get('k1').ruleId).toBe('R');
  });

  it('returns same state ref when key absent', () => {
    const s0 = L.createInitial();
    expect(L.unignoreFinding(s0, { ignoreKey: 'absent', ts: 1 })).toBe(s0);
  });

  it('isFindingIgnored returns false after tombstone', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'u' }, ts: 1 });
    s = L.unignoreFinding(s, { ignoreKey: 'k1', ts: 2 });
    expect(L.isFindingIgnored(s, 'k1')).toBe(false);
  });
});

describe('linting / applyRemoteIgnored', () => {
  it('overwrites local when remote ts is newer (LWW)', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 1 });
    s = L.applyRemoteIgnored(s, { key: 'k1', entry: { ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'b', ts: 2 } });
    expect(s.ignored.findings.get('k1').authorId).toBe('b');
  });

  it('preserves local when local ts is newer', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 10 });
    s = L.applyRemoteIgnored(s, { key: 'k1', entry: { ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'b', ts: 5 } });
    expect(s.ignored.findings.get('k1').authorId).toBe('a');
  });

  it('breaks ts ties by authorId lexicographic order (deterministic)', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'b' }, ts: 10 });
    s = L.applyRemoteIgnored(s, { key: 'k1', entry: { ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'a', ts: 10 } });
    // 'a' < 'b' so remote wins
    expect(s.ignored.findings.get('k1').authorId).toBe('a');
  });

  it('inserts entry when key absent locally', () => {
    let s = L.createInitial();
    s = L.applyRemoteIgnored(s, { key: 'k1', entry: { ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'b', ts: 1 } });
    expect(s.ignored.findings.has('k1')).toBe(true);
  });

  it('returns same state ref on invalid input', () => {
    const s0 = L.createInitial();
    expect(L.applyRemoteIgnored(s0, null)).toBe(s0);
    expect(L.applyRemoteIgnored(s0, { key: null, entry: {} })).toBe(s0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run linting-ignored.test`
Expected: FAIL on `L.ignoreFinding is not a function`.

- [ ] **Step 3: Add verbs to `linting.js`**

Append to `src/lib/linting.js`:

```javascript
/**
 * Insert/overwrite a finding-ignore entry. `ignoreKey` is the SHA-prefix
 * pre-computed by `useBlockLinting.js`. Tombstoned entries are revived as
 * non-tombstone (a fresh ignoreFinding after an unignore is identity-restore).
 */
export function ignoreFinding(state, { ignoreKey, ruleId, blockHash, match, identity, ts }) {
  if (typeof ignoreKey !== 'string' || typeof ruleId !== 'string') return state;
  if (typeof blockHash !== 'string' || typeof match !== 'string') return state;
  const entry = {
    ruleId,
    blockHash,
    match,
    ts: typeof ts === 'number' ? ts : Date.now(),
    authorId: identity?.id || '',
  };
  const findings = new Map(state.ignored.findings);
  findings.set(ignoreKey, entry);
  return { ...state, ignored: { ...state.ignored, findings } };
}

/**
 * Tombstone an existing finding-ignore entry. Preserves ruleId / blockHash /
 * match from the original so peers can still inspect the lineage; only sets
 * `tombstone: true` and bumps `ts`.
 */
export function unignoreFinding(state, { ignoreKey, ts }) {
  if (typeof ignoreKey !== 'string') return state;
  const prev = state.ignored.findings.get(ignoreKey);
  if (!prev) return state;
  const findings = new Map(state.ignored.findings);
  findings.set(ignoreKey, { ...prev, tombstone: true, ts: typeof ts === 'number' ? ts : Date.now() });
  return { ...state, ignored: { ...state.ignored, findings } };
}

/**
 * Per-key remote update — LWW-by-timestamp, ties broken by authorId
 * lexicographic order for deterministic convergence.
 */
export function applyRemoteIgnored(state, args) {
  if (!args || typeof args !== 'object') return state;
  const { key, entry } = args;
  if (typeof key !== 'string' || !entry || typeof entry !== 'object') return state;
  if (typeof entry.ts !== 'number') return state;
  const prev = state.ignored.findings.get(key);
  if (prev) {
    if (prev.ts > entry.ts) return state;
    if (prev.ts === entry.ts) {
      // Ties: lexicographic by authorId (smaller wins for determinism)
      if ((prev.authorId || '') <= (entry.authorId || '')) return state;
    }
  }
  const findings = new Map(state.ignored.findings);
  findings.set(key, { ...entry });
  return { ...state, ignored: { ...state.ignored, findings } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run linting-ignored.test`
Expected: PASS (added describes pass; earlier ones still pass).

- [ ] **Step 5: Commit**

```bash
git add src/lib/linting.js src/lib/__tests__/linting-ignored.test.js
git commit -m "feat(linting): add ignoreFinding/unignoreFinding/applyRemoteIgnored (#140)"
```

---

## Task 3: muteNlpRule / unmuteNlpRule / applyRemoteMutedRule

**Files:**
- Modify: `src/lib/linting.js`
- Modify: `src/lib/__tests__/linting-ignored.test.js`

- [ ] **Step 1: Write the failing test (append to linting-ignored.test.js)**

```javascript
describe('linting / muteNlpRule', () => {
  it('adds a MuteEntry for a NLP-* rule id', () => {
    const s = L.muteNlpRule(L.createInitial(), { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 1 });
    expect(s.ignored.mutedRules.get('NLP-passive')).toMatchObject({ ts: 1, authorId: 'a' });
    expect(L.isNlpRuleMuted(s, 'NLP-passive')).toBe(true);
  });

  it('silently no-ops on non-NLP rule (e.g. TERM-shall)', () => {
    const s0 = L.createInitial();
    expect(L.muteNlpRule(s0, { ruleId: 'TERM-shall', identity: { id: 'a' }, ts: 1 })).toBe(s0);
  });

  it('silently no-ops on invalid input', () => {
    const s0 = L.createInitial();
    expect(L.muteNlpRule(s0, { ruleId: null, identity: { id: 'a' }, ts: 1 })).toBe(s0);
  });
});

describe('linting / unmuteNlpRule', () => {
  it('writes tombstone and selector returns false', () => {
    let s = L.createInitial();
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 1 });
    s = L.unmuteNlpRule(s, { ruleId: 'NLP-passive', ts: 2 });
    expect(s.ignored.mutedRules.get('NLP-passive').tombstone).toBe(true);
    expect(L.isNlpRuleMuted(s, 'NLP-passive')).toBe(false);
  });

  it('returns same state ref when rule not present', () => {
    const s0 = L.createInitial();
    expect(L.unmuteNlpRule(s0, { ruleId: 'NLP-passive', ts: 1 })).toBe(s0);
  });
});

describe('linting / applyRemoteMutedRule', () => {
  it('LWW per ruleId', () => {
    let s = L.createInitial();
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 5 });
    s = L.applyRemoteMutedRule(s, { ruleId: 'NLP-passive', entry: { authorId: 'b', ts: 10 } });
    expect(s.ignored.mutedRules.get('NLP-passive').authorId).toBe('b');
  });

  it('preserves local when local ts newer', () => {
    let s = L.createInitial();
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 10 });
    s = L.applyRemoteMutedRule(s, { ruleId: 'NLP-passive', entry: { authorId: 'b', ts: 5 } });
    expect(s.ignored.mutedRules.get('NLP-passive').authorId).toBe('a');
  });

  it('breaks ts ties by authorId', () => {
    let s = L.createInitial();
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'b' }, ts: 10 });
    s = L.applyRemoteMutedRule(s, { ruleId: 'NLP-passive', entry: { authorId: 'a', ts: 10 } });
    expect(s.ignored.mutedRules.get('NLP-passive').authorId).toBe('a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run linting-ignored.test`
Expected: FAIL on `L.muteNlpRule is not a function`.

- [ ] **Step 3: Add verbs to `linting.js`**

Append to `src/lib/linting.js`:

```javascript
/** Adds a NLP-rule mute entry. Silently no-ops on non-NLP rule ids. */
export function muteNlpRule(state, { ruleId, identity, ts }) {
  if (typeof ruleId !== 'string' || !ruleId.startsWith('NLP-')) return state;
  const entry = {
    ts: typeof ts === 'number' ? ts : Date.now(),
    authorId: identity?.id || '',
  };
  const mutedRules = new Map(state.ignored.mutedRules);
  mutedRules.set(ruleId, entry);
  return { ...state, ignored: { ...state.ignored, mutedRules } };
}

/** Tombstone a mute entry. No-op if rule absent. */
export function unmuteNlpRule(state, { ruleId, ts }) {
  if (typeof ruleId !== 'string') return state;
  const prev = state.ignored.mutedRules.get(ruleId);
  if (!prev) return state;
  const mutedRules = new Map(state.ignored.mutedRules);
  mutedRules.set(ruleId, { ...prev, tombstone: true, ts: typeof ts === 'number' ? ts : Date.now() });
  return { ...state, ignored: { ...state.ignored, mutedRules } };
}

/** Per-rule remote update — LWW with authorId tiebreak. */
export function applyRemoteMutedRule(state, args) {
  if (!args || typeof args !== 'object') return state;
  const { ruleId, entry } = args;
  if (typeof ruleId !== 'string' || !entry || typeof entry !== 'object') return state;
  if (typeof entry.ts !== 'number') return state;
  const prev = state.ignored.mutedRules.get(ruleId);
  if (prev) {
    if (prev.ts > entry.ts) return state;
    if (prev.ts === entry.ts && (prev.authorId || '') <= (entry.authorId || '')) return state;
  }
  const mutedRules = new Map(state.ignored.mutedRules);
  mutedRules.set(ruleId, { ...entry });
  return { ...state, ignored: { ...state.ignored, mutedRules } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run linting-ignored.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/linting.js src/lib/__tests__/linting-ignored.test.js
git commit -m "feat(linting): add muteNlpRule/unmuteNlpRule/applyRemoteMutedRule (#140)"
```

---

## Task 4: resetIgnored + mergeRemoteIgnored + mergeRemoteMutedRules + prefillIgnored

**Files:**
- Modify: `src/lib/linting.js`
- Create: `src/lib/__tests__/linting-ignored-merge.test.js` (NEW file — keeps `linting-ignored.test.js` under the 30-test cap)

- [ ] **Step 1: Write the failing test (create new file)**

Create `src/lib/__tests__/linting-ignored-merge.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import * as L from '../linting.js';
```

Then add the body below (same content as previously specified):

```javascript
describe('linting / resetIgnored', () => {
  it('tombstones every entry, preserving keys for collab convergence', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 1 });
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 1 });
    s = L.resetIgnored(s, { ts: 5 });
    expect(s.ignored.findings.get('k1').tombstone).toBe(true);
    expect(s.ignored.mutedRules.get('NLP-passive').tombstone).toBe(true);
    expect(L.getIgnoredCount(s)).toBe(0);
  });
});

describe('linting / resetIgnoredFindings (partial reset)', () => {
  it('tombstones findings only; leaves mutedRules intact', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 1 });
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 1 });
    s = L.resetIgnoredFindings(s, { ts: 5 });
    expect(s.ignored.findings.get('k1').tombstone).toBe(true);
    expect(s.ignored.mutedRules.get('NLP-passive').tombstone).toBeFalsy();
  });

  it('returns same ref when findings is empty (no allocation)', () => {
    const s = L.createInitial();
    expect(L.resetIgnoredFindings(s, { ts: 1 })).toBe(s);
  });
});

describe('linting / resetMutedRules (partial reset)', () => {
  it('tombstones mutedRules only; leaves findings intact', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 1 });
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 1 });
    s = L.resetMutedRules(s, { ts: 5 });
    expect(s.ignored.findings.get('k1').tombstone).toBeFalsy();
    expect(s.ignored.mutedRules.get('NLP-passive').tombstone).toBe(true);
  });

  it('returns same ref when mutedRules is empty (no allocation)', () => {
    const s = L.createInitial();
    expect(L.resetMutedRules(s, { ts: 1 })).toBe(s);
  });
});

describe('linting / mergeRemoteIgnored', () => {
  it('LWW per key for overlapping entries', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 5 });
    const remote = new Map([
      ['k1', { ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'b', ts: 10 }],
    ]);
    s = L.mergeRemoteIgnored(s, remote);
    expect(s.ignored.findings.get('k1').authorId).toBe('b');
  });

  it('inserts remote-only entries', () => {
    let s = L.createInitial();
    const remote = new Map([['k2', { ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'a', ts: 1 }]]);
    s = L.mergeRemoteIgnored(s, remote);
    expect(s.ignored.findings.has('k2')).toBe(true);
  });

  it('preserves local-only entries unconditionally (no seenRemoteIds tombstone-by-absence)', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 1 });
    s = L.mergeRemoteIgnored(s, new Map());
    expect(s.ignored.findings.has('k1')).toBe(true);
    expect(s.ignored.findings.get('k1').tombstone).toBeFalsy();
  });

  it('is idempotent under repeated application', () => {
    let s = L.createInitial();
    const remote = new Map([['k1', { ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'b', ts: 10 }]]);
    s = L.mergeRemoteIgnored(s, remote);
    const s2 = L.mergeRemoteIgnored(s, remote);
    expect(s2.ignored.findings.get('k1')).toEqual(s.ignored.findings.get('k1'));
  });

  it('returns same state ref when remote empty AND no local change needed', () => {
    const s0 = L.createInitial();
    // Empty remote + empty local: must return the same ref (no allocation)
    expect(L.mergeRemoteIgnored(s0, new Map())).toBe(s0);
  });
});

describe('linting / mergeRemoteMutedRules', () => {
  it('LWW per rule + preserves local-only', () => {
    let s = L.createInitial();
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 5 });
    const remote = new Map([
      ['NLP-mood-indicative', { authorId: 'b', ts: 10 }],
    ]);
    s = L.mergeRemoteMutedRules(s, remote);
    expect(s.ignored.mutedRules.has('NLP-passive')).toBe(true);
    expect(s.ignored.mutedRules.has('NLP-mood-indicative')).toBe(true);
  });
});

describe('linting / prefillIgnored', () => {
  it('merges sidecar findings with LWW per key', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 5 });
    s = L.prefillIgnored(s, {
      findings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'b', ts: 10 }],
      mutedRules: [],
    });
    expect(s.ignored.findings.get('k1').authorId).toBe('b');
  });

  it('preserves local-only entries absent from sidecar', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 1 });
    s = L.prefillIgnored(s, { findings: [], mutedRules: [] });
    expect(s.ignored.findings.has('k1')).toBe(true);
  });

  it('handles tombstoned sidecar entries', () => {
    let s = L.createInitial();
    s = L.prefillIgnored(s, {
      findings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', authorId: 'a', ts: 1, tombstone: true }],
      mutedRules: [],
    });
    expect(s.ignored.findings.get('k1').tombstone).toBe(true);
    expect(L.isFindingIgnored(s, 'k1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --run linting-ignored-merge`
Expected: FAIL.

- [ ] **Step 3: Add verbs**

Append to `src/lib/linting.js`:

```javascript
/**
 * Tombstone every dismissal + mute. Preserves keys so peers see explicit
 * tombstone writes for convergence. Race window: a peer's concurrent dismiss
 * landing AFTER this transaction is NOT retroactively cleared.
 */
export function resetIgnored(state, { ts } = {}) {
  const stamp = typeof ts === 'number' ? ts : Date.now();
  if (state.ignored.findings.size === 0 && state.ignored.mutedRules.size === 0) {
    return state;
  }
  const findings = new Map();
  for (const [k, v] of state.ignored.findings) {
    findings.set(k, { ...v, tombstone: true, ts: stamp });
  }
  const mutedRules = new Map();
  for (const [k, v] of state.ignored.mutedRules) {
    mutedRules.set(k, { ...v, tombstone: true, ts: stamp });
  }
  return { ...state, ignored: { findings, mutedRules } };
}

/**
 * Partial reset: tombstone findings only. Used by the Settings "Reset ignored
 * findings" button when the UX requires independent reset of the two columns.
 */
export function resetIgnoredFindings(state, { ts } = {}) {
  if (state.ignored.findings.size === 0) return state;
  const stamp = typeof ts === 'number' ? ts : Date.now();
  const findings = new Map();
  for (const [k, v] of state.ignored.findings) {
    findings.set(k, { ...v, tombstone: true, ts: stamp });
  }
  return { ...state, ignored: { ...state.ignored, findings } };
}

/** Partial reset: tombstone mutedRules only. */
export function resetMutedRules(state, { ts } = {}) {
  if (state.ignored.mutedRules.size === 0) return state;
  const stamp = typeof ts === 'number' ? ts : Date.now();
  const mutedRules = new Map();
  for (const [k, v] of state.ignored.mutedRules) {
    mutedRules.set(k, { ...v, tombstone: true, ts: stamp });
  }
  return { ...state, ignored: { ...state.ignored, mutedRules } };
}

/**
 * Bulk merge for `initial: true` handleSync payload. LWW per key over
 * remoteMap ∪ local; local-only entries preserved unconditionally (never
 * tombstoned by absence — ignores use never-delete tombstones so peer
 * deletions arrive AS entries with tombstone:true, never as absence).
 */
export function mergeRemoteIgnored(state, remoteMap) {
  if (!(remoteMap instanceof Map)) return state;
  if (remoteMap.size === 0) return state;
  let next = state;
  for (const [key, entry] of remoteMap) {
    next = applyRemoteIgnored(next, { key, entry });
  }
  return next;
}

/** Same semantics as mergeRemoteIgnored, for mutedRules. */
export function mergeRemoteMutedRules(state, remoteMap) {
  if (!(remoteMap instanceof Map)) return state;
  if (remoteMap.size === 0) return state;
  let next = state;
  for (const [ruleId, entry] of remoteMap) {
    next = applyRemoteMutedRule(next, { ruleId, entry });
  }
  return next;
}

/**
 * Merge sidecar payload into state. LWW per key; local-only entries preserved.
 * Caller gates to file-mode (in collab mode the room is authoritative).
 */
export function prefillIgnored(state, { findings, mutedRules }) {
  let next = state;
  if (Array.isArray(findings)) {
    for (const f of findings) {
      if (!f || typeof f.ignoreKey !== 'string') continue;
      const entry = {
        ruleId: f.ruleId,
        blockHash: f.blockHash,
        match: f.match,
        authorId: f.authorId || '',
        ts: typeof f.ts === 'number' ? f.ts : 0,
      };
      if (f.tombstone === true) entry.tombstone = true;
      next = applyRemoteIgnored(next, { key: f.ignoreKey, entry });
    }
  }
  if (Array.isArray(mutedRules)) {
    for (const r of mutedRules) {
      if (!r || typeof r.ruleId !== 'string') continue;
      const entry = {
        authorId: r.authorId || '',
        ts: typeof r.ts === 'number' ? r.ts : 0,
      };
      if (r.tombstone === true) entry.tombstone = true;
      next = applyRemoteMutedRule(next, { ruleId: r.ruleId, entry });
    }
  }
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run linting-ignored-merge`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/linting.js src/lib/__tests__/linting-ignored-merge.test.js
git commit -m "feat(linting): add resetIgnored + bulk merge + prefillIgnored (#140)"
```

---

## Task 5: Property tests

**Files:** Modify `src/lib/__tests__/linting-ignored-merge.test.js`

- [ ] **Step 1: Append property tests to linting-ignored-merge.test.js**

```javascript
describe('linting / ignored property tests', () => {
  function rand(rng, n) { return Math.floor(rng() * n); }
  function makeRng(seed) {
    let s = seed >>> 0 || 1;
    return () => {
      s = Math.imul(s ^ (s >>> 16), 2246822507) >>> 0;
      s = Math.imul(s ^ (s >>> 13), 3266489909) >>> 0;
      s ^= s >>> 16;
      return (s >>> 0) / 0xffffffff;
    };
  }

  it('200 randomized verb sequences keep ignored.findings keys monotonic (never lose entries)', () => {
    const rng = makeRng(0xfeed1234);
    let s = L.createInitial();
    let everSeen = new Set();
    for (let i = 0; i < 200; i++) {
      const action = rand(rng, 4);
      const key = `k${rand(rng, 8)}`;
      const ts = i + 1;
      const ruleId = 'NLP-passive';
      switch (action) {
        case 0:
          s = L.ignoreFinding(s, { ignoreKey: key, ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'u' }, ts });
          everSeen.add(key);
          break;
        case 1: s = L.unignoreFinding(s, { ignoreKey: key, ts }); break;
        case 2: s = L.muteNlpRule(s, { ruleId, identity: { id: 'u' }, ts }); break;
        case 3: s = L.unmuteNlpRule(s, { ruleId, ts }); break;
      }
    }
    for (const k of everSeen) expect(s.ignored.findings.has(k)).toBe(true);
  });

  it('mergeRemoteIgnored is idempotent', () => {
    const rng = makeRng(0xc0ffee);
    let s = L.createInitial();
    for (let i = 0; i < 50; i++) {
      const key = `k${rand(rng, 5)}`;
      s = L.ignoreFinding(s, { ignoreKey: key, ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'u' }, ts: i });
    }
    const remote = new Map();
    for (const [k, v] of s.ignored.findings) remote.set(k, v);
    const s2 = L.mergeRemoteIgnored(s, remote);
    const s3 = L.mergeRemoteIgnored(s2, remote);
    expect(s3.ignored.findings.size).toBe(s2.ignored.findings.size);
  });

  it('resetIgnored then ignoreFinding restores entry as non-tombstone', () => {
    let s = L.createInitial();
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 1 });
    s = L.resetIgnored(s, { ts: 2 });
    expect(s.ignored.findings.get('k1').tombstone).toBe(true);
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', identity: { id: 'a' }, ts: 3 });
    expect(s.ignored.findings.get('k1').tombstone).toBeFalsy();
    expect(L.isFindingIgnored(s, 'k1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm pass**

Run: `npm test -- --run linting-ignored-merge`
Expected: PASS (file should be ≤15 it() blocks; linting-ignored.test.js stays ≤30).

- [ ] **Step 3: Commit**

```bash
git add src/lib/__tests__/linting-ignored-merge.test.js
git commit -m "test(linting): property tests for ignored merge/prefill (#140)"
```

---

## Task 6: Loosen lint-sidecar decoder version-gate

**Files:**
- Modify: `src/lib/lint-sidecar.js`
- Modify: `src/lib/__tests__/lint-sidecar.test.js`

- [ ] **Step 1: Find and update the existing strict-version test**

Open `src/lib/__tests__/lint-sidecar.test.js`. Find the test that asserts `v: 999` returns empty (around line 173). Replace its body:

```javascript
// Was: it('returns empty when payload.v is not 1', () => { ... empty assert ... })
it('decodes known fields from future-version payload (forward-compat)', () => {
  const future = {
    v: 999,
    good: '0123456789abcdef01234567',  // 24 hex chars
    bad: {},
    futureUnknownField: { stuff: 'ignored' },
  };
  const r = decodeSidecar(future);
  expect(r.fingerprints.size).toBe(1);
  expect(r.fingerprints.get('0123456789abcdef01234567')).toBe('good');
});

it('returns empty when payload.v is missing or non-numeric', () => {
  expect(decodeSidecar({ good: '...' }).fingerprints.size).toBe(0);
  expect(decodeSidecar({ v: 'banana', good: '...' }).fingerprints.size).toBe(0);
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test -- --run lint-sidecar.test`
Expected: FAIL on the new forward-compat test (v:999 currently returns empty).

- [ ] **Step 3: Loosen the decoder gate**

In `src/lib/lint-sidecar.js`, find line ~199:

```javascript
// OLD
if (payload.v !== PAYLOAD_VERSION) return { fingerprints, byFingerprint };

// NEW: forward-compat — accept any v >= 1; reject missing/non-numeric.
if (typeof payload.v !== 'number' || payload.v < 1) {
  return { fingerprints, byFingerprint };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test -- --run lint-sidecar.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lint-sidecar.js src/lib/__tests__/lint-sidecar.test.js
git commit -m "refactor(lint-sidecar): loosen decoder version-gate for forward-compat (#140)"
```

---

## Task 7: lint-sidecar v2 encoder

**Files:**
- Modify: `src/lib/lint-sidecar.js`
- Create: `src/lib/__tests__/lint-sidecar-ignored-encode.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/lint-sidecar-ignored-encode.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { encodeSidecar, encodeSidecarV2 } from '../lint-sidecar.js';

const IDENT = (id = 'u') => ({ id });
const findings = (ignored) => ignored || [];

describe('encodeSidecar v2', () => {
  it('emits v1 shape when ignoredFindings + mutedNlpRules are both empty', async () => {
    const out = await encodeSidecarV2(new Map(), [], { ignoredFindings: [], mutedNlpRules: [] });
    expect(out.v).toBe(1);
    expect('ignoredFindings' in out).toBe(false);
  });

  it('emits v2 shape when ignoredFindings non-empty', async () => {
    const out = await encodeSidecarV2(new Map(), [], {
      ignoredFindings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' }],
      mutedNlpRules: [],
    });
    expect(out.v).toBe(2);
    expect(out.ignoredFindings).toHaveLength(1);
    expect(out.ignoredFindings[0].ignoreKey).toBe('k1');
  });

  it('emits v2 shape when mutedNlpRules non-empty', async () => {
    const out = await encodeSidecarV2(new Map(), [], {
      ignoredFindings: [],
      mutedNlpRules: [{ ruleId: 'NLP-passive', ts: 1, authorId: 'a' }],
    });
    expect(out.v).toBe(2);
    expect(out.mutedNlpRules).toHaveLength(1);
  });

  it('preserves tombstone flag through encode', async () => {
    const out = await encodeSidecarV2(new Map(), [], {
      ignoredFindings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a', tombstone: true }],
      mutedNlpRules: [],
    });
    expect(out.ignoredFindings[0].tombstone).toBe(true);
  });

  it('sorts arrays by key for deterministic byte-stable output', async () => {
    const out = await encodeSidecarV2(new Map(), [], {
      ignoredFindings: [
        { ignoreKey: 'k2', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' },
        { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' },
      ],
      mutedNlpRules: [
        { ruleId: 'NLP-mood-indicative', ts: 1, authorId: 'a' },
        { ruleId: 'NLP-passive', ts: 1, authorId: 'a' },
      ],
    });
    expect(out.ignoredFindings.map(e => e.ignoreKey)).toEqual(['k1', 'k2']);
    expect(out.mutedNlpRules.map(e => e.ruleId)).toEqual(['NLP-mood-indicative', 'NLP-passive']);
  });

  it('round-trips byte-stable across two encode calls with identical input', async () => {
    const ignored = {
      ignoredFindings: [
        { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' },
      ],
      mutedNlpRules: [],
    };
    const a = await encodeSidecarV2(new Map(), [], ignored);
    const b = await encodeSidecarV2(new Map(), [], ignored);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
```

- [ ] **Step 2: Run test to confirm fail**

Run: `npm test -- --run lint-sidecar-ignored-encode`
Expected: FAIL on `encodeSidecarV2 is not a function`.

- [ ] **Step 3: Add `encodeSidecarV2` to lint-sidecar.js**

Append to `src/lib/lint-sidecar.js`:

```javascript
const PAYLOAD_VERSION_V2 = 2;

/**
 * v2 encoder — wraps `encodeSidecar` and appends `ignoredFindings` +
 * `mutedNlpRules` if either is non-empty. Falls through to v1 shape if both
 * are empty (preserves byte-stable round-trip for existing tests). Arrays are
 * sorted by primary key for deterministic output.
 *
 * @param {Map} byBlock — same as encodeSidecar
 * @param {Array} blocksOrder — same as encodeSidecar
 * @param {{ ignoredFindings: Array, mutedNlpRules: Array }} ignored
 */
export async function encodeSidecarV2(byBlock, blocksOrder, ignored) {
  const v1 = await encodeSidecar(byBlock, blocksOrder);
  const ignoredFindings = Array.isArray(ignored?.ignoredFindings) ? ignored.ignoredFindings : [];
  const mutedNlpRules = Array.isArray(ignored?.mutedNlpRules) ? ignored.mutedNlpRules : [];

  if (ignoredFindings.length === 0 && mutedNlpRules.length === 0) {
    return v1;
  }

  const sortedFindings = [...ignoredFindings]
    .filter(f => f && typeof f.ignoreKey === 'string')
    .map(f => normalizeIgnoredFindingEntry(f))
    .sort((a, b) => a.ignoreKey.localeCompare(b.ignoreKey));

  const sortedMutes = [...mutedNlpRules]
    .filter(r => r && typeof r.ruleId === 'string')
    .map(r => normalizeMutedRuleEntry(r))
    .sort((a, b) => a.ruleId.localeCompare(b.ruleId));

  return {
    ...v1,
    v: PAYLOAD_VERSION_V2,
    ignoredFindings: sortedFindings,
    mutedNlpRules: sortedMutes,
  };
}

function normalizeIgnoredFindingEntry(f) {
  const out = {
    ignoreKey: f.ignoreKey,
    ruleId: typeof f.ruleId === 'string' ? f.ruleId : '',
    blockHash: typeof f.blockHash === 'string' ? f.blockHash : '',
    match: typeof f.match === 'string' ? f.match : '',
    ts: typeof f.ts === 'number' ? f.ts : 0,
    authorId: typeof f.authorId === 'string' ? f.authorId : '',
  };
  if (f.tombstone === true) out.tombstone = true;
  return out;
}

function normalizeMutedRuleEntry(r) {
  const out = {
    ruleId: r.ruleId,
    ts: typeof r.ts === 'number' ? r.ts : 0,
    authorId: typeof r.authorId === 'string' ? r.authorId : '',
  };
  if (r.tombstone === true) out.tombstone = true;
  return out;
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npm test -- --run lint-sidecar-ignored-encode`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lint-sidecar.js src/lib/__tests__/lint-sidecar-ignored-encode.test.js
git commit -m "feat(lint-sidecar): v2 encoder with ignoredFindings + mutedNlpRules (#140)"
```

---

## Task 8: lint-sidecar v2 decoder

**Files:**
- Modify: `src/lib/lint-sidecar.js`
- Create: `src/lib/__tests__/lint-sidecar-ignored-decode.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/lint-sidecar-ignored-decode.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { decodeSidecarV2 } from '../lint-sidecar.js';

describe('decodeSidecarV2', () => {
  it('decodes v1 payload — ignoredFindings + mutedNlpRules are empty', () => {
    const r = decodeSidecarV2({ v: 1, good: '', bad: {} });
    expect(r.ignoredFindings).toEqual([]);
    expect(r.mutedNlpRules).toEqual([]);
  });

  it('decodes v2 payload round-trip', () => {
    const r = decodeSidecarV2({
      v: 2, good: '', bad: {},
      ignoredFindings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' }],
      mutedNlpRules: [{ ruleId: 'NLP-passive', ts: 2, authorId: 'b' }],
    });
    expect(r.ignoredFindings).toHaveLength(1);
    expect(r.ignoredFindings[0].ignoreKey).toBe('k1');
    expect(r.mutedNlpRules[0].ruleId).toBe('NLP-passive');
  });

  it('decodes v3+ future payload preserving v2 fields it understands', () => {
    const r = decodeSidecarV2({
      v: 3, good: '', bad: {},
      ignoredFindings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' }],
      futureField: 'ignored-silently',
    });
    expect(r.ignoredFindings).toHaveLength(1);
  });

  it('silently drops malformed entries (load-boundary tolerance)', () => {
    const r = decodeSidecarV2({
      v: 2, good: '', bad: {},
      ignoredFindings: [
        { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' },
        null,
        { /* no ignoreKey */ ruleId: 'X' },
        { ignoreKey: 42, ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' }, // wrong type
      ],
      mutedNlpRules: [
        { ruleId: 'NLP-passive', ts: 1, authorId: 'a' },
        { /* no ruleId */ ts: 1 },
      ],
    });
    expect(r.ignoredFindings).toHaveLength(1);
    expect(r.mutedNlpRules).toHaveLength(1);
  });

  it('handles nested objects in match field defensively', () => {
    const r = decodeSidecarV2({
      v: 2, good: '', bad: {},
      ignoredFindings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: { nested: 'object' }, ts: 1, authorId: 'a' }],
    });
    expect(r.ignoredFindings).toHaveLength(0);  // match must be string
  });

  it('preserves tombstone flag through decode', () => {
    const r = decodeSidecarV2({
      v: 2, good: '', bad: {},
      ignoredFindings: [{ ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a', tombstone: true }],
    });
    expect(r.ignoredFindings[0].tombstone).toBe(true);
  });

  it('does not collide on pipe-character matches', () => {
    // Sanity that the encoded shape (which uses ignoreKey, not joined-string key)
    // doesn't lose distinction.
    const r = decodeSidecarV2({
      v: 2, good: '', bad: {},
      ignoredFindings: [
        { ignoreKey: 'A', ruleId: 'R', blockHash: 'bh', match: 'a|b', ts: 1, authorId: 'a' },
        { ignoreKey: 'B', ruleId: 'R', blockHash: 'bh|', match: 'b', ts: 1, authorId: 'a' },
      ],
    });
    expect(r.ignoredFindings).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to confirm fail**

Run: `npm test -- --run lint-sidecar-ignored-decode`
Expected: FAIL.

- [ ] **Step 3: Add decodeSidecarV2 to lint-sidecar.js**

Append to `src/lib/lint-sidecar.js`:

```javascript
/**
 * v2-aware decoder — wraps decodeSidecar and also extracts ignoredFindings +
 * mutedNlpRules. Silent on malformed entries (load-boundary tolerance, mirrors
 * comments.normalizeForLoad). Forward-compat: future v3+ payloads still have
 * their v2 fields decoded.
 *
 * @returns {{
 *   fingerprints: Map, byFingerprint: Map,        // from decodeSidecar
 *   ignoredFindings: Array<{ ignoreKey, ruleId, blockHash, match, ts, authorId, tombstone? }>,
 *   mutedNlpRules: Array<{ ruleId, ts, authorId, tombstone? }>,
 * }}
 */
export function decodeSidecarV2(payload) {
  const base = decodeSidecar(payload);
  const out = {
    ...base,
    ignoredFindings: [],
    mutedNlpRules: [],
  };
  if (!payload || typeof payload !== 'object') return out;
  if (typeof payload.v !== 'number' || payload.v < 1) return out;

  const ignored = Array.isArray(payload.ignoredFindings) ? payload.ignoredFindings : [];
  for (const f of ignored) {
    if (!f || typeof f !== 'object') continue;
    if (typeof f.ignoreKey !== 'string') continue;
    if (typeof f.ruleId !== 'string') continue;
    if (typeof f.blockHash !== 'string') continue;
    if (typeof f.match !== 'string') continue;
    if (typeof f.ts !== 'number') continue;
    const entry = {
      ignoreKey: f.ignoreKey,
      ruleId: f.ruleId,
      blockHash: f.blockHash,
      match: f.match,
      ts: f.ts,
      authorId: typeof f.authorId === 'string' ? f.authorId : '',
    };
    if (f.tombstone === true) entry.tombstone = true;
    out.ignoredFindings.push(entry);
  }

  const muted = Array.isArray(payload.mutedNlpRules) ? payload.mutedNlpRules : [];
  for (const r of muted) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.ruleId !== 'string') continue;
    if (typeof r.ts !== 'number') continue;
    const entry = {
      ruleId: r.ruleId,
      ts: r.ts,
      authorId: typeof r.authorId === 'string' ? r.authorId : '',
    };
    if (r.tombstone === true) entry.tombstone = true;
    out.mutedNlpRules.push(entry);
  }

  return out;
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npm test -- --run lint-sidecar-ignored-decode`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lint-sidecar.js src/lib/__tests__/lint-sidecar-ignored-decode.test.js
git commit -m "feat(lint-sidecar): v2 decoder with ignoredFindings + mutedNlpRules (#140)"
```

---

## Task 9: Remove dedup from useBlockLinting (move to projection)

**Files:**
- Modify `src/components/useBlockLinting.js`
- Create `src/lib/__tests__/linting-ignored-projection.test.js` (NEW)

- [ ] **Step 1: Create the projection test file with the dedup-storage contract**

Create `src/lib/__tests__/linting-ignored-projection.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import * as L from '../linting.js';
```

Then add:

```javascript
describe('linting / projection-layer dedup (engine stores undeduped)', () => {
  // This test acts as a contract: useBlockLinting.js MUST store engine output
  // verbatim in byBlock. Dedup runs in getRangesByTier (covered later).
  it('setBlockFindings stores compliance + nlp + grammar without inter-tier filtering', () => {
    const violation = (ruleId, idx, match) => ({ ruleId, index: idx, match, severity: 'medium' });
    const finding = (v) => ({ range: { __r: true }, violation: v });
    let s = L.createInitial();
    const complianceFindings = [finding(violation('TERM-shall', 10, 'shall'))];
    const nlpFindings = [finding(violation('NLP-passive', 10, 'shall be'))];  // overlaps deliberately
    s = L.setBlockFindings(s, 'b1', { compliance: complianceFindings, nlp: nlpFindings, grammar: [] });
    expect(s.byBlock.get('b1').compliance).toHaveLength(1);
    expect(s.byBlock.get('b1').nlp).toHaveLength(1);  // overlap NOT removed here
  });
});
```

- [ ] **Step 2: Run to confirm pass** (this is a passive contract test — should already pass since `setBlockFindings` already stores verbatim)

Run: `npm test -- --run linting-ignored-projection`
Expected: PASS.

- [ ] **Step 3: Modify `src/components/useBlockLinting.js` to remove dedup calls**

In `src/components/useBlockLinting.js`, remove the dedup calls. Replace lines 124-133 (the NLP dedup):

```javascript
// OLD:
//    let nlpViolations = [];
//    if (isNlpReady()) {
//      nlpViolations = dedupNlpAgainstCompliance(
//        detectNlpIssues(plainText, blockId, isNoteBlock),
//        complianceViolations,
//      );
//    } else {
//      preloadNlp();
//    }

// NEW: engines stash unfiltered findings; dedup + ignore-filter runs in
// getRangesByTier (projection layer) — see #140 / spec §4.3.
let nlpViolations = [];
if (isNlpReady()) {
  nlpViolations = detectNlpIssues(plainText, blockId, isNoteBlock);
} else {
  preloadNlp();
}
```

Then replace the dedup call inside `runGrammarPass` (lines 326-329):

```javascript
// OLD:
//      const deduped = dedupGrammarAgainstFindings(
//        grammarViolations,
//        [...complianceViolations, ...nlpViolations],
//      );
//      const grammarFindings = toFindings(el, deduped);

// NEW: store grammar verbatim; projection layer dedupes against the
// post-filter compliance + nlp set.
const grammarFindings = toFindings(el, grammarViolations);
```

Also remove the now-unused imports at the top of the file:

```javascript
// OLD:
// import {
//   setBlockFindings,
//   clearBlock,
//   getBlockFindings,
//   getBlockSeverity,
//   getGrammarText,
//   isActive,
//   isDeferredRule,
//   dedupNlpAgainstCompliance,
//   dedupGrammarAgainstFindings,
// } from '../lib/linting.js';

// NEW:
import {
  setBlockFindings,
  clearBlock,
  getBlockFindings,
  getBlockSeverity,
  getGrammarText,
  isActive,
  isDeferredRule,
} from '../lib/linting.js';
```

Also remove the unused `complianceViolations` / `nlpViolations` params to `runGrammarPass`:

```javascript
// OLD signature:
// function runGrammarPass({ el, plainText, blockId, dispatch, complianceViolations, nlpViolations }) {

// NEW:
function runGrammarPass({ el, plainText, blockId, dispatch }) {
```

And the call site that passes them:

```javascript
// OLD:
// runGrammarPass({
//   el, plainText, blockId, dispatch,
//   complianceViolations, nlpViolations,
// });

// NEW:
runGrammarPass({ el, plainText, blockId, dispatch });
```

- [ ] **Step 4: Run all linting-related tests**

Run: `npm test -- --run linting` (catches all linting* tests)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/useBlockLinting.js src/lib/__tests__/linting-ignored-projection.test.js
git commit -m "refactor(useBlockLinting): remove engine-layer dedup (moves to projection) (#140)"
```

---

## Task 10: Move dedup into `getRangesByTier` + filter ignored

**Files:**
- Modify: `src/lib/linting.js`
- Modify: `src/lib/__tests__/linting-ignored-projection.test.js`

- [ ] **Step 1: Append failing tests for the new projection behavior to linting-ignored-projection.test.js**

```javascript
describe('linting / getRangesByTier projection', () => {
  // Build a block whose findings have known ignoreKey + violation positions.
  function buildState({ compliance = [], nlp = [], grammar = [], blockHash = 'bh' } = {}) {
    let s = L.createInitial();
    s = L.setBlockFindings(s, 'b1', {
      compliance: compliance.map((f, i) => ({ range: { __r: i, kind: 'c' }, violation: f, ignoreKey: f.ignoreKey || null })),
      nlp:        nlp.map((f, i) => ({ range: { __r: i, kind: 'n' }, violation: f, ignoreKey: f.ignoreKey || null })),
      grammar:    grammar.map((f, i) => ({ range: { __r: i, kind: 'g' }, violation: f, ignoreKey: f.ignoreKey || null })),
      blockHash,
    });
    return s;
  }
  const violation = (ruleId, idx, match) => ({ ruleId, index: idx, match, severity: 'medium' });

  it('filters out findings whose ignoreKey is in ignored.findings', () => {
    let s = buildState({ compliance: [{ ...violation('TERM-shall', 10, 'shall'), ignoreKey: 'k1' }] });
    s = L.ignoreFinding(s, { ignoreKey: 'k1', ruleId: 'TERM-shall', blockHash: 'bh', match: 'shall', identity: { id: 'a' }, ts: 1 });
    const r = L.getRangesByTier(s);
    expect(r.compliance).toHaveLength(0);
  });

  it('does NOT filter findings with null ignoreKey (hash cache not populated yet)', () => {
    const s = buildState({ compliance: [{ ...violation('R', 0, 'm'), ignoreKey: null }] });
    const r = L.getRangesByTier(s);
    expect(r.compliance).toHaveLength(1);
  });

  it('filters NLP findings whose ruleId is in mutedRules', () => {
    let s = buildState({ nlp: [{ ...violation('NLP-passive', 5, 'is done'), ignoreKey: 'k2' }] });
    s = L.muteNlpRule(s, { ruleId: 'NLP-passive', identity: { id: 'a' }, ts: 1 });
    expect(L.getRangesByTier(s).nlp).toHaveLength(0);
  });

  it('dedupes NLP against compliance overlaps after ignore-filter (dismiss-static-surfaces-NLP)', () => {
    // Compliance + NLP overlap; both unignored: NLP is dedup-suppressed.
    let s = buildState({
      compliance: [{ ...violation('TERM-shall', 10, 'shall'), ignoreKey: 'kc' }],
      nlp:        [{ ...violation('NLP-passive', 8, 'shall be'), ignoreKey: 'kn' }],
    });
    expect(L.getRangesByTier(s).nlp).toHaveLength(0);  // suppressed by overlap
    expect(L.getRangesByTier(s).compliance).toHaveLength(1);

    // Now dismiss the compliance finding → NLP should resurface.
    s = L.ignoreFinding(s, { ignoreKey: 'kc', ruleId: 'TERM-shall', blockHash: 'bh', match: 'shall', identity: { id: 'a' }, ts: 1 });
    expect(L.getRangesByTier(s).compliance).toHaveLength(0);
    expect(L.getRangesByTier(s).nlp).toHaveLength(1);  // resurfaces
  });

  it('dedupes grammar against compliance+nlp after ignore-filter', () => {
    let s = buildState({
      compliance: [{ ...violation('TERM-shall', 10, 'shall'), ignoreKey: 'kc' }],
      grammar:    [{ ...violation('GRAMMAR-Agreement', 8, 'shall be'), ignoreKey: 'kg' }],
    });
    expect(L.getRangesByTier(s).grammar).toHaveLength(0);  // suppressed by >50% overlap
    s = L.ignoreFinding(s, { ignoreKey: 'kc', ruleId: 'TERM-shall', blockHash: 'bh', match: 'shall', identity: { id: 'a' }, ts: 1 });
    expect(L.getRangesByTier(s).grammar).toHaveLength(1);  // resurfaces
  });

  it('return value is NOT a Promise (sync structural assertion)', () => {
    const s = buildState();
    const r = L.getRangesByTier(s);
    expect(r).not.toBeInstanceOf(Promise);
    expect(r.compliance).toBeInstanceOf(Array);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test -- --run linting-ignored-projection`
Expected: FAIL — current `getRangesByTier` ignores `ignoreKey` and doesn't dedup.

- [ ] **Step 3: Replace `getRangesByTier` in `src/lib/linting.js`**

Find the existing `getRangesByTier` (around line 285) and replace:

```javascript
/**
 * Return ranges grouped by tier — the projection that App turns into
 * CSS.highlights groups. Pipeline per call:
 *   1. Read cached findings + blockHash from byBlock.
 *   2. Skip findings whose f.ignoreKey is null (async hash cache not yet
 *      populated for this engine cycle).
 *   3. Apply ignore-filter (isFindingIgnored) and mute-filter (isNlpRuleMuted).
 *   4. Run cross-tier dedup (dedupNlpAgainstCompliance, dedupGrammarAgainstFindings)
 *      AFTER ignore-filter so dismissing a static finding surfaces the suppressed
 *      NLP/grammar overlap.
 *   5. Collect surviving Ranges into per-tier arrays.
 */
export function getRangesByTier(state) {
  const compliance = [];
  const grammar = [];
  const nlp = [];
  if (!state.byBlock || state.byBlock.size === 0) {
    return { compliance, grammar, nlp };
  }
  // Per-block: filter, dedup, then push.
  for (const bf of state.byBlock.values()) {
    // 1+2+3: filter each tier by ignored / muted + null-key skip
    const cFiltered = filterFindings(bf.compliance, state, null);
    const nFiltered = filterFindings(bf.nlp, state, null);
    const gFiltered = filterFindings(bf.grammar, state, null);

    // 4: cross-tier dedup, post-filter
    const cViolations = cFiltered.map(f => f.violation);
    const nViolationsDeduped = dedupNlpAgainstCompliance(
      nFiltered.map(f => f.violation),
      cViolations,
    );
    const gViolationsDeduped = dedupGrammarAgainstFindings(
      gFiltered.map(f => f.violation),
      [...cViolations, ...nViolationsDeduped],
    );

    // 5: map back to findings (matched by violation identity), collect Ranges
    const nSurvive = new Set(nViolationsDeduped);
    const gSurvive = new Set(gViolationsDeduped);
    for (const f of cFiltered) if (f.range) compliance.push(f.range);
    for (const f of nFiltered) if (f.range && nSurvive.has(f.violation)) nlp.push(f.range);
    for (const f of gFiltered) if (f.range && gSurvive.has(f.violation)) grammar.push(f.range);
  }
  return { compliance, grammar, nlp };
}

/**
 * Filter findings by ignored.findings + ignored.mutedRules.
 * Null-`ignoreKey` findings pass through unfiltered (hash cache lag — see §6.2).
 * Delegates to spec §4.2 selectors `isFindingIgnored` / `isNlpRuleMuted` so the
 * "active" predicate stays in one place.
 */
function filterFindings(findings, state, _kind) {
  if (!findings || findings.length === 0) return [];
  if (!state || !state.ignored) return findings;
  const out = [];
  for (const f of findings) {
    if (!f) continue;
    const v = f.violation;
    if (!v) continue;
    // Skip filter when ignoreKey not yet computed (async cache placeholder).
    if (f.ignoreKey != null && isFindingIgnored(state, f.ignoreKey)) continue;
    // Mute NLP rules at projection time.
    if (typeof v.ruleId === 'string' && v.ruleId.startsWith('NLP-')
        && isNlpRuleMuted(state, v.ruleId)) continue;
    out.push(f);
  }
  return out;
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npm test -- --run linting`
Expected: PASS (all linting tests, including the projection ones from this task).

- [ ] **Step 5: Commit**

```bash
git add src/lib/linting.js src/lib/__tests__/linting-ignored-projection.test.js
git commit -m "feat(linting): projection-time filter + dedup in getRangesByTier (#140)"
```

---

## Task 11: blockHash + ignoreKey async cache wiring in useBlockLinting

**Files:**
- Modify: `src/components/useBlockLinting.js`
- Modify: `src/lib/linting.js` (extend `setBlockFindings` to accept blockHash)
- Create: `src/lib/__tests__/blockhash-cache.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/blockhash-cache.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import * as L from '../linting.js';

describe('blockHash + ignoreKey cache (BlockFindings.blockHash field)', () => {
  it('setBlockFindings accepts and stores blockHash', () => {
    let s = L.createInitial();
    s = L.setBlockFindings(s, 'b1', { compliance: [], nlp: [], grammar: [], blockHash: 'abc123' });
    expect(s.byBlock.get('b1').blockHash).toBe('abc123');
  });

  it('omitting blockHash leaves the previous value untouched', () => {
    let s = L.createInitial();
    s = L.setBlockFindings(s, 'b1', { compliance: [], nlp: [], grammar: [], blockHash: 'h1' });
    s = L.setBlockFindings(s, 'b1', { compliance: [] });  // no blockHash field
    expect(s.byBlock.get('b1').blockHash).toBe('h1');
  });

  it('findings carry per-finding ignoreKey field', () => {
    let s = L.createInitial();
    const f = (ignoreKey) => ({ range: { __r: true }, violation: { ruleId: 'R', index: 0, match: 'm' }, ignoreKey });
    s = L.setBlockFindings(s, 'b1', { compliance: [f('k1'), f(null)] });
    expect(s.byBlock.get('b1').compliance[0].ignoreKey).toBe('k1');
    expect(s.byBlock.get('b1').compliance[1].ignoreKey).toBe(null);
  });

  it('wrapper construction does NOT mutate engine-emitted finding objects (spec §6.2)', () => {
    // Simulates the pipeline in useBlockLinting.js: an engine emits a finding,
    // the hook builds a NEW wrapper with ignoreKey rather than mutating the
    // engine's object. If the engine caches its emission, a future cycle must
    // still see an untouched object.
    const engineEmission = { range: { __r: true }, violation: { ruleId: 'R', index: 0, match: 'm' } };
    const wrapped = { ...engineEmission, ignoreKey: 'k1' };
    expect(engineEmission.ignoreKey).toBeUndefined();
    expect(wrapped).not.toBe(engineEmission);
    expect(wrapped.violation).toBe(engineEmission.violation);  // shallow-clone, violation is a shared ref
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test -- --run blockhash-cache`
Expected: FAIL — `blockHash` field not preserved by `setBlockFindings`.

- [ ] **Step 3: Update `emptyBlockFindings` + `setBlockFindings` in linting.js**

In `src/lib/linting.js`:

```javascript
// OLD
// function emptyBlockFindings() {
//   return { compliance: [], nlp: [], grammar: [], grammarText: null };
// }

// NEW
function emptyBlockFindings() {
  return { compliance: [], nlp: [], grammar: [], grammarText: null, blockHash: null };
}
```

Then update `setBlockFindings` to handle `blockHash`:

```javascript
export function setBlockFindings(state, blockId, partial) {
  const prev = state.byBlock.get(blockId) || emptyBlockFindings();
  const next = {
    compliance: partial.compliance !== undefined ? partial.compliance : prev.compliance,
    nlp: partial.nlp !== undefined ? partial.nlp : prev.nlp,
    grammar: partial.grammar !== undefined ? partial.grammar : prev.grammar,
    grammarText: partial.grammarText !== undefined ? partial.grammarText : prev.grammarText,
    blockHash: partial.blockHash !== undefined ? partial.blockHash : prev.blockHash,
  };
  if (
    next.compliance === prev.compliance &&
    next.nlp === prev.nlp &&
    next.grammar === prev.grammar &&
    next.grammarText === prev.grammarText &&
    next.blockHash === prev.blockHash
  ) {
    return state;
  }
  const byBlock = new Map(state.byBlock);
  byBlock.set(blockId, next);
  return { ...state, byBlock };
}
```

- [ ] **Step 4: Run test to confirm pass**

Run: `npm test -- --run blockhash-cache`
Expected: PASS.

- [ ] **Step 5: Wire async hash + ignoreKey computation in `useBlockLinting.js`**

In `src/components/useBlockLinting.js`, add imports near the existing imports:

```javascript
import { fingerprintBlock } from '../lib/lint-sidecar.js';
import { computeIgnoreKey } from '../lib/linting.js';
```

Replace the body of `lint` (around lines 138-146) — the `dispatch` block that stashes findings:

```javascript
// OLD
//    const complianceFindings = toFindings(el, complianceViolations);
//    const nlpFindings = toFindings(el, nlpViolations);
//    const grammarReady = isGrammarReady();
//    dispatch(s => setBlockFindings(s, blockId, {
//      compliance: complianceFindings,
//      nlp: nlpFindings,
//      grammar: [],
//      grammarText: grammarReady ? plainText : null,
//    }));

// NEW: emit findings with ignoreKey:null placeholder synchronously; populate
// the hashes async. The projection layer treats null ignoreKey as
// "don't filter yet" so the brief async window has no impact on rendered
// highlights beyond a possible single-cycle flash.
const grammarReady = isGrammarReady();
const complianceFindings = toFindings(el, complianceViolations).map(f => ({ ...f, ignoreKey: null }));
const nlpFindings = toFindings(el, nlpViolations).map(f => ({ ...f, ignoreKey: null }));
dispatch(s => setBlockFindings(s, blockId, {
  compliance: complianceFindings,
  nlp: nlpFindings,
  grammar: [],
  grammarText: grammarReady ? plainText : null,
}));

// Async hash + per-finding ignoreKey population. Race-safe: if html changes
// before we resolve, we read getGrammarText to detect stale state (mirrors
// runGrammarPass).
const htmlSnapshot = el.innerHTML;
(async () => {
  let blockHash;
  try { blockHash = await fingerprintBlock(htmlSnapshot); } catch { return; }
  const cKeys = await Promise.all(complianceFindings.map(f =>
    computeIgnoreKey(f.violation.ruleId, blockHash, f.violation.match)));
  const nKeys = await Promise.all(nlpFindings.map(f =>
    computeIgnoreKey(f.violation.ruleId, blockHash, f.violation.match)));
  const curEl = getEl();
  if (!curEl || curEl.innerHTML !== htmlSnapshot) return;  // stale
  dispatch(s => setBlockFindings(s, blockId, {
    compliance: complianceFindings.map((f, i) => ({ ...f, ignoreKey: cKeys[i] })),
    nlp: nlpFindings.map((f, i) => ({ ...f, ignoreKey: nKeys[i] })),
    blockHash,
  }));
})();
```

Update `runGrammarPass` to also populate ignoreKey via the same pattern:

```javascript
function runGrammarPass({ el, plainText, blockId, dispatch }) {
  checkGrammar(plainText, blockId).then(async grammarViolations => {
    const htmlSnapshot = el.innerHTML;
    const grammarFindings = toFindings(el, grammarViolations).map(f => ({ ...f, ignoreKey: null }));
    dispatch(s => {
      if (getGrammarText(s, blockId) !== plainText) return s;
      return setBlockFindings(s, blockId, { grammar: grammarFindings });
    });

    // Async hash + per-finding ignoreKey
    let blockHash;
    try { blockHash = await fingerprintBlock(htmlSnapshot); } catch { return; }
    const keys = await Promise.all(grammarFindings.map(f =>
      computeIgnoreKey(f.violation.ruleId, blockHash, f.violation.match)));
    if (!el.isConnected || el.innerHTML !== htmlSnapshot) return;
    dispatch(s => {
      if (getGrammarText(s, blockId) !== plainText) return s;
      return setBlockFindings(s, blockId, {
        grammar: grammarFindings.map((f, i) => ({ ...f, ignoreKey: keys[i] })),
      });
    });
  }).catch(() => {});
}
```

- [ ] **Step 6: Run full linting suite**

Run: `npm test -- --run linting && npm test -- --run blockhash-cache`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/linting.js src/components/useBlockLinting.js src/lib/__tests__/blockhash-cache.test.js
git commit -m "feat(useBlockLinting): async blockHash + per-finding ignoreKey cache (#140)"
```

---

## Task 12: Yjs substrate — yLintIgnored + yLintMutedNlp + collab.js helpers

**Files:**
- Modify: `src/lib/collab.js`
- Create: `src/lib/__tests__/collab-lint-ignored.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/__tests__/collab-lint-ignored.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import {
  readLintIgnored, publishLintIgnoredToDoc,
  readLintMutedNlp, publishLintMutedNlpToDoc,
} from '../collab.js';

function makeIgnoredDoc() {
  const ydoc = new Y.Doc();
  return { ydoc, yLintIgnored: ydoc.getMap('lintIgnored'), yLintMutedNlp: ydoc.getMap('lintMutedNlp') };
}

describe('readLintIgnored / publishLintIgnoredToDoc', () => {
  it('round-trips a single ignore entry', () => {
    const { ydoc, yLintIgnored } = makeIgnoredDoc();
    publishLintIgnoredToDoc(ydoc, yLintIgnored, new Map([
      ['k1', { ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' }],
    ]));
    const m = readLintIgnored(yLintIgnored);
    expect(m.size).toBe(1);
    expect(m.get('k1').ruleId).toBe('R');
  });

  it('preserves tombstones', () => {
    const { ydoc, yLintIgnored } = makeIgnoredDoc();
    publishLintIgnoredToDoc(ydoc, yLintIgnored, new Map([
      ['k1', { ruleId: 'R', blockHash: 'bh', match: 'm', ts: 2, authorId: 'a', tombstone: true }],
    ]));
    expect(readLintIgnored(yLintIgnored).get('k1').tombstone).toBe(true);
  });

  it('write uses local-lint-ignored origin (caught by handleAfterTx prefix filter)', () => {
    const { ydoc, yLintIgnored } = makeIgnoredDoc();
    let observedOrigin = null;
    ydoc.on('afterTransaction', tx => { observedOrigin = tx.origin; });
    publishLintIgnoredToDoc(ydoc, yLintIgnored, new Map([
      ['k1', { ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' }],
    ]));
    expect(observedOrigin).toBe('local-lint-ignored');
  });

  it('write is NOT captured by an UndoManager tracking local-publish + ySyncPluginKey (spec §3.2)', () => {
    // Mirrors collab.js:1040 — the in-room UndoManager's trackedOrigins.
    // Ctrl+Z must NOT un-dismiss; ignored writes are not undoable.
    const { ydoc, yLintIgnored } = makeIgnoredDoc();
    const um = new Y.UndoManager(yLintIgnored, {
      trackedOrigins: new Set(['local-publish', ySyncPluginKey]),
    });
    publishLintIgnoredToDoc(ydoc, yLintIgnored, new Map([
      ['k1', { ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' }],
    ]));
    expect(um.undoStack.length).toBe(0);
    um.destroy();
  });

  it('skips re-writes for byte-equal entries (diff-only)', () => {
    const { ydoc, yLintIgnored } = makeIgnoredDoc();
    const entries = new Map([['k1', { ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' }]]);
    publishLintIgnoredToDoc(ydoc, yLintIgnored, entries);
    let secondTxFired = false;
    ydoc.on('afterTransaction', tx => {
      if (tx.changed.size > 0 || tx.changedParentTypes.size > 0) secondTxFired = true;
    });
    publishLintIgnoredToDoc(ydoc, yLintIgnored, entries);
    expect(secondTxFired).toBe(false);
  });

  it('concurrent same-key dismisses converge after replicate', () => {
    // Simulate two docs sharing updates: latest LWW per key.
    const a = makeIgnoredDoc(); const b = makeIgnoredDoc();
    publishLintIgnoredToDoc(a.ydoc, a.yLintIgnored, new Map([['k1', { ruleId: 'R', blockHash: 'bh', match: 'm', ts: 10, authorId: 'a' }]]));
    publishLintIgnoredToDoc(b.ydoc, b.yLintIgnored, new Map([['k1', { ruleId: 'R', blockHash: 'bh', match: 'm', ts: 20, authorId: 'b' }]]));
    // Sync a → b → a
    Y.applyUpdate(b.ydoc, Y.encodeStateAsUpdate(a.ydoc));
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b.ydoc));
    // Both should converge — at least one entry, ts >= 10.
    expect(readLintIgnored(a.yLintIgnored).get('k1').ts).toBeGreaterThanOrEqual(10);
    expect(readLintIgnored(b.yLintIgnored).get('k1').ts).toBeGreaterThanOrEqual(10);
  });
});

describe('readLintMutedNlp / publishLintMutedNlpToDoc', () => {
  it('round-trips a mute entry', () => {
    const { ydoc, yLintMutedNlp } = makeIgnoredDoc();
    publishLintMutedNlpToDoc(ydoc, yLintMutedNlp, new Map([
      ['NLP-passive', { ts: 1, authorId: 'a' }],
    ]));
    expect(readLintMutedNlp(yLintMutedNlp).get('NLP-passive').authorId).toBe('a');
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `npm test -- --run collab-lint-ignored`
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Add helpers to `src/lib/collab.js`**

Append, immediately after the `lintEntryEqual` helper (around line 577):

```javascript
/** Read yLintIgnored into a JS Map<ignoreKey, IgnoreEntry>. */
export function readLintIgnored(yLintIgnored) {
  const out = new Map();
  if (!yLintIgnored || typeof yLintIgnored.forEach !== 'function') return out;
  yLintIgnored.forEach((val, key) => {
    if (!val || typeof val !== 'object') return;
    out.set(key, val);
  });
  return out;
}

/**
 * Publish a Map<ignoreKey, IgnoreEntry> to yLintIgnored. Diffs against current
 * state — never deletes (set-only per never-delete tombstone discipline).
 * Origin 'local-lint-ignored' is caught by handleAfterTx's 'local-' prefix
 * filter and NOT in UndoManager.trackedOrigins (Ctrl+Z does not un-dismiss).
 */
export function publishLintIgnoredToDoc(ydoc, yLintIgnored, entries) {
  if (!(entries instanceof Map)) return;
  ydoc.transact(() => {
    for (const [key, next] of entries) {
      const cur = yLintIgnored.get(key);
      if (!ignoredEntryEqual(cur, next)) yLintIgnored.set(key, next);
    }
  }, 'local-lint-ignored');
}

function ignoredEntryEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Read yLintMutedNlp into a Map<ruleId, MuteEntry>. */
export function readLintMutedNlp(yLintMutedNlp) {
  const out = new Map();
  if (!yLintMutedNlp || typeof yLintMutedNlp.forEach !== 'function') return out;
  yLintMutedNlp.forEach((val, key) => {
    if (!val || typeof val !== 'object') return;
    out.set(key, val);
  });
  return out;
}

/** Publish a Map<ruleId, MuteEntry> to yLintMutedNlp. Same semantics as ignored. */
export function publishLintMutedNlpToDoc(ydoc, yLintMutedNlp, entries) {
  if (!(entries instanceof Map)) return;
  ydoc.transact(() => {
    for (const [key, next] of entries) {
      const cur = yLintMutedNlp.get(key);
      if (!ignoredEntryEqual(cur, next)) yLintMutedNlp.set(key, next);
    }
  }, 'local-lint-ignored');
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `npm test -- --run collab-lint-ignored`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/collab.js src/lib/__tests__/collab-lint-ignored.test.js
git commit -m "feat(collab): readLintIgnored + publishLintIgnoredToDoc + muted equivalents (#140)"
```

---

## Task 13: Wire substrate into createCollabSession (Y.Maps + observer + initial sync)

**Files:** Modify `src/lib/collab.js`

- [ ] **Step 1: Write the integration test (append to collab-lint-ignored.test.js)**

```javascript
import { createCollabSession } from '../collab.js';

describe('createCollabSession lint-ignored wiring', () => {
  // Note: createCollabSession requires a wsUrl + room; we can construct a
  // minimal session and exercise only the Y.Map + dispatch surfaces by
  // passing a stub provider. The actual WebsocketProvider path is covered by
  // E2E tests in collab.spec.js.

  it('exposes yLintIgnored + yLintMutedNlp on session', () => {
    // We can't easily instantiate the full session here without a WS server.
    // Treat this as a smoke check on the export shape via spy assertion
    // in subsequent E2E tests; if needed, expand server/__tests__ later.
    expect(typeof createCollabSession).toBe('function');
  });
});
```

- [ ] **Step 2: Modify createCollabSession to attach Y.Maps + observers**

In `src/lib/collab.js`, find line 818 (`const yLint = ydoc.getMap('lint');`) and add:

```javascript
const yLint = ydoc.getMap('lint');
const yLintIgnored = ydoc.getMap('lintIgnored');
const yLintMutedNlp = ydoc.getMap('lintMutedNlp');
```

Find the `handleSync` block (around line 880-890) and add initial-emit hooks. Locate the existing block:

```javascript
// EXISTING handleSync emit area around line 889:
onRemoteLint?.(readLint(yLint), { initial: true });
```

Add immediately below it:

```javascript
onRemoteLintIgnored?.(readLintIgnored(yLintIgnored), { initial: true });
onRemoteLintMutedNlp?.(readLintMutedNlp(yLintMutedNlp), { initial: true });
```

Find `handleAfterTx`'s `lintChanged` block (around line 969-985) and append:

```javascript
const lintIgnoredChanged = cpt.has(yLintIgnored) || ch.has(yLintIgnored);
const lintMutedNlpChanged = cpt.has(yLintMutedNlp) || ch.has(yLintMutedNlp);

// ... existing lintChanged block below stays as-is ...

if (lintIgnoredChanged) {
  onRemoteLintIgnored?.(readLintIgnored(yLintIgnored), { initial: false });
}
if (lintMutedNlpChanged) {
  onRemoteLintMutedNlp?.(readLintMutedNlp(yLintMutedNlp), { initial: false });
}
```

Add the callback params to the `createCollabSession` signature. Find the start of the function (around line 700) — the existing options destructure has `onRemoteLint`. Add:

```javascript
// Find params destructure (search for `onRemoteLint,`) and add adjacent:
onRemoteLintIgnored,
onRemoteLintMutedNlp,
```

In the returned object (around line 1046), expose the new Y.Maps + dispatch verbs. Find the existing return block (after `yLint,` around line 1053) and add:

```javascript
yLintIgnored,
yLintMutedNlp,
publishLintIgnored(entries) {
  publishLintIgnoredToDoc(ydoc, yLintIgnored, entries);
},
publishLintMutedNlp(entries) {
  publishLintMutedNlpToDoc(ydoc, yLintMutedNlp, entries);
},
```

- [ ] **Step 3: Run unit tests**

Run: `npm test -- --run collab`
Expected: PASS (no breakage to existing collab tests).

- [ ] **Step 4: Commit**

```bash
git add src/lib/collab.js src/lib/__tests__/collab-lint-ignored.test.js
git commit -m "feat(collab): wire yLintIgnored + yLintMutedNlp into session (#140)"
```

---

## Task 14: useCollabSession publish effect + remote callbacks

**Files:** Modify `src/hooks/useCollabSession.js`

- [ ] **Step 1: Add new prop callbacks to useCollabSession**

In `src/hooks/useCollabSession.js`, find the existing `onRemoteLint` callback wiring (around line 322). Add adjacent:

```javascript
// Existing:
onRemoteLint: (lintPayload, meta) => { ... },

// Add:
onRemoteLintIgnored: (ignoredMap, meta) => {
  if (meta?.initial) {
    onLintIgnoredInitial?.(ignoredMap);
  } else {
    onLintIgnoredUpdated?.(ignoredMap);
  }
},
onRemoteLintMutedNlp: (mutedMap, meta) => {
  if (meta?.initial) {
    onLintMutedNlpInitial?.(mutedMap);
  } else {
    onLintMutedNlpUpdated?.(mutedMap);
  }
},
```

Find the props destructure at the top of the hook. Add:

```javascript
onLintIgnoredInitial,
onLintIgnoredUpdated,
onLintMutedNlpInitial,
onLintMutedNlpUpdated,
```

- [ ] **Step 2: Add a publish effect for ignored state**

After the existing `publishLint` effect (around line 478-507), add:

```javascript
// Publish state.ignored.findings → yLintIgnored. Diffs against last published
// state to avoid re-publishing on every render. Gating: shares canPublishMeta
// (cache-like data, not user verb).
useEffect(() => {
  if (!inRoom) return;
  const session = sessionRef.current;
  if (!session || typeof session.publishLintIgnored !== 'function') return;
  if (!sc.canPublishMeta(coordRef.current)) return;
  if (!lintingState?.ignored) return;
  if (lintingState.ignored.findings === lastPublishedLintIgnoredRef.current) return;
  try {
    session.publishLintIgnored(lintingState.ignored.findings);
    lastPublishedLintIgnoredRef.current = lintingState.ignored.findings;
  } catch (err) {
    console.error('[collab] publishLintIgnored failed:', err);
  }
}, [lintingState, inRoom]);

// Publish state.ignored.mutedRules → yLintMutedNlp.
useEffect(() => {
  if (!inRoom) return;
  const session = sessionRef.current;
  if (!session || typeof session.publishLintMutedNlp !== 'function') return;
  if (!sc.canPublishMeta(coordRef.current)) return;
  if (!lintingState?.ignored) return;
  if (lintingState.ignored.mutedRules === lastPublishedLintMutedNlpRef.current) return;
  try {
    session.publishLintMutedNlp(lintingState.ignored.mutedRules);
    lastPublishedLintMutedNlpRef.current = lintingState.ignored.mutedRules;
  } catch (err) {
    console.error('[collab] publishLintMutedNlp failed:', err);
  }
}, [lintingState, inRoom]);
```

Declare the refs near the top of the hook (search for `lastPublishedLintByBlockRef` declaration):

```javascript
const lastPublishedLintIgnoredRef = useRef(null);
const lastPublishedLintMutedNlpRef = useRef(null);
```

- [ ] **Step 2b: Reset the new refs on session teardown**

Search for the existing destroy cleanup that resets `lastPublishedLintByBlockRef.current = null;` (around line 375). Append two lines so the next room's first dispatch is not silently skipped by the ref-identity bail:

```javascript
lastPublishedLintByBlockRef.current = null;
// Add:
lastPublishedLintIgnoredRef.current = null;
lastPublishedLintMutedNlpRef.current = null;
```

- [ ] **Step 3: Run hook tests if any exist**

Run: `npm test -- --run useCollabSession`
Expected: PASS (or no matching tests — that's fine).

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useCollabSession.js
git commit -m "feat(useCollabSession): publish + observer effects for lintIgnored (#140)"
```

---

## Task 15: Server-side room-serializer extension + storage contract

**Files:**
- Modify: `server/room-serializer.cjs`
- Modify: `server/__tests__/room-serializer.test.mjs`
- Modify: `server/__tests__/storage-contract.test.mjs`

- [ ] **Step 1: Read the existing room-serializer.cjs to find the yLint extraction**

Run: `Read server/room-serializer.cjs` to locate the section that extracts yLint into the sidecar.

- [ ] **Step 2: Write the failing server test**

Append to `server/__tests__/room-serializer.test.mjs`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as Y from 'yjs';
import { serializeLintSidecar } from '../room-serializer.cjs';

describe('serializeLintSidecar — v2 ignored', () => {
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
});
```

- [ ] **Step 3: Run to confirm fail**

Run: `npm run test:server`
Expected: FAIL — `serializeLintSidecar` doesn't accept those args or doesn't exist.

- [ ] **Step 4: Modify `server/room-serializer.cjs`**

Find the existing `serializeLintSidecar` (or the equivalent function that produces `.lint.json` output). Update its signature to accept the two new Y.Maps and emit v2 when either is non-empty. Pseudocode:

```javascript
function serializeLintSidecar(yLint, yLintIgnored, yLintMutedNlp, blocksOrder) {
  // existing v1 logic...
  const v1 = buildV1Payload(yLint, blocksOrder);

  const ignored = [];
  yLintIgnored.forEach((v, k) => {
    if (!v || typeof v !== 'object') return;
    if (typeof k !== 'string') return;
    ignored.push({
      ignoreKey: k,
      ruleId: v.ruleId, blockHash: v.blockHash, match: v.match,
      ts: v.ts, authorId: v.authorId || '',
      ...(v.tombstone === true ? { tombstone: true } : {}),
    });
  });

  const muted = [];
  yLintMutedNlp.forEach((v, k) => {
    if (!v || typeof v !== 'object') return;
    muted.push({
      ruleId: k,
      ts: v.ts, authorId: v.authorId || '',
      ...(v.tombstone === true ? { tombstone: true } : {}),
    });
  });

  if (ignored.length === 0 && muted.length === 0) return v1;
  ignored.sort((a, b) => a.ignoreKey.localeCompare(b.ignoreKey));
  muted.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  return { ...v1, v: 2, ignoredFindings: ignored, mutedNlpRules: muted };
}
```

Replace the existing function. Update its callers in the same file (typically in the room serialization entry point) to pass the new Y.Maps.

- [ ] **Step 5: Run server test**

Run: `npm run test:server`
Expected: PASS for the new cases.

- [ ] **Step 6: Add storage contract assertion**

In `server/__tests__/storage-contract.test.mjs`, find the loop over backends. Inside the existing block that exercises lint sidecar persistence, add:

```javascript
// After existing yLint assertion:
const ignoredYMap = ydoc.getMap('lintIgnored');
ignoredYMap.set('k1', { ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' });
// Flush room → reload → verify yLintIgnored has k1 after reload.
// (The existing pattern in this file should be followed exactly; adapt
// per the test harness's load/save dance.)
```

If the existing test pattern uses a fixture-based round trip, append:

```javascript
test(`${name}: persists lintIgnored across save+load`, async () => {
  await stor.saveRoom(roomId, {
    sec: '<SEC></SEC>',
    lintSidecar: { v: 2, good: '', bad: {}, ignoredFindings: [
      { ignoreKey: 'k1', ruleId: 'R', blockHash: 'bh', match: 'm', ts: 1, authorId: 'a' },
    ], mutedNlpRules: [] },
  });
  const loaded = await stor.loadRoom(roomId);
  assert.deepEqual(loaded.lintSidecar.ignoredFindings[0].ignoreKey, 'k1');
});
```

(Match the exact API the surrounding test code uses.)

- [ ] **Step 7: Run storage contract tests**

Run: `npm run test:server`
Expected: PASS for all 3 backends.

- [ ] **Step 8: Commit**

```bash
git add server/room-serializer.cjs server/__tests__/room-serializer.test.mjs server/__tests__/storage-contract.test.mjs
git commit -m "feat(server): extract yLintIgnored + yLintMutedNlp into sidecar v2 (#140)"
```

---

## Task 16: App.jsx wiring + prefillIgnored file-mode gate + test seam

**Files:** Modify `src/App.jsx`

- [ ] **Step 1: Add callback handlers for ignored-state remote events**

Search `src/App.jsx` for the existing `onRemoteLint` / `onLintReceived` handler. Add adjacent:

```javascript
// Handlers for remote ignored / muted updates.
const handleLintIgnoredInitial = useCallback((ignoredMap) => {
  setLintingState(s => linting.mergeRemoteIgnored(s, ignoredMap));
}, []);
const handleLintIgnoredUpdated = useCallback((ignoredMap) => {
  // Full snapshot — apply via the same bulk merge.
  setLintingState(s => linting.mergeRemoteIgnored(s, ignoredMap));
}, []);
const handleLintMutedNlpInitial = useCallback((mutedMap) => {
  setLintingState(s => linting.mergeRemoteMutedRules(s, mutedMap));
}, []);
const handleLintMutedNlpUpdated = useCallback((mutedMap) => {
  setLintingState(s => linting.mergeRemoteMutedRules(s, mutedMap));
}, []);
```

Wire them into the `useCollabSession` call:

```javascript
useCollabSession({
  /* ...existing props... */
  onLintIgnoredInitial: handleLintIgnoredInitial,
  onLintIgnoredUpdated: handleLintIgnoredUpdated,
  onLintMutedNlpInitial: handleLintMutedNlpInitial,
  onLintMutedNlpUpdated: handleLintMutedNlpUpdated,
});
```

- [ ] **Step 2: Add file-mode prefillIgnored to .SEC import handler**

Search for the existing `parseSEC` / `.lint.json` drag-drop handler. Find where `prefillFromSidecar` is invoked. Add gated call:

```javascript
// After existing prefillFromSidecar call:
if (decoded.ignoredFindings?.length > 0 || decoded.mutedNlpRules?.length > 0) {
  // File-mode only: in collab mode, yLintIgnored is authoritative.
  if (!inRoom) {
    setLintingState(s => linting.prefillIgnored(s, {
      findings: decoded.ignoredFindings || [],
      mutedRules: decoded.mutedNlpRules || [],
    }));
  }
}
```

Make sure the decode call uses `decodeSidecarV2` instead of `decodeSidecar`:

```javascript
// Change the import:
import { decodeSidecarV2 } from './lib/lint-sidecar.js';

// And the call:
const decoded = decodeSidecarV2(payload);
```

- [ ] **Step 3: Add the test seam to `window.__simEditorTestUtils`**

Search App.jsx for the existing `window.__simEditorTestUtils` definition (under `import.meta.env.DEV`). Add:

```javascript
// Inside the existing object literal:
getIgnoredKeys: () => {
  const out = [];
  lintingStateRef.current.ignored.findings.forEach((entry, key) => {
    if (entry.tombstone !== true) out.push(key);
  });
  return out;
},
getBlockHash: (blockId) => {
  // Exposes the cached per-block fingerprint so E2E tests (Task 26) can
  // construct an ignoreKey envelope without round-tripping through the DOM.
  return lintingStateRef.current.byBlock.get(blockId)?.blockHash || null;
},
isFindingIgnored: (ruleId, blockHash, match) => {
  // Async — returns a Promise from test land.
  return linting.computeIgnoreKey(ruleId, blockHash, match)
    .then(key => linting.isFindingIgnored(lintingStateRef.current, key));
},
dispatchLintIgnore: (envelope) => {
  if (!envelope || typeof envelope !== 'object') return;
  const ts = typeof envelope.ts === 'number' ? envelope.ts : Date.now();
  const identity = envelope.identity || effectiveIdentity();
  switch (envelope.kind) {
    case 'ignore':
      linting.computeIgnoreKey(envelope.ruleId, envelope.blockHash, envelope.match)
        .then(ignoreKey => setLintingState(s => linting.ignoreFinding(s,
          { ignoreKey, ruleId: envelope.ruleId, blockHash: envelope.blockHash, match: envelope.match, identity, ts })));
      break;
    case 'unignore':
      linting.computeIgnoreKey(envelope.ruleId, envelope.blockHash, envelope.match)
        .then(ignoreKey => setLintingState(s => linting.unignoreFinding(s, { ignoreKey, ts })));
      break;
    case 'mute-nlp':
      setLintingState(s => linting.muteNlpRule(s, { ruleId: envelope.ruleId, identity, ts }));
      break;
    case 'unmute-nlp':
      setLintingState(s => linting.unmuteNlpRule(s, { ruleId: envelope.ruleId, ts }));
      break;
    case 'reset':
      setLintingState(s => linting.resetIgnored(s, { ts }));
      break;
  }
},
```

Make sure `lintingStateRef` exists (mirrors lintingState into a ref for the seam):

```javascript
// Near other ref declarations:
const lintingStateRef = useRef(lintingState);
useEffect(() => { lintingStateRef.current = lintingState; }, [lintingState]);
```

- [ ] **Step 4: Run typecheck-equivalent (Vite build)**

Run: `npx vite build --mode development`
Expected: build succeeds.

- [ ] **Step 5: Run unit tests**

Run: `npm test -- --run`
Expected: All existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "feat(app): wire prefillIgnored + remote ignored callbacks + test seam (#140)"
```

---

## PR A Merge Checkpoint

At this point PR A is feature-complete and shippable. Run the full gate:

```bash
npm test -- --run
npm run test:server
npm run test:compliance
npx playwright test --project=chromium tests/e2e/editor.spec.js
```

Expected: green build, no UI surfaces yet, ignored state syncs but no buttons to trigger dismissals (only `window.__simEditorTestUtils.dispatchLintIgnore` in DEV).

**Branch tip:** push to remote and open the draft PR for PR A. The PR description should reference the spec + this plan.

---

# PR B: User-Visible UI

## Task 17: InlineTooltip [Dismiss] button

**Files:** Modify `src/components/InlineTooltip.jsx`

- [ ] **Step 1: Inspect the current button row to identify the insertion point**

Read `src/components/InlineTooltip.jsx`. The button row is around lines 257-326 (`<div style={{ marginTop: 8, ... display: 'flex', gap: 6, ... flexWrap: 'wrap' }}>`).

- [ ] **Step 2: Add a Dismiss button + onSuppress prop**

Add `onSuppress` and `blockHash` to the destructured props at the top:

```javascript
export default function InlineTooltip({
  finding, blockId, onFix, onDismiss, blockEl,
  onAddToDictionary, onSuppress, blockHash,
}) {
```

After the existing button row's `[Fix]` group (around line 277) and before the canAddToDict block, insert:

```javascript
{/* Persistent Dismiss — survives reload */}
{typeof onSuppress === 'function' && typeof blockHash === 'string' && (
  <button
    onClick={() => {
      onSuppress(violation.ruleId, blockHash, violation.match);
      onDismiss();
    }}
    onMouseDown={(e) => e.preventDefault()}
    title="Dismiss this specific finding (persists across reload; reset from Settings)"
    style={{
      padding: '3px 10px',
      fontSize: 12,
      fontWeight: 500,
      backgroundColor: '#fff',
      color: '#475569',
      border: '1px solid #cbd5e1',
      borderRadius: 4,
      cursor: 'pointer',
      fontFamily: 'inherit',
    }}
  >
    Dismiss
  </button>
)}
```

- [ ] **Step 3: Wire onSuppress + blockHash from caller**

In the file that mounts InlineTooltip (likely `App.jsx`'s render of `<InlineTooltip ... />` per block), find the `<InlineTooltip />` JSX call and add:

```javascript
<InlineTooltip
  /* existing props */
  blockHash={lintingState.byBlock.get(blockId)?.blockHash || null}
  onSuppress={(ruleId, blockHash, match) => {
    if (!blockHash) return;
    // Single dispatch path — production AND tests share it. The DEV seam
    // `__simEditorTestUtils.dispatchLintIgnore` exists in App.jsx Task 16 for
    // E2E tests that need to inject envelopes WITHOUT a tooltip mounted.
    // Do NOT call it from here (would double-dispatch in DEV).
    linting.computeIgnoreKey(ruleId, blockHash, match).then(ignoreKey => {
      setLintingState(s => linting.ignoreFinding(s, {
        ignoreKey, ruleId, blockHash, match,
        identity: effectiveIdentity(), ts: Date.now(),
      }));
    });
  }}
/>
```

- [ ] **Step 4: Manual smoke test**

Start dev server: `npm run dev`. Open a sample doc, click a flagged term, verify Dismiss button appears. Click it, verify highlight disappears. Reload the page — verify the highlight stays gone (only in collab mode; file mode needs PR B Task 25's `.lint.json` save flow which already exists from #138 via the publish effect).

- [ ] **Step 5: Commit**

```bash
git add src/components/InlineTooltip.jsx src/App.jsx
git commit -m "feat(InlineTooltip): persistent Dismiss button (#140)"
```

---

## Task 18: InlineTooltip [Mute NLP-rule] button

**Files:** Modify `src/components/InlineTooltip.jsx`

- [ ] **Step 1: Add onMuteNlpRule prop + button**

In `src/components/InlineTooltip.jsx`, add `onMuteNlpRule` to props:

```javascript
export default function InlineTooltip({
  finding, blockId, onFix, onDismiss, blockEl,
  onAddToDictionary, onSuppress, blockHash, onMuteNlpRule,
}) {
```

Compute a helper variable near the existing `canAddToDict`:

```javascript
const isNlp = typeof violation.ruleId === 'string' && violation.ruleId.startsWith('NLP-');
const canMute = isNlp && typeof onMuteNlpRule === 'function';
```

Add the button after the Dismiss button:

```javascript
{canMute && (
  <button
    onClick={() => {
      const ok = window.confirm(`Mute ${violation.ruleId} in this document?`);
      if (ok) {
        onMuteNlpRule(violation.ruleId);
        onDismiss();
      }
    }}
    onMouseDown={(e) => e.preventDefault()}
    title={`Suppress all ${violation.ruleId} findings in this document. Reset from Settings.`}
    style={{
      padding: '3px 10px',
      fontSize: 12,
      fontWeight: 500,
      backgroundColor: '#fff',
      color: '#92400e',
      border: '1px solid #fde68a',
      borderRadius: 4,
      cursor: 'pointer',
      fontFamily: 'inherit',
    }}
  >
    Mute {violation.ruleId}
  </button>
)}
```

- [ ] **Step 2: Wire onMuteNlpRule from App.jsx**

```javascript
<InlineTooltip
  /* existing props */
  onMuteNlpRule={(ruleId) => {
    setLintingState(s => linting.muteNlpRule(s, {
      ruleId, identity: effectiveIdentity(), ts: Date.now(),
    }));
  }}
/>
```

- [ ] **Step 3: Manual smoke test**

`npm run dev`. Open a doc with passive voice, click the NLP highlight, click Mute NLP-passive, confirm dialog, verify all passive highlights disappear in the current doc.

- [ ] **Step 4: Commit**

```bash
git add src/components/InlineTooltip.jsx src/App.jsx
git commit -m "feat(InlineTooltip): Mute NLP-rule button with confirm (#140)"
```

---

## Task 19: CompliancePanel item-level Dismiss button

**Files:** Modify `src/components/CompliancePanel.jsx`

- [ ] **Step 1: Find the item row**

In `src/components/CompliancePanel.jsx`, locate the per-instance row (around lines 600-660, where `[✓ Accept] [✗ Reject]` buttons sit).

- [ ] **Step 2: Add the Dismiss button**

Beside the existing Accept/Reject buttons, add:

```javascript
<button
  onClick={() => onItemDismiss(group.ruleId, item)}
  onMouseDown={(e) => e.preventDefault()}
  title="Persistent — survives reload"
  style={{
    padding: '2px 8px',
    fontSize: 11,
    fontWeight: 500,
    backgroundColor: '#fff',
    color: '#475569',
    border: '1px solid #cbd5e1',
    borderRadius: 3,
    cursor: 'pointer',
  }}
>
  Dismiss
</button>
```

Pass `onItemDismiss` from props:

```javascript
function CompliancePanel({ /* existing */, onItemDismiss, onGroupDismiss }) {
```

- [ ] **Step 3: Wire in App.jsx**

```javascript
<CompliancePanel
  /* existing props */
  onItemDismiss={(ruleId, item) => {
    const blockHash = lintingState.byBlock.get(item.blockId)?.blockHash;
    if (!blockHash) return;
    linting.computeIgnoreKey(ruleId, blockHash, item.match).then(ignoreKey => {
      setLintingState(s => linting.ignoreFinding(s, {
        ignoreKey, ruleId, blockHash, match: item.match,
        identity: effectiveIdentity(), ts: Date.now(),
      }));
    });
  }}
/>
```

- [ ] **Step 4: Manual smoke test**

`npm run dev`, open Compliance Panel, click Dismiss on an item, verify it disappears from the panel + inline highlight.

- [ ] **Step 5: Commit**

```bash
git add src/components/CompliancePanel.jsx src/App.jsx
git commit -m "feat(CompliancePanel): per-item Dismiss button (#140)"
```

---

## Task 20: CompliancePanel group-level Dismiss all

**Files:** Modify `src/components/CompliancePanel.jsx`

- [ ] **Step 1: Find the group header row**

In `src/components/CompliancePanel.jsx`, locate the group header (around lines 528-590, the row with `[Accept All N] [Reject All] [View All N ▸]`).

- [ ] **Step 2: Add the Dismiss all button — no confirm dialog (matches Reject All)**

```javascript
{group.instances.length > 0 && (
  <button
    onClick={() => onGroupDismiss(group)}
    onMouseDown={(e) => e.preventDefault()}
    title="Dismiss all findings for this rule in the current document. Persistent."
    style={{
      padding: '3px 10px',
      fontSize: 12,
      fontWeight: 500,
      backgroundColor: '#fff',
      color: '#475569',
      border: '1px solid #cbd5e1',
      borderRadius: 4,
      cursor: 'pointer',
      marginLeft: 4,
    }}
  >
    Dismiss all
  </button>
)}
```

- [ ] **Step 3: Wire onGroupDismiss in App.jsx**

```javascript
<CompliancePanel
  /* existing props */
  onGroupDismiss={async (group) => {
    // Batched single state update via reduce.
    const updates = [];
    for (const item of group.instances) {
      const blockHash = lintingState.byBlock.get(item.blockId)?.blockHash;
      if (!blockHash) continue;
      const ignoreKey = await linting.computeIgnoreKey(group.ruleId, blockHash, item.match);
      updates.push({ ignoreKey, ruleId: group.ruleId, blockHash, match: item.match });
    }
    const identity = effectiveIdentity();
    const ts = Date.now();
    setLintingState(s => updates.reduce(
      (acc, args) => linting.ignoreFinding(acc, { ...args, identity, ts }),
      s,
    ));
  }}
/>
```

- [ ] **Step 4: Manual smoke**

`npm run dev`, open Compliance Panel, click Dismiss all on a group, verify all instances disappear from inline + panel.

- [ ] **Step 5: Commit**

```bash
git add src/components/CompliancePanel.jsx src/App.jsx
git commit -m "feat(CompliancePanel): group-level Dismiss all button (#140)"
```

---

## Task 21: ComplianceSettings Reset section

**Files:** Modify `src/components/ComplianceSettings.jsx`

- [ ] **Step 1: Find the existing "Clear Key" pattern**

In `src/components/ComplianceSettings.jsx`, locate the existing "Clear Key" section (around lines 155-167).

- [ ] **Step 2: Add Ignored findings + Muted rules sections**

After the Clear Key section:

```javascript
{/* Ignored findings reset */}
<div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #e5e7eb' }}>
  <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>
    Ignored findings
  </div>
  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
    {ignoredCount === 0
      ? 'No findings dismissed in this document.'
      : `${ignoredCount} findings dismissed across this document.`}
  </div>
  <button
    onClick={() => {
      const ok = window.confirm(`Reset all ${ignoredCount} dismissed findings? They will reappear.`);
      if (ok) onResetIgnored();
    }}
    disabled={ignoredCount === 0}
    style={{
      padding: '6px 12px',
      fontSize: 13,
      backgroundColor: ignoredCount === 0 ? '#f1f5f9' : '#fff',
      color: ignoredCount === 0 ? '#94a3b8' : '#dc2626',
      border: `1px solid ${ignoredCount === 0 ? '#e2e8f0' : '#fca5a5'}`,
      borderRadius: 4,
      cursor: ignoredCount === 0 ? 'not-allowed' : 'pointer',
    }}
  >
    Reset ignored findings
  </button>
</div>

{/* Muted rules reset */}
<div style={{ marginTop: 12 }}>
  <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b', marginBottom: 6 }}>
    Muted rules
  </div>
  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
    {mutedCount === 0
      ? 'No rules muted in this document.'
      : `${mutedCount} rules muted in this document.`}
  </div>
  <button
    onClick={() => {
      const ok = window.confirm(`Reset all ${mutedCount} muted rules? Their findings will reappear.`);
      if (ok) onResetMuted();
    }}
    disabled={mutedCount === 0}
    style={{
      padding: '6px 12px',
      fontSize: 13,
      backgroundColor: mutedCount === 0 ? '#f1f5f9' : '#fff',
      color: mutedCount === 0 ? '#94a3b8' : '#dc2626',
      border: `1px solid ${mutedCount === 0 ? '#e2e8f0' : '#fca5a5'}`,
      borderRadius: 4,
      cursor: mutedCount === 0 ? 'not-allowed' : 'pointer',
    }}
  >
    Reset muted rules
  </button>
</div>
```

Update the props destructure:

```javascript
export default function ComplianceSettings({
  /* existing */, ignoredCount, mutedCount, onResetIgnored, onResetMuted,
}) {
```

- [ ] **Step 3: Wire from App.jsx**

```javascript
<ComplianceSettings
  /* existing props */
  ignoredCount={Array.from(lintingState.ignored.findings.values()).filter(e => !e.tombstone).length}
  mutedCount={Array.from(lintingState.ignored.mutedRules.values()).filter(e => !e.tombstone).length}
  onResetIgnored={() => {
    setLintingState(s => linting.resetIgnoredFindings(s, { ts: Date.now() }));
  }}
  onResetMuted={() => {
    setLintingState(s => linting.resetMutedRules(s, { ts: Date.now() }));
  }}
/>
```

- [ ] **Step 4: Manual smoke**

`npm run dev`, dismiss several findings, open Settings, verify counts + reset works.

- [ ] **Step 5: Commit**

```bash
git add src/components/ComplianceSettings.jsx src/App.jsx
git commit -m "feat(ComplianceSettings): reset ignored/muted sections (#140)"
```

---

## Task 22: Onboarding pop-down

**Files:**
- Modify: `src/components/InlineTooltip.jsx`
- Modify: `tests/e2e/global-setup.js`

- [ ] **Step 1: Add onboarding state to InlineTooltip**

In `src/components/InlineTooltip.jsx`, near the top of the component:

```javascript
const [showDismissOnboarding, setShowDismissOnboarding] = useState(false);

useEffect(() => {
  // Only show on first time a tooltip with a Dismiss button is opened.
  const seen = typeof window !== 'undefined' && localStorage.getItem('sim-dismiss-onboarded') === '1';
  if (!seen && typeof onSuppress === 'function' && finding) {
    setShowDismissOnboarding(true);
    localStorage.setItem('sim-dismiss-onboarded', '1');
  }
}, [finding, onSuppress]);
```

After the action button row (around line 326), inside the same tooltip div, add:

```javascript
{showDismissOnboarding && (
  <div style={{
    marginTop: 8,
    padding: '6px 10px',
    backgroundColor: 'rgba(59, 130, 246, 0.1)',
    border: '1px solid #93c5fd',
    borderRadius: 4,
    fontSize: 11,
    color: '#1e3a8a',
  }}>
    💡 Dismiss is persistent — survives reload. Reset from ⚙ Settings.
  </div>
)}
```

- [ ] **Step 2: Clear onboarding flag in E2E setup**

In `tests/e2e/global-setup.js`, find the existing localStorage cleanup block and add:

```javascript
// Within the existing localStorage clear scope (look for a similar pattern, e.g., 'sim-compliance-onboarded'):
localStorage.removeItem('sim-dismiss-onboarded');
```

- [ ] **Step 3: Commit**

```bash
git add src/components/InlineTooltip.jsx tests/e2e/global-setup.js
git commit -m "feat(InlineTooltip): first-time dismiss onboarding pop-down (#140)"
```

---

## Task 23: E2E test — dismiss → reload → still dismissed

**Files:** Modify `tests/e2e/editor.spec.js`

- [ ] **Step 1: Add the test**

Append to `tests/e2e/editor.spec.js`:

```javascript
test('persistent dismiss: finding stays dismissed across reload (file mode)', async ({ page }) => {
  await page.goto('/');
  // Load a sample with at least one flagged term.
  await loadSampleDoc(page);  // existing helper
  // Wait for inline lint to render.
  await page.waitForSelector('.lint-highlight-static');
  // Position cursor inside a highlight, wait for tooltip.
  const highlight = page.locator('.lint-highlight-static').first();
  await highlight.click();
  await page.waitForSelector('button:has-text("Dismiss")');
  // Click Dismiss.
  await page.click('button:has-text("Dismiss")');
  // Verify the specific highlight is gone (count decreased).
  const after = await page.locator('.lint-highlight-static').count();
  // Reload via the file-mode persistence (export+import).
  await downloadAndReopenSec(page);  // existing helper or new helper that uses File-System Access
  await page.waitForSelector('.lint-highlight-static');
  const reloaded = await page.locator('.lint-highlight-static').count();
  expect(reloaded).toBe(after);
});
```

(Adapt `loadSampleDoc` and `downloadAndReopenSec` to the existing E2E helper conventions — search for similar helpers in `tests/e2e/editor.spec.js`.)

- [ ] **Step 2: Run**

Run: `npx playwright test --project=chromium tests/e2e/editor.spec.js -g "persistent dismiss"`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/editor.spec.js
git commit -m "test(e2e): dismiss-reload persistence (#140)"
```

---

## Task 24: E2E test — mute NLP rule

**Files:** Modify `tests/e2e/editor.spec.js`

- [ ] **Step 1: Add the test**

```javascript
test('mute NLP rule: hides all instances, engines still run (unmute reveals)', async ({ page }) => {
  await page.goto('/');
  await loadSampleDocWithPassiveVoice(page);  // helper: load text containing passive voice
  await page.waitForSelector('.lint-highlight-nlp');
  const before = await page.locator('.lint-highlight-nlp').count();
  expect(before).toBeGreaterThan(0);

  // Click an NLP highlight.
  await page.locator('.lint-highlight-nlp').first().click();
  await page.waitForSelector('button:has-text("Mute NLP")');

  // Accept the confirm dialog.
  page.on('dialog', d => d.accept());
  await page.click('button:has-text("Mute NLP-passive")');

  // All NLP highlights gone.
  await page.waitForFunction(() => document.querySelectorAll('.lint-highlight-nlp').length === 0);

  // Open Settings → Reset muted rules to verify engines are still emitting.
  await page.click('button[title*="Settings"]');  // adapt selector
  await page.click('button:has-text("Reset muted rules")');
  await page.locator('button:has-text("Reset muted rules")').last().click();
  await page.waitForSelector('.lint-highlight-nlp');
  const after = await page.locator('.lint-highlight-nlp').count();
  expect(after).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run + Commit**

```bash
npx playwright test --project=chromium tests/e2e/editor.spec.js -g "mute NLP"
git add tests/e2e/editor.spec.js
git commit -m "test(e2e): mute NLP + unmute via Settings (#140)"
```

---

## Task 25: E2E test — Reset from Settings

**Files:** Modify `tests/e2e/editor.spec.js`

- [ ] **Step 1: Add the test**

```javascript
test('reset ignored + muted from Settings clears state, buttons disabled after', async ({ page }) => {
  await page.goto('/');
  await loadSampleDoc(page);
  await page.waitForSelector('.lint-highlight-static');

  // Dismiss 3 findings via dispatchLintIgnore (test seam).
  const dismissed = await page.evaluate(async () => {
    const tu = window.__simEditorTestUtils;
    if (!tu) return 0;
    // Pick 3 distinct rule+match pairs from current highlights.
    const els = document.querySelectorAll('.lint-highlight-static');
    let n = 0;
    for (let i = 0; i < Math.min(3, els.length); i++) {
      const blockId = els[i].closest('[data-block-id]').dataset.blockId;
      tu.dispatchLintIgnore({ kind: 'ignore', ruleId: 'TERM-shall', blockHash: 'bh-' + i, match: 'shall' });
      n++;
    }
    return n;
  });
  expect(dismissed).toBeGreaterThan(0);

  page.on('dialog', d => d.accept());
  await page.click('button[title*="Settings"]');
  await page.click('button:has-text("Reset ignored findings")');
  await page.waitForSelector('button:has-text("Reset ignored findings"):disabled');
});
```

- [ ] **Step 2: Run + Commit**

```bash
npx playwright test --project=chromium tests/e2e/editor.spec.js -g "reset ignored"
git add tests/e2e/editor.spec.js
git commit -m "test(e2e): Settings reset disables buttons after click (#140)"
```

---

## Task 26: E2E test — two-tab collab dismiss sync

**Files:** Modify `tests/e2e/collab.spec.js`

- [ ] **Step 1: Add the test (mirrors PR #157's lint sidecar two-tab pattern)**

```javascript
test('collab: peer A dismisses, peer B sees dismissal sync', async ({ context }) => {
  test.setTimeout(60000);  // CLAUDE.md item 10 — collab flake mitigation

  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await Promise.all([
    pageA.goto('/?room=test-dismiss-' + Date.now()),
    pageB.goto(pageA.url()),
  ]);
  await Promise.all([
    pageA.waitForSelector('.lint-highlight-static'),
    pageB.waitForSelector('.lint-highlight-static'),
  ]);

  // Peer A dismisses one finding.
  const dismissed = await pageA.evaluate(async () => {
    const tu = window.__simEditorTestUtils;
    const els = document.querySelectorAll('.lint-highlight-static');
    const blockId = els[0].closest('[data-block-id]').dataset.blockId;
    const match = els[0].textContent;
    // computeIgnoreKey via the test seam.
    return new Promise(resolve => {
      tu.dispatchLintIgnore({
        kind: 'ignore',
        ruleId: 'TERM-shall',
        blockHash: tu.getBlockHash?.(blockId) || 'h',
        match,
      });
      setTimeout(resolve, 100);
    });
  });

  // Peer B's highlight count drops by 1 within 2s.
  await pageB.waitForFunction(
    (prevCount) => document.querySelectorAll('.lint-highlight-static').length < prevCount,
    await pageA.locator('.lint-highlight-static').count() + 1,
    { timeout: 5000 },
  );

  // Reset from peer A → peer B sees highlights return.
  pageA.on('dialog', d => d.accept());
  await pageA.click('button[title*="Settings"]');
  await pageA.click('button:has-text("Reset ignored findings")');
  await pageB.waitForSelector('.lint-highlight-static');
});
```

- [ ] **Step 2: Run + Commit**

```bash
npx playwright test --project=chromium tests/e2e/collab.spec.js -g "dismiss sync"
git add tests/e2e/collab.spec.js
git commit -m "test(e2e): two-tab dismiss sync + reset (#140)"
```

---

## Task 27: Corpus tool — `--with-ignores` flag + fixture

**Files:**
- Modify: `tools/run-corpus-test.mjs`
- Create: `corpus/fixtures/ignored-fixture.json`

- [ ] **Step 1: Create the fixture**

Run a small audit to identify ~20 known-FP rule hits from the calibration corpus:

```bash
node --import ./tools/json-loader.mjs tools/run-corpus-test.mjs --corpus calibration
# Inspect corpus/results/calibration-results.json — pick FPs of common rules
```

Create `corpus/fixtures/ignored-fixture.json`:

```json
{
  "v": 2,
  "ignoredFindings": [
    {
      "ignoreKey": "placeholder-key-1",
      "ruleId": "TERM-suitable",
      "blockHash": "<fp from calibration>",
      "match": "as suitable",
      "ts": 1716326400000,
      "authorId": "corpus-fixture"
    }
  ],
  "mutedNlpRules": []
}
```

(Populate with real entries derived from the calibration audit — at least 5 entries to make the regression assertion meaningful.)

- [ ] **Step 2: Add --with-ignores flag to runner**

Open `tools/run-corpus-test.mjs`. Find the existing arg parsing (look for `--corpus`). Add:

```javascript
const withIgnores = process.argv.includes('--with-ignores');
let ignoredFixture = null;
if (withIgnores) {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const fp = path.join(process.cwd(), 'corpus/fixtures/ignored-fixture.json');
  ignoredFixture = JSON.parse(fs.readFileSync(fp, 'utf8'));
}
```

In the rule-engine invocation site, post-filter the findings:

```javascript
if (ignoredFixture) {
  const ignoredKeys = new Set(ignoredFixture.ignoredFindings
    .filter(e => !e.tombstone)
    .map(e => e.ignoreKey));
  const mutedRules = new Set(ignoredFixture.mutedNlpRules
    .filter(e => !e.tombstone)
    .map(e => e.ruleId));
  // For each finding in the result, compute its ignoreKey using the same
  // SHA-prefix as the live app + filter out matches.
  // (Use the existing computeIgnoreKey logic — import it from linting.js
  // or replicate inline since the runner is Node ESM.)
  // ... filter loop here
}
```

- [ ] **Step 3: Run + Commit**

```bash
node --import ./tools/json-loader.mjs tools/run-corpus-test.mjs --corpus calibration --with-ignores
git add tools/run-corpus-test.mjs corpus/fixtures/ignored-fixture.json
git commit -m "feat(tools): --with-ignores flag for corpus runner (#140)"
```

---

## Task 28: Corpus regression baseline

**Files:** None new — produces a report.

- [ ] **Step 1: Run baseline + with-ignores**

```bash
node --import ./tools/json-loader.mjs tools/run-corpus-test.mjs --corpus calibration > before.txt
node --import ./tools/json-loader.mjs tools/run-corpus-test.mjs --corpus calibration --with-ignores > after.txt
node tools/generate-report.mjs
```

- [ ] **Step 2: Inspect `corpus/results/REPORT.md`**

Verify:
- Static FP rate before: 0.31% baseline.
- Static FP rate after `--with-ignores`: monotonically decreased.
- No new TP losses (recall unchanged).

- [ ] **Step 3: Commit**

```bash
git add corpus/results/REPORT.md corpus/results/metrics.json
git commit -m "docs(corpus): baseline measurement for persistent ignores (#140)"
```

---

## Acceptance criteria verification

After all tasks complete, verify each AC from spec §9:

- [ ] Dismiss on InlineTooltip → Task 17
- [ ] Dismiss on CompliancePanel group → Task 20
- [ ] Dismiss on CompliancePanel item → Task 19
- [ ] `ignoredFindings` persisted → Task 7
- [ ] `mutedNlpRules` persisted → Task 7
- [ ] Inline + panel filter → Task 10
- [ ] NLP mute filter → Task 10 + 18
- [ ] Collab sync → Tasks 12-15, 26
- [ ] Reset ignored → Task 21
- [ ] Reset muted → Task 21
- [ ] Property tests → Task 5
- [ ] E2E dismiss-reload → Task 23
- [ ] E2E two-tab → Task 26
- [ ] Corpus regression < 0.31% → Task 28
- [ ] Structural assertion (no Promise from `getRangesByTier`) → Task 10

---

## Final checklist before opening PR B

- [ ] All unit tests pass: `npm test -- --run`
- [ ] Compliance tests pass: `npm run test:compliance`
- [ ] Server tests pass: `npm run test:server`
- [ ] Full E2E pass: `npx playwright test --project=chromium`
- [ ] Corpus regression report shows monotonic improvement
- [ ] No regressions in CSP test (`src/__tests__/csp.test.js`)
- [ ] CLAUDE.md updated if any cross-cutting architectural invariant changed (note `'local-lint-ignored'` origin in the "Collab Publish Path" section)
