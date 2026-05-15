// @vitest-environment jsdom
//
// Sub-PR 1h Q36 Commit A — word-boundary undo plugin.
//
// The plugin calls a supplied `stopCapturing` callback on space and
// punctuation keydowns. The intent is that, once Commit B adds
// `ySyncPluginKey` to the Yjs UndoManager's trackedOrigins, a typing burst
// like "hello world." produces three undo frames (one per word), matching
// Word's behavior. In Commit A the plugin is wired but the trackedOrigins
// change hasn't landed yet, so the callback is a no-op in production —
// these tests pin the BEHAVIOR of the plugin itself so Commit B has a
// foundation to land against.
//
// CRITICAL ORDERING INVARIANT (adversarial Q4 finding):
//   stopCapturing must fire BEFORE PM's default insertText so the space op
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
let stopCapturing;
let view;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  stopCapturing = vi.fn();
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
    plugins: [wordBoundaryUndoPlugin({ getStopCapturing: () => stopCapturing })],
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
  it('fires stopCapturing on space', () => {
    makeView();
    fireKeyDown(' ');
    expect(stopCapturing).toHaveBeenCalledTimes(1);
  });

  it('fires stopCapturing on common punctuation: . , ; : ! ?', () => {
    makeView();
    for (const k of ['.', ',', ';', ':', '!', '?']) {
      fireKeyDown(k);
    }
    expect(stopCapturing).toHaveBeenCalledTimes(6);
  });

  it('fires stopCapturing on Enter', () => {
    // Enter is the strongest word boundary — never coalesce across it.
    makeView();
    fireKeyDown('Enter');
    expect(stopCapturing).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on regular character keys', () => {
    makeView();
    for (const k of ['a', 'B', 'z', '7', 'Z']) fireKeyDown(k);
    expect(stopCapturing).not.toHaveBeenCalled();
  });

  it('does NOT fire on modifier-only keys', () => {
    makeView();
    for (const k of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) fireKeyDown(k);
    expect(stopCapturing).not.toHaveBeenCalled();
  });

  it('does NOT fire on arrow keys, Backspace, Tab', () => {
    // Boundary semantics are about NEW frames per word; navigation and
    // backspace are explicitly not word boundaries (Backspace continues
    // the current edit; arrow keys don't edit at all).
    makeView();
    for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Tab']) {
      fireKeyDown(k);
    }
    expect(stopCapturing).not.toHaveBeenCalled();
  });

  it('does NOT consume the keydown event (returns false from handleKeyDown)', () => {
    // Critical: the plugin is observational. PM's default insertText for
    // space MUST run after stopCapturing, so the space character ends up
    // in the document. If the handler returned true, PM would consume
    // the event and no space would be inserted.
    makeView();
    const handled = fireKeyDown(' ');
    expect(handled).toBe(false);
    expect(stopCapturing).toHaveBeenCalledTimes(1);
  });

  it('tolerates a null getStopCapturing callback (no-op)', () => {
    // The plugin must be safe to mount before the UndoManager exists
    // (PmEditableBlock can mount before App's session is ready in collab
    // mode; out-of-room mode has no UndoManager until Commit B's hook
    // lands). Returning null from getStopCapturing must not throw.
    const para = schema.node('paragraph', null, []);
    const doc = schema.node('doc', null, [para]);
    const state = EditorState.create({
      schema,
      doc,
      plugins: [wordBoundaryUndoPlugin({ getStopCapturing: () => null })],
    });
    view = new EditorView(root, { state });

    expect(() => fireKeyDown(' ')).not.toThrow();
  });

  it('reads getStopCapturing lazily on every keydown', () => {
    // Plugin is constructed once at EditorView mount; the live
    // UndoManager reference may change (session create/destroy cycles in
    // collab mode). The getter MUST be invoked per keydown so the latest
    // session's stopCapturing is the one called.
    const callsA = [];
    const callsB = [];
    let activeStop = () => callsA.push('A');

    const para = schema.node('paragraph', null, []);
    const doc = schema.node('doc', null, [para]);
    const state = EditorState.create({
      schema,
      doc,
      plugins: [wordBoundaryUndoPlugin({ getStopCapturing: () => activeStop })],
    });
    view = new EditorView(root, { state });

    fireKeyDown(' ');
    expect(callsA).toEqual(['A']);
    expect(callsB).toEqual([]);

    // Swap the live callback — simulates session destroy + new session.
    activeStop = () => callsB.push('B');
    fireKeyDown(' ');
    expect(callsA).toEqual(['A']);
    expect(callsB).toEqual(['B']);
  });
});
