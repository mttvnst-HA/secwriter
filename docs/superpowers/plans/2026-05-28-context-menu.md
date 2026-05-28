# Custom Right-Click Context Menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a SecWriter-specific right-click context menu inside the editor (clipboard, tracked-changes accept/reject, comment add/resolve, table ops) that fires only over editable content and otherwise yields the native browser menu.

**Architecture:** One App-level singleton `contextmenu` listener on the editor scroll container. It resolves a context descriptor for the right-click target (PM blocks via a `getContextAtCoords` registry handle; Table/Title/Ref via direct DOM reads), builds a dynamic flat item list via a pure builder, and opens one shared `<ContextMenu>` portal at the pointer. Null descriptor → no `preventDefault` → native menu.

**Tech Stack:** React (portals), ProseMirror (posAtCoords / mark resolution / transactions), Yjs (ySyncPlugin substrate writes), Vitest (unit), Playwright chromium (E2E).

**Design spec:** `docs/superpowers/specs/2026-05-28-context-menu-design.md`

---

## File Structure

**New files:**
- `src/lib/menu-placement.js` — `computePlacement` / `computeLeft` extracted verbatim from `SlashMenu.jsx`. Pure, React-free. Imported by SlashMenu and ContextMenu.
- `src/lib/context-menu-items.js` — pure `buildContextMenuItems(ctx) → Item[]` (dynamic item model) + `tableCellCoordsFromTd(td)` (pure DOM-attr read for table resolution).
- `src/components/ContextMenu.jsx` — React portal popup; `role="menu"`, items `role="menuitem"`; anchored at pointer coords via menu-placement; arrow/Enter/Escape nav; outside-mousedown + scroll dismiss.

**Modified files:**
- `src/components/SlashMenu.jsx` — import `computePlacement`/`computeLeft` from menu-placement.js; re-export both so the existing placement test keeps passing.
- `src/lib/block-registry.js` — add `getContextAtCoordsById(blockId, coords)` passthrough.
- `src/components/PmEditableBlock.jsx` — add `getContextAtCoords({x,y})` to the imperative handle; suppress the two `mousedown`-capture listeners (slash-dismiss + new-block-discard) on right-click (`e.button === 2`).
- `src/components/TableBlock.jsx` — add `data-row` / `data-col` (cell array index) / `data-vcol` (visual column start) to each rendered `<td>`/`<th>`.
- `src/lib/table-ops.js` — add `insertRowAt(table, rowIdx)` and `insertColumnAt(table, vcolIdx)` pure functions.
- `src/App.jsx` — `editorScrollRef`, the singleton `contextmenu` listener effect, `contextMenu` state, `<ContextMenu>` render, and action routing.

---

## Task 1: Extract menu-placement.js (no behavior change)

**Files:**
- Create: `src/lib/menu-placement.js`
- Modify: `src/components/SlashMenu.jsx:16-53`
- Test: `src/lib/__tests__/menu-placement.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/__tests__/menu-placement.test.js
import { describe, it, expect } from 'vitest';
import { computePlacement, computeLeft } from '../menu-placement.js';

describe('computePlacement', () => {
  it('places below when there is room', () => {
    const r = computePlacement({
      anchorRect: { top: 100, bottom: 120 },
      viewportHeight: 800, menuHeight: 200, margin: 8,
    });
    expect(r.placement).toBe('below');
    expect(r.top).toBe(124); // bottom + ANCHOR_GAP(4)
    expect(r.maxHeight).toBeNull();
  });

  it('places above when below lacks room but above has it', () => {
    const r = computePlacement({
      anchorRect: { top: 700, bottom: 720 },
      viewportHeight: 800, menuHeight: 200, margin: 8,
    });
    expect(r.placement).toBe('above');
    expect(r.top).toBe(700 - 200 - 4);
  });

  it('clamps with maxHeight when neither side fits', () => {
    const r = computePlacement({
      anchorRect: { top: 300, bottom: 320 },
      viewportHeight: 600, menuHeight: 5000, margin: 8,
    });
    expect(['above', 'below']).toContain(r.placement);
    expect(r.maxHeight).toBeGreaterThan(0);
  });
});

describe('computeLeft', () => {
  it('returns the anchor left when it fits', () => {
    expect(computeLeft({ anchorRect: { left: 50 }, menuWidth: 280, viewportWidth: 1000, margin: 8 })).toBe(50);
  });
  it('clamps to the right viewport edge', () => {
    expect(computeLeft({ anchorRect: { left: 990 }, menuWidth: 280, viewportWidth: 1000, margin: 8 })).toBe(1000 - 280 - 8);
  });
  it('clamps to the left margin', () => {
    expect(computeLeft({ anchorRect: { left: -50 }, menuWidth: 280, viewportWidth: 1000, margin: 8 })).toBe(8);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/menu-placement.test.js`
Expected: FAIL — cannot resolve `../menu-placement.js`.

- [ ] **Step 3: Create menu-placement.js (verbatim extraction)**

```javascript
// src/lib/menu-placement.js
/**
 * menu-placement.js — viewport placement math for pointer/caret-anchored
 * popups. Extracted verbatim from SlashMenu.jsx so SlashMenu and the new
 * ContextMenu share one implementation. No logic change.
 */

const ANCHOR_GAP = 4; // px between anchor edge and menu edge

export function computePlacement({ anchorRect, viewportHeight, menuHeight, margin }) {
  const spaceBelow = viewportHeight - anchorRect.bottom - margin;
  const spaceAbove = anchorRect.top - margin;

  if (menuHeight <= spaceBelow) {
    return { placement: 'below', maxHeight: null, top: anchorRect.bottom + ANCHOR_GAP };
  }
  if (menuHeight <= spaceAbove) {
    return { placement: 'above', maxHeight: null, top: anchorRect.top - menuHeight - ANCHOR_GAP };
  }
  if (spaceBelow >= spaceAbove) {
    return { placement: 'below', maxHeight: Math.max(spaceBelow, 120), top: anchorRect.bottom + ANCHOR_GAP };
  }
  return { placement: 'above', maxHeight: Math.max(spaceAbove, 120), top: margin };
}

export function computeLeft({ anchorRect, menuWidth, viewportWidth, margin }) {
  const desired = anchorRect.left;
  return Math.max(margin, Math.min(desired, viewportWidth - menuWidth - margin));
}
```

- [ ] **Step 4: Replace the SlashMenu definitions with a re-export**

In `src/components/SlashMenu.jsx`, delete the local `const ANCHOR_GAP = 4;` (line 16) and the two function definitions `export function computePlacement(...)` / `export function computeLeft(...)` (lines 22-53). Add this import near the top (after the existing react/react-dom imports) and a re-export:

```javascript
import { computePlacement, computeLeft } from "../lib/menu-placement.js";
export { computePlacement, computeLeft };
```

Leave the SlashMenu-only constants `HEADER_HEIGHT`, `ROW_HEIGHT`, `MENU_WIDTH`, `VIEWPORT_MARGIN` in place (lines 17-20).

- [ ] **Step 5: Run both placement tests to verify pass**

Run: `npm test -- src/lib/__tests__/menu-placement.test.js src/components/__tests__/slash-menu-placement.test.js`
Expected: PASS (the existing slash test imports from `../SlashMenu.jsx`, which now re-exports the moved functions).

- [ ] **Step 6: Commit**

```bash
git add src/lib/menu-placement.js src/components/SlashMenu.jsx src/lib/__tests__/menu-placement.test.js
git commit -m "refactor(menu): extract placement math to shared menu-placement.js"
```

---

## Task 2: table-ops insert-at-index helpers

**Files:**
- Modify: `src/lib/table-ops.js` (append after `splitCell`)
- Test: `src/lib/__tests__/table-ops-insert.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/__tests__/table-ops-insert.test.js
import { describe, it, expect } from 'vitest';
import { insertRowAt, insertColumnAt } from '../table-ops.js';

const t = () => ({
  columns: 2,
  rows: [
    [{ text: 'a', colspan: 1 }, { text: 'b', colspan: 1 }],
    [{ text: 'c', colspan: 1 }, { text: 'd', colspan: 1 }],
  ],
});

describe('insertRowAt', () => {
  it('inserts an empty row at the index, pushing the rest down', () => {
    const r = insertRowAt(t(), 1);
    expect(r.rows.length).toBe(3);
    expect(r.rows[1]).toEqual([{ text: '', colspan: 1 }, { text: '', colspan: 1 }]);
    expect(r.rows[2][0].text).toBe('c');
  });
  it('clamps an out-of-range index to append', () => {
    const r = insertRowAt(t(), 99);
    expect(r.rows.length).toBe(3);
    expect(r.rows[2]).toEqual([{ text: '', colspan: 1 }, { text: '', colspan: 1 }]);
  });
});

describe('insertColumnAt', () => {
  it('inserts an empty visual column at the index', () => {
    const r = insertColumnAt(t(), 1);
    expect(r.columns).toBe(3);
    expect(r.rows[0].map(c => c.text)).toEqual(['a', '', 'b']);
  });
  it('extends a spanning cell when the insert falls inside its span', () => {
    const spanned = { columns: 2, rows: [[{ text: 'wide', colspan: 2 }]] };
    const r = insertColumnAt(spanned, 1);
    expect(r.columns).toBe(3);
    expect(r.rows[0][0].colspan).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/table-ops-insert.test.js`
