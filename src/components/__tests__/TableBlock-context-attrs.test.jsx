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

  it('data-vcol diverges from data-col for a cell after a colspan>1 cell', () => {
    const spanBlock = {
      id: 't2', type: 'table',
      table: {
        columns: 3,
        rows: [
          [{ text: 'x', colspan: 2 }, { text: 'y', colspan: 1 }],
        ],
      },
    };
    const { container } = render(<TableBlock block={spanBlock} onUpdate={() => {}} readOnly={false} />);
    const y = container.querySelector('td[data-row="0"][data-col="1"]');
    expect(y).not.toBeNull();
    expect(y.getAttribute('data-col')).toBe('1');   // array index
    expect(y.getAttribute('data-vcol')).toBe('2');  // visual column start (after the colspan-2 'x')
  });
});
