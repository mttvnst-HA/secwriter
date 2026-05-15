// @vitest-environment jsdom
//
// Sub-PR 1h Q36 Commit A — word-boundary undo plugin.
//
// The plugin calls a supplied `forceFrame` callback on space and
// punctuation keydowns. The intent is that, once Commit B adds
// `ySyncPluginKey` to the Yjs UndoManager's trackedOrigins, a typing burst
// like "hello world." produces three undo frames (one per word), matching
// Word's behavior. In Commit A the plugin is wired but the trackedOrigins
// change hasn't landed yet, so the callback has no production effect on
// the user's typing — these tests pin the BEHAVIOR of the plugin itself
// so Commit B has a foundation to land against.
//
// Naming: the plugin's public-API name is `forceFrame` (matches
// `collab.forceFrame` exposed by useCollabSession). Internally it's
// implemented as `undoManager.stopCapturing()` — Yjs library vocabulary
// stays at the boundary.
//
// CRITICAL ORDERING INVARIANT (adversarial Q4 finding):
//   forceFrame must fire BEFORE PM's default insertText so the space op
//   itself enters a NEW frame, not the previous frame. The plugin uses
//   `props.handleKeyDown` (which prosemirror-view dispatches synchronously
//   on the keydown event, before the browser's default beforeinput →
//   insertText chain). Do NOT switch to appendTransaction — that fires
//   after the Yjs commit, putting the space in the WRONG frame.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { schema } from '../pm-schema.js';
import { wordBoundaryUndoPlugin } from '../pm-plugins/word-boundary-undo.js';

let root;
let forceFrame;
let view;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  forceFrame = vi.fn();
});

afterEach(() => {
  view?.destroy();
  view = null;
  root?.remove();
});

function makeView() {
  const para = schema.node('paragraph', null, [schema.text('hello')]);
  const doc = schema.node('doc', null, [para]);
  const state = EditorState.create({
    schema,
    doc,
    plugins: [wordBoundaryUndoPlugin({ getForceFrame: () => forceFrame })],
  });
  view = new EditorView(root, { state });
  return view;
}

function fireKeyDown(key) {
  // Walk PM's plugin props to find the handler. This is exactly how
  // prosemirror-view dispatches keydown — see prosemirror-view's
  // editIntegrate.js. Returns whatever the handler returned (true =
  // event consumed).
  const handled = view.someProp('handleKeyDown', (handler) => {
    const evt = new KeyboardEvent('keydown', { key });
    return handler(view, evt);
  });
  return !!handled;
}

describe('wordBoundaryUndoPlugin', () => {
  it('fires forceFrame on space', () => {
    makeView();
    fireKeyDown(' ');
    expect(forceFrame).toHaveBeenCalledTimes(1);
  });

  it('fires forceFrame on common punctuation: . , ; : ! ?', () => {
    makeView();
    for (const k of ['.', ',', ';', ':', '!', '?']) {
      fireKeyDown(k);
    }
    expect(forceFrame).toHaveBeenCalledTimes(6);
  });

  it('fires forceFrame on Enter', () => {
    // Enter is the strongest word boundary — never coalesce across it.
    makeView();
    fireKeyDown('Enter');
    expect(forceFrame).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on regular character keys', () => {
    makeView();
    for (const k of ['a', 'B', 'z', '7', 'Z']) fireKeyDown(k);
    expect(forceFrame).not.toHaveBeenCalled();
  });

  it('does NOT fire on modifier-only keys', () => {
    makeView();
    for (const k of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) fireKeyDown(k);
    expect(forceFrame).not.toHaveBeenCalled();
  });

  it('does NOT fire on arrow keys, Backspace, Tab', () => {
    // Boundary semantics are about NEW frames per word; navigation and
    // backspace are explicitly not word boundaries (Backspace continues
    // the current edit; arrow keys don't edit at all).
    makeView();
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Tab']) {
      fireKeyDown(k);
    }
    expect(forceFrame).not.toHaveBeenCalled();
  });

  it('does NOT fire on ambiguous punctuation (quotes / brackets / dashes)', () => {
    // The plugin's docstring documents these as "ambiguous; let coalesce
    // until adversarial evidence pins a different rule." This test pins
    // the intentional exclusion so a future maintainer who adds e.g. `(`
    // to BOUNDARY_KEYS sees an explicit test fail rather than a silent
    // semantic drift.
    makeView();
    for (const k of ["'", '"', '`', '(', ')', '[', ']', '{', '}', '-', '_']) {
      fireKeyDown(k);
    }
    expect(forceFrame).not.toHaveBeenCalled();
  });

  it('does NOT consume the keydown event (returns false from handleKeyDown)', () => {
    // Critical: the plugin is observational. PM's default insertText for
    // space MUST run after forceFrame, so the space character ends up in
    // the document. If the handler returned true, PM would consume the
    // event and no space would be inserted.
    makeView();
    const handled = fireKeyDown(' ');
    expect(handled).toBe(false);
    expect(forceFrame).toHaveBeenCalledTimes(1);
  });

  it('tolerates a null getForceFrame callback (no-op)', () => {
    // The plugin must be safe to mount before the UndoManager exists
    // (PmEditableBlock can mount before App's session is ready in collab
    // mode; out-of-room mode has no UndoManager until Commit B's hook
    // lands). Returning null from getForceFrame must not throw.
    const para = schema.node('paragraph', null, []);
    const doc = schema.node('doc', null, [para]);
    const state = EditorState.create({
      schema,
      doc,
      plugins: [wordBoundaryUndoPlugin({ getForceFrame: () => null })],
    });
    view = new EditorView(root, { state });

    expect(() => fireKeyDown(' ')).not.toThrow();
  });

  it('reads getForceFrame lazily on every keydown', () => {
    // Plugin is constructed once at EditorView mount; the live
    // UndoManager reference may change (session create/destroy cycles in
    // collab mode). The getter MUST be invoked per keydown so the latest
    // session's forceFrame is the one called.
    const callsA = [];
    const callsB = [];
    let activeFn = () => callsA.push('A');

    const para = schema.node('paragraph', null, []);
    const doc = schema.node('doc', null, [para]);
    const state = EditorState.create({
      schema,
      doc,
      plugins: [wordBoundaryUndoPlugin({ getForceFrame: () => activeFn })],
    });
    view = new EditorView(root, { state });

    fireKeyDown(' ');
    expect(callsA).toEqual(['A']);
    expect(callsB).toEqual([]);

    // Swap the live callback — simulates session destroy + new session.
    activeFn = () => callsB.push('B');
    fireKeyDown(' ');
    expect(callsA).toEqual(['A']);
    expect(callsB).toEqual(['B']);
  });
});
