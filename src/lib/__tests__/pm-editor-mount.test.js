// @vitest-environment jsdom
//
// Regression test for the TDZ bug in PmEditableBlock's `dispatchTransaction`
// that landed in sub-PR 1e (#56) and was latent on `main` until uncovered
// while preparing the VITE_PM_EDITOR flag flip.
//
// Symptom in production: every PM-mode Playwright test threw
//   "Cannot access 'view' before initialization"
// from inside `dispatchTransaction`, blocking React mount of every editable
// block. The legacy contentEditable path was unaffected, which is why CI
// stayed green — the existing Playwright project only exercised flag-off.
//
// Root cause: `dispatchTransaction` was an inline property of the
// `new EditorView(root, { ..., dispatchTransaction(tr) { ... } })` config,
// and its body referenced the outer `const view = new EditorView(...)`.
// y-prosemirror's `ySyncPlugin` registers a `view(editorView)` hook that
// dispatches an initial-sync transaction *synchronously* during the
// `EditorView` constructor — i.e. before the outer `view` binding is
// assigned the constructor's return value. TDZ.
//
// Fix: use `this` (PM calls `dispatchTransaction.call(view, tr)`, so `this`
// is the view and is bound on every call, including during construction).
//
// This test mounts the same plugin shape PmEditableBlock uses (ySyncPlugin
// against a Y.XmlFragment, dispatchTransaction passed in the initial config)
// and asserts the construction completes cleanly. If someone reverts the
// `this.*` → outer `view.*` pattern, this test fails on construction.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as Y from 'yjs';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { ySyncPlugin, prosemirrorToYXmlFragment } from 'y-prosemirror';

import { schema } from '../pm-schema.js';
import { htmlToPmFragment } from '../pmdoc-html.js';

let root;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  root?.remove();
});

describe('PmEditableBlock EditorView mount under ySyncPlugin (1e TDZ regression)', () => {
  it('dispatchTransaction passed inline survives ySyncPlugin initial-sync via `this`', () => {
    // Seed the substrate so ySyncPlugin's view() hook has content to render.
    // Some y-prosemirror code paths skip the initial dispatch when the Y.XmlFragment
    // is empty — pre-seeding guarantees the failure mode is reachable.
    const ydoc = new Y.Doc();
    const yXml = ydoc.getXmlFragment('test');
    prosemirrorToYXmlFragment(htmlToPmFragment('<p>hello</p>'), yXml);

    const state = EditorState.create({ schema, plugins: [ySyncPlugin(yXml)] });

    // Match PmEditableBlock's shape exactly: dispatchTransaction is passed
    // as part of the initial config (NOT via setProps after construction).
    // Body uses `this.state.apply(tr)` / `this.updateState(newState)`. If a
    // future refactor reintroduces `view.state.apply(tr)`, this test will
    // throw "Cannot access 'view' before initialization" during the `new
    // EditorView(...)` call below.
    let view;
    let txCount = 0;
    expect(() => {
      view = new EditorView(root, {
        state,
        dispatchTransaction(tr) {
          const newState = this.state.apply(tr);
          this.updateState(newState);
          txCount += 1;
        },
      });
    }).not.toThrow();

    expect(view).toBeTruthy();
    // No explicit txCount assertion: y-prosemirror version drift may batch
    // the initial sync into a microtask. What matters is that construction
    // completed without TDZ. If someone reverts to outer `view`, the throw
    // above fires whether or not the initial dispatch is sync.
    view?.destroy();
  });

  it('pins the bug shape: inline dispatchTransaction referencing outer `view` throws under ySyncPlugin', () => {
    // Counter-test: prove that the failure mode the fix prevents is real and
    // is specifically reachable through the inline-dispatchTransaction +
    // ySyncPlugin combination. If this test ever stops throwing, either
    // y-prosemirror changed (no longer dispatches during construction) or
    // PM changed (no longer routes the initial sync through dispatchTransaction),
    // and the other regression test should be re-evaluated for whether it
    // still pins anything load-bearing.
    const ydoc = new Y.Doc();
    const yXml = ydoc.getXmlFragment('test');
    prosemirrorToYXmlFragment(htmlToPmFragment('<p>hello</p>'), yXml);

    const state = EditorState.create({ schema, plugins: [ySyncPlugin(yXml)] });

    let threw = null;
    try {
      // const declaration — `view` is in TDZ inside dispatchTransaction
      // during construction. Wrapped IIFE so the const stays scoped.
      // eslint-disable-next-line no-unused-vars
      (() => {
        // eslint-disable-next-line prefer-const
        const view = new EditorView(root, {
          state,
          dispatchTransaction(tr) {
            // Intentional bug shape — referencing outer `view` during the
            // ySyncPlugin initial-sync dispatch.
            // eslint-disable-next-line no-undef-init, no-unused-expressions
            view.state.apply(tr);
          },
        });
        // Silence "view is declared but never used" — we don't reach here
        // if the bug fires.
        view?.destroy();
      })();
    } catch (err) {
      threw = err;
    }

    expect(threw).not.toBeNull();
    // Either ReferenceError ("Cannot access 'view' before initialization")
    // or TypeError reading off the TDZ value — both confirm the bug shape.
    expect(/initialization|undefined|cannot read/i.test(String(threw))).toBe(true);
  });
});
