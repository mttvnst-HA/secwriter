# Slash menu visibility — design spec

**Issue:** None filed yet (spec-first).
**Status:** Approved through brainstorming + 1 round of independent agent critique (3 critique points integrated: caret-coord anchor, portal, ARIA).
**Date:** 2026-05-27
**Related:**
- `src/components/SlashMenu.jsx` — the React component being rewritten
- `src/components/PmEditableBlock.jsx:958-965` — current call site
- `src/lib/pm-plugins/slash-menu.js` — PM plugin (state already carries `fromPos`)
- Commit `8ebccb5` — original flip-above attempt (the one being replaced)

## 1. Problem statement

The slash menu opens when a user types `/` at the start of a block. It currently uses `position: absolute` anchored to the block wrapper, with a `useLayoutEffect` that flips it to `bottom: position.top` (still anchored to the block) when its bottom edge overflows the viewport.

This breaks in two cases:

1. **Cursor near the viewport bottom.** Flipping uses `bottom` relative to the block — only useful if there is space above the block in the document, not in the viewport. The menu can still spill off-screen, forcing the user to scroll the page to see remaining items.
2. **Cursor near the viewport top.** The flip-above branch can push the menu off the top of the viewport with no further fallback.

The menu has 9 items at full length (~390px tall). On a typical viewport with the editor toolbar consuming the top portion, the menu can easily exceed the remaining space below the cursor.

## 2. Design summary

- **Viewport-fixed positioning** via `position: fixed`, rendered through a React portal to `document.body`.
- **Caret-anchored** using PM's `view.coordsAtPos(fromPos)` rather than the block element's rect. Falls back to the block rect if PM coords are unavailable.
- **Smart placement decision** — compute space above and below the anchor against `window.innerHeight`; pick the side that fits or the larger side with a clamped `max-height` and internal scroll.
- **Predicted natural height** — no two-pass measure flicker; compute from `HEADER_HEIGHT + filteredCount * ROW_HEIGHT` constants.
- **Close on window scroll** — passive scroll listener closes the menu (matches Notion / Linear).
- **ARIA semantics** — `role="listbox"`, `aria-activedescendant`, items as `role="option"` with `aria-selected`.
- **Sticky "Insert block" header** when scrolling internally.
- **Empty state** ("No matches") instead of `return null` when filter has no hits.
- **Keyboard active item** scrolled into view via `scrollIntoView({ block: 'nearest' })`.

## 3. Architecture

### 3.1 Pure placement function

New module-level pure function in `src/components/SlashMenu.jsx`:

```js
function computePlacement({ anchorRect, viewportHeight, menuHeight, margin = 8 }) {
  const spaceBelow = viewportHeight - anchorRect.bottom - margin;
  const spaceAbove = anchorRect.top - margin;

  if (menuHeight <= spaceBelow) {
    return { placement: 'below', maxHeight: null, top: anchorRect.bottom + 4 };
  }
  if (menuHeight <= spaceAbove) {
    return {
      placement: 'above',
      maxHeight: null,
      top: anchorRect.top - menuHeight - 4,
    };
  }
  // Neither side fits — pick the larger and clamp.
  if (spaceBelow >= spaceAbove) {
    return {
      placement: 'below',
      maxHeight: Math.max(spaceBelow, 120),
      top: anchorRect.bottom + 4,
    };
  }
  return {
    placement: 'above',
    maxHeight: Math.max(spaceAbove, 120),
    top: margin,
  };
}
```

Pure, table-testable. Floor of 120px on `maxHeight` prevents degenerate cases (anchor pinned exactly at viewport edge) from collapsing the menu to invisibility — the menu always shows at least ~2 rows.

Horizontal placement (returned alongside `top`):

```js
function computeLeft({ anchorRect, menuWidth, viewportWidth, margin = 8 }) {
  const desired = anchorRect.left;
  return Math.max(margin, Math.min(desired, viewportWidth - menuWidth - margin));
}
```

### 3.2 SlashMenu component rewrite — `src/components/SlashMenu.jsx`

