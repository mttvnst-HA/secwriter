// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import IdentityModal from '../IdentityModal.jsx';

function render(container, handlers) {
  const root = createRoot(container);
  const noop = () => {};
  act(() => {
    root.render(
      <IdentityModal
        roomId="testroom"
        onIdentity={handlers.onIdentity || noop}
        onCancel={handlers.onCancel || noop}
      />
    );
  });
  return root;
}

// Set a controlled <input>'s value the way React expects (native setter +
// input event) so the component's useState updates.
function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  ).set;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('IdentityModal cancel affordances', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    localStorage.clear();
  });

  it('Cancel button fires onCancel and is type=button (not a form submit)', () => {
    const onCancel = vi.fn();
    const onIdentity = vi.fn();
    const root = render(container, { onCancel, onIdentity });

    const cancelBtn = [...container.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'Cancel');
    expect(cancelBtn).toBeTruthy();
    expect(cancelBtn.type).toBe('button');

    act(() => { cancelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onIdentity).not.toHaveBeenCalled();

    act(() => root.unmount());
  });

  it('Escape keydown fires onCancel', () => {
    const onCancel = vi.fn();
    const root = render(container, { onCancel });

    const input = container.querySelector('input');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('form submit (Enter) routes to Join/onIdentity, not Cancel', () => {
    const onCancel = vi.fn();
    const onIdentity = vi.fn();
    const root = render(container, { onCancel, onIdentity });

    const input = container.querySelector('input');
    act(() => { setInputValue(input, 'Jordan Rivera'); });

    const form = container.querySelector('form');
    act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

    expect(onIdentity).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('Join button is disabled until a non-empty name is entered', () => {
    const root = render(container, {});
    const joinBtn = [...container.querySelectorAll('button')]
      .find(b => b.textContent.trim() === 'Join room');
    expect(joinBtn.disabled).toBe(true);

    const input = container.querySelector('input');
    act(() => { setInputValue(input, '  '); }); // whitespace only
    expect(joinBtn.disabled).toBe(true);

    act(() => { setInputValue(input, 'Jordan'); });
    expect(joinBtn.disabled).toBe(false);

    act(() => root.unmount());
  });
});
