// @vitest-environment jsdom
//
// Regression test for #21 — typing in a focused block must publish via
// onUpdate after PUBLISH_DEBOUNCE_MS, without requiring blur. The pre-fix
// behavior was that handleInput only wired up the slash menu and onUpdate
// fired only on blur, so typed edits never reached collab/R2 if the user
// reloaded before blurring.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import EditableBlock, { PUBLISH_DEBOUNCE_MS } from '../EditableBlock.jsx';

// Common props — most callbacks are unused for these tests but the component
// requires them. Linting state is constructed disabled to avoid the CSS Custom
// Highlight API which jsdom doesn't implement.
import * as linting from '../../lib/linting.js';

function defaultProps(overrides = {}) {
  return {
    block: { id: 'b1', type: 'txt', html: 'hello' },
    onUpdate: vi.fn(),
    onEnterKey: vi.fn(),
    onFocus: vi.fn(),
    onDelete: vi.fn(),
    onFocusPrev: vi.fn(),
    onFocusNext: vi.fn(),
    onConvertBlock: vi.fn(),
    onChangeOliLevel: vi.fn(),
    lintingState: linting.createInitial({ enabled: false }),
    lintingDispatch: vi.fn(),
    showTags: false,
    readOnly: false,
    isFocused: false,
    ...overrides,
  };
}

function fireInput(el, newHtml) {
  // Simulate the browser mutating contentEditable then firing 'input'.
  el.innerHTML = newHtml;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('EditableBlock — debounced publish on input (#21)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does NOT call onUpdate immediately on input', () => {
    const props = defaultProps();
    const { container } = render(<EditableBlock {...props} />);
    const editable = container.querySelector('[data-block-id="b1"]');
    expect(editable).toBeTruthy();

    fireInput(editable, 'hello world');
    // Debounce hasn't elapsed yet.
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it('calls onUpdate with the new html after PUBLISH_DEBOUNCE_MS — no blur required', () => {
    const props = defaultProps();
    const { container } = render(<EditableBlock {...props} />);
    const editable = container.querySelector('[data-block-id="b1"]');

    fireInput(editable, 'hello world');
    act(() => { vi.advanceTimersByTime(PUBLISH_DEBOUNCE_MS); });

    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith('b1', 'hello world');
  });

  it('coalesces multiple keystrokes into a single publish at the end of the idle window', () => {
    const props = defaultProps();
    const { container } = render(<EditableBlock {...props} />);
    const editable = container.querySelector('[data-block-id="b1"]');

    fireInput(editable, 'a');
    act(() => { vi.advanceTimersByTime(PUBLISH_DEBOUNCE_MS - 100); });
    fireInput(editable, 'ab');
    act(() => { vi.advanceTimersByTime(PUBLISH_DEBOUNCE_MS - 100); });
    fireInput(editable, 'abc');
    // No publish yet — each input reset the timer.
    expect(props.onUpdate).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(PUBLISH_DEBOUNCE_MS); });
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith('b1', 'abc');
  });

  it('blur cancels a pending debounced publish — exactly one onUpdate fires', () => {
    const props = defaultProps();
    const { container } = render(<EditableBlock {...props} />);
    const editable = container.querySelector('[data-block-id="b1"]');

    fireInput(editable, 'final text');
    // Blur before the debounce fires.
    editable.dispatchEvent(new Event('blur', { bubbles: true }));
    // Even after the debounce window elapses, the canceled timer must not fire.
    act(() => { vi.advanceTimersByTime(PUBLISH_DEBOUNCE_MS * 2); });

    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith('b1', 'final text');
  });

  it('unmount clears the pending debounce — no late onUpdate call', () => {
    const props = defaultProps();
    const { container, unmount } = render(<EditableBlock {...props} />);
    const editable = container.querySelector('[data-block-id="b1"]');

    fireInput(editable, 'never published');
    unmount();
    act(() => { vi.advanceTimersByTime(PUBLISH_DEBOUNCE_MS * 2); });

    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  // Regression: with the publish-debounce active, an E2E flow that types
  // text → selects it → clicks a toolbar button (FloatingToolbar) saves a
  // Range and then mutates around it. If publishBlocks fires in the middle
  // it re-renders and used to invalidate that Range. Defer publish while a
  // non-collapsed selection is active inside the block.
  it('skips the debounced publish while a non-collapsed selection is active inside the block', () => {
    const props = defaultProps();
    const { container } = render(<EditableBlock {...props} />);
    const editable = container.querySelector('[data-block-id="b1"]');

    fireInput(editable, 'green text');

    // Simulate a non-collapsed selection inside the block.
    const text = editable.firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    act(() => { vi.advanceTimersByTime(PUBLISH_DEBOUNCE_MS); });
    expect(props.onUpdate).not.toHaveBeenCalled();

    // After the selection collapses and the next input fires, publishing resumes.
    sel.removeAllRanges();
    fireInput(editable, 'green text!');
    act(() => { vi.advanceTimersByTime(PUBLISH_DEBOUNCE_MS); });
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith('b1', 'green text!');
  });
});