Expected: FAIL — `insertRowAt`/`insertColumnAt` are not exported.

- [ ] **Step 3: Append the implementations to table-ops.js**

```javascript
/**
 * Insert an empty row before `rowIdx` (use rowIdx+1 from the caller for
 * "below"). An out-of-range index appends at the end.
 */
export function insertRowAt(table, rowIdx) {
  const t = cloneTable(table);
  const newRow = [];
  for (let i = 0; i < t.columns; i++) newRow.push({ text: '', colspan: 1 });
  const at = Math.max(0, Math.min(rowIdx, t.rows.length));
  t.rows.splice(at, 0, newRow);
  return t;
}

/**
 * Insert an empty column at visual column `vcolIdx` (use vcol+1 from the
 * caller for "right"). If a cell's colspan straddles the insertion point,
 * that cell's colspan grows instead of a new cell being added. Mirrors the
 * colspan handling in addColumn/deleteColumn (visual-column indexed).
 */
export function insertColumnAt(table, vcolIdx) {
  const t = cloneTable(table);
  t.columns += 1;
  for (const row of t.rows) {
    let pos = 0;
    let inserted = false;
    for (let c = 0; c < row.length; c++) {
      const span = row[c].colspan || 1;
      if (vcolIdx > pos && vcolIdx < pos + span) {
        // Insertion point falls inside this spanning cell — widen it.
        row[c].colspan = span + 1;
        inserted = true;
        break;
      }
      if (vcolIdx <= pos) {
        row.splice(c, 0, { text: '', colspan: 1 });
        inserted = true;
        break;
      }
      pos += span;
    }
    if (!inserted) row.push({ text: '', colspan: 1 });
  }
  return t;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/__tests__/table-ops-insert.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/table-ops.js src/lib/__tests__/table-ops-insert.test.js
git commit -m "feat(table-ops): add insertRowAt / insertColumnAt helpers"
```

---

## Task 3: buildContextMenuItems pure builder + table-cell resolver

**Context descriptor shapes** (produced by hosts in later tasks, consumed here):

```
// PM block
{ blockId, kind:'pm', pos, selectionEmpty, readOnly,
  addCommentRange?:{from,to}, revision?:{kind:'add'|'del'|'chg', range:{from,to}},
  comment?:{commentId, range:{from,to}, resolved:boolean} }
// table cell
{ blockId, kind:'table', row, col, vcol, canMerge, canSplit, readOnly }
// title / ref (copy-only)
{ blockId, kind:'title'|'ref', selectionEmpty, readOnly }
```

**Item shape** (pure descriptors — NO closures, so the builder is table-testable):
`{ id, label, icon }` for an action; `{ divider:true }` for a section separator. App maps `id` to behavior in Task 9.

**Files:**
- Create: `src/lib/context-menu-items.js`
- Test: `src/lib/__tests__/context-menu-items.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/__tests__/context-menu-items.test.js
import { describe, it, expect } from 'vitest';
import { buildContextMenuItems } from '../context-menu-items.js';

const ids = (items) => items.filter(i => !i.divider).map(i => i.id);

describe('buildContextMenuItems - clipboard', () => {
  it('plain PM, no selection, editable -> paste only (no copy/cut)', () => {
    const items = buildContextMenuItems({ blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: true, readOnly: false });
    expect(ids(items)).toEqual(['paste']);
  });
  it('PM with a selection -> copy, cut, paste', () => {
    const items = buildContextMenuItems({ blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: false, readOnly: false });
    expect(ids(items)).toEqual(['copy', 'cut', 'paste']);
  });
  it('read-only with a selection -> copy only (no cut, no paste)', () => {
    const items = buildContextMenuItems({ blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: false, readOnly: true });
    expect(ids(items)).toEqual(['copy']);
  });
  it('read-only with no selection -> empty (App suppresses -> native menu)', () => {
    const items = buildContextMenuItems({ blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: true, readOnly: true });
    expect(ids(items)).toEqual([]);
  });
});

describe('buildContextMenuItems - tracked changes & comments', () => {
  it('over a revision mark -> accept/reject change after clipboard', () => {
    const items = buildContextMenuItems({
      blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: true, readOnly: false,
      revision: { kind: 'add', range: { from: 2, to: 6 } },
    });
    expect(ids(items)).toEqual(['paste', 'accept-change', 'reject-change']);
  });
  it('selection contains the click -> add-comment offered', () => {
    const items = buildContextMenuItems({
      blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: false, readOnly: false,
      addCommentRange: { from: 1, to: 8 },
    });
    expect(ids(items)).toContain('add-comment');
  });
  it('over an unresolved comment -> resolve-comment offered', () => {
    const items = buildContextMenuItems({
      blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: true, readOnly: false,
      comment: { commentId: 'c1', range: { from: 1, to: 8 }, resolved: false },
    });
    expect(ids(items)).toContain('resolve-comment');
  });
  it('over an already-resolved comment -> no resolve-comment', () => {
    const items = buildContextMenuItems({
      blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: true, readOnly: false,
      comment: { commentId: 'c1', range: { from: 1, to: 8 }, resolved: true },
    });
    expect(ids(items)).not.toContain('resolve-comment');
  });
});

describe('buildContextMenuItems - table', () => {
  it('editable table cell -> insert/delete row+col, merge gated, split gated', () => {
    const items = buildContextMenuItems({
      blockId: 'b1', kind: 'table', row: 0, col: 0, vcol: 0,
      canMerge: true, canSplit: false, readOnly: false,
    });
    const got = ids(items);
    expect(got).toEqual([
      'table-insert-row-above', 'table-insert-row-below',
      'table-insert-col-left', 'table-insert-col-right',
      'table-delete-row', 'table-delete-col', 'table-merge',
    ]);
    expect(got).not.toContain('table-split');
  });
  it('read-only table -> empty', () => {
    const items = buildContextMenuItems({
      blockId: 'b1', kind: 'table', row: 0, col: 0, vcol: 0,
      canMerge: true, canSplit: true, readOnly: true,
    });
    expect(ids(items)).toEqual([]);
  });
});

describe('buildContextMenuItems - title/ref copy-only', () => {
  it('title with selection -> copy only', () => {
    expect(ids(buildContextMenuItems({ blockId: 'b1', kind: 'title', selectionEmpty: false, readOnly: false }))).toEqual(['copy']);
  });
  it('ref with no selection -> empty', () => {
    expect(ids(buildContextMenuItems({ blockId: 'b1', kind: 'ref', selectionEmpty: true, readOnly: false }))).toEqual([]);
  });
});

describe('buildContextMenuItems - dividers', () => {
  it('never starts or ends with a divider and never doubles one', () => {
    const items = buildContextMenuItems({
      blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: false, readOnly: false,
      revision: { kind: 'del', range: { from: 2, to: 6 } },
      comment: { commentId: 'c1', range: { from: 1, to: 8 }, resolved: false },
    });
    expect(items[0].divider).toBeUndefined();
    expect(items[items.length - 1].divider).toBeUndefined();
    for (let i = 1; i < items.length; i++) {
      expect(items[i].divider && items[i - 1].divider).toBeFalsy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/context-menu-items.test.js`
Expected: FAIL — cannot resolve `../context-menu-items.js`.

- [ ] **Step 3: Create context-menu-items.js**

