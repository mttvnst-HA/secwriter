# Cancel room creation — design

**Date:** 2026-06-03
**Status:** Approved, ready for implementation

## Problem

Clicking **Share** ("Start a collaborative room") immediately:

1. generates a room ID,
2. rewrites the URL to `?room=<id>`,
3. clears the localStorage autosave (`clearAutoSave()`, `src/App.jsx:1875`),
4. reloads the page.

After reload the app sees `?room=<id>`, so `inRoom` is true and the
`IdentityModal` (`src/components/IdentityModal.jsx`) renders, asking for the
user's display name. That modal exposes only a **Join room** button (disabled
until a name is typed). There is no Cancel, no close affordance, and no Escape
handler. A user who clicked Share by mistake is stuck on a name prompt for a
room they may not want, with no way out short of hand-editing the URL.

The WebSocket provider is gated on `inRoom && identity`, so at the modal stage
no server room has been created yet — cancelling is a clean local operation.

## Goal

Add a way to cancel the name prompt. Cancelling returns the user to the normal
single-user (local) editor **with their pre-Share document intact**.

## Design

### 1. Defer the autosave wipe from Share-time to join-time

The pre-Share document already lives in the localStorage autosave. The current
code destroys it at Share time, which is why it cannot be recovered on cancel.

- **Remove** `clearAutoSave()` from `handleShare` (`src/App.jsx:1875`).
- **Re-add** the clear at a **mode-independent join seam**: a `useEffect` with
  deps `[inRoom, identity]` whose body is `if (inRoom && identity)
  clearAutoSave();`.

**Why a join-seam effect and NOT a wrapper around the stub modal's
`onIdentity`:** the `IdentityModal` only renders when
`getAuthMode() === 'stub'` (`src/App.jsx:3323`). In `external` (JWT) and `msal`
modes, identity is established without the modal — via `initAuth`/the
safety-net effect at `src/App.jsx:266-271` calling `setIdentity(authIdentity)`.
If the clear lived only in the modal callback, those modes would *never* clear
the autosave on join, leaving a stale local document that could be restored or
written to disk later. The `[inRoom, identity]` effect fires for every auth
mode the moment the user is both in a room and has an identity, which is
exactly "the user has joined."

This preserves the original intent — once the user is in the room, the
server-persisted Yjs doc is the source of truth, so the stale local autosave is
dropped — while keeping the autosave alive across the Share → name-prompt
window (in stub mode, identity is null during the modal, so the effect does not
fire and the autosave survives for a possible cancel).

**Why this is safe:** in-room, the autosave is never read or written. Both the
save effect (`src/App.jsx:1526`) and the restore-on-mount effect
(`src/App.jsx:1544`) early-return when `inRoom` is true. Moving the clear
therefore only affects the cancel-back-to-local path; in-room behavior is
unchanged.

**Intentional behavior change (accepted):** under the original code,
`clearAutoSave()` ran only from `handleShare`, so opening someone else's room
link *directly* never cleared the local autosave. With the join-seam effect,
entering any room (direct link included) clears it once identity is present.
This is the safer direction — it prevents a stale local document from being
resurrected after a room visit — and has no in-room effect since the autosave
is inert there.

### 2. Cancel + Escape in IdentityModal

- Add a new `onCancel` prop to `IdentityModal`.
- Render a **Cancel** button to the left of **Join room** (secondary styling).
  It MUST be `type="button"` so it does not act as a form submit and trigger
  the join handler — its `onClick` calls `onCancel`.
- Add an Escape handler scoped to the form/overlay via a React `onKeyDown` (not
  a document-level listener) so there is nothing to leak on unmount; on
  `Escape` it calls `onCancel`.

The **Join room** button keeps its existing behavior: `type="submit"`, disabled
until a non-empty trimmed name, submit saves identity and calls `onIdentity`.
Because it is the only `type="submit"` in DOM order, pressing **Enter** in the
name field still routes to Join, not Cancel.

### 3. onCancel wiring in App

`onCancel` navigates to the current URL with the `room` query parameter
stripped, then the browser reloads. On reload `inRoom` is false, so:

