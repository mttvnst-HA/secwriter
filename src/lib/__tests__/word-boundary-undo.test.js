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

// ── Integration: end-to-end "hello world." → 3 undo frames ─────────────
//
// Sub-PR 1h Q36 Commit B. Pins the user-facing contract that motivated
// this whole undo subsystem: typing "hello world." produces exactly
// three undo frames (one per word), matching Word/Notion. Each
// component (collab.js's UndoManager config, the word-boundary plugin,
// the undo helpers) has its own unit tests; this is the integration
// fixture that catches regressions where the components individually
// pass but their composition does not.
//
// Failure modes this catches:
//   - trackedOrigins drift between in-room and out-of-room — without
//     `ySyncPluginKey` in trackedOrigins, PM keystrokes don't enter the
//     stack, count goes to 0.
//   - forceFrame wired to the wrong UndoManager — count goes to 1
//     (everything coalesces into one frame).
//   - forceFrame fired AFTER PM's insert (e.g. via appendTransaction
//     instead of handleKeyDown) — count is correct but the space/period
//     would end up in the WRONG frame (a known footgun; see plugin
//     docstring).
//
// The full PM-mode-with-ySyncPlugin path is exercised here, not just
// the plugin in isolation, because the contract is "after typing
// 'hello world.' the undoStack has 3 frames" — that's only meaningful
// when ySyncPlugin's writes are actually entering the UndoManager.

describe('integration — "hello world." produces 3 undo frames', () => {
  let setupRoot;
  let setupView;

  beforeEach(() => {
    setupRoot = document.createElement('div');
    document.body.appendChild(setupRoot);
  });

  afterEach(() => {
    setupView?.destroy();
    setupView = null;
    setupRoot?.remove();
  });

  it('three boundary keystrokes split the typing burst into three frames', async () => {
    // ── Lazy imports to avoid pulling y-prosemirror into the plugin-
    // only unit tests above (faster startup, smaller error surface).
    const Y = await import('yjs');
    const { EditorState } = await import('prosemirror-state');
    const { EditorView } = await import('prosemirror-view');
    const { ySyncPlugin, ySyncPluginKey, prosemirrorToYXmlFragment } =
      await import('y-prosemirror');
    const { htmlToPmFragment } = await import('../pmdoc-html.js');

    // Build a Y.Doc with an empty paragraph + a PM EditorView bound via
    // ySyncPlugin. The fragment must be seeded BEFORE the EditorView is
    // constructed so ySyncPlugin's initial sync has a doc to read.
    const ydoc = new Y.Doc();
    const yXml = ydoc.getXmlFragment('test');
    prosemirrorToYXmlFragment(htmlToPmFragment('<p></p>'), yXml);

    // UndoManager config MUST match collab.js's session UndoManager.
    // If this drifts (e.g. removing ySyncPluginKey), the test fails
    // with "expected 3, received 0" — the canonical "PM keystrokes
    // didn't enter the stack" failure.
    const undoManager = new Y.UndoManager(yXml, {
      trackedOrigins: new Set(['local-publish', ySyncPluginKey]),
      captureTimeout: 500,
    });

    // forceFrame wiring: same shape PmEditableBlock uses — getForceFrame
    // returns the live callback. The plugin sits at the FRONT of the
    // plugin list so its handleKeyDown runs before any other handler
    // that might consume the event.
    let forceFrameFn = () => undoManager.stopCapturing();
    const state = EditorState.create({
      schema,
      plugins: [
        wordBoundaryUndoPlugin({ getForceFrame: () => forceFrameFn }),
        ySyncPlugin(yXml),
      ],
    });
    setupView = new EditorView(setupRoot, { state });

    // Type "hello world." one character at a time. Each character is:
    //   1. A keydown event (the boundary plugin fires forceFrame for
    //      space + period; other chars are no-op).
    //   2. A PM transaction inserting the character (ySyncPlugin
    //      observes and writes to the substrate with origin
    //      ySyncPluginKey — captured by the UndoManager).
    //
    // This is what `prosemirror-view` does for a real `insertText`
    // when the browser dispatches keydown → beforeinput → input; we
    // collapse it to (handleKeyDown call + view.dispatch) since we're
    // exercising the boundary-plugin contract, not the browser bridge.
    const sequence = 'hello world.';
    for (const ch of sequence) {
      setupView.someProp('handleKeyDown', (handler) => {
        const evt = new KeyboardEvent('keydown', { key: ch });
        return handler(setupView, evt);
      });
      const tr = setupView.state.tr.insertText(ch);
      setupView.dispatch(tr);
    }

    // Three frames: "hello" / " world" / ".".
    //
    // Why three (not two or four):
    //   - The space keydown calls forceFrame BEFORE PM inserts the
    //     space — the "hello" frame is closed, the space + "world"
    //     start a fresh frame.
    //   - The period keydown calls forceFrame before PM inserts the
    //     period — the " world" frame is closed, the period starts a
    //     fresh frame.
    //   - No fourth: nothing happens after the period. EOF closes
    //     the third frame implicitly when the captureTimeout expires,
    //     but UndoManager keeps the current capture window's frame in
    //     `undoStack` even while open.
    expect(undoManager.undoStack.length).toBe(3);

    // Sanity: the substrate has the typed text.
    const text = yXml.toString();
    expect(text).toContain('hello world.');

    undoManager.destroy();
    ydoc.destroy();
  });
});