```javascript
// src/lib/context-menu-items.js
/**
 * context-menu-items.js - pure builder for the right-click context menu.
 *
 * buildContextMenuItems(ctx) takes a resolved context descriptor (see the
 * implementation plan / design spec for the per-kind shapes) and returns an
 * ordered flat array of item descriptors. Items are `{ id, label, icon }`;
 * section separators are `{ divider: true }`. The dynamic model: only items
 * valid for the exact target appear ("hide irrelevant", not show-disabled).
 *
 * React-free and DOM-free so it is table-testable. The owning component
 * (App) maps each item `id` to behavior at dispatch time.
 *
 * tableCellCoordsFromTd(td) is the pure DOM-attr reader used by App's table
 * host resolution - colocated here because it produces the {row,col,vcol,
 * canMerge,canSplit} half of a table descriptor.
 */

function pushSection(out, sectionItems) {
  if (sectionItems.length === 0) return;
  if (out.length > 0) out.push({ divider: true });
  out.push(...sectionItems);
}

export function buildContextMenuItems(ctx) {
  if (!ctx) return [];
  const out = [];

  if (ctx.kind === 'pm') {
    const clip = [];
    if (!ctx.selectionEmpty) {
      clip.push({ id: 'copy', label: 'Copy', icon: '⧉' });
      if (!ctx.readOnly) clip.push({ id: 'cut', label: 'Cut', icon: '✂' });
    }
    if (!ctx.readOnly) clip.push({ id: 'paste', label: 'Paste', icon: '📋' });
    pushSection(out, clip);

    if (!ctx.readOnly) {
      const tc = [];
      if (ctx.revision) {
        tc.push({ id: 'accept-change', label: 'Accept change', icon: '✓' });
        tc.push({ id: 'reject-change', label: 'Reject change', icon: '✕' });
      }
      pushSection(out, tc);

      const comments = [];
      if (ctx.addCommentRange) comments.push({ id: 'add-comment', label: 'Add comment', icon: '💬' });
      if (ctx.comment && !ctx.comment.resolved) {
        comments.push({ id: 'resolve-comment', label: 'Resolve comment', icon: '✅' });
      }
      pushSection(out, comments);
    }
    return out;
  }

  if (ctx.kind === 'table') {
    if (ctx.readOnly) return [];
    const table = [
      { id: 'table-insert-row-above', label: 'Insert row above', icon: '▦' },
      { id: 'table-insert-row-below', label: 'Insert row below', icon: '▦' },
      { id: 'table-insert-col-left', label: 'Insert column left', icon: '▦' },
      { id: 'table-insert-col-right', label: 'Insert column right', icon: '▦' },
      { id: 'table-delete-row', label: 'Delete row', icon: '✕' },
      { id: 'table-delete-col', label: 'Delete column', icon: '✕' },
    ];
    if (ctx.canMerge) table.push({ id: 'table-merge', label: 'Merge cell right', icon: '⇨' });
    if (ctx.canSplit) table.push({ id: 'table-split', label: 'Split cell', icon: '⇔' });
    pushSection(out, table);
    return out;
  }

  if (ctx.kind === 'title' || ctx.kind === 'ref') {
    if (!ctx.selectionEmpty) pushSection(out, [{ id: 'copy', label: 'Copy', icon: '⧉' }]);
    return out;
  }

  return out;
}

/**
 * Read a table descriptor's index half from a <td>/<th> carrying the
 * data-row / data-col / data-vcol attributes set by TableBlock. Returns null
 * if the element lacks the attributes (not a registered table cell).
 *
 * data-col is the CELL ARRAY index (drives merge/split/updateCell, which are
 * array-indexed); data-vcol is the VISUAL column start (drives column
 * insert/delete, which are visual-column indexed). A right-click on a merged
 * (colspan>1) cell maps to that cell's start column via data-vcol.
 */
export function tableCellCoordsFromTd(td) {
  if (!td || typeof td.getAttribute !== 'function') return null;
  const r = td.getAttribute('data-row');
  const c = td.getAttribute('data-col');
  const v = td.getAttribute('data-vcol');
  if (r == null || c == null) return null;
  return {
    row: Number(r),
    col: Number(c),
    vcol: v == null ? Number(c) : Number(v),
    canMerge: td.getAttribute('data-can-merge') === 'true',
    canSplit: td.getAttribute('data-can-split') === 'true',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/__tests__/context-menu-items.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/context-menu-items.js src/lib/__tests__/context-menu-items.test.js
git commit -m "feat(context-menu): pure item builder + table-cell coord reader"
```

---

## Task 4: ContextMenu.jsx portal component

**Files:**
- Create: `src/components/ContextMenu.jsx`
- Test: `src/components/__tests__/ContextMenu.test.jsx`

**Props:** `{ items, anchor: {x, y}, onSelect(id), onClose }`. Renders a `position:fixed` portal at `document.body`, anchored at the pointer via `computePlacement`/`computeLeft` (treating the pointer as a zero-height anchor rect). `role="menu"`; action items `role="menuitem"`. Keyboard: ArrowUp/Down move highlight over non-divider items, Enter activates, Escape closes. Dismiss: capture-phase document `mousedown` outside the menu, capture-phase `scroll` outside the menu, window `resize` reposition.

- [ ] **Step 1: Write the failing test**

```jsx
// src/components/__tests__/ContextMenu.test.jsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import ContextMenu from '../ContextMenu.jsx';

afterEach(cleanup);

const items = [
  { id: 'copy', label: 'Copy', icon: '⧉' },
  { id: 'cut', label: 'Cut', icon: '✂' },
  { divider: true },
  { id: 'paste', label: 'Paste', icon: '📋' },
];

function setup(props = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  render(<ContextMenu items={items} anchor={{ x: 100, y: 100 }} onSelect={onSelect} onClose={onClose} {...props} />);
  return { onSelect, onClose };
}

describe('ContextMenu', () => {
  it('renders a menu with one menuitem per non-divider item', () => {
    setup();
    const menu = screen.getByRole('menu');
    expect(menu).toBeTruthy();
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  });

  it('clicking an item calls onSelect with its id', () => {
    const { onSelect } = setup();
    fireEvent.mouseDown(screen.getByText('Paste'));
    expect(onSelect).toHaveBeenCalledWith('paste');
  });

  it('Escape closes the menu', () => {
    const { onClose } = setup();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('ArrowDown then Enter activates the next item, skipping dividers', () => {
    const { onSelect } = setup();
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' }); // copy -> cut
    fireEvent.keyDown(menu, { key: 'ArrowDown' }); // cut -> paste (skip divider)
    fireEvent.keyDown(menu, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('paste');
  });

  it('outside mousedown closes the menu', () => {
    const { onClose } = setup();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/__tests__/ContextMenu.test.jsx`
Expected: FAIL — cannot resolve `../ContextMenu.jsx`.

- [ ] **Step 3: Create ContextMenu.jsx**

```jsx
// src/components/ContextMenu.jsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { computePlacement, computeLeft } from "../lib/menu-placement.js";

const MENU_WIDTH = 220;
const ROW_HEIGHT = 30;
const VIEWPORT_MARGIN = 8;

// Indices of the actionable (non-divider) items, in order.
function actionableIndices(items) {
  const out = [];
  items.forEach((it, i) => { if (!it.divider) out.push(i); });
  return out;
}

export default function ContextMenu({ items, anchor, onSelect, onClose }) {
  const menuRef = useRef(null);
  const [resizeTick, setResizeTick] = useState(0);
  // null until the layout effect computes a placement — avoids a one-frame
  // flash at the top-left corner before positioning runs.
  const [placement, setPlacement] = useState(null);
  // Highlight tracks an index into the FULL items array (dividers skipped by nav).
  const actionable = useMemo(() => actionableIndices(items), [items]);
  const [activeIdx, setActiveIdx] = useState(actionable[0] ?? -1);

  useEffect(() => { setActiveIdx(actionable[0] ?? -1); }, [actionable]);

  useEffect(() => {
    const onResize = () => setResizeTick(t => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Capture-phase dismiss: outside mousedown + outside scroll.
  useEffect(() => {
    if (!onClose) return undefined;
    const onDown = (e) => {
      const menu = menuRef.current;
      if (menu && e.target instanceof Node && menu.contains(e.target)) return;
      onClose();
    };
    const onScroll = (e) => {
      const menu = menuRef.current;
      if (menu && e.target instanceof Node && menu.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, { capture: true });
    };
  }, [onClose]);

  useLayoutEffect(() => {
    if (!anchor) return;
    const menuHeight = items.length * ROW_HEIGHT + 8;
    const anchorRect = { top: anchor.y, bottom: anchor.y, left: anchor.x };
    const p = computePlacement({ anchorRect, viewportHeight: window.innerHeight, menuHeight, margin: VIEWPORT_MARGIN });
    const left = computeLeft({ anchorRect, menuWidth: MENU_WIDTH, viewportWidth: window.innerWidth, margin: VIEWPORT_MARGIN });
    setPlacement({ top: p.top, left, maxHeight: p.maxHeight });
  }, [anchor, items.length, resizeTick]);

  const move = (dir) => {
    if (actionable.length === 0) return;
    const cur = actionable.indexOf(activeIdx);
    const next = cur < 0 ? 0 : (cur + dir + actionable.length) % actionable.length;
    setActiveIdx(actionable[next]);
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose?.(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[activeIdx];
      if (it && !it.divider) onSelect?.(it.id);
    }
  };

  // Focus the menu once it actually renders (placement !== null) so it
  // receives the keydowns. A plain []-deps effect would fire on the first
  // (null-placement) commit when the menu DOM does not exist yet.
  const hasFocusedRef = useRef(false);
  useEffect(() => {
    if (placement && !hasFocusedRef.current) {
      hasFocusedRef.current = true;
      menuRef.current?.focus?.();
    }
  }, [placement]);

  if (!anchor || items.length === 0 || !placement) return null;

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Editor actions"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        top: placement.top,
        left: placement.left,
        width: MENU_WIDTH,
        maxHeight: placement.maxHeight ?? undefined,
        overflowY: placement.maxHeight ? 'auto' : 'visible',
        overscrollBehavior: 'contain',
        zIndex: 1000,
        backgroundColor: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
        padding: '4px 0',
        outline: 'none',
        fontSize: 13,
        color: '#1e293b',
      }}
    >
      {items.map((it, i) => {
        if (it.divider) {
          return <div key={`d${i}`} aria-hidden="true" style={{ borderTop: '1px solid #eef2f7', margin: '4px 0' }} />;
        }
        const isActive = i === activeIdx;
        return (
          <div
            key={it.id}
            role="menuitem"
            tabIndex={-1}
            onMouseDown={(e) => { e.preventDefault(); onSelect?.(it.id); }}
            onMouseMove={() => { if (activeIdx !== i) setActiveIdx(i); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '5px 12px',
              cursor: 'pointer',
              backgroundColor: isActive ? '#f1f5f9' : 'transparent',
            }}
          >
            <span style={{ width: 18, textAlign: 'center', flexShrink: 0 }}>{it.icon}</span>
            <span>{it.label}</span>
          </div>
        );
      })}
    </div>
  );

  return createPortal(menu, document.body);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/__tests__/ContextMenu.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ContextMenu.jsx src/components/__tests__/ContextMenu.test.jsx
git commit -m "feat(context-menu): ContextMenu portal component"
```

