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
- **Re-add** the clear at the moment the user actually joins: wrap the modal's
  `onIdentity` callback so it calls `clearAutoSave()` and then
  `setIdentity(identity)`.

This preserves the original intent — once the user is in the room, the
server-persisted Yjs doc is the source of truth, so the stale local autosave is
dropped — while keeping the autosave alive across the Share → name-prompt
window.

**Why this is safe:** in-room, the autosave is never read or written. Both the
save effect (`src/App.jsx:1527`) and the restore-on-mount effect
(`src/App.jsx:1545`) early-return when `inRoom` is true. Moving the clear
therefore only affects the cancel-back-to-local path; in-room behavior is
unchanged.

### 2. Cancel + Escape in IdentityModal

- Add a new `onCancel` prop to `IdentityModal`.
- Render a **Cancel** button to the left of **Join room** (secondary styling).
- Add a `keydown` Escape handler that calls `onCancel`.

The **Join room** button keeps its existing behavior (disabled until a
non-empty trimmed name; submit saves identity and calls `onIdentity`).

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

## Caveat (accepted, out of scope to fix)

The autosave snapshots on a 3-second timer (`src/App.jsx:1528`). If the user
clicks Share within ~3s of their last edit, cancel restores to the last
snapshot, which can be up to ~3 seconds stale. This matches the existing
crash-recovery granularity and is accepted. No forced synchronous save is
added.

## Testing

1. **`src/components/__tests__/IdentityModal.test.jsx`** (new): Cancel button
   click fires `onCancel`; Escape keydown fires `onCancel`; Join remains
   disabled with an empty/whitespace name and enabled with a real name.
2. **`src/lib/__tests__/collab.test.js`** (or the existing collab URL test
   file): `stripRoomFromUrl()` removes the `room` param and preserves other
   query params.
3. **Manual verification** in the running app: load a document, click Share,
   click Cancel on the modal, confirm the document is restored in local mode.

## Scope

- `src/components/IdentityModal.jsx` — add `onCancel` prop, Cancel button,
  Escape handler.
- `src/lib/collab.js` — add `stripRoomFromUrl()`.
- `src/App.jsx` — remove `clearAutoSave()` from `handleShare`; add it to the
  join path; wire `onCancel` on the `IdentityModal`.
- Tests as above.
