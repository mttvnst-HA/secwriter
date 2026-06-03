# Cancel Room Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Cancel button (and Escape handler) to the collab "Join collaborative room" name prompt that returns the user to the local single-user editor with their pre-Share document restored.

**Architecture:** Three coordinated changes. (1) A pure `stripRoomFromUrl()` URL helper in `collab.js`. (2) `IdentityModal` gains an `onCancel` prop, a `type="button"` Cancel button, and a form-scoped Escape handler. (3) `App.jsx` stops clearing the autosave at Share-time and instead clears it at a mode-independent join seam (`useEffect([inRoom, identity])`), and wires the modal's `onCancel` to navigate to the room-stripped URL — which on reload re-enters local mode and lets the existing restore-on-mount effect rehydrate the document.

**Tech Stack:** React, Vitest (jsdom), Playwright (E2E). Component tests use raw `react-dom/client` `createRoot` + `act` (the project does not use @testing-library/react).

**Spec:** `docs/superpowers/specs/2026-06-03-cancel-room-creation-design.md`

---

## File Structure

- `src/lib/collab.js` — **modify**: add `stripRoomFromUrl(href?)` next to `buildRoomUrl` (URL helpers cluster, ~line 110). One pure function, no React.
- `src/lib/__tests__/collab.test.js` — **modify**: extend the existing `'URL helpers'` `it()` block with `stripRoomFromUrl` assertions (keeps the file under the ≤30 `it()` rule).
- `src/components/IdentityModal.jsx` — **modify**: add `onCancel` prop, Cancel button, Escape handler. Self-contained presentational component.
- `src/components/__tests__/IdentityModal.test.jsx` — **create**: render/interaction tests for the modal.
- `src/App.jsx` — **modify**: remove `clearAutoSave()` from `handleShare`; add the `[inRoom, identity]` clear-on-join effect; import `stripRoomFromUrl`; wire `onCancel` on `<IdentityModal>`.

---

## Task 1: `stripRoomFromUrl` URL helper

**Files:**
- Modify: `src/lib/collab.js` (add after `buildRoomUrl`, ~line 110)
- Test: `src/lib/__tests__/collab.test.js` (extend the `'URL helpers'` block, ~line 587)

- [ ] **Step 1: Write the failing test**

In `src/lib/__tests__/collab.test.js`, add `stripRoomFromUrl` to the import block (the destructured import from `'../collab.js'` starting at line 12):

```js
  buildRoomUrl,
  stripRoomFromUrl,
```

Then extend the existing `it('URL helpers: generateRoomId + buildRoomUrl', ...)` block (ends ~line 596) by appending these assertions before its closing `});`:

```js
    // stripRoomFromUrl removes ?room and preserves other query params.
    expect(stripRoomFromUrl('https://x.test/?room=abc123')).toBe('https://x.test/');
    expect(stripRoomFromUrl('https://x.test/?room=abc&foo=1')).toContain('foo=1');
    expect(stripRoomFromUrl('https://x.test/?room=abc&foo=1')).not.toContain('room=');
    expect(stripRoomFromUrl('https://x.test/?foo=1')).toContain('foo=1'); // no room param: unchanged params
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/collab.test.js`
Expected: FAIL — `stripRoomFromUrl is not a function` (or import resolves to `undefined`).

- [ ] **Step 3: Write minimal implementation**

In `src/lib/collab.js`, immediately after the `buildRoomUrl` function (which ends at line 110 with its closing `}`), add:

```js
/**
 * Return the current URL with the `room` query param removed. Used by the
 * IdentityModal Cancel path to drop back into single-user (local) mode — on
 * the subsequent reload, getRoomFromUrl() returns null so inRoom is false and
 * the autosave restore-on-mount effect rehydrates the pre-Share document.
 * Accepts an optional explicit href so it can be unit-tested without touching
 * window.location.
 */
export function stripRoomFromUrl(href) {
  const base = href || (typeof window !== 'undefined' ? window.location.href : null);
  if (!base) return '/';
  const url = new URL(base);
  url.searchParams.delete('room');
  return url.toString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/__tests__/collab.test.js`
Expected: PASS (all blocks in the file, including the extended URL-helpers block).

- [ ] **Step 5: Commit**

```bash
git add src/lib/collab.js src/lib/__tests__/collab.test.js
git commit -m "feat(collab): add stripRoomFromUrl helper"
```

---

## Task 2: IdentityModal — Cancel button + Escape

**Files:**
- Create: `src/components/__tests__/IdentityModal.test.jsx`
- Modify: `src/components/IdentityModal.jsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/IdentityModal.test.jsx`:

```jsx
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import IdentityModal from '../IdentityModal.jsx';

function render(container, handlers) {
  const root = createRoot(container);
  const noop = () => {};
  act(() => {
    root.render(
      <IdentityModal
        roomId="testroom"
        onIdentity={handlers.onIdentity || noop}
        onCancel={handlers.onCancel || noop}
      />
    );
  });
  return root;
}

// Set a controlled <input>'s value the way React expects (native setter +
// input event) so the component's useState updates.
function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('IdentityModal cancel affordances', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    localStorage.clear();
  });

  it('Cancel button fires onCancel and is type=button (not a form submit)', () => {
    const onCancel = vi.fn();
    const onIdentity = vi.fn();
    const root = render(container, { onCancel, onIdentity });

    const cancelBtn = [...container.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'Cancel');
    expect(cancelBtn).toBeTruthy();
    expect(cancelBtn.type).toBe('button');

    act(() => { cancelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onIdentity).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it('Escape keydown fires onCancel', () => {
    const onCancel = vi.fn();
    const root = render(container, { onCancel });

    const input = container.querySelector('input');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('form submit (Enter) routes to Join/onIdentity, not Cancel', () => {
    const onCancel = vi.fn();
    const onIdentity = vi.fn();
    const root = render(container, { onCancel, onIdentity });

    const input = container.querySelector('input');
    act(() => { setInputValue(input, 'Jordan Rivera'); });

    const form = container.querySelector('form');
    act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

    expect(onIdentity).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('Join button is disabled until a non-empty name is entered', () => {
    const root = render(container, {});
    const joinBtn = [...container.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'Join room');
    expect(joinBtn.disabled).toBe(true);

    const input = container.querySelector('input');
    act(() => { setInputValue(input, '  '); }); // whitespace only
    expect(joinBtn.disabled).toBe(true);

    act(() => { setInputValue(input, 'Jordan'); });
    expect(joinBtn.disabled).toBe(false);

    act(() => root.unmount());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/__tests__/IdentityModal.test.jsx`
Expected: FAIL — the Cancel test fails (`cancelBtn` is `undefined`, no Cancel button yet) and the Escape test fails (`onCancel` not called).

- [ ] **Step 3: Write minimal implementation**

In `src/components/IdentityModal.jsx`:

(a) Add `onCancel` to the props destructure (line 9):

```jsx
export default function IdentityModal({ onIdentity, onCancel, roomId }) {
```

(b) Add a form-scoped Escape handler. Change the `<form>` opening tag (line 27) from:

```jsx
      <form onSubmit={handleSubmit} style={{
```

to:

```jsx
      <form
        onSubmit={handleSubmit}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel?.(); }}
        style={{
```

(The existing style object and its closing `}}>` stay exactly as they are on the following lines.)

(c) Add the Cancel button inside the button row. The button row is the `<div>` at line 67 that currently contains only the submit button. Change it from:

```jsx
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="submit"
```

to:

```jsx
        <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '8px 16px', fontSize: 13, fontWeight: 600,
              background: '#f1f5f9', color: '#475569',
              border: '1px solid #cbd5e1', borderRadius: 6, cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
```

(The existing submit button — its `disabled`, `style`, and `Join room` text — is unchanged below this.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/__tests__/IdentityModal.test.jsx`
Expected: PASS (all four `it()` blocks).

- [ ] **Step 5: Commit**

```bash
git add src/components/IdentityModal.jsx src/components/__tests__/IdentityModal.test.jsx
git commit -m "feat(collab): add Cancel + Escape to IdentityModal"
```

---

## Task 3: App wiring — defer autosave clear, wire onCancel

**Files:**
- Modify: `src/App.jsx` (import ~line 52; `handleShare` ~line 1871-1876; new effect after the restore effect ~line 1571; modal render ~line 3324)

This task has no unit test: the changes are an import, the removal of one line, a 3-line `useEffect`, and a prop wiring inside the ~3300-line `App` component. Exercising the `[inRoom, identity]` effect in isolation would require a full App render (heavy, brittle, and outside the project's component-test conventions). The seam is covered by manual verification (Task 4) and the regression risk it guards (non-stub auth modes never clearing the autosave) is documented in an inline code comment per the spec's testing note. The `onCancel` navigation calls the already-unit-tested `stripRoomFromUrl`.

- [ ] **Step 1: Import `stripRoomFromUrl`**

Change the collab import (line 52) from:

```jsx
import { getRoomFromUrl, buildRoomUrl, generateRoomId, DEFAULT_HTTP_URL, applyBlocksToYDoc, yBlocksToArray } from "./lib/collab.js";
```

to:

```jsx
import { getRoomFromUrl, buildRoomUrl, stripRoomFromUrl, generateRoomId, DEFAULT_HTTP_URL, applyBlocksToYDoc, yBlocksToArray } from "./lib/collab.js";
```

- [ ] **Step 2: Remove the Share-time autosave clear**

In `handleShare`, change lines 1871-1876 from:

```jsx
    const newRoom = generateRoomId();
    const url = buildRoomUrl(newRoom);
    // Starting a room clears our localStorage auto-save so the server-persisted
    // doc becomes the source of truth cleanly.
    try { clearAutoSave(); } catch { /* ignore */ }
    window.location.href = url;
```

to:

```jsx
    const newRoom = generateRoomId();
    const url = buildRoomUrl(newRoom);
    // NOTE: the autosave is intentionally NOT cleared here. It is cleared at the
    // join seam (the [inRoom, identity] effect below) so it survives the
    // Share -> name-prompt window and the IdentityModal Cancel path can restore
    // the pre-Share document.
    window.location.href = url;
```

- [ ] **Step 3: Add the clear-on-join effect**

Immediately after the autosave restore-on-mount effect (the `useEffect` that ends at line 1571 with `}, [inRoom, localSubstrate]);`), add:

```jsx
  // When the user actually joins a room (identity established while in-room),
  // drop the local autosave so the server-persisted Yjs doc is the sole source
  // of truth. Mode-independent on purpose: stub auth sets identity via the
  // IdentityModal; external (JWT) / msal set it via auth-client + the
  // safety-net effect above. All routes pass through here — without this seam
  // those non-stub modes would never clear the autosave (it used to be cleared
  // in handleShare), leaving a stale local document that could later be
  // restored or written to disk. Until the user joins, the autosave survives so
  // the IdentityModal Cancel path can restore the pre-Share document.
  useEffect(() => {
    if (inRoom && identity) {
      try { clearAutoSave(); } catch { /* ignore */ }
    }
  }, [inRoom, identity]);