- the `IdentityModal` no longer renders,
- the restore-on-mount effect (`src/App.jsx:1545`) reads the preserved autosave
  and rehydrates `blocks` / `sectionMeta` / comments — the pre-Share document
  returns.

### 4. stripRoomFromUrl helper

Add `stripRoomFromUrl()` to `src/lib/collab.js`, mirroring the existing
`buildRoomUrl(roomId)`:

```js
export function stripRoomFromUrl() {
  if (typeof window === 'undefined') return '/';
  const url = new URL(window.location.href);
  url.searchParams.delete('room');
  return url.toString();
}
```

Keeping the URL logic in `collab.js` makes it unit-testable rather than inline
in JSX. App's `onCancel` does `window.location.href = stripRoomFromUrl()`.

## Caveats (accepted, out of scope to fix)

1. **3-second staleness.** The autosave snapshots on a 3-second timer
   (`src/App.jsx:1528`). If the user clicks Share within ~3s of their last
   edit, cancel restores to the last snapshot, which can be up to ~3 seconds
   stale. This matches the existing crash-recovery granularity and is accepted.
   No forced synchronous save is added.

2. **File handle is detached on restore.** The restore-on-mount effect
   (`src/App.jsx:1555`) deliberately sets `currentFile` to a null handle and
   `isDirty=false`. So if the user had opened a real `.SEC` via the File System
   Access API, then clicked Share and then Cancel, the restored document has no
   attached handle and the next Ctrl+S will prompt for a file rather than
   writing back to the original. This is inherent to reusing the existing
   restore effect (and is itself a guard against silently writing restored
   state onto an unrelated file). Accepted.

3. **No autosave yet ⇒ cancel yields the fresh sample.** If the user clicks
   Share within the first 3 seconds of a fresh load (before any autosave timer
   has fired), there is no autosave to restore. Cancel reloads into the default
   sample document — which is what a fresh local load shows anyway. Correct, no
   special handling needed.

4. **Cancel only helps users who SEE the modal.** `identity` initializes from
   `loadIdentity()` when in a room (`src/App.jsx:263`). A returning stub user who
   already saved a display name in a prior session has a non-null `identity` on
   the post-Share reload, so the modal's `!identity` guard suppresses it — they
   are auto-joined and the `[inRoom, identity]` effect clears the autosave
   immediately. Such a user therefore never gets a Cancel button. This is NOT a
   regression (before this feature, Share cleared the autosave and committed
   immediately for everyone), and it matches the population the spec targets —
   the user "stuck on a name prompt" is by definition one without a saved
   identity. Giving returning users a way back would need a different mechanism
   (e.g. a confirm step on Share) and is out of scope.

## Testing

1. **`src/components/__tests__/IdentityModal.test.jsx`** (new):
   - Cancel button click fires `onCancel`.
   - Escape keydown fires `onCancel`.
   - Cancel button is `type="button"` (does not submit the form).
   - Pressing **Enter** in the name field fires `onIdentity` (Join), not
     `onCancel`.
   - Join remains disabled with an empty/whitespace name and enabled with a
     real name.
2. **`src/lib/__tests__/collab.test.js`** (or the existing collab URL test
   file): `stripRoomFromUrl()` removes the `room` param and preserves other
   query params.
3. **Join-clears-autosave** (covers finding 1 / the regression risk): a test
   asserting that the `[inRoom, identity]` seam clears the autosave when both
   are present — i.e. independent of auth mode, not tied to the stub modal.
   Prefer a focused unit/integration test over a full App render if the seam
   can be exercised directly; otherwise an inline code comment at the effect
   documenting that non-stub modes rely on it.
4. **Manual verification** in the running app: load a document, click Share,
   click Cancel on the modal, confirm the document is restored in local mode.

## Scope

- `src/components/IdentityModal.jsx` — add `onCancel` prop, `type="button"`
  Cancel button, form-scoped Escape handler.
- `src/lib/collab.js` — add `stripRoomFromUrl()`.
- `src/App.jsx` — remove `clearAutoSave()` from `handleShare`; add the
  `[inRoom, identity]` clear-on-join effect; wire `onCancel` on the
  `IdentityModal` to `window.location.href = stripRoomFromUrl()`.
- Tests as above.
