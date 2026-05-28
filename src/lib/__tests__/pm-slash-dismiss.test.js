// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { schema } from '../pm-schema.js';
import { slashMenuPlugin, slashMenuPluginKey, getSlashMenuState } from '../pm-plugins/slash-menu.js';
import { closeSlashMenuPlugin, isBlockJustSlashTrigger } from '../pm-slash-dismiss.js';

function makeView(text = '') {
  const plugins = [slashMenuPlugin()];
  let state = EditorState.create({ schema, plugins });
  if (text) state = state.apply(state.tr.insertText(text, 1));
  // Lightweight view shim — closeSlashMenuPlugin only needs `state` and
  // `dispatch`. Real EditorView would mount DOM; we don't need that here.
  const view = {
    state,
    dispatch(tr) { view.state = view.state.apply(tr); },
  };
  return view;
}

describe('closeSlashMenuPlugin', () => {
  it('dispatches forceClose meta that closes the plugin state', () => {
    const view = makeView('/heading');
    expect(getSlashMenuState(view.state).open).toBe(true);
    closeSlashMenuPlugin(view);
    expect(getSlashMenuState(view.state).open).toBe(false);
  });

  it('is a no-op when view is null', () => {
    expect(() => closeSlashMenuPlugin(null)).not.toThrow();
  });

  it('swallows errors when dispatch throws (mid-tear-down)', () => {
    const view = {
      state: EditorState.create({ schema, plugins: [slashMenuPlugin()] }),
      dispatch: () => { throw new Error('view detached'); },
    };
    expect(() => closeSlashMenuPlugin(view)).not.toThrow();
  });
});

describe('isBlockJustSlashTrigger', () => {
  it('true when block contains only "/"', () => {
    const view = makeView('/');
    expect(isBlockJustSlashTrigger(view)).toBe(true);
  });

  it('true when block contains "/filter"', () => {
    const view = makeView('/heading');
    expect(isBlockJustSlashTrigger(view)).toBe(true);
  });

  it('false when block contains non-slash content', () => {
    const view = makeView('hello');
    expect(isBlockJustSlashTrigger(view)).toBe(false);
  });

  it('false when block is empty (no leading slash)', () => {
    const view = makeView('');
    expect(isBlockJustSlashTrigger(view)).toBe(false);
  });

  it('false when view is null', () => {
    expect(isBlockJustSlashTrigger(null)).toBe(false);
  });

  it('tolerates trailing whitespace', () => {
    const view = makeView('/heading   ');
    expect(isBlockJustSlashTrigger(view)).toBe(true);
  });
});
