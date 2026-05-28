# Custom Right-Click Context Menu — Design

**Issue:** [#182](https://github.com/mttvnst-HA/secwriter/issues/182)
**Date:** 2026-05-28
**Status:** Design approved, pending implementation plan

## Problem

The browser's native right-click menu is not useful inside the SecWriter editor. We want a
SecWriter-specific context menu tailored to spec-editing actions, while preserving the native
browser menu outside the editable text (page gutters, app chrome).

## Scope (v1)

Four item groups, all flat (no submenus):

1. **Clipboard** — Cut / Copy / Paste (paste stays plaintext-only per [#99](https://github.com/mttvnst-HA/secwriter/issues/99)).
2. **Tracked changes** — Accept / Reject the single change under the pointer (only when over a revision mark).
3. **Comments** — Add comment (selection-gated, see below) / Resolve comment (when over a comment mark).
4. **Table operations** — Insert row above/below, insert column left/right, delete row, delete column, merge cell, split cell (only inside a table cell).

**Explicitly out of scope for v1** (already covered elsewhere): block-type conversion (slash menu),
inline formatting (FloatingToolbar), reference insertion (Reference Wizard).

### Locked decisions

- **Boundary rule:** the custom menu fires ONLY when the right-click target resolves inside a
  registered editable block. Block indents, page gutter, and app chrome keep the NATIVE browser menu.
- **Item model:** dynamic — only items valid for the exact right-click target appear ("hide
  irrelevant", not "show-disabled").
- **Read-only states** (`collabReadOnly` true — collab disconnected/syncing or a non-editable
  connection state; note `migration-partial` stays editable): show a copy-only custom menu when a
  selection exists. With no selection the item list is empty → the menu is suppressed and the native
  browser menu fires (which still offers native Copy).
- **Add comment** appears ONLY when a non-empty selection already exists AND the right-click landed
  inside it. Otherwise the item is hidden. Reuses the existing FloatingToolbar selection-gated
  comment flow (`applyCommentMarkTr` returns null on a collapsed selection, so there is no
  point-based add path in v1).

## Architecture

**App-level singleton menu.** One `contextmenu` listener on the editor scroll container. On
right-click, the listener:

1. Finds the nearest `[data-block-id]` host of the event target.
2. Resolves the context descriptor for that host (see Context Resolution).
3. If the descriptor is `null` (right-click outside editable content) → `return` WITHOUT
   `preventDefault()`, letting the native browser menu fire (boundary rule).
4. Otherwise → `event.preventDefault()`, build the item list, open one shared `<ContextMenu>` portal
   anchored at `{event.clientX, event.clientY}`.

This was chosen over a per-block menu (each block component owning its own handler) because:

- The boundary decision ("inside a registered block vs. native menu for the gutter") is inherently
  container-level — a per-block `contextmenu` handler only fires once already over the block and
  cannot let the native menu through for non-editable regions.
- App already reaches into live `EditorView`s via `getBlockView` at multiple call sites;
  `block-registry` was purpose-built as that seam. A singleton reuses it; per-block would fork
  hit-testing, the one-menu invariant, and read-only handling across four host types.
- One-menu-at-a-time is a natural singleton invariant.

### Module layout

**New files:**

- `src/components/ContextMenu.jsx` — React portal popup. `role="menu"`, items `role="menuitem"`.
  Anchored at the pointer coordinate. Reuses placement helpers (below).
- `src/lib/context-menu-items.js` — pure `buildContextMenuItems(ctx) → Item[]`. Input is a resolved
  context descriptor; output is the ordered, flat item list (dynamic model). React-free,
  table-testable. Each `Item` carries `{ id, label, icon?, onSelect }`.
- `src/lib/menu-placement.js` — `computePlacement` / `computeLeft` extracted verbatim from
  `SlashMenu.jsx`, imported by both SlashMenu and ContextMenu. (SlashMenu keeps its current
  behavior; this is a no-logic-change extraction.)

**Touched files:**

- `src/lib/block-registry.js` — the PmEditableBlock handle gains `getContextAtCoords({x, y})`.
  Title/Ref/Table blocks do NOT register handles (see below).
- `src/components/PmEditableBlock.jsx` — registers `getContextAtCoords`; on `contextmenu`,
  force-closes any open slash menu + del-popup and suppresses the scratch-block discard path.
- `src/components/TableBlock.jsx` — adds `data-row` / `data-col` attributes to each rendered `<td>`.
- `src/App.jsx` — the singleton `contextmenu` listener, menu open/close state, and action routing.

### Host context resolution

`ContextDescriptor | null`. Per host:

- **PmEditableBlock** (PM editor) — via the registry handle `getContextAtCoords({x, y})`:
  - `view.posAtCoords({ left: x, top: y })`; if null → return null.
  - Read marks at that pos via `findMarkRangeAt` (exported from `pm-toolbar.js`) to detect
    `revisionAdd` / `revisionDel` / `revisionChg` (→ accept/reject, carrying `{ type, range }`) and
    the `comment` mark (→ resolve, carrying `{ commentId, range }`).
  - Selection state: if a non-empty selection exists and the click pos falls inside it → mark
    `addCommentRange` available.
  - Returns `{ blockId, kind: 'pm', pos, selectionEmpty, addCommentRange?, revision?, comment? }`.
- **TableBlock** — App resolves directly from the DOM (no registry handle): `event.target.closest('td[data-row]')`
  yields logical `{ row, col }`. A right-click on a merged (colspan) cell maps to the cell's start
  column. Returns `{ blockId, kind: 'table', row, col, canMerge, canSplit }`.
- **TitleBlock / RefBlock** — App resolves directly from the `[data-block-id]` element (no registry
  handle). Copy-only. Returns `{ blockId, kind: 'title' | 'ref', selectionEmpty }`.
- **Read-only** (any host, `collabReadOnly` true) — copy-only descriptor regardless of marks under
  the pointer.

Rationale for not adding registry handles to Title/Ref/Table: only PmEditableBlock registers a
handle today; the other three would each need net-new registration lifecycle (mount/unmount effects
+ handle object) and teardown-race surface. Title/Ref are copy-only and Table ops are
DOM/index-based, so none of them need PM-coordinate resolution — App resolves them directly.

### Item builder

`buildContextMenuItems(ctx)` assembles flat sections separated by dividers, including only applicable
sections:

- **Clipboard:** Copy and Cut require a non-empty selection (right-click does not create one, so in
  plain text with no prior selection neither appears — matching native browser behavior). Paste
  appears only when editable. Cut is additionally omitted in read-only.
- **Tracked changes:** Accept change / Reject change only if `ctx.revision`.
- **Comments:** Add comment only if `ctx.addCommentRange`; Resolve comment only if `ctx.comment` and
  it is not already resolved.
- **Table:** the row/column/merge/split items only if `kind === 'table'` (merge gated on `canMerge`,
  split on `canSplit`).

Empty / whitespace-only result → App suppresses the menu and lets the native menu fire.

### Action dispatch

Items route to existing handlers; no new domain logic except the clipboard mechanism.

- **Copy / Cut** — Clipboard API over the resolved range/selection (serialize via the existing PM
  HTML/text path). **Paste** reuses `sanitizePasteText` + the existing plaintext-only insert path
  ([#99](https://github.com/mttvnst-HA/secwriter/issues/99)). The clipboard wiring is the one
  genuinely new mechanism — detailed in the implementation plan.
- **Accept / Reject change** — the single-change resolve verb. `applyInlineRevisionResolveTr(state,
  action, pos, kindHint)` accepts a `pos` override (no selection required), as the del-popup already
  does. The reject-add / accept-del paths must honor `TC_RESOLVE_META` where applicable (see the
  Track Changes section of `CLAUDE.md` — FloatingToolbar's resolve path does not yet set it; the
  context-menu path should set it on accept-del to avoid the no-op rewrite described in the
  `#96` fix note).
- **Add comment** — existing `handleCommentCreate(blockId, html, commentId, highlightText)` over the
  pre-existing selection's range (highlightText via `extractRangeText`).
- **Resolve comment** — existing `handleCommentResolve(ctx.comment.commentId)`.
- **Table ops** — `table-ops.js` functions (insertRow/insertColumn/deleteRow/deleteColumn/merge/split)
  via the existing block-update path, indexed by the resolved logical `{ row, col }`.

### Position re-resolution under concurrent editing

A right-click captures a point/range; a collab peer's edit between menu-open and item-click can shift
positions. The guard is **re-resolve fresh at action time**, not relpos-at-open:

- PM actions (accept/reject): at click, re-run mark resolution at the live coordinate
  (`posAtCoords` + `findMarkRangeAt`). `applyInlineRevisionResolveTr` already returns null when the
  mark is gone → no-op + toast.
- Table actions: re-resolve `closest('td[data-row]')` at click; if the row/col no longer exists →
  no-op + toast.
- Comment add: the selection is re-read at click; if collapsed/changed → no-op.

This is deliberately simpler than `dispatchToolbarVerb`'s selection-relpos restore, which protects a
selection the context menu does not have.

### Slash-menu / del-popup interaction

Right-click fires `mousedown` then `contextmenu`. When the slash menu is open, PmEditableBlock's
capture-phase `mousedown`-outside listener can delete the scratch block or convert it, and the
new-block-discard listener can delete the block out from under the menu. Rule: on `contextmenu`, the
handler first force-closes any open slash menu (`closeSlashMenuPlugin`) and del-popup, and suppresses
the scratch-block discard path — a right-click NEVER deletes a scratch block. Precedence is explicit
and covered by a regression test.

### Dismiss + accessibility

Reuses SlashMenu patterns:

- Capture-phase document `mousedown` outside the menu → close.
- `Escape` → close + restore focus to the editor.
- Capture-phase `scroll` outside the menu → close.
- Window `resize` → reposition.
- `role="menu"` / `role="menuitem"`, arrow-key up/down navigation, Enter or click to activate.
  Items are hidden when inapplicable (never `aria-disabled`), so no disabled-item focus handling.

Single instance → no cross-block "close the other menu" coordination.

### Error handling

- `getContextAtCoords` (PM host) wrapped in try/catch → returns null on throw (mid-teardown views),
  never blocking the native menu.
- Action dispatch guards `el.isConnected` + re-resolution; failed resolution → toast, no mutation.
- Empty item list → no menu shown.

## Testing

**Unit (Vitest):**

- `buildContextMenuItems` — table-driven over context descriptors (plain text, over-revision,
  over-comment, in-table, read-only, selection-present).
- `menu-placement` — extend existing SlashMenu placement coverage to the shared module.
- PmEditableBlock `getContextAtCoords` — mark detection at a position via direct `view.someProp`-style
  invocation (the pattern used by existing PM tests).

**E2E (`editor.spec.js`, `--project=chromium`):**

- Right-click over plain text → custom menu with Clipboard (+ Add comment only when a selection
  contains the click).
- Right-click over a revision mark → Accept/Reject present and functional.
- Right-click over a comment mark → Resolve present and functional.
- Right-click in a table cell → row/column ops present and functional.
- Right-click over the gutter/chrome → NATIVE menu (assert no custom menu opens).
- Read-only room → copy-only custom menu.
- Right-click while the slash menu is open → slash menu closes, scratch block survives, context menu
  opens (regression for the mousedown/contextmenu race).

**Collab-drift regression:** deterministic test forcing a peer range-shift between menu-open and
action-click (per `CLAUDE.md` testing rule 7 — force the race rather than chasing a CI flake).

## Open items for the implementation plan

- Exact clipboard serialization for Copy/Cut (PM range → HTML/text) and the read-only Copy path.
- Whether `TC_RESOLVE_META` must be set on the reject-add path as well as accept-del.
- Merged-cell (colspan) right-click → start-column mapping detail for table ops.
