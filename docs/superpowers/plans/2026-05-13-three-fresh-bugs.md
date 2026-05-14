# Three Fresh Bugs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three `needs-triage` bugs filed during the PR #69 smoke test ([#76](https://github.com/mttvnst-HA/secwriter/issues/76), [#77](https://github.com/mttvnst-HA/secwriter/issues/77), [#78](https://github.com/mttvnst-HA/secwriter/issues/78)) so the local-dev console is clean on a fresh checkout.

**Architecture:** Three independent fixes, three feature branches, three PRs. #76 is a mechanical CSP + default-URL edit. #77 is a missed skeleton-then-populate site in the substrate writer (and a diagnostic step in case more sites exist). #78 is a React `setState`-during-render warning whose root cause needs live reproduction first; the plan includes a diagnostic task that produces the finding, then a fix task. Each bug gets its own regression test that fails before the fix and passes after.

**Tech Stack:** React 18 + Yjs + y-prosemirror; Vitest for unit/integration tests; Playwright for E2E.

---

## Branch & PR strategy

1. Three feature branches off `main`: `fix/76-collab-port-mismatch`, `fix/77-yjs-invalid-access`, `fix/78-setstate-in-render`.
2. One PR per branch.
3. Each PR's verification command is documented in its task.
4. Task 1 (#76) is independent of Tasks 2 and 3.
5. Tasks 2 and 3 may share an underlying cause (synchronous Yjs mutation during render) — recommended order is Task 2 first, then re-test Task 3 to see if it auto-resolved before doing the diagnostic.

---

## File Structure

- **Task 1 (#76):**
  - Modify: `src/lib/collab.js:74` (one-character change in default HTTP URL).
  - Modify: `index.html:7` (two host:port literals in CSP `connect-src`).
  - Modify: `src/lib/__tests__/csp.test.js` (add a port-specific assertion so any future regression is caught at CI time).

- **Task 2 (#77):**
  - Modify: `src/lib/collab.js:561-568` (reorder the defensive recovery branch to skeleton-then-populate).
  - Create: `src/lib/__tests__/collab-defensive-fallback.test.js` (regression test for the reordered branch).
  - Modify: `src/lib/__tests__/block-html-store.test.js` (add a "no Yjs warnings emitted on a healthy load sequence" assertion if one doesn't already exist).

- **Task 3 (#78):**
  - Create: `src/components/__tests__/render-no-react-warnings.test.jsx` (mount-trap that fails when React emits the setState-during-render warning).
  - Modify: `src/App.jsx:147-153` (move `seedBlockArray` out of the `useState` lazy initializer into a `useEffect` with a ref guard — primary hypothesis fix). If the diagnostic step in 3.5 names a different culprit, the modify target shifts to that file; the fix shape stays the same (move the offending Yjs mutation out of the render phase).

---

## Task 1: Fix local-dev collab port mismatch (#76)

**Files:**
- Modify: `src/lib/collab.js:74`
- Modify: `index.html:7`
- Modify: `src/lib/__tests__/csp.test.js` (add port assertion)

- [ ] **Step 1.1: Create branch and verify reproduction**

```bash
git checkout main
git pull
git checkout -b fix/76-collab-port-mismatch
```

In two terminals, run:
```bash
npm run dev
npm run collab
```

Open `http://localhost:5173/` with DevTools Console open. Expected before fix: CSP violation errors for `http://127.0.0.1:1235/rooms` when the splash page tries to list rooms.

- [ ] **Step 1.2: Update default HTTP URL in `src/lib/collab.js`**

Change line 74 from:
```js
export const DEFAULT_HTTP_URL = import.meta.env?.VITE_COLLAB_HTTP_URL || 'http://127.0.0.1:1235';
```
to:
```js
export const DEFAULT_HTTP_URL = import.meta.env?.VITE_COLLAB_HTTP_URL || 'http://127.0.0.1:1234';
```

- [ ] **Step 1.3: Update CSP `connect-src` in `index.html`**

In line 7, find:
```
http://127.0.0.1:1235 http://localhost:1235
```
and replace with:
```
http://127.0.0.1:1234 http://localhost:1234
```

- [ ] **Step 1.4: Add port-specific assertion to `src/lib/__tests__/csp.test.js`**

Append a new `it()` inside the existing `describe('CSP guardrail', ...)` block:

```js
it('CSP connect-src loopback origins use port 1234 (matching server/collab-server.cjs)', () => {
    const match = csp.match(/connect-src\s+([^;]+)/i);
    expect(match, 'CSP must have an explicit connect-src directive').toBeTruthy();
    const sources = match[1].trim().split(/\s+/);
    const loopback = sources.filter((s) => {
      const host = hostOf(s);
      return host && LOOPBACK_HOSTS.has(host);
    });
    const wrongPort = loopback.filter((s) => {
      try {
        const u = new URL(s);
        return u.port && u.port !== '1234';
      } catch {
        return false;
      }
    });
    if (wrongPort.length > 0) {
      throw new Error(
        'CSP loopback origin on wrong port (server listens on 1234):\n  ' +
        wrongPort.join('\n  '),
      );
    }
    expect(wrongPort).toEqual([]);
  });
```

- [ ] **Step 1.5: Run the CSP test**

```bash
npx vitest run src/lib/__tests__/csp.test.js
```

Expected: all 4 tests pass (the original 3 plus the new port assertion).

- [ ] **Step 1.6: Run the full unit suite**

```bash
npm test
```

Expected: green. If anything red, investigate — the port change should not affect other tests.

- [ ] **Step 1.7: Manual smoke**

Restart `npm run dev`. Open `http://localhost:5173/`. DevTools Console should be free of `http://127.0.0.1:1235` CSP errors. Click the splash-page rooms list — it should populate from the server.

- [ ] **Step 1.8: Commit**

```bash
git add src/lib/collab.js index.html src/lib/__tests__/csp.test.js
git commit -m "$(cat <<'EOF'
fix(collab): align local-dev default URLs + CSP to port 1234

Server consolidated to a single listener on 1234 for both HTTP and
WebSocket; the frontend defaults and CSP allowlist still referenced
1235, breaking room listing on a fresh checkout without env overrides.

Closes #76

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 1.9: Push and open PR**

```bash
git push -u origin fix/76-collab-port-mismatch
"C:\Program Files\GitHub CLI\gh.exe" pr create --title "fix(collab): align local-dev default URLs + CSP to port 1234 (#76)" --body "$(cat <<'EOF'
## Summary
- Fixes #76 — frontend defaults and CSP allowlist referenced port 1235; server listens on 1234.
- Adds a port-specific assertion to csp.test.js so a regression is caught by CI.

## Test plan
- [ ] Vitest green (`npm test`).
- [ ] Manual smoke: fresh `npm run dev` + `npm run collab`, no CSP errors in console, splash-page rooms list populates.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Task 2: Fix Y.XmlFragment "Invalid access" warning flood (#77)

**Files:**
- Modify: `src/lib/collab.js:561-568`
- Create: `src/lib/__tests__/collab-defensive-fallback.test.js`

**Primary suspect (from static analysis):** the defensive recovery branch in `updateYMapFromBlock` at `src/lib/collab.js:561-568` constructs a detached `Y.XmlFragment`, calls `prosemirrorToYXmlFragment` against it, and only attaches it via `ymap.set('html', yXml)` afterward. This is the warning-flood pattern CLAUDE.md documents under "Nine non-obvious invariants → Y.XmlFragment construction must be skeleton-then-populate." The other call sites (`seedYBlocks`, `blockToYMapSkeleton` + `populateBlockHtml`, `block-html-store.js seedHtmlSlot`) already use the correct order; this one was missed.

**Diagnostic note:** the defensive branch only fires when the html slot is missing or has an unrecognized shape. On a healthy fresh load, the slot is a Y.XmlFragment and the branch is skipped — so this suspect may not account for all 3-5 warnings per load reported in the issue. Step 2.2 captures console.warn during a representative mount sequence; if the count is non-zero AFTER fixing the defensive branch, Step 2.6 adds a diagnostic step to locate the remaining site(s).

- [ ] **Step 2.1: Create branch**

```bash
git checkout main
git pull
git checkout -b fix/77-yjs-invalid-access
```

- [ ] **Step 2.2: Write a failing regression test that captures Yjs warnings during a healthy load**

Create `src/lib/__tests__/collab-defensive-fallback.test.js`:

```js
/**
 * Regression test for issue #77 — Y.XmlFragment defensive-recovery branch
 * in updateYMapFromBlock must skeleton-then-populate, not detached-then-attach.
 *
 * Also asserts that a healthy seed + applyBlocksToYDoc sequence (the shape
 * App.jsx runs on every fresh out-of-room mount) emits ZERO
 * "Invalid access: Add Yjs type to a document before reading data" warnings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { applyBlocksToYDoc } from '../collab.js';
import { seedBlockArray } from '../block-html-store.js';

const SAMPLE_BLOCKS = [
  { id: 'n1', type: 'title', html: 'Section Title' },
  { id: 'n2', type: 'txt', part: 1, depth: 0, html: 'Para one.' },
  { id: 'n3', type: 'txt', part: 1, depth: 0, html: 'Para two.' },
];

describe('issue #77 — no Y.XmlFragment "Invalid access" warnings on healthy load', () => {
  let warnSpy;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('seedBlockArray + applyBlocksToYDoc on default sample emits no Yjs warnings', () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    seedBlockArray(ydoc, yOrder, yStore, SAMPLE_BLOCKS);
    applyBlocksToYDoc(ydoc, yOrder, yStore, SAMPLE_BLOCKS);

    const offending = warnSpy.mock.calls.filter((args) =>
      String(args[0] ?? '').includes('Add Yjs type to a document before reading data'),
    );
    expect(offending).toEqual([]);
  });

  it('updateYMapFromBlock defensive recovery does not emit warnings on malformed slot', () => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');

    // Stand up a Y.Map whose html slot is missing — forces the defensive
    // branch at collab.js:561-568.
    ydoc.transact(() => {
      const yMap = new Y.Map();
      yMap.set('id', 'n1');
      yMap.set('type', 'txt');
      // intentionally no html slot
      yStore.set('n1', yMap);
      yOrder.push(['n1']);
    });

    applyBlocksToYDoc(ydoc, yOrder, yStore, [{ id: 'n1', type: 'txt', html: 'hello' }]);

    const offending = warnSpy.mock.calls.filter((args) =>
      String(args[0] ?? '').includes('Add Yjs type to a document before reading data'),
    );
    expect(offending).toEqual([]);
  });
});
```

- [ ] **Step 2.3: Run the new test — verify the defensive-branch case fails before the fix**

```bash
npx vitest run src/lib/__tests__/collab-defensive-fallback.test.js
```

Expected:
1. The first test ("healthy load") may pass or fail depending on whether other sites also leak warnings. Note the result.
2. The second test ("defensive recovery") fails with one or more "Add Yjs type to a document before reading data" warnings captured.

- [ ] **Step 2.4: Fix the defensive recovery branch in `src/lib/collab.js`**

Find lines 561-568:

```js
  if (!isYXmlFragment && !isYText) {
    // Truly missing or malformed slot — defensive recovery. Use the v2
    // shape (Y.XmlFragment) so we don't drop the doc back to v1.
    const yXml = new Y.XmlFragment();
    const pmNode = htmlToPmFragment(typeof block.html === 'string' ? block.html : '');
    prosemirrorToYXmlFragment(pmNode, yXml);
    ymap.set('html', yXml);
  }
```

Replace with the skeleton-then-populate order:

```js
  if (!isYXmlFragment && !isYText) {
    // Truly missing or malformed slot — defensive recovery. Use the v2
    // shape (Y.XmlFragment) so we don't drop the doc back to v1.
    //
    // ATTACH the fragment to the parent yMap BEFORE prosemirrorToYXmlFragment
    // populates it. y-prosemirror's diff-and-merge calls toArray() during
    // populate; on a detached fragment that fires the "Invalid access: Add
    // Yjs type to a document before reading data" warning (issue #77,
    // CLAUDE.md "Nine non-obvious invariants"). The other Y.XmlFragment
    // construction sites in this file (blockToYMapSkeleton + populateBlockHtml
    // in seedYBlocks/applyBlocksToYDoc) already enforce this order; this
    // defensive branch was missed when the original fix landed.
    const yXml = new Y.XmlFragment();
    ymap.set('html', yXml);
    const pmNode = htmlToPmFragment(typeof block.html === 'string' ? block.html : '');
    prosemirrorToYXmlFragment(pmNode, yXml);
  }
```

- [ ] **Step 2.5: Run the test again — verify the defensive-branch case passes**

```bash
npx vitest run src/lib/__tests__/collab-defensive-fallback.test.js
```

Expected: the second test (defensive recovery) now passes with zero warnings.

If the first test (healthy load) still fails, proceed to Step 2.6 to find the other leaking call site. If it passes, skip to Step 2.7.

- [ ] **Step 2.6 (conditional — only if Step 2.5 leaves Step 2.2's first test red): diagnose remaining call sites**

Run this in the test file to enable a stack-trace dump on every offending warning:

```js
// Add temporarily inside beforeEach, BEFORE the mockImplementation
const origWarn = console.warn;
warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args) => {
  if (String(args[0] ?? '').includes('Add Yjs type to a document before reading data')) {
    origWarn('--- offending warning, stack follows ---');
    origWarn(new Error('captured-here').stack);
  }
});
```

Run `npx vitest run src/lib/__tests__/collab-defensive-fallback.test.js`. Read the stack trace. The first non-test frame in the stack identifies the call site.

Suspect call sites worth checking before running this:
1. `src/lib/block-html-store.js:99-108` (`seedHtmlSlot`) — already attaches before populate; verify line numbers haven't drifted.
2. `src/lib/collab.js:483-489` (`seedYBlocks`) — already attaches before populate.
3. `src/lib/collab.js:611-616` (`applyBlocksToYDoc` new-block branch) — already attaches before populate.
4. Any new `Y.XmlFragment` constructor introduced since CLAUDE.md was last updated — `grep -rn 'new Y\.XmlFragment'` in `src/`.

Apply the same skeleton-then-populate fix to whatever site the stack trace identifies, then re-run Step 2.5.

- [ ] **Step 2.7: Run the full unit suite**

```bash
npm test
```

Expected: green.

- [ ] **Step 2.8: Manual smoke**

```bash
npm run dev
npm run collab
```

Open `http://localhost:5173/` and `http://localhost:5173/?pm=1`. DevTools Console should be free of "Invalid access: Add Yjs type to a document before reading data" warnings in both modes, in-room and out-of-room.

- [ ] **Step 2.9: Commit**

```bash
git add src/lib/collab.js src/lib/__tests__/collab-defensive-fallback.test.js
git commit -m "$(cat <<'EOF'
fix(collab): skeleton-then-populate in defensive Y.XmlFragment recovery

The defensive recovery branch in updateYMapFromBlock created a detached
Y.XmlFragment and called prosemirrorToYXmlFragment against it BEFORE
attaching to the parent yMap. y-prosemirror's diff-and-merge reads via
toArray() during populate; on a detached fragment that fires the
"Invalid access: Add Yjs type to a document before reading data" warning.

The seedYBlocks and blockToYMapSkeleton paths already enforce attach-
before-populate; this fallback was missed.

Closes #77

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2.10: Push and open PR**

```bash
git push -u origin fix/77-yjs-invalid-access
"C:\Program Files\GitHub CLI\gh.exe" pr create --title "fix(collab): skeleton-then-populate in defensive Y.XmlFragment recovery (#77)" --body "$(cat <<'EOF'
## Summary
- Fixes #77 — Y.XmlFragment "Invalid access" warning flood on editor load.
- Reorders the defensive recovery branch in updateYMapFromBlock to attach the fragment to the parent yMap BEFORE prosemirrorToYXmlFragment populates it.
- Adds regression test capturing console.warn during a healthy load + during the defensive recovery path.

## Test plan
- [ ] Vitest green (`npm test`), specifically `collab-defensive-fallback.test.js` passes.
- [ ] Manual smoke: `npm run dev` + `npm run collab`, load `localhost:5173/` and `localhost:5173/?pm=1`, no "Invalid access" warnings in console.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Task 3: Fix React setState-during-render warning (#78)

**Files:**
- Create: `src/components/__tests__/render-no-react-warnings.test.jsx`
- Modify: TBD — identified by the diagnostic step.

**Diagnostic context:** the warning trace points at `src/lib/block-html-store.js:193` (the `listener()` call inside `subscribeBlock`'s `onHtml` callback). `listener` is the `notify` function React passes into `useSyncExternalStore`'s subscribe. For `notify` to fire during `SpecEditor`'s render means a Yjs observer fired during a render — either:

1. **Synchronous Yjs mutation in a render path.** Some `useMemo`, render-time helper, or child-component render is mutating yStore / a Y.XmlFragment.
2. **`useState` lazy initializer side effect under StrictMode.** `src/main.jsx:46` enables `React.StrictMode`; React 18 runs `useState` lazy initializers twice in dev to surface impure init code. `App.jsx:147-153` seeds the local Y.Doc inside its initializer via `seedBlockArray`. A child `LegacyEditableBlock`'s subscription from the FIRST (discarded) initializer pass may still be observing the discarded ydoc when the SECOND pass re-seeds, firing `listener()` during the second render.
3. **`getSnapshot` not being pure.** `useBlockBinder.js` calls `getBlockHtml` which calls `getCached` which registers an observer on first call. Registering should not fire the observer, but worth verifying.

The diagnostic step traps the warning at mount time and reads the React-emitted stack trace to identify the responsible call site.

- [ ] **Step 3.1: Create branch**

```bash
git checkout main
git pull
git checkout -b fix/78-setstate-in-render
```

- [ ] **Step 3.2: Re-test against `main` after Task 2 lands**

If Task 2's PR has merged before this task starts, pull main and check whether #78 still reproduces:

```bash
npm run dev
```

Load `http://localhost:5173/`, check console. If the React warning is gone, document the finding in this task's PR description and skip to Step 3.10 (close as fixed-by-#77). If it still reproduces, continue.

- [ ] **Step 3.3: Write a failing test that captures the React warning on mount**

Create `src/components/__tests__/render-no-react-warnings.test.jsx`:

```jsx
/**
 * Regression test for issue #78 — no React "Cannot update a component while
 * rendering a different component" warnings on initial mount of SpecEditor.
 *
 * The warning is React 18's setState-during-render detector. It fires when
 * a render path schedules an update on a different component synchronously.
 * In SecWriter, the culprit is a Yjs observer firing `listener()` (from
 * useSyncExternalStore) during SpecEditor's render — block-html-store.js:193.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

// Import lazily inside the test so the StrictMode + render path mirrors main.jsx.

describe('issue #78 — no setState-during-render warnings on SpecEditor mount', () => {
  let errorSpy;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('mounting SpecEditor under StrictMode emits no setState-in-render warnings', async () => {
    const { default: SpecEditor } = await import('../../App.jsx');
    render(
      <React.StrictMode>
        <SpecEditor />
      </React.StrictMode>,
    );
    const offending = errorSpy.mock.calls.filter((args) =>
      String(args[0] ?? '').includes('Cannot update a component') &&
      String(args[0] ?? '').includes('while rendering a different component'),
    );
    if (offending.length > 0) {
      throw new Error(
        'React setState-in-render warning fired during SpecEditor mount:\n' +
        offending.map((a) => a.join(' ')).join('\n'),
      );
    }
    expect(offending).toEqual([]);
  });
});
```

- [ ] **Step 3.4: Run the new test — verify it fails**

```bash
npx vitest run src/components/__tests__/render-no-react-warnings.test.jsx
```

Expected: fails with the React warning. The captured error message includes the component name and a stack-trace link. Note any test setup gaps (e.g. missing jsdom config, missing test environment) — fix those first if they block the test from reaching the actual warning.

- [ ] **Step 3.5: Locate the synchronous Yjs mutation that fires during render**

Add a temporary debug hook in `src/lib/block-html-store.js`, inside the `onHtml` closure at the existing line 188 area:

```js
const onHtml = () => {
    if (yHtml) {
      const entry = cache.get(yHtml);
      if (entry) entry.dirty = true;
    }
    // TEMPORARY DEBUG (issue #78): dump the stack on every notify so we
    // can see who triggered the Yjs op. Remove before commit.
    // eslint-disable-next-line no-console
    console.warn('issue-78-debug: subscribeBlock listener fired', new Error('stack').stack);
    listener();
};
```

Re-run the test or the dev server. Read the stack trace. The first non-`block-html-store.js` frame in the trace identifies the render-phase mutation.

Hypotheses (in priority order):
1. The `useState` lazy initializer at `src/App.jsx:147-153` running for a second time under StrictMode, while observers from the first (discarded) pass are still attached. **If confirmed**, the fix is to move `seedBlockArray` out of the lazy initializer into a `useEffect` that runs after first commit, AND make `subscribeBlock` resilient to substrate identity changes (it already is — see lines 213-225). Likely shape: `useState(() => createEmptySubstrate())` then `useEffect(() => seedBlockArray(...), [])`.
2. A `useMemo` or render-time helper calling `setBlockHtml` / `applyBlocksToYDoc`. Use the Grep tool with pattern `setBlockHtml\(|applyBlocksToYDoc\(` in `src/App.jsx` to confirm each call site is inside an event handler or `useEffect`, not a render-time expression.
3. `getCached` triggering an observer fire via its `observeDeep`/`observe` registration. Inspect `block-html-store.js:80-90`; verify that observer registration in Yjs does not fire the observer immediately (it should not — Yjs observers fire on transactions, not on attach).

- [ ] **Step 3.6: Remove the debug hook**

Revert the temporary `console.warn` added in Step 3.5.

- [ ] **Step 3.7: Write the minimal fix**

The exact fix depends on Step 3.5's finding. Most likely fix shapes:

**If hypothesis 1 (StrictMode + useState lazy init):**

Change `src/App.jsx:147-153` from:
```js
  const [localSubstrate] = useState(() => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    seedBlockArray(ydoc, yOrder, yStore, INITIAL_BLOCKS);
    return { ydoc, yOrder, yStore };
  });
```
to:
```js
  const [localSubstrate] = useState(() => {
    const ydoc = new Y.Doc();
    const yOrder = ydoc.getArray('order');
    const yStore = ydoc.getMap('store');
    return { ydoc, yOrder, yStore };
  });
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (localSubstrate.yOrder.length === 0 && localSubstrate.yStore.size === 0) {
      seedBlockArray(
        localSubstrate.ydoc,
        localSubstrate.yOrder,
        localSubstrate.yStore,
        INITIAL_BLOCKS,
      );
    }
  }, [localSubstrate]);
```

The `seedBlockArray` precondition (`yOrder.length === 0 && yStore.size === 0`) is still enforced; the `seededRef` guard prevents a second seed on StrictMode's double-effect.

**If hypothesis 2 (render-time mutation):** move the offending call into an event handler or `useEffect`. The exact site is named by Step 3.5's stack trace; apply the same shape as hypothesis 1's fix (extract the mutation into a post-commit effect with a ref guard against double-execution under StrictMode).

**If hypothesis 3 (observer fire on attach):** Yjs `observe` / `observeDeep` do NOT fire on registration in Yjs 13.x (verified in `node_modules/yjs/src/utils/EventHandler.js`), so this hypothesis is unlikely. If Step 3.5 nonetheless points at the registration path, the fix is to wrap the initial-attach `listener()` call (if added) in a `queueMicrotask` so it runs after the current render completes.

- [ ] **Step 3.8: Run the test — verify it passes**

```bash
npx vitest run src/components/__tests__/render-no-react-warnings.test.jsx
```

Expected: green.

- [ ] **Step 3.9: Run the full unit suite + targeted E2E**

```bash
npm test
npx playwright test tests/e2e/editor.spec.js --project=chromium
```

Expected: both green. The seed-in-effect change at `App.jsx:147-153` is on the critical out-of-room mount path; the editor E2E suite covers it end-to-end.

- [ ] **Step 3.10: Manual smoke**

```bash
npm run dev
```

Load `http://localhost:5173/`. DevTools Console should be free of:
1. "Cannot update a component (`LegacyEditableBlock`) while rendering a different component (`SpecEditor`)" — the issue #78 warning.
2. Any new errors introduced by the fix (in particular, the editor must mount with the default sample blocks visible).

- [ ] **Step 3.11: Commit**

```bash
git add src/components/__tests__/render-no-react-warnings.test.jsx src/App.jsx
# (and any other file Step 3.7 touched)
git commit -m "$(cat <<'EOF'
fix(app): seed local substrate in effect, not in useState initializer

React 18 StrictMode runs useState lazy initializers twice in dev to
surface impure init code. The local Y.Doc was seeded inside the
initializer, so a subscribed binder from the first (discarded) pass
fired listener() during the second pass's render — surfacing as the
"Cannot update a component while rendering a different component"
warning at block-html-store.js:193.

Move seedBlockArray into a useEffect with a ref guard. The
preconditions (yOrder/yStore empty before seed) remain enforced.

Closes #78

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(Update the commit body if Step 3.5's diagnosis identified a different root cause.)

- [ ] **Step 3.12: Push and open PR**

```bash
git push -u origin fix/78-setstate-in-render
"C:\Program Files\GitHub CLI\gh.exe" pr create --title "fix(app): no setState-in-render warning on SpecEditor mount (#78)" --body "$(cat <<'EOF'
## Summary
- Fixes #78 — React 18 setState-in-render warning at `block-html-store.js:193` on mount.
- Moves `seedBlockArray` out of the `useState` lazy initializer (called twice under StrictMode in dev) into a `useEffect` with a ref guard, so the second initializer pass doesn't fire observers from the first pass's discarded substrate during render. (Adjust this bullet if Step 3.5 named a different culprit.)
- Adds regression test that traps the warning via console.error spy.

## Test plan
- [ ] Vitest green (`npm test`), `render-no-react-warnings.test.jsx` passes.
- [ ] Editor E2E green (`npx playwright test tests/e2e/editor.spec.js`).
- [ ] Manual smoke: `npm run dev`, no React warnings, default sample blocks visible.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Verification matrix (post-merge)

After all three PRs land, on a fresh `main` checkout:

1. `npm install` and `npm run dev` + `npm run collab` (two terminals).
2. Open `http://localhost:5173/` in a clean browser profile, DevTools Console open.
3. Console should be free of:
   - `127.0.0.1:1235` CSP errors (Task 1).
   - "Invalid access: Add Yjs type to a document before reading data" (Task 2).
   - "Cannot update a component while rendering a different component" (Task 3).
4. `npm test` passes.
5. `npm run test:e2e` passes (both `chromium` and `chromium-pm` projects).