```

- [ ] **Step 4: Wire `onCancel` on the modal**

Change the modal render (lines 3323-3324) from:

```jsx
      {inRoom && !identity && getAuthMode() === 'stub' && (
        <IdentityModal roomId={roomId} onIdentity={setIdentity} />
      )}
```

to:

```jsx
      {inRoom && !identity && getAuthMode() === 'stub' && (
        <IdentityModal
          roomId={roomId}
          onIdentity={setIdentity}
          onCancel={() => { window.location.href = stripRoomFromUrl(); }}
        />
      )}
```

- [ ] **Step 5: Verify the app builds / type-checks via the unit suite**

Run: `npm test -- src/lib/__tests__/collab.test.js src/components/__tests__/IdentityModal.test.jsx`
Expected: PASS (no import or render regressions introduced by the App edits).

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx
git commit -m "feat(collab): wire IdentityModal Cancel; defer autosave clear to join"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS. If a pre-existing unrelated failure appears, confirm it also fails on a clean checkout before attributing it to this work.

- [ ] **Step 2: Run the collab E2E suite (touches the join/name-prompt flow)**

Run: `npm run test:e2e -- --project=chromium tests/e2e/collab.spec.js`
Expected: PASS, or only the known baseline parallel-load flakes (see CLAUDE.md Testing Rules #10/#11). If a collab test fails, re-run it in isolation (`--grep` under `--project=chromium`) to distinguish a real regression from a baseline flake before treating it as a regression.

- [ ] **Step 3: Manual round-trip in the running app**

Terminal A: `npm run collab`
Terminal B: `npm run dev`

1. Open `http://localhost:5173`, let the editor load the sample document, and make a small edit. Wait ~4 seconds so the 3-second autosave fires.
2. Click **Share**. The page reloads with `?room=<id>` and the "Join collaborative room" modal appears.
3. Click **Cancel** (and on a second run, press **Escape**).
4. Confirm: the URL no longer has `?room=`, the editor is back in local single-user mode (the "Share" button reads "Share", not "Room …"), and your edited document is restored — not the fresh sample.
5. Re-run from step 1, but this time enter a name and click **Join room**. Confirm you enter the room normally (no console errors).

Expected: Cancel and Escape both return to the restored local document; Join still works.

- [ ] **Step 4: Final commit (if any verification-driven fixes were needed)**

```bash
git add -A
git commit -m "test(collab): verify cancel-room-creation round-trip"
```

(Skip if Steps 1-3 required no changes.)

---

## Self-Review Notes

- **Spec coverage:** §1 (defer clear) → Task 3 Steps 2-3; §2 (Cancel/Escape) → Task 2; §3 (onCancel nav) → Task 3 Step 4; §4 (`stripRoomFromUrl`) → Task 1. All three spec caveats are inherent to the existing restore effect and need no code. All four spec test items → Task 1 (helper), Task 2 (modal: cancel/escape/type/enter/disabled), Task 3 note + Task 4 (join-clear seam via manual verification).
- **Type consistency:** `stripRoomFromUrl` defined in Task 1, imported in Task 3, called in Task 3 Step 4 and the Task 1 test — same signature throughout. `onCancel` prop added in Task 2, supplied in Task 3 Step 4.
- **No placeholders:** every code step shows exact code and exact before/after anchors.