**New props** (replaces today's `position: { left, top }`):

```js
SlashMenu({
  filter,             // unchanged
  selectedIdx,        // unchanged
  onSelect,           // unchanged
  onClose,            // NEW — called on window scroll
  anchorRect,         // NEW — { top, bottom, left, right } in viewport coords
  readOnly = false,   // unchanged
})
```

**Constants** (module-level, with a comment tying them to the row styles):

```js
const HEADER_HEIGHT = 26;   // "Insert block" header + padding
const ROW_HEIGHT = 50;      // icon + label + desc row
const MENU_WIDTH = 280;     // unchanged from today
const VIEWPORT_MARGIN = 8;
```

**Render structure** (via `createPortal(menu, document.body)`):

```jsx
<div
  ref={menuRef}
  id="sim-slash-listbox"
  role="listbox"
  aria-label="Insert block"
  style={{
    position: 'fixed',
    top, left,
    width: MENU_WIDTH,
    maxHeight: maxHeight ?? undefined,
    overflowY: maxHeight ? 'auto' : 'visible',
    zIndex: 1000,
    backgroundColor: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
    padding: '4px 0',
  }}
  onMouseLeave={() => setHoverIdx(-1)}
>
  <div style={{ position: 'sticky', top: 0, backgroundColor: '#fff', /* ... */ }} aria-hidden="true">
    Insert block
  </div>
  {filtered.length === 0 ? (
    <div role="status" aria-live="polite" style={{ padding: '12px', color: '#94a3b8', fontStyle: 'italic' }}>
      No matches
    </div>
  ) : (
    filtered.map((item, i) => (
      <div
        key={item.type}
        id={`sim-slash-item-${i}`}
        role="option"
        aria-selected={i === safeIdx}
        tabIndex={-1}
        ref={i === safeIdx ? activeItemRef : null}
        /* ... */
      >
        {/* unchanged item content */}
      </div>
    ))
  )}
</div>
```

**ARIA pattern: combobox-with-listbox-popup.** The listbox above never holds focus (PM owns the contentEditable). For `aria-activedescendant` to actually announce changes, it must be set on the FOCUSED element — i.e., the PM contentEditable — not on the listbox itself. This requires adding ARIA attributes to PM's editor DOM in `PmEditableBlock.jsx`. See §3.4 step 3.

The empty-state row uses `role="status"` + `aria-live="polite"` so it announces "No matches" instead of misleadingly being announced as a selectable option (the previous orphan `role="option"` was semantically wrong). The sticky header is `aria-hidden="true"` because it is decorative — the listbox's `aria-label` already conveys the same intent.

**Layout effect** — recompute placement on `anchorRect`, `filtered.length`, and `window` resize:

```js
useLayoutEffect(() => {
  if (!anchorRect) return;
  const menuHeight = HEADER_HEIGHT + Math.max(filtered.length, 1) * ROW_HEIGHT;
  const { placement, maxHeight, top } = computePlacement({
    anchorRect,
    viewportHeight: window.innerHeight,
    menuHeight,
    margin: VIEWPORT_MARGIN,
  });
  const left = computeLeft({
    anchorRect,
    menuWidth: MENU_WIDTH,
    viewportWidth: window.innerWidth,
    margin: VIEWPORT_MARGIN,
  });
  setPlacement({ top, left, maxHeight });
}, [anchorRect, filtered.length, resizeTick]);

const [resizeTick, setResizeTick] = useState(0);
useEffect(() => {
  const onResize = () => setResizeTick(t => t + 1);
  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
}, []);
```

(`resizeTick` must be declared above the `useLayoutEffect` for the dep reference to work; the order shown is illustrative — adjust during implementation.)

**Close on scroll**:

```js
useEffect(() => {
  if (!onClose) return;
  const onScroll = () => onClose();
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });
  return () => window.removeEventListener('scroll', onScroll, { capture: true });
}, [onClose]);
```

Capture phase ensures the listener fires for scrolls in any nested scroll container (sidebar, editor scroll area). Internal menu scrolls do not propagate to `window`, so they do not trigger close.

**Active item scroll-into-view**:

```js
useEffect(() => {
  activeItemRef.current?.scrollIntoView({ block: 'nearest' });
}, [safeIdx]);
```

### 3.3 PM plugin — `src/lib/pm-plugins/slash-menu.js`

**No code changes.** The existing exposure path is `slashMenuPluginKey.getState(state)` called from `PmEditableBlock.dispatchTransaction` (lines ~482-489) — not an `addSlashListener` API (the file header comment describes a never-implemented design; the actual `view()` returns `{}`). The plugin's existing state shape `{ open, filter, fromPos }` has `fromPos: null` initially and `fromPos: 0` when open. The spec reads `fromPos` from the existing `getState` payload rather than hardcoding `0`, so future relaxations of the trigger (e.g., slash after whitespace) work without changes here. `fromPos` can be `null` when `open: false` — the React-side state mirror normalizes to `null` for that case (see §3.4).

### 3.4 PM EditableBlock — `src/components/PmEditableBlock.jsx`

**Three logical changes**: (1) extend the React state shape to include `fromPos` — touches four setState sites; (2) compute and thread `anchorRect` to the new prop — touches the JSX call site and adds a `useMemo` + a `handleSlashClose` callback; (3) sync ARIA combobox attributes to the PM editor DOM when the menu opens or the selected item changes — one new effect.

1. **Surface `fromPos` from the plugin mirror** (line ~482-489). Today the mirror projects `{ open, filter, selectedIdx }`; extend to `{ open, filter, selectedIdx, fromPos }`. **All four `setSlashState` call sites must use the new shape** — the mirror at :483, `handleSlashSelect` at :289, `onSlashEscape` at :303, and `handleSlashSelectClick` at :781. The non-mirror sites all set `fromPos: null` (matching the plugin's `initialState.fromPos`). Without this normalization, the mirror's `slash.fromPos !== slashStateRef.current.fromPos` gate would compare `null !== undefined` and trigger a spurious re-render on the next dispatch after each escape/select.

   ```js
   const slash = slashMenuPluginKey.getState(newState);
   if (slash && (
     slash.open !== slashStateRef.current.open ||
     slash.filter !== slashStateRef.current.filter ||
     slash.fromPos !== slashStateRef.current.fromPos
   )) {
     setSlashState((prev) => ({
       open: slash.open,
       filter: slash.filter,
       fromPos: slash.fromPos,
       selectedIdx: slash.open ? prev.selectedIdx : 0,
     }));
   }
   ```

2. **Compute `anchorRect` once per menu-open and pass to `SlashMenu`** (lines 958-965). `anchorRect` is memoized via `useMemo` keyed on `slashState.open` + `slashState.fromPos` so it does NOT re-compute on every keystroke (filter chars change `slashState.filter` but the anchor stays put — the menu does not chase the caret as the user types, matching §6 "out of scope: cursor-following placement"):

   ```js
   const anchorRect = useMemo(() => {
     if (!slashState.open) return null;
     return computeSlashAnchorRect(viewRef.current, slashState.fromPos, containerRef.current);
     // viewRef and containerRef are intentionally NOT deps — they are mutable
     // refs read at memo-recompute time, and re-running the memo when their
     // identity changes (it does not) would defeat the lock-at-open invariant.
   }, [slashState.open, slashState.fromPos]);

   {slashState.open && editable && anchorRect && (
     <SlashMenu
       filter={slashState.filter}
       selectedIdx={slashState.selectedIdx}
       onSelect={handleSlashSelectClick}
       onClose={handleSlashClose}
       anchorRect={anchorRect}
     />
   )}
   ```

   Where `computeSlashAnchorRect` is a small helper:

   ```js
   function computeSlashAnchorRect(view, fromPos, fallbackEl) {
     if (view && typeof fromPos === 'number') {
       try {
         const coords = view.coordsAtPos(fromPos);
         return { top: coords.top, bottom: coords.bottom, left: coords.left, right: coords.right };
       } catch {
         // fall through
       }
     }
     return fallbackEl?.getBoundingClientRect() ?? null;
   }
   ```

   `handleSlashClose` is a new local callback:

   ```js
   const handleSlashClose = useCallback(() => {
     setSlashState({ open: false, filter: '', fromPos: null, selectedIdx: 0 });
   }, []);
   ```

   This matches the existing Escape semantic (`onSlashEscape` at PmEditableBlock.jsx:302-305): set React state to closed, leave the `/filter` text in the block. The plugin state remains `open: true` until the doc changes. If the user resumes typing after a scroll-close, the next keystroke triggers a plugin state mirror in `dispatchTransaction` (lines ~482-489) and the menu re-opens with the updated filter — that is the intended behavior. If the user does nothing, the menu stays closed.

   (A latent quirk in this scheme: the next keystroke re-opens the menu even if the user wanted it gone for good. This pre-dates the redesign; out of scope.)

3. **Apply ARIA combobox attributes to the PM editor DOM when the menu is open.** The listbox's `aria-activedescendant` must live on the focused element (the PM contentEditable) for screen readers to announce active-item changes. Add a new effect that toggles attributes on `viewRef.current?.dom` whenever `slashState.open` or `slashState.selectedIdx` changes:

   ```js
   useEffect(() => {
     const dom = viewRef.current?.dom;
     if (!dom) return;
     if (slashState.open) {
       dom.setAttribute('role', 'combobox');
       dom.setAttribute('aria-haspopup', 'listbox');
       dom.setAttribute('aria-expanded', 'true');
       dom.setAttribute('aria-controls', 'sim-slash-listbox');
       dom.setAttribute('aria-activedescendant', `sim-slash-item-${slashState.selectedIdx}`);
     } else {
       dom.removeAttribute('role');
       dom.removeAttribute('aria-haspopup');
       dom.removeAttribute('aria-expanded');
       dom.removeAttribute('aria-controls');
       dom.removeAttribute('aria-activedescendant');
     }
     // Cleanup on unmount: PM destroys the DOM, no leak.
   }, [slashState.open, slashState.selectedIdx]);
   ```

   We manipulate the contentEditable's DOM attributes directly rather than threading them through PM's `EditorProps.attributes` because PM's attribute reconciliation merges static attributes; making them dynamic per-keystroke would force PM to re-reconcile on every state change. Direct DOM mutation is what y-prosemirror and similar plugins do for transient attributes.

## 4. Out of scope

- **Cursor-following placement.** The anchor locks at open time. As the user types filter characters, the menu does not chase the caret. This matches today's behavior and Notion's.
- **Two-column layout** (option B from brainstorming) — defer until we see whether the scroll fallback feels acceptable in practice.
- **Mobile / touch keyboard.** `position: fixed` + iOS soft keyboard interactions are not addressed. UFGS engineers use desktop.
- **RTL.** UFGS is English-only.
- **Animation polish.** No enter / exit transitions added.

## 5. Tests

### 5.1 New unit tests — `src/components/__tests__/slash-menu-placement.test.js`

Table-driven over `computePlacement`:

| Case | anchorRect | viewportHeight | menuHeight | Expected |
|---|---|---|---|---|
| fits below | `{ top: 100, bottom: 120 }` | 800 | 390 | `placement: 'below', maxHeight: null, top: 124` |
| fits above only | `{ top: 600, bottom: 620 }` | 800 | 390 | `placement: 'above', maxHeight: null, top: 206` |
| neither fits, more below | `{ top: 50, bottom: 70 }` | 400 | 390 | `placement: 'below', maxHeight: 322, top: 74` |
| neither fits, more above | `{ top: 350, bottom: 370 }` | 400 | 390 | `placement: 'above', maxHeight: 342, top: 8` |
| anchor at viewport top | `{ top: 0, bottom: 0 }` | 800 | 390 | `placement: 'below', maxHeight: null, top: 4` |
| anchor at viewport bottom | `{ top: 800, bottom: 800 }` | 800 | 390 | `placement: 'above', maxHeight: null, top: 406` |
| min maxHeight floor | `{ top: 50, bottom: 70 }` | 100 | 390 | `placement: 'above', maxHeight: 120, top: 8` |

Note: an offscreen anchor (`anchor.top < 0` or `anchor.bottom > viewportHeight`) is not tested here. The close-on-scroll listener in `SlashMenu` closes the menu before the next render in that scenario, so `computePlacement` is never called against an offscreen anchor in production. If a caller did invoke it with offscreen coords, the function still returns a value — it just is not guaranteed to be sensible.

Plus `computeLeft`:

| Case | anchorRect.left | menuWidth | viewportWidth | Expected |
|---|---|---|---|---|
| normal | 100 | 280 | 1200 | 100 |
| would overflow right | 1000 | 280 | 1200 | 912 |
| negative left | -50 | 280 | 1200 | 8 |

### 5.2 New unit test — `src/components/__tests__/SlashMenu.test.jsx`

- Listbox renders with `role="listbox"`, `id="sim-slash-listbox"`, `aria-label="Insert block"`.
- Listbox does NOT carry `aria-activedescendant` (it belongs on the PM editor DOM, not here).
- Empty filter renders "No matches" with `role="status"` and `aria-live="polite"` (NOT `role="option"`).
- Non-empty renders item rows with `role="option"` and stable `id="sim-slash-item-${i}"` attributes.
- `aria-selected="true"` is set on the keyboard-selected item only (not the hover one).
- Sticky header is `aria-hidden="true"`.
- Mounts via portal to `document.body` (assert the menu DOM is not a descendant of the wrapping `<div>` in the test render tree).

### 5.3 New integration test — `src/components/__tests__/PmEditableBlock-slash-aria.test.jsx`

When `slashState.open` transitions to true, the PM editor's contentEditable DOM gains:
- `role="combobox"`
- `aria-haspopup="listbox"`
- `aria-expanded="true"`
- `aria-controls="sim-slash-listbox"`
- `aria-activedescendant="sim-slash-item-${selectedIdx}"`

When `selectedIdx` changes (arrow-key nav), `aria-activedescendant` updates to the new id.

When the menu closes, all five attributes are removed.

### 5.4 Existing tests

- `src/lib/__tests__/slash-menu-plugin.test.js` — unaffected (plugin code unchanged).
- E2E `tests/e2e/editor.spec.js` slash menu specs — must continue to pass. Validate locally and in CI.

## 6. Verification before completion

Per CLAUDE.md rule about "Before claiming 'no E2E regressions,' run the FULL `editor.spec.js` and `collab.spec.js` under `--project=chromium`":

- `npm test` — unit suite green.
- `npm run test:e2e -- --project=chromium` — full Playwright suite. Compare failures against the parallel-load flake baseline ([#126](https://github.com/mttvnst-HA/secwriter/issues/126), [#145](https://github.com/mttvnst-HA/secwriter/issues/145)) — re-run any new failures in isolation to distinguish regression from flake.
- Manual smoke: open the dev server, create blocks at the top and bottom of a long document, trigger the slash menu in each position, verify the menu is fully visible. Filter to one item, verify "No matches" appears for typos. Scroll while the menu is open, verify it closes.

## 7. Risk

**Low-to-moderate.**

- Portal + `position: fixed` is a small visual restructuring. If anything is off (z-index conflict with another popup, weird ancestor), it shows up immediately in manual testing.
- `view.coordsAtPos` is a standard PM API (`prosemirror.net/docs/ref/#view.EditorView.coordsAtPos`). Used here for the first time in SecWriter — flag for any future code that needs caret coords (e.g., FloatingToolbar already uses `view.coordsAtPos` indirectly through DOM measurement; this is an explicit version).
- Predicted height (`HEADER_HEIGHT + ROW_HEIGHT * N`) is fragile against future CSS changes to the slash menu rows. Comment in the constants ties them to the row styles. Worst case if the constants drift: the menu picks a side slightly wrong, internal scroll still works.
- ARIA additions are additive and won't break existing keyboard interactions (PM keymap still owns arrow keys + Enter; menu items have `tabIndex={-1}`).
- Direct DOM attribute mutation on `viewRef.current.dom` (for combobox ARIA) bypasses PM's `EditorProps.attributes` reconciliation. If PM at any point re-renders the editor DOM and wipes our attributes, the next selection-or-open change re-applies them — but verify under PM 1.x behavior during implementation. Mitigation: the effect runs on every `[slashState.open, slashState.selectedIdx]` change, so reapplication is automatic on the very next state transition.

## 8. Files changed

1. `src/components/SlashMenu.jsx` — main rewrite (props change, portal, placement math, ARIA listbox semantics, sticky header, empty state, active-item scroll-into-view, close-on-scroll listener).
2. `src/components/PmEditableBlock.jsx` — surface `fromPos` through the slash mirror (4 setState sites); compute memoized `anchorRect` via `view.coordsAtPos`; new `handleSlashClose` callback; new effect syncing combobox ARIA attributes to the PM editor DOM; pass new props to `SlashMenu`.
3. `src/components/__tests__/slash-menu-placement.test.js` — new file, pure-function unit tests for `computePlacement` + `computeLeft`.
4. `src/components/__tests__/SlashMenu.test.jsx` — new file, component-level ARIA + empty-state + portal tests.
5. `src/components/__tests__/PmEditableBlock-slash-aria.test.jsx` — new file, integration test for combobox ARIA attributes on the PM editor DOM.

No changes to `src/lib/pm-plugins/slash-menu.js`.
