# Slash Menu Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the slash menu from spilling off-screen by switching to viewport-fixed positioning, caret-anchored via PM's `view.coordsAtPos`, with viewport-aware placement math and internal scroll when neither side fits.

**Architecture:** SlashMenu rewrites to `position: fixed` + `createPortal(menu, document.body)`. Placement math is a pure exported function `computePlacement` (table-testable). PmEditableBlock memoizes `anchorRect` at open time (no caret-chasing), surfaces `fromPos` through the React state mirror to all four `setSlashState` sites, and adds a small effect that syncs combobox ARIA attributes (`role`, `aria-haspopup`, `aria-expanded`, `aria-controls`, `aria-activedescendant`) to the PM editor's contentEditable DOM so screen readers announce active-item changes.

**Tech Stack:** Vitest + jsdom (unit), `@testing-library/react` (component), Playwright (E2E), React 18 (`createRoot` + `act`), ProseMirror (`view.coordsAtPos`), `react-dom`'s `createPortal`.

**Spec:** [docs/superpowers/specs/2026-05-27-slash-menu-visibility-design.md](../specs/2026-05-27-slash-menu-visibility-design.md) (HEAD `9c7070f`)
**Issue:** None filed (spec-first)
**Branch:** `claude/quirky-ramanujan-8a7f29` (worktree)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/components/SlashMenu.jsx` | modify (near-rewrite) | Export pure `computePlacement` + `computeLeft`; portal-mounted listbox; new props `anchorRect` + `onClose`; sticky header; empty state; active-item scrollIntoView; window-scroll close; resize handling |
| `src/components/PmEditableBlock.jsx` | modify | Extend React state with `fromPos` (4 setState sites); memoize `anchorRect` via `useMemo([open, fromPos])`; new `handleSlashClose` callback; new effect syncing combobox ARIA on PM editor DOM; update JSX call site |
| `src/components/__tests__/slash-menu-placement.test.js` | create | Pure-function unit tests for `computePlacement` + `computeLeft` (7 + 3 cases) |
| `src/components/__tests__/SlashMenu.test.jsx` | create | Component-level: portal mount, ARIA listbox, role=status empty state, aria-selected on active item, sticky header aria-hidden |
| `src/components/__tests__/PmEditableBlock-slash-aria.test.jsx` | create | Integration: combobox ARIA attributes on PM contentEditable when menu opens/closes/nav |

No changes to `src/lib/pm-plugins/slash-menu.js`.

---

## Conventions

- TDD throughout: write failing test → run to confirm fail → minimal impl → run to confirm pass → commit.
- Vitest: `npm test -- <pattern>` or `npm test -- --run <file>`.
- E2E: `npx playwright test --project=chromium tests/e2e/editor.spec.js -g "slash"`.
- Full E2E gate before claiming done (CLAUDE.md item 10): `npm run test:e2e -- --project=chromium`.
- Conventional commits: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`.
- Tests per file ≤30 (CLAUDE.md item 3).
- Never use `replace_all` on indented code (CLAUDE.md item 1).
- Branch already exists. Do NOT switch branches.

---

## Task 1: Pure placement math (`computePlacement` + `computeLeft`)

**Files:**
- Modify: `src/components/SlashMenu.jsx` (add and export two module-level functions; do not touch the React component yet)
- Create: `src/components/__tests__/slash-menu-placement.test.js`

- [ ] **Step 1: Write the failing test file**

