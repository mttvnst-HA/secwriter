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