---

## Task 5: block-registry getContextAtCoords passthrough

**Files:**
- Modify: `src/lib/block-registry.js` (add after `getBlockView`, ~line 150)
- Test: `src/lib/__tests__/block-registry-context.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/__tests__/block-registry-context.test.js
import { describe, it, expect, afterEach } from 'vitest';
import {
  registerBlock, __resetBlockRegistry, getContextAtCoordsById,
} from '../block-registry.js';

afterEach(() => __resetBlockRegistry());

describe('getContextAtCoordsById', () => {
  it('returns null for an unregistered id', () => {
    expect(getContextAtCoordsById('nope', { x: 1, y: 2 })).toBeNull();
  });
  it('returns null when the handle lacks getContextAtCoords', () => {
    registerBlock('b1', { focus() {}, getDom: () => null, getEditable: () => null, getPlainText: () => '', setHtml() {} });
    expect(getContextAtCoordsById('b1', { x: 1, y: 2 })).toBeNull();
  });
  it('passes coords through to the handle method', () => {
    registerBlock('b1', {
      focus() {}, getDom: () => null, getEditable: () => null, getPlainText: () => '', setHtml() {},
      getContextAtCoords: ({ x, y }) => ({ blockId: 'b1', kind: 'pm', pos: x + y }),
    });
    expect(getContextAtCoordsById('b1', { x: 3, y: 4 })).toEqual({ blockId: 'b1', kind: 'pm', pos: 7 });
  });
  it('swallows a throwing handle and returns null', () => {
    registerBlock('b1', {
      focus() {}, getDom: () => null, getEditable: () => null, getPlainText: () => '', setHtml() {},
      getContextAtCoords: () => { throw new Error('mid-teardown'); },
    });
    expect(getContextAtCoordsById('b1', { x: 1, y: 2 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/block-registry-context.test.js`
Expected: FAIL — `getContextAtCoordsById` is not exported.

- [ ] **Step 3: Add the passthrough to block-registry.js**

Insert after the `getBlockView` function (after line 150):

```javascript
/**
 * Resolve a context descriptor at viewport coordinates for a PM-mounted
 * block via its `getContextAtCoords` handle. Returns null for non-PM hosts
 * (no such handle), unknown ids, or a throwing handle (mid-teardown view).
 * Never throws — the App-level contextmenu listener relies on a null return
 * to fall through to the native browser menu.
 */
export function getContextAtCoordsById(blockId, coords) {
  const h = handles.get(blockId);
  if (!h || typeof h.getContextAtCoords !== 'function') return null;
  try {
    return h.getContextAtCoords(coords) ?? null;
  } catch {
    return null;
  }
}
```

Also extend the `BlockHandle` typedef block (lines 38-58) with one line so the contract is documented:

```javascript
 * @property {((coords: {x:number,y:number}) => object | null)=} getContextAtCoords
 *   PM handle: resolves a context descriptor (mark/selection state) at the
 *   given viewport coordinate for the right-click context menu. Other hosts
 *   omit it (App resolves Title/Ref/Table from the DOM directly).
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/__tests__/block-registry-context.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/block-registry.js src/lib/__tests__/block-registry-context.test.js
git commit -m "feat(context-menu): block-registry getContextAtCoordsById passthrough"
```

---

## Task 6: pm-context.js — pure PM context resolver

Extract the mark/selection resolution into a pure function so it is unit-testable without mounting an EditorView. PmEditableBlock's handle (Task 7) just calls `view.posAtCoords(...)` then delegates here.

**Files:**
- Create: `src/lib/pm-context.js`
- Test: `src/lib/__tests__/pm-context.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../pm-schema.js';
import { resolvePmContextAt } from '../pm-context.js';

function docOf(...children) {
  return schema.node('doc', null, [schema.node('paragraph', null, children)]);
}
const txt = (text, ...marks) => schema.text(text, marks);
function stateOf(doc, from = 0, to = from) {
  return EditorState.create({ doc, selection: TextSelection.create(doc, from, to) });
}

describe('resolvePmContextAt', () => {
  it('plain text, collapsed selection -> selectionEmpty true, no extras', () => {
    const state = stateOf(docOf(txt('hello')), 3);
    const d = resolvePmContextAt(state, 3, { blockId: 'b1', readOnly: false });
    expect(d).toMatchObject({ blockId: 'b1', kind: 'pm', pos: 3, selectionEmpty: true, readOnly: false });
    expect(d.revision).toBeUndefined();
    expect(d.comment).toBeUndefined();
    expect(d.addCommentRange).toBeUndefined();
  });

  it('read-only short-circuits before mark resolution', () => {
    const mark = schema.marks.revisionAdd.create({ authorId: 'a', authorColor: '#f00' });
    const state = stateOf(docOf(txt('hello', mark)), 3);
    const d = resolvePmContextAt(state, 3, { blockId: 'b1', readOnly: true });
    expect(d.readOnly).toBe(true);
    expect(d.revision).toBeUndefined();
  });

  it('detects a revisionAdd mark under the position', () => {
    const mark = schema.marks.revisionAdd.create({ authorId: 'a', authorColor: '#f00' });
    const state = stateOf(docOf(txt('hello', mark)), 3);
    const d = resolvePmContextAt(state, 3, { blockId: 'b1', readOnly: false });
    expect(d.revision.kind).toBe('add');
    expect(d.revision.range).toEqual({ from: 1, to: 6 });
  });

  it('detects an unresolved comment mark under the position', () => {
    const mark = schema.marks.comment.create({ id: 'c1', resolved: false });
    const state = stateOf(docOf(txt('hello', mark)), 3);
    const d = resolvePmContextAt(state, 3, { blockId: 'b1', readOnly: false });
    expect(d.comment).toEqual({ commentId: 'c1', range: { from: 1, to: 6 }, resolved: false });
  });

  it('marks addCommentRange when a non-empty selection contains the click pos', () => {
    const state = stateOf(docOf(txt('hello world')), 1, 6); // selection 1..6
    const d = resolvePmContextAt(state, 3, { blockId: 'b1', readOnly: false });
    expect(d.selectionEmpty).toBe(false);
    expect(d.addCommentRange).toEqual({ from: 1, to: 6 });
  });

  it('omits addCommentRange when the click is outside the selection', () => {
    const state = stateOf(docOf(txt('hello world')), 1, 4);
    const d = resolvePmContextAt(state, 9, { blockId: 'b1', readOnly: false });
    expect(d.addCommentRange).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/__tests__/pm-context.test.js`
Expected: FAIL — cannot resolve `../pm-context.js`.

- [ ] **Step 3: Create pm-context.js**

```javascript
// src/lib/pm-context.js
/**
 * pm-context.js - pure resolver that maps a PM EditorState + document
 * position to a context descriptor for the right-click context menu.
 *
 * Kept pure (no view, no DOM) so it is unit-testable without mounting an
 * EditorView. PmEditableBlock's `getContextAtCoords` handle resolves the
 * position via `view.posAtCoords` then delegates here.
 *
 * Read-only short-circuits before mark resolution: in a read-only room the
 * menu is copy-only, so revision/comment/add-comment items never apply.
 */

import { REVISION_MARK_TYPE_NAMES } from './pm-schema.js';
import { findMarkRangeAt } from './pm-toolbar.js';

const REVISION_KINDS = ['add', 'del', 'chg'];

export function resolvePmContextAt(state, pos, { blockId, readOnly }) {
  if (!state) return null;
  const { from, to, empty } = state.selection;
  const desc = {
    blockId, kind: 'pm', pos,
    selectionEmpty: empty, readOnly: !!readOnly,
  };
  if (readOnly) return desc;

  const schema = state.schema;
  for (const k of REVISION_KINDS) {
    const markType = schema.marks[REVISION_MARK_TYPE_NAMES[k]];
    if (!markType) continue;
    const r = findMarkRangeAt(state.doc, pos, markType, () => true);
    if (r) { desc.revision = { kind: k, range: { from: r.from, to: r.to } }; break; }
  }

  const commentType = schema.marks.comment;
  if (commentType) {
    const cr = findMarkRangeAt(state.doc, pos, commentType, () => true);
    if (cr) {
      desc.comment = {
        commentId: cr.mark.attrs.id,
        range: { from: cr.from, to: cr.to },
        resolved: !!cr.mark.attrs.resolved,
      };
    }
  }

  if (!empty && pos >= from && pos <= to) {
    desc.addCommentRange = { from, to };
  }
  return desc;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/__tests__/pm-context.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pm-context.js src/lib/__tests__/pm-context.test.js
git commit -m "feat(context-menu): pure PM context resolver (pm-context.js)"
```

---

## Task 7: PmEditableBlock — getContextAtCoords handle + right-click safety

