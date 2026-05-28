// @vitest-environment jsdom
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