Create `src/components/__tests__/slash-menu-placement.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { computePlacement, computeLeft } from '../SlashMenu.jsx';

describe('computePlacement', () => {
  const cases = [
    {
      name: 'fits below',
      anchorRect: { top: 100, bottom: 120 },
      viewportHeight: 800,
      menuHeight: 390,
      expected: { placement: 'below', maxHeight: null, top: 124 },
    },
    {
      name: 'fits above only',
      anchorRect: { top: 600, bottom: 620 },
      viewportHeight: 800,
      menuHeight: 390,
      expected: { placement: 'above', maxHeight: null, top: 206 },
    },
    {
      name: 'neither fits, more below',
      anchorRect: { top: 50, bottom: 70 },
      viewportHeight: 400,
      menuHeight: 390,
      expected: { placement: 'below', maxHeight: 322, top: 74 },
    },
    {
      name: 'neither fits, more above',
      anchorRect: { top: 350, bottom: 370 },
      viewportHeight: 400,
      menuHeight: 390,
      expected: { placement: 'above', maxHeight: 342, top: 8 },
    },
    {
      name: 'anchor at viewport top',
      anchorRect: { top: 0, bottom: 0 },
      viewportHeight: 800,
      menuHeight: 390,
      expected: { placement: 'below', maxHeight: null, top: 4 },
    },
    {
      name: 'anchor at viewport bottom',
      anchorRect: { top: 800, bottom: 800 },
      viewportHeight: 800,
      menuHeight: 390,
      expected: { placement: 'above', maxHeight: null, top: 406 },
    },
    {
      name: 'min maxHeight floor (degenerate)',
      anchorRect: { top: 50, bottom: 70 },
      viewportHeight: 100,
      menuHeight: 390,
      expected: { placement: 'above', maxHeight: 120, top: 8 },
    },
  ];

  it.each(cases)('$name', ({ anchorRect, viewportHeight, menuHeight, expected }) => {
    const result = computePlacement({ anchorRect, viewportHeight, menuHeight, margin: 8 });
    expect(result).toEqual(expected);
  });
});

describe('computeLeft', () => {
  const cases = [
    { name: 'normal', anchorLeft: 100, expected: 100 },
    { name: 'would overflow right', anchorLeft: 1000, expected: 912 },
    { name: 'negative left clamps to margin', anchorLeft: -50, expected: 8 },
  ];

  it.each(cases)('$name', ({ anchorLeft, expected }) => {
    const result = computeLeft({
      anchorRect: { left: anchorLeft },
      menuWidth: 280,
      viewportWidth: 1200,
      margin: 8,
    });
    expect(result).toBe(expected);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (functions not exported yet)**

Run: `npm test -- --run src/components/__tests__/slash-menu-placement.test.js`
Expected: FAIL — `computePlacement is not a function` (the import resolves but the named exports do not exist).

- [ ] **Step 3: Implement the two functions in SlashMenu.jsx**

Open `src/components/SlashMenu.jsx`. After the `SLASH_ITEMS` export (around line 13), before the `SlashMenu` component definition, add:

```js
export function computePlacement({ anchorRect, viewportHeight, menuHeight, margin = 8 }) {
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

export function computeLeft({ anchorRect, menuWidth, viewportWidth, margin = 8 }) {
  const desired = anchorRect.left;
  return Math.max(margin, Math.min(desired, viewportWidth - menuWidth - margin));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --run src/components/__tests__/slash-menu-placement.test.js`
Expected: PASS, 10 tests (7 placement + 3 left).

- [ ] **Step 5: Commit**

```bash
git add src/components/SlashMenu.jsx src/components/__tests__/slash-menu-placement.test.js
git commit -m "feat(slash-menu): pure placement math (computePlacement, computeLeft)"
```

---

## Task 2: SlashMenu component rewrite (portal, ARIA, sticky header, empty state, scroll handling)

**Files:**
- Modify: `src/components/SlashMenu.jsx` (rewrite component body — props change, portal, render structure, layout effect, close-on-scroll listener, active-item scrollIntoView, resize)
- Create: `src/components/__tests__/SlashMenu.test.jsx`

**Note on commit sequencing:** This task's changes break the existing `<SlashMenu position={...}>` call site in `PmEditableBlock.jsx`. DO NOT COMMIT at the end of Task 2 — commit happens at the end of Task 3 with both files together. The repo is intentionally in a broken intermediate state between Tasks 2 and 3.

- [ ] **Step 1: Write the failing component test file**

Create `src/components/__tests__/SlashMenu.test.jsx`:

```jsx
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

import SlashMenu from '../SlashMenu.jsx';

let container = null;
let root = null;

function mount(element) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(element); });
}

afterEach(() => {
  if (root) act(() => { root.unmount(); });
  if (container) document.body.removeChild(container);
  container = null;
  root = null;
});