Wire the pure resolver into the block's imperative handle, suppress the destructive right-click paths, and force-close the slash menu / del-popup on `contextmenu` so they never overlap the context menu.

**Files:**
- Modify: `src/components/PmEditableBlock.jsx`
- Test: `src/components/__tests__/PmEditableBlock-contextmenu.test.jsx`

- [ ] **Step 1: Add the resolver import**

After the existing imports (near line 84), add:

```javascript
import { resolvePmContextAt } from '../lib/pm-context.js';
```

> `closeSlashMenuPlugin` is ALREADY imported at line 84 (`import { closeSlashMenuPlugin, isBlockJustSlashTrigger } from '../lib/pm-slash-dismiss.js'`) and is used by Step 5 — do NOT re-import it. `setSlashState` (state hook, line 177) and `setDelPopup` (line 181) are the correct setter names used in Step 5.

- [ ] **Step 2: Add a readOnly ref**

After the `onConvertBlockRef` ref assignment (line 215), add:

```javascript
const readOnlyRef = useRef(readOnly);
readOnlyRef.current = readOnly;
```

- [ ] **Step 3: Add getContextAtCoords to the handle**

In the handle object literal (registered at line 740), after the `getView` entry (line 700), add:

```javascript
      getContextAtCoords: ({ x, y }) => {
        const view = viewRef.current;
        if (!view) return null;
        let coords;
        try {
          coords = view.posAtCoords({ left: x, top: y });
        } catch {
          return null;
        }
        if (!coords) return null;
        return resolvePmContextAt(view.state, coords.pos, {
          blockId: block.id,
          readOnly: readOnlyRef.current,
        });
      },
```

- [ ] **Step 4: Suppress right-click in both mousedown-capture listeners**

In the slash-dismiss listener's `onDocMouseDown` (line 896) and the new-block-discard listener's `onDocMouseDown` (line 936), add this as the FIRST statement of each handler body:

```javascript
      if (e.button === 2) return; // right-click: let the contextmenu path own it
```

This prevents a right-click `mousedown` (which precedes `contextmenu`) from converting a scratch block to txt or discarding it.

> Verified complete: these are the ONLY two `mousedown`-capture listeners in PmEditableBlock (their `addEventListener('mousedown', onDocMouseDown, true)` calls are at ~line 916 and ~line 953). The del-popup dismiss listens on `scroll` only (line 662), not `mousedown`, and is force-closed explicitly by `handleContextMenuCapture` (Step 5). No third right-click-sensitive mousedown path exists.

- [ ] **Step 5: Add the contextmenu cleanup handler**

After the `handleDelAction` useCallback (ends line 854), add:

```javascript
  // On right-click, force-close any open slash menu + del-popup so neither
  // overlaps the context menu. Capture phase (onContextMenuCapture) so this
  // runs before App's bubble-phase singleton contextmenu listener. Closing
  // an already-closed menu is a no-op forceClose.
  const handleContextMenuCapture = useCallback(() => {
    closeSlashMenuPlugin(viewRef.current);
    setSlashState({ open: false, filter: '', selectedIdx: 0, fromPos: null });
    setDelPopup(null);
  }, []);
```

Then add the handler to the wrapper `<div>` at line 1067:

```jsx
    <div
      id={`block-${block.id}`}
      style={{ position: 'relative' }}
      className={revisionClass}
      data-tag={sgmlTag}
      data-block-type={block.type}
      onContextMenuCapture={handleContextMenuCapture}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
```

- [ ] **Step 6: Write the regression test**

```jsx
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { getBlockHandle, __resetBlockRegistry } from '../../lib/block-registry.js';
import PmEditableBlock from '../PmEditableBlock.jsx';

// Minimal substrate stub: PmEditableBlock bails to an unmounted view when
// yStore.get(id) is undefined, so getView()/getContextAtCoords resolve with
// a null view and return null without throwing. That is exactly the
// "never block the native menu mid-teardown" contract we assert here.
const yStoreStub = { get: () => undefined, observe() {}, unobserve() {} };

afterEach(() => { cleanup(); __resetBlockRegistry(); });

function renderBlock(props = {}) {
  const block = { id: 'b1', type: 'txt', html: '<p>hello</p>', part: 1, depth: 0 };
  render(<PmEditableBlock block={block} yStore={yStoreStub} onUpdate={vi.fn()} readOnly={false} {...props} />);
  return getBlockHandle('b1');
}

describe('PmEditableBlock context-menu handle', () => {
  it('registers a getContextAtCoords handle method', () => {
    const handle = renderBlock();
    expect(typeof handle.getContextAtCoords).toBe('function');
  });

  it('getContextAtCoords returns null when the view is unmounted (never blocks native menu)', () => {
    const handle = renderBlock();
    expect(handle.getContextAtCoords({ x: 10, y: 10 })).toBeNull();
  });
});
```

> Note: a full mark-detection assertion is already covered purely in `pm-context.test.js` (Task 6). This test only pins the handle wiring + the mid-teardown null-safety contract, which is what keeps the native menu reachable.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npm test -- src/components/__tests__/PmEditableBlock-contextmenu.test.jsx`
Expected: PASS.

- [ ] **Step 8: Run the existing PmEditableBlock + slash tests for regressions**

Run: `npm test -- src/components/__tests__/PmEditableBlock-mount-race.test.jsx src/lib/__tests__/pm-slash-dismiss.test.js src/lib/__tests__/slash-menu-plugin.test.js`
Expected: PASS (right-click suppression must not perturb left-click slash/discard behavior).

- [ ] **Step 9: Commit**

```bash
git add src/components/PmEditableBlock.jsx src/components/__tests__/PmEditableBlock-contextmenu.test.jsx
git commit -m "feat(context-menu): PmEditableBlock getContextAtCoords + right-click safety"
```

---

## Task 8: TableBlock — data-row / data-col / data-vcol on cells

App resolves table context directly from the DOM (no registry handle). Tag every body cell with the indices the action dispatch needs.

**Files:**
- Modify: `src/components/TableBlock.jsx:144-160` (the `renderCell` function)
- Test: `src/components/__tests__/TableBlock-context-attrs.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import TableBlock from '../TableBlock.jsx';

afterEach(cleanup);

const block = {
  id: 't1', type: 'table',
  table: {
    columns: 3,
    rows: [
      [{ text: 'a', colspan: 1 }, { text: 'bc', colspan: 2 }],
      [{ text: 'd', colspan: 1 }, { text: 'e', colspan: 1 }, { text: 'f', colspan: 1 }],
    ],
  },
};

function cellAt(container, row, col) {
  return container.querySelector(`td[data-row="${row}"][data-col="${col}"]`);
}

