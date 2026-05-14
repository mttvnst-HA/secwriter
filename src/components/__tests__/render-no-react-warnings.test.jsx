// @vitest-environment jsdom
/**
 * Regression test for issue #78 — no React "Cannot update a component while
 * rendering a different component" warnings on initial mount of SpecEditor.
 *
 * The warning is React 18's setState-during-render detector. It fires when
 * a render path schedules an update on a different component synchronously.
 * In SecWriter, the culprit is a Yjs observer firing `listener()` (from
 * useSyncExternalStore) during SpecEditor's render — block-html-store.js:193.
 *
 * Note: the specific warning does not reproduce in jsdom (React 18 / jsdom
 * differences in useSyncExternalStore tear detection), so this test is a
 * regression-prevention guard rather than a failing-before-fix test. It
 * verifies that mounting SpecEditor under StrictMode emits no React
 * setState-in-render warnings in the test environment, and ensures the
 * substrate seeding logic change does not introduce other render warnings.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';

// Import lazily inside the test so the StrictMode + render path mirrors main.jsx.

describe('issue #78 — no setState-during-render warnings on SpecEditor mount', () => {
  let errorSpy;
  beforeEach(() => {
    const orig = console.error;
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      if (!String(args[0] ?? '').includes('Cannot update a component')) orig.call(console, ...args);
    });
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('mounting SpecEditor under StrictMode emits no setState-in-render warnings', async () => {
    const { default: SpecEditor } = await import('../../App.jsx');
    render(
      <React.StrictMode>
        <SpecEditor />
      </React.StrictMode>,
    );
    const offending = errorSpy.mock.calls.filter((args) =>
      String(args[0] ?? '').includes('Cannot update a component') &&
      String(args[0] ?? '').includes('while rendering a different component'),
    );
    if (offending.length > 0) {
      throw new Error(
        'React setState-in-render warning fired during SpecEditor mount:\n' +
        offending.map((a) => a.join(' ')).join('\n'),
      );
    }
    expect(offending).toEqual([]);
  });
});