const anchorRect = { top: 100, bottom: 120, left: 50, right: 50 };

describe('SlashMenu', () => {
  it('renders the listbox via portal to document.body', () => {
    mount(<SlashMenu filter="" selectedIdx={0} onSelect={() => {}} onClose={() => {}} anchorRect={anchorRect} />);
    const listbox = document.querySelector('[role="listbox"][id="sim-slash-listbox"]');
    expect(listbox).toBeTruthy();
    // Portal: the listbox must NOT be a descendant of our test container.
    expect(container.contains(listbox)).toBe(false);
    // It IS a descendant of body though.
    expect(document.body.contains(listbox)).toBe(true);
  });

  it('listbox has aria-label and does NOT carry aria-activedescendant', () => {
    mount(<SlashMenu filter="" selectedIdx={0} onSelect={() => {}} onClose={() => {}} anchorRect={anchorRect} />);
    const listbox = document.querySelector('[role="listbox"]');
    expect(listbox.getAttribute('aria-label')).toBe('Insert block');
    expect(listbox.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('renders item rows with stable ids and role=option', () => {
    mount(<SlashMenu filter="" selectedIdx={2} onSelect={() => {}} onClose={() => {}} anchorRect={anchorRect} />);
    const items = document.querySelectorAll('[role="option"]');
    expect(items.length).toBe(9);
    expect(items[0].id).toBe('sim-slash-item-0');
    expect(items[8].id).toBe('sim-slash-item-8');
  });

  it('aria-selected=true only on the keyboard-selected item', () => {
    mount(<SlashMenu filter="" selectedIdx={3} onSelect={() => {}} onClose={() => {}} anchorRect={anchorRect} />);
    const items = document.querySelectorAll('[role="option"]');
    expect(items[3].getAttribute('aria-selected')).toBe('true');
    expect(items[0].getAttribute('aria-selected')).toBe('false');
    expect(items[2].getAttribute('aria-selected')).toBe('false');
    expect(items[4].getAttribute('aria-selected')).toBe('false');
  });

  it('empty filter renders "No matches" with role=status (NOT role=option)', () => {
    mount(<SlashMenu filter="zzzzz" selectedIdx={0} onSelect={() => {}} onClose={() => {}} anchorRect={anchorRect} />);
    const status = document.querySelector('[role="status"]');
    expect(status).toBeTruthy();
    expect(status.textContent).toContain('No matches');
    expect(status.getAttribute('aria-live')).toBe('polite');
    // No option rows when nothing matches.
    expect(document.querySelectorAll('[role="option"]').length).toBe(0);
  });

  it('sticky header is aria-hidden', () => {
    mount(<SlashMenu filter="" selectedIdx={0} onSelect={() => {}} onClose={() => {}} anchorRect={anchorRect} />);
    const listbox = document.querySelector('[role="listbox"]');
    const headers = listbox.querySelectorAll('[aria-hidden="true"]');
    // At least one — the sticky "Insert block" header.
    expect(headers.length).toBeGreaterThanOrEqual(1);
    expect(Array.from(headers).some(h => h.textContent.includes('Insert block'))).toBe(true);
  });

  it('returns null when readOnly is true', () => {
    mount(<SlashMenu filter="" selectedIdx={0} onSelect={() => {}} onClose={() => {}} anchorRect={anchorRect} readOnly={true} />);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('returns null when anchorRect is null', () => {
    mount(<SlashMenu filter="" selectedIdx={0} onSelect={() => {}} onClose={() => {}} anchorRect={null} />);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('calls onClose when window scrolls', () => {
    const onClose = vi.fn();
    mount(<SlashMenu filter="" selectedIdx={0} onSelect={() => {}} onClose={onClose} anchorRect={anchorRect} />);
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onSelect with the item type on mousedown', () => {
    const onSelect = vi.fn();
    mount(<SlashMenu filter="" selectedIdx={0} onSelect={onSelect} onClose={() => {}} anchorRect={anchorRect} />);
    const item = document.querySelector('#sim-slash-item-0');
    act(() => {
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    // First SLASH_ITEMS entry is 'title' (Heading).
    expect(onSelect).toHaveBeenCalledWith('title');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --run src/components/__tests__/SlashMenu.test.jsx`
Expected: FAIL — current `SlashMenu` does not accept `anchorRect`/`onClose` props, doesn't portal, doesn't have `role="listbox"`, etc.

- [ ] **Step 3: Rewrite `src/components/SlashMenu.jsx`**

Replace the file contents (preserving the `SLASH_ITEMS`, `computePlacement`, `computeLeft` exports from Task 1):

```jsx
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export const SLASH_ITEMS = [
  { type: "title", label: "Heading", desc: "Section heading (Tab/Shift+Tab to change level)", icon: "H" },
  { type: "txt", label: "Paragraph", desc: "Plain text paragraph", icon: "¶" },
  { type: "note", label: "Designer Note", desc: "Note to the designer (not in published spec)", icon: "✉" },
  { type: "oli", label: "Ordered List", desc: "Lettered list item (a. b. c.)", icon: "a." },
  { type: "item", label: "List Item", desc: "Bulleted list item", icon: "•" },
  { type: "lst", label: "List Header", desc: "Submittal group header (e.g. SD-01)", icon: "☰" },
  { type: "ref", label: "Reference", desc: "Standards reference group (ORG + RID/RTL)", icon: "📚" },
  { type: "table", label: "Table", desc: "Data table with editable cells", icon: "▦" },
  { type: "pagebreak", label: "Page Break", desc: "Insert a page break for printing", icon: "┄" },
];

// Tied to the row styles below. If row padding/font sizes change, update these.
const HEADER_HEIGHT = 26;
const ROW_HEIGHT = 50;
const MENU_WIDTH = 280;
const VIEWPORT_MARGIN = 8;

export function computePlacement({ anchorRect, viewportHeight, menuHeight, margin = 8 }) {
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

export function computeLeft({ anchorRect, menuWidth, viewportWidth, margin = 8 }) {
  const desired = anchorRect.left;
  return Math.max(margin, Math.min(desired, viewportWidth - menuWidth - margin));
}

export default function SlashMenu({ filter, selectedIdx, onSelect, onClose, anchorRect, readOnly = false }) {
  if (readOnly || !anchorRect) return null;

  const [hoverIdx, setHoverIdx] = useState(-1);
  const [resizeTick, setResizeTick] = useState(0);
  const [placement, setPlacement] = useState({ top: 0, left: 0, maxHeight: null });
  const menuRef = useRef(null);
  const activeItemRef = useRef(null);

  const filtered = useMemo(() => SLASH_ITEMS.filter(item => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return item.label.toLowerCase().startsWith(q);
  }), [filter]);

  const safeIdx = Math.min(selectedIdx, Math.max(filtered.length - 1, 0));
  const activeIdx = hoverIdx >= 0 ? hoverIdx : safeIdx;

  // Resize listener — bumps tick so the layout effect re-runs.
  useEffect(() => {
    const onResize = () => setResizeTick(t => t + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Close on any window scroll. Internal menu scroll does not propagate to window.
  useEffect(() => {
    if (!onClose) return undefined;
    const onScroll = () => onClose();
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    return () => window.removeEventListener('scroll', onScroll, { capture: true });
  }, [onClose]);

  // Placement computation — runs whenever the anchor / filter / viewport changes.
  useLayoutEffect(() => {
    if (!anchorRect) return;
    const itemCount = Math.max(filtered.length, 1);
    const menuHeight = HEADER_HEIGHT + itemCount * ROW_HEIGHT;
    const p = computePlacement({
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
    setPlacement({ top: p.top, left, maxHeight: p.maxHeight });
  }, [anchorRect, filtered.length, resizeTick]);

  // Keep the keyboard-active item visible when scrolling internally.
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [safeIdx]);

  const menu = (
    <div
      ref={menuRef}
      id="sim-slash-listbox"
      role="listbox"
      aria-label="Insert block"
      style={{
        position: 'fixed',
        top: placement.top,
        left: placement.left,
        width: MENU_WIDTH,
        maxHeight: placement.maxHeight ?? undefined,
        overflowY: placement.maxHeight ? 'auto' : 'visible',
        zIndex: 1000,
        backgroundColor: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.08)',
        padding: '4px 0',
      }}
      onMouseLeave={() => setHoverIdx(-1)}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'sticky',
          top: 0,
          backgroundColor: '#ffffff',
          padding: '6px 12px 4px',
          fontSize: 10,
          color: '#94a3b8',
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        Insert block
      </div>
      {filtered.length === 0 ? (
        <div role="status" aria-live="polite" style={{ padding: '12px', color: '#94a3b8', fontStyle: 'italic', fontSize: 12 }}>
          No matches
        </div>
      ) : (
        filtered.map((item, i) => {
          const isActive = i === activeIdx;
          const isKeyboardSelected = i === safeIdx;
          return (
            <div
              key={item.type}
              id={`sim-slash-item-${i}`}
              role="option"
              aria-selected={isKeyboardSelected}
              tabIndex={-1}
              ref={isKeyboardSelected ? activeItemRef : null}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(item.type);
              }}
              onMouseEnter={() => setHoverIdx(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '7px 12px',
                cursor: 'pointer',
                backgroundColor: isActive ? '#f1f5f9' : 'transparent',
                borderLeft: isActive ? '2px solid #6384a8' : '2px solid transparent',
                transition: 'background 0.1s',
              }}
            >
              <span style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                backgroundColor: '#f1f5f9',
                border: '1px solid #e2e8f0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 700,
                color: '#475569',
                flexShrink: 0,
              }}>
                {item.icon}
              </span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#1e293b' }}>{item.label}</div>
                <div style={{ fontSize: 11, color: '#94a3b8' }}>{item.desc}</div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );

  return createPortal(menu, document.body);
}
```

- [ ] **Step 4: Run SlashMenu component tests to verify they pass**

Run: `npm test -- --run src/components/__tests__/SlashMenu.test.jsx`
Expected: PASS, 10 tests.

- [ ] **Step 5: Re-run placement tests to verify Task 1 still passes**

Run: `npm test -- --run src/components/__tests__/slash-menu-placement.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 6: DO NOT COMMIT YET**

Repo is currently in a broken state — `PmEditableBlock.jsx` still passes the old `position` prop and now SlashMenu expects `anchorRect`. The next task fixes that. Skip directly to Task 3.

---

## Task 3: PmEditableBlock state + anchorRect + combobox ARIA effect + JSX update

**Files:**
- Modify: `src/components/PmEditableBlock.jsx` (4 setState sites get `fromPos`; new `handleSlashClose`; new `useMemo` for `anchorRect`; new combobox ARIA effect; updated JSX call site)
- Create: `src/components/__tests__/PmEditableBlock-slash-aria.test.jsx`

- [ ] **Step 1: Write the failing integration test file**

Create `src/components/__tests__/PmEditableBlock-slash-aria.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// PmEditableBlock-slash-aria.test.jsx — regression for the slash menu
// visibility redesign. When the slash menu opens, the PM editor's
// contentEditable DOM must gain combobox ARIA attributes so screen
// readers announce active-item changes (the listbox itself never
// holds focus). When the menu closes, the attributes must be removed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

import { htmlToPmFragment } from '../../lib/pmdoc-html.js';
import PmEditableBlock from '../PmEditableBlock.jsx';

function setupYStore(blockId, html) {
  const ydoc = new Y.Doc();
  const yStore = ydoc.getMap('blocks');
  const yMap = new Y.Map();
  const yXml = new Y.XmlFragment();
  yMap.set('html', yXml);
  yStore.set(blockId, yMap);
  prosemirrorToYXmlFragment(htmlToPmFragment(html), yXml);
  return { ydoc, yStore };
}

let container = null;
let root = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => { root.unmount(); });
  if (container) document.body.removeChild(container);
  container = null;
  root = null;
});

function renderBlock({ block, yStore }) {
  act(() => {
    root.render(
      <PmEditableBlock
        block={block}
        yStore={yStore}
        editable={true}
        trackChanges={false}
        identity={{ id: 'u1', color: '#000' }}
        commentsState={{ byId: {}, seenRemoteIds: new Set() }}
        onUpdate={() => {}}
        onConvertBlock={() => {}}
        onEnterKey={() => {}}
        onDelete={() => {}}
        onFocusPrev={() => {}}
        onFocusNext={() => {}}
        onChangeOliLevel={() => {}}
        onCommentClick={() => {}}
        onRefreshTcSnapshot={() => {}}
      />
    );
  });
}

function getEditorDom() {
  return container.querySelector('.ProseMirror');
}

function typeChar(view, ch) {
  act(() => {
    view.dispatch(view.state.tr.insertText(ch));
  });
}

describe('PmEditableBlock combobox ARIA', () => {
  it('PM editor has no combobox attributes initially', () => {
    const { yStore } = setupYStore('b1', '<p></p>');
    renderBlock({ block: { id: 'b1', type: 'txt', html: '<p></p>', isNew: false }, yStore });
    const dom = getEditorDom();
    // The five attributes we manage. (PM may set its own attributes like
    // contenteditable; we only assert on ours.)
    expect(dom.hasAttribute('role')).toBe(false);
    expect(dom.hasAttribute('aria-haspopup')).toBe(false);
    expect(dom.hasAttribute('aria-expanded')).toBe(false);
    expect(dom.hasAttribute('aria-controls')).toBe(false);
    expect(dom.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('PM editor gains combobox attributes when slash menu opens', async () => {
    const { yStore } = setupYStore('b1', '<p></p>');
    renderBlock({ block: { id: 'b1', type: 'txt', html: '<p></p>', isNew: false }, yStore });
    const { getBlockView } = await import('../../lib/block-registry.js');
    const view = getBlockView('b1');
    expect(view).toBeTruthy();

    // Typing '/' triggers the slash plugin -> React state mirror -> ARIA effect.
    typeChar(view, '/');

    const dom = getEditorDom();
    expect(dom.getAttribute('role')).toBe('combobox');
    expect(dom.getAttribute('aria-haspopup')).toBe('listbox');
    expect(dom.getAttribute('aria-expanded')).toBe('true');
    expect(dom.getAttribute('aria-controls')).toBe('sim-slash-listbox');
    expect(dom.getAttribute('aria-activedescendant')).toBe('sim-slash-item-0');
  });

  it('combobox attributes are removed when the leading slash is deleted', async () => {
    const { yStore } = setupYStore('b1', '<p></p>');
    renderBlock({ block: { id: 'b1', type: 'txt', html: '<p></p>', isNew: false }, yStore });
    const { getBlockView } = await import('../../lib/block-registry.js');
    const view = getBlockView('b1');

    typeChar(view, '/');
    // Sanity: combobox attrs present.
    expect(getEditorDom().getAttribute('role')).toBe('combobox');

    // Remove the leading slash — plugin sees no leading '/', sets open: false,
    // mirror updates React state, effect tears down the attrs.
    // (Avoids fragile jsdom KeyboardEvent dispatch for Escape; both paths flow
    // through the same setSlashState({ open: false }) reducer.)
    act(() => {
      view.dispatch(view.state.tr.delete(0, 1));
    });

    const dom = getEditorDom();
    expect(dom.hasAttribute('role')).toBe(false);
    expect(dom.hasAttribute('aria-haspopup')).toBe(false);
    expect(dom.hasAttribute('aria-expanded')).toBe(false);
    expect(dom.hasAttribute('aria-controls')).toBe(false);
    expect(dom.hasAttribute('aria-activedescendant')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the integration test to verify it fails**

Run: `npm test -- --run src/components/__tests__/PmEditableBlock-slash-aria.test.jsx`
Expected: FAIL — `PmEditableBlock` does not yet apply ARIA attributes to the editor DOM; `dom.getAttribute('role')` returns `null`.

- [ ] **Step 3: Update the four `setSlashState` sites in PmEditableBlock.jsx to include `fromPos`**

Open `src/components/PmEditableBlock.jsx`.

Around **line 156**, update the initial state:

```jsx
const [slashState, setSlashState] = useState({ open: false, filter: '', selectedIdx: 0, fromPos: null });
```

Around **line 289** (`handleSlashSelect`), update:

```jsx
const handleSlashSelect = (type) => {
  setSlashState({ open: false, filter: '', selectedIdx: 0, fromPos: null });
  onConvertBlockRef.current?.(block.id, type);
};
```

Around **line 303** (`onSlashEscape`), update:

```jsx
onSlashEscape: () => {
  setSlashState({ open: false, filter: '', selectedIdx: 0, fromPos: null });
  return true;
},
```

Around **line 482-489** (the dispatchTransaction mirror), update the gate and the setter:

```jsx
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

Around **line 780-783** (`handleSlashSelectClick`), update:

```jsx
const handleSlashSelectClick = useCallback((type) => {
  setSlashState({ open: false, filter: '', selectedIdx: 0, fromPos: null });
  onConvertBlockRef.current?.(block.id, type);
}, [block.id]);
```

- [ ] **Step 4: Add `handleSlashClose` and the `anchorRect` memo**

Around line 783 (right after `handleSlashSelectClick`), add:

```jsx
const handleSlashClose = useCallback(() => {
  setSlashState({ open: false, filter: '', selectedIdx: 0, fromPos: null });
}, []);

const slashAnchorRect = useMemo(() => {
  if (!slashState.open) return null;
  return computeSlashAnchorRect(viewRef.current, slashState.fromPos, containerRef.current);
}, [slashState.open, slashState.fromPos]);
```

At the top of the file, add the helper near the existing module-level helpers (e.g., right after the `gutterBtn` helper near line 970, or as a top-level function at the bottom of the file):

```jsx
function computeSlashAnchorRect(view, fromPos, fallbackEl) {
  if (view && typeof fromPos === 'number') {
    try {
      const coords = view.coordsAtPos(fromPos);
      return { top: coords.top, bottom: coords.bottom, left: coords.left, right: coords.right };
    } catch {
      // PM view may not be in a consistent state — fall through to DOM bounds.
    }
  }
  if (fallbackEl) {
    const r = fallbackEl.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  }
  return null;
}
```

Ensure `useMemo` is imported. The file's existing imports should already include it; if not, add `useMemo` to the React import line.

- [ ] **Step 5: Add the combobox ARIA effect**

Below the `slashAnchorRect` memo (or with the other effects), add:

```jsx
useEffect(() => {
  const dom = viewRef.current?.dom;
  if (!dom) return undefined;
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
  return undefined;
}, [slashState.open, slashState.selectedIdx]);
```

- [ ] **Step 6: Update the JSX call site**

Around **lines 958-965**, replace:

```jsx
{slashState.open && editable && (
  <SlashMenu
    filter={slashState.filter}
    selectedIdx={slashState.selectedIdx}
    onSelect={handleSlashSelectClick}
    position={{ left: leftMargin + 12, top: 32 }}
  />
)}
```

with:

```jsx
{slashState.open && editable && slashAnchorRect && (
  <SlashMenu
    filter={slashState.filter}
    selectedIdx={slashState.selectedIdx}
    onSelect={handleSlashSelectClick}
    onClose={handleSlashClose}
    anchorRect={slashAnchorRect}
  />
)}
```

- [ ] **Step 7: Run the integration test to verify it passes**

Run: `npm test -- --run src/components/__tests__/PmEditableBlock-slash-aria.test.jsx`
Expected: PASS, 3 tests.

- [ ] **Step 8: Run the SlashMenu unit tests to verify they still pass**

Run: `npm test -- --run src/components/__tests__/slash-menu-placement.test.js src/components/__tests__/SlashMenu.test.jsx`
Expected: PASS, 20 tests total.

- [ ] **Step 9: Run the full PmEditableBlock test suite to check for regressions**

Run: `npm test -- --run "PmEditableBlock"`
Expected: ALL PASS (the existing PmEditableBlock tests do not exercise slash state shape; should be unaffected).

- [ ] **Step 10: Commit Tasks 2 + 3 atomically**

```bash
git add src/components/SlashMenu.jsx src/components/PmEditableBlock.jsx src/components/__tests__/SlashMenu.test.jsx src/components/__tests__/PmEditableBlock-slash-aria.test.jsx
git commit -m "feat(slash-menu): viewport-fixed positioning with ARIA combobox

SlashMenu rewrites to position: fixed + createPortal(document.body),
anchored to PM caret coords (view.coordsAtPos(fromPos)). Placement math
picks above/below by available viewport space; clamps max-height +
internal scroll when neither side fits. Closes on window scroll.

PmEditableBlock surfaces fromPos through the React state mirror (all
four setSlashState sites), memoizes anchorRect at open time (no
caret-chasing), and syncs combobox ARIA attributes to the PM editor's
contentEditable DOM so screen readers announce active-item changes
(the listbox itself never holds focus).

Empty filter renders 'No matches' as role=status + aria-live=polite
(previously was role=option, semantically wrong).
"
```

---

## Task 4: E2E verification + manual smoke

**Files:**
- No code changes expected. If a smoke-test regression surfaces, file follow-up tasks.

- [ ] **Step 1: Run the full Vitest suite**

Run: `npm test`
Expected: ALL PASS. If anything fails outside the four files touched, investigate before declaring done.

- [ ] **Step 2: Run E2E slash menu specs in isolation first**

Run: `npx playwright test --project=chromium tests/e2e/editor.spec.js -g "slash"`
Expected: ALL PASS. Slash menu specs cover open/close, item selection, keyboard nav. Should be unaffected.

- [ ] **Step 3: Run the FULL editor.spec.js + collab.spec.js**

Per CLAUDE.md item 10: spot-checking is how regressions reach CI. Run the whole suites.

Run: `npx playwright test --project=chromium tests/e2e/editor.spec.js tests/e2e/collab.spec.js`
Expected: Failures should be confined to the parallel-load flake baseline ([#126](https://github.com/mttvnst-HA/secwriter/issues/126), [#145](https://github.com/mttvnst-HA/secwriter/issues/145)). Re-run any new failure in isolation under `--repeat-each=3 --workers=1` to distinguish regression from flake. If a test fails in isolation, fix before declaring done.

- [ ] **Step 4: Manual smoke**

Start: `npm run dev`

Verify each of the following in a browser at `http://localhost:5173`:

1. Create a new document. Add several blocks until you have one near the bottom of the viewport. Type `/` at the start of the bottom-most block. Expected: slash menu is fully visible, flipped above the cursor. No scrolling needed.
2. Scroll up so a block is near the viewport top. Type `/` at the start. Expected: menu appears below the cursor, fully visible.
3. Resize the browser window to a short height (300px). Type `/` somewhere. Expected: menu picks the larger side, shows internal scrollbar, header sticks at the top of the scroll area.
4. With the menu open, scroll the page using the mouse wheel. Expected: menu closes immediately.
5. With the menu open, type `zzzzz`. Expected: "No matches" row shows; menu does not collapse.
6. With the menu open, press ArrowDown several times. Expected: keyboard selection moves; if items overflow the scroll region, the active item scrolls into view.
7. Open Chrome DevTools → Accessibility tree → click the editor div. Expected: when slash menu is open, the editor has role="combobox", aria-haspopup="listbox", aria-expanded="true", aria-controls="sim-slash-listbox", aria-activedescendant="sim-slash-item-0" (or whichever index is selected).

- [ ] **Step 5: If everything passes, declare done**

No additional commit needed. Plan complete.

If any step surfaced a regression, file a follow-up task with reproduction steps and fix before declaring done. Do not declare done with known regressions.

---

## Self-Review Notes

- Task 1 covers spec §3.1 (pure functions) + §5.1 (placement table).
- Task 2 covers spec §3.2 (component rewrite, portal, ARIA listbox, sticky header, empty state, close-on-scroll, active scrollIntoView, resize) + §5.2 (component tests).
- Task 3 covers spec §3.4 (all three changes: state shape, anchorRect + JSX, combobox ARIA effect) + §5.3 (integration test).
- Task 4 covers spec §6 (verification before completion).
- Spec §3.3 (PM plugin): "no code changes" — no task needed, confirmed.
- Spec §4 (out of scope): nothing to implement, no task needed.
