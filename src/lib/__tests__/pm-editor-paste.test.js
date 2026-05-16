// @vitest-environment jsdom
//
// Issue #99 regression: PmEditableBlock was missing a handlePaste handler, so
// PM's default paste pipeline parsed text/html via the schema's parseDOM rules
// — pm-schema maps `<b>` and `<strong>` to the `bold` mark — and pasted rich
// text survived as schema marks. The fix adds a handlePaste EditorProp that
// extracts text/plain only, sanitizes it via sanitizePasteText, and dispatches
// a tr.insertText, matching the legacy EditableBlock onPaste behavior.
//
// This test mounts a real EditorView with the same handlePaste body
// PmEditableBlock uses, invokes the prop with a mock paste event carrying
// rich HTML + plain text, and asserts (a) the handler claims the event,
// (b) the doc contains only the plain text, and (c) no `bold` mark survives.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Y from 'yjs';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { ySyncPlugin, prosemirrorToYXmlFragment } from 'y-prosemirror';

import { schema } from '../pm-schema.js';
import { htmlToPmFragment } from '../pmdoc-html.js';
import { sanitizePasteText } from '../paste-sanitize.js';

let root;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  root?.remove();
});

function makeView(seedHtml) {
  const ydoc = new Y.Doc();
  const yXml = ydoc.getXmlFragment('test');
  prosemirrorToYXmlFragment(htmlToPmFragment(seedHtml), yXml);
  const state = EditorState.create({ schema, plugins: [ySyncPlugin(yXml)] });
  return new EditorView(root, {
    state,
    dispatchTransaction(tr) {
      this.updateState(this.state.apply(tr));
    },
    handlePaste(view, event) {
      event.preventDefault();
      const text = sanitizePasteText(event.clipboardData?.getData('text/plain') ?? '');
      if (text) view.dispatch(view.state.tr.insertText(text));
      return true;
    },
  });
}

function selectAll(view) {
  const { doc } = view.state;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, 0, doc.content.size)));
}

function docHasMark(doc, markName) {
  let found = false;
  doc.descendants((node) => {
    if (node.marks?.some((m) => m.type.name === markName)) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

describe('PmEditableBlock handlePaste (#99)', () => {
  it('replaces selection with text/plain and strips `<b>` mark', () => {
    const view = makeView('<p>seed</p>');
    selectAll(view);

    const mockEvent = {
      preventDefault: vi.fn(),
      clipboardData: {
        getData: (type) => (type === 'text/plain'
          ? 'Bold Red Text'
          : '<b style="font-family: Comic Sans MS; color: red;">Bold Red Text</b>'),
      },
    };
    const handled = view.someProp('handlePaste', (f) => f(view, mockEvent, null));

    expect(handled).toBe(true);
    expect(mockEvent.preventDefault).toHaveBeenCalled();

    const text = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '');
    expect(text).toBe('Bold Red Text');
    expect(docHasMark(view.state.doc, 'bold')).toBe(false);

    view.destroy();
  });

  it('sanitizes whitespace and zero-width spaces from pasted text', () => {
    const view = makeView('<p>seed</p>');
    selectAll(view);

    const mockEvent = {
      preventDefault: vi.fn(),
      clipboardData: {
        getData: (type) => (type === 'text/plain'
          ? 'line1\r\n\nline2​  '
          : '<p>line1</p><p>line2</p>'),
      },
    };
    view.someProp('handlePaste', (f) => f(view, mockEvent, null));

    const text = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '');
    // sanitizePasteText: \r\n+ → ' ', strip U+200B, trimEnd() removes trailing
    // whitespace. Internal multi-spaces are preserved (matches legacy behavior).
    expect(text).toBe('line1 line2');

    view.destroy();
  });

  it('is a no-op when clipboard text/plain is missing or empty', () => {
    const view = makeView('<p>seed</p>');
    const beforeText = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '');

    const mockEvent = {
      preventDefault: vi.fn(),
      clipboardData: {
        getData: () => '',
      },
    };
    const handled = view.someProp('handlePaste', (f) => f(view, mockEvent, null));

    expect(handled).toBe(true);
    expect(mockEvent.preventDefault).toHaveBeenCalled();

    const afterText = view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '');
    expect(afterText).toBe(beforeText);

    view.destroy();
  });
});
