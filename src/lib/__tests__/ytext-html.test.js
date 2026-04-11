import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { yTextToHtml } from '../ytext-html.js';

/** Helper: build a Y.Text from a delta array. */
function makeYText(deltas) {
  const ydoc = new Y.Doc();
  const yText = ydoc.getText('test');
  ydoc.transact(() => {
    let pos = 0;
    for (const d of deltas) {
      yText.insert(pos, d.insert, d.attributes || {});
      pos += d.insert.length;
    }
  });
  return yText;
}

describe('yTextToHtml', () => {
  it('converts plain text with no attributes', () => {
    const yText = makeYText([{ insert: 'Hello world' }]);
    expect(yTextToHtml(yText)).toBe('Hello world');
  });

  it('converts bold attribute to <b> tag', () => {
    const yText = makeYText([
      { insert: 'Hello ' },
      { insert: 'bold', attributes: { bold: true } },
      { insert: ' world' },
    ]);
    expect(yTextToHtml(yText)).toBe('Hello <b>bold</b> world');
  });

  it('converts italic attribute to <i> tag', () => {
    const yText = makeYText([
      { insert: 'Hello ' },
      { insert: 'italic', attributes: { italic: true } },
    ]);
    expect(yTextToHtml(yText)).toBe('Hello <i>italic</i>');
  });

  it('converts underline attribute to <u> tag', () => {
    const yText = makeYText([
      { insert: 'underlined', attributes: { underline: true } },
    ]);
    expect(yTextToHtml(yText)).toBe('<u>underlined</u>');
  });

  it('converts mark attribute to <span class="mark-XXX">', () => {
    const yText = makeYText([
      { insert: 'See ' },
      { insert: 'ASTM C33', attributes: { mark: 'rid' } },
      { insert: ' for details' },
    ]);
    expect(yTextToHtml(yText)).toBe('See <span class="mark-rid">ASTM C33</span> for details');
  });

  it('converts tai mark with markOption to data-opt attribute', () => {
    const yText = makeYText([
      { insert: 'tailored text', attributes: { mark: 'tai', markOption: 'OPTION_A' } },
    ]);
    expect(yTextToHtml(yText)).toBe('<span class="mark-tai" data-opt="OPTION_A">tailored text</span>');
  });

  it('converts revision "add" to <ins class="mark-add">', () => {
    const yText = makeYText([
      { insert: 'added text', attributes: { revision: 'add' } },
    ]);
    expect(yTextToHtml(yText)).toBe('<ins class="mark-add">added text</ins>');
  });

  it('converts revision "del" to <del class="mark-del">', () => {
    const yText = makeYText([
      { insert: 'deleted', attributes: { revision: 'del' } },
    ]);
    expect(yTextToHtml(yText)).toBe('<del class="mark-del">deleted</del>');
  });

  it('converts revision "chg" to <span class="mark-chg">', () => {
    const yText = makeYText([
      { insert: 'changed', attributes: { revision: 'chg' } },
    ]);
    expect(yTextToHtml(yText)).toBe('<span class="mark-chg">changed</span>');
  });

  it('converts revision with author color to style attribute', () => {
    const yText = makeYText([
      { insert: 'added', attributes: { revision: 'add', revisionAuthorColor: '#ff6b6b' } },
    ]);
    expect(yTextToHtml(yText)).toBe('<ins class="mark-add" style="--author-color:#ff6b6b">added</ins>');
  });

  it('converts chg revision with author color to style attribute', () => {
    const yText = makeYText([
      { insert: 'changed', attributes: { revision: 'chg', revisionAuthorColor: '#aabbcc' } },
    ]);
    expect(yTextToHtml(yText)).toBe('<span class="mark-chg" style="--author-color:#aabbcc">changed</span>');
  });

  it('converts comment attribute to <span class="mark-comment">', () => {
    const yText = makeYText([
      { insert: 'commented', attributes: { comment: 'comment-123' } },
    ]);
    expect(yTextToHtml(yText)).toBe('<span class="mark-comment" data-comment-id="comment-123">commented</span>');
  });

  it('converts commentResolved to mark-comment-resolved class', () => {
    const yText = makeYText([
      { insert: 'resolved', attributes: { comment: 'c1', commentResolved: true } },
    ]);
    expect(yTextToHtml(yText)).toBe('<span class="mark-comment-resolved" data-comment-id="c1">resolved</span>');
  });

  it('handles stacked attributes: bold + mark-rid', () => {
    const yText = makeYText([
      { insert: 'ASTM D2487', attributes: { bold: true, mark: 'rid' } },
    ]);
    // Nesting order: mark (outer) → format (inner)
    expect(yTextToHtml(yText)).toBe('<span class="mark-rid"><b>ASTM D2487</b></span>');
  });

  it('handles stacked: revision + mark + format', () => {
    const yText = makeYText([
      { insert: 'new ref', attributes: { revision: 'add', mark: 'rid', bold: true } },
    ]);
    // Nesting: revision → mark → format
    expect(yTextToHtml(yText)).toBe('<ins class="mark-add"><span class="mark-rid"><b>new ref</b></span></ins>');
  });

  it('handles adjacent segments with same attribute merging', () => {
    const yText = makeYText([
      { insert: 'hello', attributes: { bold: true } },
      { insert: ' world', attributes: { bold: true } },
    ]);
    expect(yTextToHtml(yText)).toBe('<b>hello world</b>');
  });

  it('returns empty string for empty Y.Text', () => {
    const ydoc = new Y.Doc();
    const yText = ydoc.getText('test');
    expect(yTextToHtml(yText)).toBe('');
  });

  it('escapes HTML entities in text content', () => {
    const yText = makeYText([{ insert: '3 < 5 & 5 > 3' }]);
    expect(yTextToHtml(yText)).toBe('3 &lt; 5 &amp; 5 &gt; 3');
  });
});
