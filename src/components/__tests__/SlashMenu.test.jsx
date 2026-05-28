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

  it('does NOT call onClose when scrolling inside the menu itself', () => {
    // Regression: the capture-phase window scroll listener fires for scroll events
    // on ANY descendant scroll container, including the menu's own scrollbar. The
    // handler must check e.target and skip when the scroll originated inside the menu.
    const onClose = vi.fn();
    mount(<SlashMenu filter="" selectedIdx={0} onSelect={() => {}} onClose={onClose} anchorRect={anchorRect} />);
    const listbox = document.querySelector('[role="listbox"]');
    act(() => {
      // Scroll events do not bubble, but capture-phase listeners fire regardless of
      // bubbling — the window listener will see this event during capture.
      listbox.dispatchEvent(new Event('scroll'));
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keyboard nav (selectedIdx change) drops mouse hover so highlight follows arrows', () => {
    // Regression: mouse hover used to win over keyboard via activeIdx = hoverIdx >= 0
    // ? hoverIdx : safeIdx — arrow keys updated selectedIdx but the highlight stayed
    // pinned to whichever row the mouse was over. Now selectedIdx change clears hover.
    mount(<SlashMenu filter="" selectedIdx={0} onSelect={() => {}} onClose={() => {}} anchorRect={anchorRect} />);
    const items = document.querySelectorAll('[role="option"]');
    // Hover row 3 — mousemove (actual cursor motion), not mouseenter.
    act(() => {
      items[3].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    });
    // Parent fires arrow-down -> selectedIdx becomes 1.
    act(() => {
      root.render(<SlashMenu filter="" selectedIdx={1} onSelect={() => {}} onClose={() => {}} anchorRect={anchorRect} />);
    });
    // Highlight follows keyboard, not stale hover. aria-selected pins safeIdx; visual
    // highlight uses activeIdx — both must point at row 1 now.
    const itemsAfter = document.querySelectorAll('[role="option"]');
    expect(itemsAfter[1].getAttribute('aria-selected')).toBe('true');
    expect(itemsAfter[3].getAttribute('aria-selected')).toBe('false');
    // Visual hover-or-keyboard highlight: row 1 has the active background, row 3 does not.
    expect(itemsAfter[1].style.backgroundColor).toBe('rgb(241, 245, 249)');
    expect(itemsAfter[3].style.backgroundColor).toBe('transparent');
  });

  it('mouseenter alone does NOT set hover (scroll-induced enter must not steal highlight)', () => {
    // Regression: arrow nav triggers scrollIntoView, which slides rows under a
    // stationary cursor and fires mouseenter on each new row. The component must
    // only update hoverIdx on mousemove (real motion), not mouseenter.
    mount(<SlashMenu filter="" selectedIdx={2} onSelect={() => {}} onClose={() => {}} anchorRect={anchorRect} />);
    const items = document.querySelectorAll('[role="option"]');
    // Mouseenter on row 5 — simulates scroll bringing a new row under the cursor.
    act(() => {
      items[5].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    });
    // Keyboard-selected row (2) keeps the highlight; row 5 has no hover applied.
    expect(items[2].style.backgroundColor).toBe('rgb(241, 245, 249)');
    expect(items[5].style.backgroundColor).toBe('transparent');
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