describe('TableBlock data-* cell attributes', () => {
  it('tags each body cell with row, array col, and visual column start', () => {
    const { container } = render(<TableBlock block={block} onUpdate={() => {}} readOnly={false} />);
    const a = cellAt(container, 0, 0);
    expect(a.getAttribute('data-vcol')).toBe('0');
    const bc = cellAt(container, 0, 1);
    expect(bc.getAttribute('data-vcol')).toBe('1'); // starts after the colspan-1 'a'
    expect(bc.getAttribute('colspan')).toBe('2');
    const f = cellAt(container, 1, 2);
    expect(f.getAttribute('data-vcol')).toBe('2');
  });

  it('exposes merge/split affordances as data flags', () => {
    const { container } = render(<TableBlock block={block} onUpdate={() => {}} readOnly={false} />);
    const a = cellAt(container, 0, 0);     // not last in row -> can merge; colspan 1 -> cannot split
    expect(a.getAttribute('data-can-merge')).toBe('true');
    expect(a.getAttribute('data-can-split')).toBe('false');
    const bc = cellAt(container, 0, 1);    // last in row -> cannot merge; colspan 2 -> can split
    expect(bc.getAttribute('data-can-merge')).toBe('false');
    expect(bc.getAttribute('data-can-split')).toBe('true');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/__tests__/TableBlock-context-attrs.test.jsx`
Expected: FAIL — `data-row` etc. are absent.

- [ ] **Step 3: Add the attributes in renderCell**

In `renderCell` (line 144), after the `canSplit` line (150), compute the visual column start:

```javascript
    let vcol = 0;
    for (let i = 0; i < cellIdx; i++) vcol += (row[i].colspan || 1);
```

Then add the data attributes to the opening `<Tag>` (line 153), alongside the existing `colSpan` / `style` props:

```jsx
      <Tag
        key={cellIdx}
        data-row={rowIdx}
        data-col={cellIdx}
        data-vcol={vcol}
        data-can-merge={canMerge ? 'true' : 'false'}
        data-can-split={canSplit ? 'true' : 'false'}
        colSpan={cell.colspan > 1 ? cell.colspan : undefined}
        style={style}
        onDoubleClick={() => canEdit && startEdit(rowIdx, cellIdx, cell.text)}
        onMouseEnter={() => setHoverCell({ row: rowIdx, col: cellIdx })}
        onMouseLeave={() => setHoverCell(null)}
      >
```

> `canMerge`/`canSplit` are already gated on `canEdit` (line 149-150), so in read-only they serialize as `false` — but App also resolves `readOnly` independently and the builder hides all table items in read-only anyway.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/__tests__/TableBlock-context-attrs.test.jsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/TableBlock.jsx src/components/__tests__/TableBlock-context-attrs.test.jsx
git commit -m "feat(context-menu): tag TableBlock cells with row/col/vcol data attrs"
```

---

## Task 9: App.jsx — singleton listener, resolution, render, dispatch

This wires everything together. No new behavior is unit-testable in isolation here (it is integration glue); correctness is pinned by the E2E suite in Task 10. Verify type/signature consistency against earlier tasks as you go.

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Add imports**

Near the existing block-registry import (line 35), extend it and add the new module imports below it:

```javascript
import {
  focusBlockById, getBlockEditable, getBlockDom, getBlockView, listBlocksInDocumentOrder,
  getContextAtCoordsById, cancelPendingUpdateById, flushPendingUpdateById,
} from "./lib/block-registry.js";
import ContextMenu from "./components/ContextMenu.jsx";
import { buildContextMenuItems, tableCellCoordsFromTd } from "./lib/context-menu-items.js";
import {
  applyInlineRevisionResolveTr, dispatchToolbarVerb,
  extractHtml, extractRangeText,
} from "./lib/pm-toolbar.js";
import { TC_RESOLVE_META } from "./lib/pm-tc-mark.js";
import { sanitizePasteText } from "./lib/paste-sanitize.js";
import { pmFragmentToHtml } from "./lib/pmdoc-html.js";
import { insertRowAt, insertColumnAt, deleteRow, deleteColumn, mergeCellRight, splitCell } from "./lib/table-ops.js";
```

> Keep the original `focusBlockById, getBlockEditable, getBlockDom, getBlockView, listBlocksInDocumentOrder` names in the block-registry import — just add the three new ones.

- [ ] **Step 2: Add state + refs**

Next to the `convertPalette` state (line 195), add:

```javascript
  const [contextMenu, setContextMenu] = useState(null); // { items, anchor:{x,y}, ctx } | null
  const editorScrollRef = useRef(null);
```

- [ ] **Step 3: Attach the scroll-container ref**

On the `.editor-scroll` div (line 2587), add the ref:

```jsx
        <div
          className="editor-scroll"
          ref={editorScrollRef}
          style={{
```

- [ ] **Step 4: Add the descriptor resolver**

Add this `useCallback` alongside the other handlers (e.g. after `handleCommentClick`, ~line 947). It reads refs (`blocksRef`, `collabReadOnlyRef`) so it can be stable:

```javascript
  // Resolve a context descriptor for a right-click event, or null when the
  // click is outside editable content (gutter / chrome / page card margin) so
  // the native browser menu fires. Boundary rule: a custom menu only when the
  // target resolves inside a registered block host (id="block-<id>").
  const resolveContextDescriptor = useCallback((e) => {
    const target = e.target;
    if (!(target instanceof Element)) return null;
    const hostEl = target.closest('[id^="block-"]');
    if (!hostEl) return null;
    const blockId = hostEl.id.slice('block-'.length);
    const block = blocksRef.current.find(b => b.id === blockId);
    if (!block) return null;
    const readOnly = collabReadOnlyRef.current;

    if (block.type === 'table') {
      const td = target.closest('td[data-row]');
      const coords = tableCellCoordsFromTd(td);
      if (!coords) return null; // table chrome (add/delete buttons) -> native
      return { blockId, kind: 'table', ...coords, readOnly };
    }
    if (block.type === 'title' || block.type === 'ref') {
      const sel = window.getSelection();
      return { blockId, kind: block.type, selectionEmpty: !sel || sel.isCollapsed, readOnly };
    }
    if (block.type === 'pagebreak' || block.type === 'tbl') return null;
    // PM editable host: delegate to the registry handle (returns null on a
    // mid-teardown view -> native menu).
    return getContextAtCoordsById(blockId, { x: e.clientX, y: e.clientY });
  }, []);
```

- [ ] **Step 5: Add the singleton contextmenu listener effect**

Add this effect near the other document-level effects (e.g. after the keydown effect, ~line 1791):

```javascript
  // Singleton right-click context menu. One listener on the editor scroll
  // container. Null descriptor or an empty item list -> return WITHOUT
  // preventDefault so the native browser menu fires (boundary + read-only
  // suppression rules).
  useEffect(() => {
    const scroller = editorScrollRef.current;
    if (!scroller) return undefined;
    const onContextMenu = (e) => {
      const ctx = resolveContextDescriptor(e);
      if (!ctx) return;
      const items = buildContextMenuItems(ctx);
      if (!items.some(i => !i.divider)) return;
      e.preventDefault();
      setContextMenu({ items, anchor: { x: e.clientX, y: e.clientY }, ctx });
    };
    scroller.addEventListener('contextmenu', onContextMenu);
    return () => scroller.removeEventListener('contextmenu', onContextMenu);
  }, [resolveContextDescriptor]);
```

- [ ] **Step 6: Add the action dispatcher**

Add this `useCallback` after `resolveContextDescriptor`. It re-resolves position-sensitive actions at click time (collab-drift guard) and routes to existing handlers:

```javascript
  const handleContextAction = useCallback((id, menu) => {
    const forceFrame = inRoom ? collab.forceFrame : localUndo.forceFrame;
    const blockId = menu.ctx.blockId;
    const toastNoop = (msg) => toastPushRef.current?.({ kind: 'info', title: msg, ttl: 4000 });

    switch (id) {
      case 'copy': {
        const view = getBlockView(blockId);
        let text = '';
        if (view) {
          const { from, to } = view.state.selection;
          text = view.state.doc.textBetween(from, to, '\n', '');
        } else {
          text = window.getSelection()?.toString() ?? '';
        }
        if (!text) break;
        // v1: Copy serializes PLAIN TEXT only (consistent with the plaintext-
        // only paste design, #99). Inline data marks (RID/SUB/ENG/MET) are
        // NOT carried to the system clipboard — documented limitation, see
        // Self-Review. The menu portal stole focus; re-focus before writing.
        if (!navigator.clipboard?.writeText) { toastNoop('Clipboard unavailable'); break; }
        view?.focus();
        navigator.clipboard.writeText(text).catch((err) => {
          toastNoop(err?.name === 'NotAllowedError' ? 'Clipboard permission denied' : 'Copy failed');
        });
        break;
      }
      case 'cut': {
        const view = getBlockView(blockId);
        if (!view) break;
        const { from, to } = view.state.selection;
        if (from === to) break;
        const text = view.state.doc.textBetween(from, to, '\n', '');
        if (!navigator.clipboard?.writeText) { toastNoop('Clipboard unavailable'); break; }
        view.focus();
        navigator.clipboard.writeText(text).catch(() => {});
        forceFrame();
        view.dispatch(view.state.tr.deleteSelection());
        cancelPendingUpdateById(blockId);
        handleBlockUpdatePmSync(blockId, pmFragmentToHtml(view.state.doc));
        break;
      }
      case 'paste': {
        const view = getBlockView(blockId);
        if (!view) break;
        if (!navigator.clipboard?.readText) { toastNoop('Clipboard unavailable'); break; }
        // The menu portal stole focus on mount; clipboard READ requires the
        // document focused + transient activation. Re-focus before the read
        // AND inside the async resolve (the menu unmounts between them, and
        // setContextMenu(null) runs right after this synchronous body).
        view.focus();
        navigator.clipboard.readText().then((raw) => {
          const text = sanitizePasteText(raw || '');
          if (!text) return;
          const v = getBlockView(blockId);
          if (!v) return;
          v.focus();
          forceFrame();
          v.dispatch(v.state.tr.insertText(text));
          flushPendingUpdateById(blockId);
        }).catch((err) => {
          toastNoop(err?.name === 'NotAllowedError' ? 'Clipboard permission denied' : 'Paste failed');
        });
        break;
      }
      case 'accept-change':
      case 'reject-change': {
        const view = getBlockView(blockId);
        if (!view) { toastNoop('Change no longer available'); break; }
        let coords;
        try { coords = view.posAtCoords({ left: menu.anchor.x, top: menu.anchor.y }); }
        catch { coords = null; }
        if (!coords) { toastNoop('Change no longer available'); break; }
        const action = id === 'accept-change' ? 'accept' : 'reject';
        // Pin the resolution to the kind the user saw (kindHint). Two reasons:
        // (1) it makes resolution deterministic; (2) it lets us decide
        // TC_RESOLVE_META correctly below. If the mark of that kind drifted
        // away under a peer edit, the verb returns null -> no-op + toast.
        const kindHint = menu.ctx.revision?.kind;
        // Route through dispatchToolbarVerb (caller-owned settlement) so we
        // reuse the one tested forceFrame -> dispatch -> cancelPendingUpdate
        // protocol instead of re-implementing it.
        const result = dispatchToolbarVerb({
          view,
          saved: { blockId },
          onForceFrame: forceFrame,
          compute: (state) => {
            const r = applyInlineRevisionResolveTr(state, action, coords.pos, kindHint);
            // TC_RESOLVE_META ONLY on accept-del. That path dispatches a raw
            // tr.delete over a revisionDel range, which rewriteForTrackChanges
            // would otherwise re-mark into a no-op (#96). reject-add ALSO
            // deletes, but there the rewriter MUST run so a foreign author's
            // pending addition becomes a mark-for-deletion (preserving the
            // audit trail) — setting the meta there would hard-delete it.
            // removeMark paths (accept-add / reject-del / chg) never touch
            // the rewriter, so the meta is irrelevant for them.
            if (r && action === 'accept' && kindHint === 'del') {
              r.tr.setMeta(TC_RESOLVE_META, true);
            }
            return r;
          },
        });
        if (!result.dispatched) { toastNoop('Change no longer available'); break; }
        handleBlockUpdatePmSync(blockId, extractHtml(result.state));
        break;
      }
      case 'add-comment': {
        const view = getBlockView(blockId);
        const range = menu.ctx.addCommentRange;
        if (!view || !range) break;
        // Build the comment mark DIRECTLY from the captured range. We do NOT
        // route through dispatchToolbarVerb: it computes from the live
        // state.selection, but the menu portal stole focus and a right-click
        // can collapse the DOM selection, so applyCommentMarkTr would see an
        // empty selection and no-op. The captured range is the user's intent.
        // Cheap drift guard: the range must still fit the live doc.
        if (range.to > view.state.doc.content.size) { toastNoop('Selection no longer here'); break; }
        const markType = view.state.schema.marks.comment;
        if (!markType) break;
        const commentId = `comment-${Date.now()}`;
        forceFrame();
        view.dispatch(view.state.tr.addMark(range.from, range.to, markType.create({ id: commentId, resolved: false })));
        const stateAfter = view.state;
        flushPendingUpdateById(blockId);
        handleCommentCreate(blockId, extractHtml(stateAfter), commentId, extractRangeText(stateAfter, range));
        break;
      }
      case 'resolve-comment': {
        const fresh = getContextAtCoordsById(blockId, menu.anchor);
        const commentId = fresh?.comment?.commentId ?? menu.ctx.comment?.commentId;
        if (!commentId) { toastNoop('Comment no longer here'); break; }
        handleCommentResolve(commentId);
        break;
      }
      default: {
        if (!id.startsWith('table-')) break;
        const el = document.elementFromPoint(menu.anchor.x, menu.anchor.y);
        const td = el?.closest?.('td[data-row]');
        const coords = tableCellCoordsFromTd(td);
        if (!coords) { toastNoop('Table cell no longer here'); break; }
        const { row, col, vcol } = coords;
        const span = Number(td.getAttribute('colspan')) || 1;
        const apply = (fn) => dispatchBlocks((b) => {
          const block = b.find(x => x.id === blockId);
          if (!block || !block.table) return b;
          const nt = fn(block.table);
          return nt ? Blocks.mergeBlockData(b, blockId, { table: nt }) : b;
        });
        if (id === 'table-insert-row-above') apply(t => insertRowAt(t, row));
        else if (id === 'table-insert-row-below') apply(t => insertRowAt(t, row + 1));
        else if (id === 'table-insert-col-left') apply(t => insertColumnAt(t, vcol));
        else if (id === 'table-insert-col-right') apply(t => insertColumnAt(t, vcol + span));
        else if (id === 'table-delete-row') apply(t => deleteRow(t, row));
        else if (id === 'table-delete-col') apply(t => deleteColumn(t, vcol));
        else if (id === 'table-merge') apply(t => mergeCellRight(t, row, col));
        else if (id === 'table-split') apply(t => splitCell(t, row, col));
        break;
      }
    }
  }, [inRoom, collab, localUndo, handleBlockUpdatePmSync, handleCommentCreate, handleCommentResolve, dispatchBlocks]);
```

> `deleteRow`/`deleteColumn`/`mergeCellRight`/`splitCell` return `null` when the op is impossible (last row/col, right edge, colspan 1); the `apply` wrapper treats null as a no-op, so the menu degrades gracefully even if the table changed between open and click.

- [ ] **Step 7: Render the ContextMenu**

After the `convertPalette` render block (closes at line 2565), add:

```jsx
        {/* Right-click context menu (singleton) */}
        {contextMenu && (
          <ContextMenu
            items={contextMenu.items}
            anchor={contextMenu.anchor}
            onSelect={(actionId) => { handleContextAction(actionId, contextMenu); setContextMenu(null); }}
            onClose={() => setContextMenu(null)}
          />
        )}
```

- [ ] **Step 8: Run unit + lint to catch wiring errors**

Run: `npm test -- src/lib/__tests__/context-menu-items.test.js src/lib/__tests__/pm-context.test.js`
Then start the dev server and confirm the app boots without a runtime/import error:
Run: `npm run dev` (verify no console import errors, then stop).
Expected: tests PASS; dev server compiles clean.

- [ ] **Step 9: Manual smoke (golden path) in the browser**

With `npm run dev` running, in the editor:
1. Right-click plain text with NO selection → menu shows only **Paste**.
2. Select text, right-click inside the selection → **Copy / Cut / Paste / Add comment**.
3. Right-click a tracked-change mark → **Accept change / Reject change**; click one → mark resolves.
4. Right-click a comment span → **Resolve comment**; click → comment resolves.
5. Right-click a table cell → row/column/merge/split ops; each mutates the table.
6. Right-click the gray page gutter / toolbar → NATIVE browser menu (no custom menu).

State explicitly if any step cannot be verified.

- [ ] **Step 10: Commit**

```bash
git add src/App.jsx
git commit -m "feat(context-menu): App singleton listener, resolution, and dispatch"
```

---

## Task 10: E2E coverage (editor.spec.js, chromium)

**Files:**
- Modify: `tests/e2e/editor.spec.js` (append one `test.describe` block)

> `n24` is the anchor block id the existing suite uses; `injectBlockHtml` / `readBlockHtml` are imported at the top of the spec. Right-click via `locator.click({ button: 'right' })`. The native browser menu is not in the DOM — assert the ABSENCE of `[role="menu"]`.

> **Coverage gaps stated honestly:** these E2E tests assert item PRESENCE + the non-clipboard actions (revision accept, comment add/resolve, table insert). They do NOT execute Copy/Cut/Paste end-to-end — `navigator.clipboard` read/write needs granted permissions + a focused document, which is brittle under headless chromium. Paste-execution and the clipboard error-toast paths are verified by the manual smoke (Task 9 Step 9); the conditional-`TC_RESOLVE_META` accept-del logic is verified by the unit-level del-popup tests it mirrors plus the Task 11 drift contract. If clipboard E2E is later wanted, grant `['clipboard-read','clipboard-write']` via `context.grantPermissions` and seed with `page.evaluate(() => navigator.clipboard.writeText(...))`.

- [ ] **Step 1: Write the E2E tests**

```javascript
test.describe('right-click context menu', () => {
  test('plain text, no selection -> Paste only', async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
    await injectBlockHtml(page, 'n24', '<p>hello world</p>');
    await page.locator(blockSel('n24')).click({ button: 'right' });
    const menu = page.locator('[role="menu"]');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['Paste']);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  test('with a selection -> Copy, Cut, Paste, Add comment', async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
    await injectBlockHtml(page, 'n24', '<p>hello world</p>');
    await pmSetSelection(page, 'n24', 1, 6); // "hello"
    await page.locator(blockSel('n24')).click({ button: 'right' });
    const labels = await page.locator('[role="menu"]').getByRole('menuitem').allTextContents();
    expect(labels).toEqual(expect.arrayContaining(['Copy', 'Cut', 'Paste', 'Add comment']));
    await page.keyboard.press('Escape');
  });

  test('over a revision mark -> Accept/Reject, and Accept strips the mark', async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
    await injectBlockHtml(page, 'n24',
      '<p>keep <ins class="mark-add" data-author-id="u1" style="--author-color:#0a0">added</ins> tail</p>');
    await page.locator(`${blockSel('n24')} ins.mark-add`).click({ button: 'right' });
    const menu = page.locator('[role="menu"]');
    await expect(menu.getByRole('menuitem', { name: 'Accept change' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Accept change' }).click();
    // Accept ADD strips the mark, keeping the text.
    await expect.poll(() => readBlockHtml(page, 'n24')).not.toContain('mark-add');
    await expect.poll(() => readBlockHtml(page, 'n24')).toContain('added');
  });

  test('add-comment then resolve-comment via the menu', async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
    await injectBlockHtml(page, 'n24', '<p>comment me here</p>');
    await pmSetSelection(page, 'n24', 1, 8); // "comment"
    await page.locator(blockSel('n24')).click({ button: 'right' });
    await page.locator('[role="menu"]').getByRole('menuitem', { name: 'Add comment' }).click();
    await expect.poll(() => readBlockHtml(page, 'n24')).toContain('mark-comment');
    // Right-click the new comment span -> Resolve comment appears.
    await page.locator(`${blockSel('n24')} span.mark-comment`).click({ button: 'right' });
    const menu = page.locator('[role="menu"]');
    await expect(menu.getByRole('menuitem', { name: 'Resolve comment' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Resolve comment' }).click();
    await expect.poll(() => readBlockHtml(page, 'n24')).toContain('mark-comment-resolved');
  });

  test('table cell -> insert row below adds a row', async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
    // Find a table block in the sample doc.
    const cell = page.locator('td[data-row="0"][data-col="0"]').first();
    await expect(cell).toBeVisible();
    const before = await page.locator('td[data-col="0"]').count();
    await cell.click({ button: 'right' });
    await page.locator('[role="menu"]').getByRole('menuitem', { name: 'Insert row below' }).click();
    await expect.poll(() => page.locator('td[data-col="0"]').count()).toBe(before + 1);
  });

  test('gutter / non-block region -> native menu (no custom menu)', async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
    // The section banner is inside .editor-scroll but is not a block host.
    await page.locator('text=UNIFIED FACILITIES GUIDE SPECIFICATIONS').click({ button: 'right' });
    await expect(page.locator('[role="menu"]')).toHaveCount(0);
  });

  test('right-click while slash menu open -> slash closes, scratch block survives, context menu opens', async ({ page }) => {
    await page.goto('/');
    await waitForApp(page);
    const fresh = await createFreshBlock(page);
    const freshId = await fresh.getAttribute('data-block-id');
    await page.keyboard.type('/');
    await expect(page.locator('#sim-slash-listbox')).toBeVisible();
    await page.locator(blockSel(freshId)).click({ button: 'right' });
    await expect(page.locator('#sim-slash-listbox')).toBeHidden();
    await expect(page.locator(`#block-${freshId}`)).toHaveCount(1); // not discarded
    await expect(page.locator('[role="menu"]')).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
```

- [ ] **Step 2: Run the new E2E tests under chromium**

Run: `npm run test:e2e -- --project=chromium -g "right-click context menu"`
Expected: all PASS. If the table test fails because the sample doc has no table on first screen, scroll it into view first (`await cell.scrollIntoViewIfNeeded()`).

- [ ] **Step 3: Run the FULL editor + collab suites for regressions**

Per CLAUDE.md testing rule 10, run the whole spec files under chromium (do not spot-check):
Run: `npm run test:e2e -- --project=chromium`
Expected: no NEW failures beyond the known baseline flake set ([#126](https://github.com/mttvnst-HA/secwriter/issues/126) / [#145](https://github.com/mttvnst-HA/secwriter/issues/145)). To distinguish a regression from a baseline flake, `git stash` and re-run the failing test by `-g` at baseline; if it fails there too, it is a pre-existing flake.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/editor.spec.js
git commit -m "test(context-menu): E2E coverage for right-click menu"
```

---

## Task 11: Collab-drift regression (deterministic)

The action dispatcher re-resolves position-sensitive actions at click time. Pin the guard's contract: when a peer removes the revision mark between menu-open and item-click, `applyInlineRevisionResolveTr` at the same position returns null → App no-ops (toast, no mutation). Forces the race rather than chasing a CI flake (CLAUDE.md testing rule 7).

**Files:**
- Test: `src/lib/__tests__/context-menu-drift.test.js`

- [ ] **Step 1: Write the test**

```javascript
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { schema } from '../pm-schema.js';
import { applyInlineRevisionResolveTr } from '../pm-toolbar.js';

function docOf(...children) {
  return schema.node('doc', null, [schema.node('paragraph', null, children)]);
}
const txt = (text, ...marks) => schema.text(text, marks);
const stateOf = (doc) => EditorState.create({ doc, selection: TextSelection.create(doc, 1) });

describe('context-menu collab-drift guard', () => {
  it('resolves the revision mark when it is still present at the click position', () => {
    const mark = schema.marks.revisionAdd.create({ authorId: 'u1', authorColor: '#0a0' });
    const state = stateOf(docOf(txt('added', mark)));
    const result = applyInlineRevisionResolveTr(state, 'accept', 3);
    expect(result).not.toBeNull();
  });

  it('returns null (App no-ops) when a peer removed the mark before the click', () => {
    // Same position, but the mark is gone (peer accepted it first).
    const state = stateOf(docOf(txt('added')));
    const result = applyInlineRevisionResolveTr(state, 'accept', 3);
    expect(result).toBeNull();
  });

  it('moved-mark contract: resolves whatever same-kind mark now sits at the position', () => {
    // Drift hazard the guard does NOT fully close: a peer reflow puts a
    // DIFFERENT revisionAdd (different author) at the same position. With
    // coordinate re-resolution + kindHint='add', the verb resolves THAT mark
    // rather than the original. This pins the known v1 limitation documented
    // in the plan's Self-Review (full relpos mapping is the follow-up).
    const mark = schema.marks.revisionAdd.create({ authorId: 'u2', authorColor: '#00a' });
    const state = stateOf(docOf(txt('other', mark)));
    const result = applyInlineRevisionResolveTr(state, 'accept', 3, 'add');
    expect(result).not.toBeNull(); // resolves the now-present mark, by design
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npm test -- src/lib/__tests__/context-menu-drift.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/__tests__/context-menu-drift.test.js
git commit -m "test(context-menu): deterministic collab-drift guard regression"
```

---

## Self-Review

**Spec coverage:**
- Scope groups (Clipboard / Tracked changes / Comments / Table) — Task 3 builder + Task 9 dispatch. ✓
- Boundary rule (custom only inside a block host, else native) — Task 9 `resolveContextDescriptor` returns null → no preventDefault. ✓
- Dynamic item model (hide irrelevant) — Task 3 builder. ✓
- Read-only copy-only / suppress-when-empty — Task 3 (`readOnly` branches) + Task 9 empty-suppression. ✓
- Add-comment selection-gated — Task 6 `addCommentRange` + Task 3. ✓
- App-level singleton + getContextAtCoords handle (PM only); DOM resolution for Title/Ref/Table — Tasks 5–9. ✓
- New files menu-placement.js / context-menu-items.js / ContextMenu.jsx — Tasks 1, 3, 4. ✓
- TableBlock data-row/data-col — Task 8 (+ data-vcol resolves the merged-cell open item). ✓
- Slash/del-popup race — Task 7 (right-click suppression + contextmenu cleanup) + Task 10 regression. ✓
- Re-resolve fresh at action time — Task 9 dispatch + Task 11. ✓
- Dismiss + a11y (role=menu/menuitem, arrows/Enter/Escape, outside-mousedown, scroll, resize) — Task 4. ✓
- Testing section (unit + E2E + collab-drift) — Tasks 1–4, 6, 8, 10, 11. ✓

**Open items from the spec — decisions + known limitations:**

- **Clipboard serialization.** Copy/Cut serialize PLAIN TEXT via `doc.textBetween`; Paste is `navigator.clipboard.readText` + `sanitizePasteText` + `tr.insertText` (Task 9). **Documented v1 limitation:** copy does NOT carry inline data marks (RID/SUB/ENG/MET/revision) to the system clipboard. This is deliberate and consistent with the plaintext-only paste design (#99) — an internal copy→paste round-trip is plaintext either way, so marks would not survive a re-paste regardless. Carrying `text/html` via `ClipboardItem` for external targets (Word) is a possible follow-up, out of scope for v1. Clipboard read/write is wrapped in availability + `NotAllowedError` guards with a user toast (focus is restored to the view first, because the menu portal takes focus on open).

- **TC_RESOLVE_META.** Set ONLY on the accept-del path (`action === 'accept' && kindHint === 'del'`), NOT unconditionally. Rationale: only `tr.delete` paths interact with `rewriteForTrackChanges`. accept-del's raw delete over a `revisionDel` range would be re-marked into a no-op without the meta (#96) — so it needs it. reject-add ALSO deletes, but there the rewriter MUST run so a foreign author's pending addition is converted to a mark-for-deletion (audit trail preserved); setting the meta there would hard-delete a peer's change. The removeMark paths (accept-add / reject-del / chg) never touch the rewriter. Resolution is pinned to the kind the user saw via `kindHint`, which also makes the drift guard deterministic.

- **Merged-cell start-column mapping.** `data-vcol` (visual start) + `colspan` read at dispatch; column insert-right uses `vcol + span` (Tasks 8–9).

**Known limitation — collab-drift re-resolution.** Position-sensitive actions (accept/reject, table ops) re-resolve at click time via the stored pointer coordinate (`posAtCoords` / `elementFromPoint`), per the approved spec. The `kindHint` pin narrows mis-targeting to "a different mark of the SAME kind drifted under the same viewport point". The remaining hole: a collab peer edit that reflows content under a fixed viewport point WITHOUT scrolling (scroll dismisses the menu) between open and click can resolve a neighboring same-kind target. Probability is low (transient menu, short window) and the result is undo-recoverable. Full hardening (capture a Y.RelativePosition at open, map forward at click) is a documented follow-up, not v1 scope. Task 11 pins both the mark-absent (no-op) and mark-moved (resolves the now-present mark) contracts so the behavior is explicit rather than accidental.

**Type consistency:** descriptor keys (`blockId`, `kind`, `selectionEmpty`, `readOnly`, `revision.kind`, `revision.range`, `comment.commentId`, `comment.resolved`, `addCommentRange`, table `row`/`col`/`vcol`/`canMerge`/`canSplit`) are identical across Tasks 3, 6, 8, 9. Item ids (`copy`/`cut`/`paste`/`accept-change`/`reject-change`/`add-comment`/`resolve-comment`/`table-*`) match between the builder (Task 3) and the dispatcher (Task 9). ✓

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-28-context-menu.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
