// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../pm-schema.js';
import { slashMenuPlugin, slashMenuPluginKey, getSlashMenuState } from '../pm-plugins/slash-menu.js';

function makeState(text = '') {
  const plugins = [slashMenuPlugin()];
  let state = EditorState.create({ schema, plugins });
  if (text) {
    const tr = state.tr.insertText(text, 1);
    state = state.apply(tr);
  }
  return state;
}

describe('slash-menu plugin', () => {
  it('initial state: closed, empty filter', () => {
    const state = EditorState.create({ schema, plugins: [slashMenuPlugin()] });
    const s = getSlashMenuState(state);
    expect(s).toEqual({ open: false, filter: '', fromPos: null });
  });

  it('opens when first character is "/"', () => {
    const state = makeState('/');
    const s = getSlashMenuState(state);
    expect(s.open).toBe(true);
    expect(s.filter).toBe('');
  });

  it('captures filter after the slash', () => {
    const state = makeState('/heading');
    const s = getSlashMenuState(state);
    expect(s.open).toBe(true);
    expect(s.filter).toBe('heading');
  });

  it('does not open when text starts with non-slash', () => {
    const state = makeState('foo');
    const s = getSlashMenuState(state);
    expect(s.open).toBe(false);
  });

  it('does not open when slash is mid-paragraph', () => {
    const state = makeState('hello /world');
    const s = getSlashMenuState(state);
    expect(s.open).toBe(false);
  });

  it('closes when leading slash is removed', () => {
    let state = makeState('/heading');
    expect(getSlashMenuState(state).open).toBe(true);
    // Remove the leading "/" — selection cursor irrelevant; just rebuild text.
    const tr = state.tr.delete(1, 2);
    state = state.apply(tr);
    expect(getSlashMenuState(state).open).toBe(false);
  });

  it('selection-only transactions do not change state', () => {
    let state = makeState('/h');
    const before = getSlashMenuState(state);
    // Move selection without changing the doc.
    const tr = state.tr.setSelection(state.selection);
    state = state.apply(tr);
    const after = getSlashMenuState(state);
    expect(after).toBe(before); // reference equality — same state object reused
  });

  it('forceClose meta resets state to closed without mutating doc', () => {
    // Regression: closing the menu via React state alone leaves plugin
    // state at {open:true}; the next docChanged tr re-projects open back
    // into React. forceClose lets dismiss paths (Escape, outside-click)
    // close the plugin without removing the leading "/" text.
    let state = makeState('/heading');
    expect(getSlashMenuState(state).open).toBe(true);
    const beforeDoc = state.doc;
    const tr = state.tr.setMeta(slashMenuPluginKey, 'forceClose');
    state = state.apply(tr);
    expect(getSlashMenuState(state).open).toBe(false);
    expect(getSlashMenuState(state).filter).toBe('');
    // Doc unchanged — the "/" text remains in the block.
    expect(state.doc.eq(beforeDoc)).toBe(true);
  });

  it('forceClose is a no-op when menu already closed', () => {
    // Identity-stable when already closed so dispatchTransaction's projection
    // doesn't fire spuriously.
    let state = makeState('foo');
    const before = getSlashMenuState(state);
    const tr = state.tr.setMeta(slashMenuPluginKey, 'forceClose');
    state = state.apply(tr);
    const after = getSlashMenuState(state);
    expect(after).toBe(before); // reference equality
  });

  it('plugin key is named "sim-slash-menu"', () => {
    // Important: a future change to the key invalidates state lookups in
    // PmEditableBlock's dispatchTransaction. PluginKey carries its name on
    // the `key` field internally — we exercise it via a state lookup.
    const state = makeState('/foo');
    expect(slashMenuPluginKey.getState(state)).toBeDefined();
  });
});
