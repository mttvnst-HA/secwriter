import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { yTextToHtml, htmlToAttrList, applyHtmlToYText } from '../ytext-html.js';

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

describe('htmlToAttrList', () => {
  it('parses plain text into char tuples with empty attrs', () => {
    const result = htmlToAttrList('Hello');
    expect(result).toEqual([
      { char: 'H', attrs: {} },
      { char: 'e', attrs: {} },
      { char: 'l', attrs: {} },
      { char: 'l', attrs: {} },
      { char: 'o', attrs: {} },
    ]);
  });

  it('parses <b> as bold attribute', () => {
    const result = htmlToAttrList('a<b>B</b>c');
    expect(result).toEqual([
      { char: 'a', attrs: {} },
      { char: 'B', attrs: { bold: true } },
      { char: 'c', attrs: {} },
    ]);
  });

  it('parses <i> and <em> as italic attribute', () => {
    const r1 = htmlToAttrList('<i>x</i>');
    const r2 = htmlToAttrList('<em>x</em>');
    expect(r1).toEqual([{ char: 'x', attrs: { italic: true } }]);
    expect(r2).toEqual([{ char: 'x', attrs: { italic: true } }]);
  });

  it('parses <u> as underline attribute', () => {
    const result = htmlToAttrList('<u>x</u>');
    expect(result).toEqual([{ char: 'x', attrs: { underline: true } }]);
  });

  it('parses <span class="mark-rid"> as mark attribute', () => {
    const result = htmlToAttrList('<span class="mark-rid">ASTM</span>');
    expect(result).toEqual([
      { char: 'A', attrs: { mark: 'rid' } },
      { char: 'S', attrs: { mark: 'rid' } },
      { char: 'T', attrs: { mark: 'rid' } },
      { char: 'M', attrs: { mark: 'rid' } },
    ]);
  });

  it('parses mark-tai with data-opt', () => {
    const result = htmlToAttrList('<span class="mark-tai" data-opt="OPT_A">x</span>');
    expect(result).toEqual([{ char: 'x', attrs: { mark: 'tai', markOption: 'OPT_A' } }]);
  });

  it('parses <ins class="mark-add"> as revision add', () => {
    const result = htmlToAttrList('<ins class="mark-add">x</ins>');
    expect(result).toEqual([{ char: 'x', attrs: { revision: 'add' } }]);
  });

  it('parses <del class="mark-del"> as revision del', () => {
    const result = htmlToAttrList('<del class="mark-del">x</del>');
    expect(result).toEqual([{ char: 'x', attrs: { revision: 'del' } }]);
  });

  it('parses <span class="mark-chg"> as revision chg', () => {
    const result = htmlToAttrList('<span class="mark-chg">x</span>');
    expect(result).toEqual([{ char: 'x', attrs: { revision: 'chg' } }]);
  });

  it('parses ins with --author-color style', () => {
    const result = htmlToAttrList('<ins class="mark-add" style="--author-color:#ff6b6b">x</ins>');
    expect(result).toEqual([{ char: 'x', attrs: { revision: 'add', revisionAuthorColor: '#ff6b6b' } }]);
  });

  it('parses <span class="mark-comment" data-comment-id="c1">', () => {
    const result = htmlToAttrList('<span class="mark-comment" data-comment-id="c1">x</span>');
    expect(result).toEqual([{ char: 'x', attrs: { comment: 'c1' } }]);
  });

  it('parses mark-comment-resolved', () => {
    const result = htmlToAttrList('<span class="mark-comment-resolved" data-comment-id="c1">x</span>');
    expect(result).toEqual([{ char: 'x', attrs: { comment: 'c1', commentResolved: true } }]);
  });

  it('parses nested: <span class="mark-rid"><b>X</b></span>', () => {
    const result = htmlToAttrList('<span class="mark-rid"><b>X</b></span>');
    expect(result).toEqual([{ char: 'X', attrs: { mark: 'rid', bold: true } }]);
  });

  it('strips tag-label spans (contentEditable=false)', () => {
    const result = htmlToAttrList('<span class="tag-label" contenteditable="false">[RID]</span>ASTM');
    expect(result).toEqual([
      { char: 'A', attrs: {} },
      { char: 'S', attrs: {} },
      { char: 'T', attrs: {} },
      { char: 'M', attrs: {} },
    ]);
  });

  it('strips zero-width spaces', () => {
    const result = htmlToAttrList('\u200Bhello');
    expect(result).toEqual([
      { char: 'h', attrs: {} },
      { char: 'e', attrs: {} },
      { char: 'l', attrs: {} },
      { char: 'l', attrs: {} },
      { char: 'o', attrs: {} },
    ]);
  });

  it('returns empty array for empty string', () => {
    expect(htmlToAttrList('')).toEqual([]);
  });

  it('roundtrips: yTextToHtml(yText) → htmlToAttrList → same chars+attrs', () => {
    const ydoc = new Y.Doc();
    const yText = ydoc.getText('test');
    ydoc.transact(() => {
      yText.insert(0, 'Hello ', {});
      yText.insert(6, 'bold', { bold: true });
      yText.insert(10, ' ', {});
      yText.insert(11, 'ref', { mark: 'rid' });
    });
    const html = yTextToHtml(yText);
    const tuples = htmlToAttrList(html);
    const text = tuples.map(t => t.char).join('');
    expect(text).toBe('Hello bold ref');
    expect(tuples[6].attrs).toEqual({ bold: true });
    expect(tuples[11].attrs).toEqual({ mark: 'rid' });
  });
});

describe('applyHtmlToYText', () => {
  function makeEmptyYText() {
    const ydoc = new Y.Doc();
    return ydoc.getText('test');
  }

  it('seeds empty Y.Text from HTML', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'Hello <b>world</b>');
    expect(yTextToHtml(yText)).toBe('Hello <b>world</b>');
  });

  it('appends text to existing Y.Text', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'Hello');
    applyHtmlToYText(yText, 'Hello world');
    expect(yTextToHtml(yText)).toBe('Hello world');
  });

  it('deletes text from Y.Text', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'Hello world');
    applyHtmlToYText(yText, 'Hello');
    expect(yTextToHtml(yText)).toBe('Hello');
  });

  it('replaces text in middle', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'Hello world');
    applyHtmlToYText(yText, 'Hello earth');
    expect(yTextToHtml(yText)).toBe('Hello earth');
  });

  it('adds formatting to existing text', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'Hello world');
    applyHtmlToYText(yText, 'Hello <b>world</b>');
    expect(yTextToHtml(yText)).toBe('Hello <b>world</b>');
  });

  it('removes formatting from existing text', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'Hello <b>world</b>');
    applyHtmlToYText(yText, 'Hello world');
    expect(yTextToHtml(yText)).toBe('Hello world');
  });

  it('adds mark to existing text', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'See ASTM C33');
    applyHtmlToYText(yText, 'See <span class="mark-rid">ASTM C33</span>');
    expect(yTextToHtml(yText)).toBe('See <span class="mark-rid">ASTM C33</span>');
  });

  it('handles simultaneous text change + format change', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'old text');
    applyHtmlToYText(yText, '<b>new text</b>');
    expect(yTextToHtml(yText)).toBe('<b>new text</b>');
  });

  it('preserves Y.Text identity (does not create new Y.Text)', () => {
    const ydoc = new Y.Doc();
    const yText = ydoc.getText('test');
    applyHtmlToYText(yText, 'Hello');
    const ref1 = ydoc.getText('test');
    applyHtmlToYText(yText, 'Hello world');
    const ref2 = ydoc.getText('test');
    expect(ref1).toBe(ref2); // Same object
  });

  it('no-ops when HTML has not changed', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, 'Hello <b>world</b>');
    const beforeLength = yText.toDelta().length;
    applyHtmlToYText(yText, 'Hello <b>world</b>');
    const afterLength = yText.toDelta().length;
    expect(afterLength).toBe(beforeLength);
    expect(yTextToHtml(yText)).toBe('Hello <b>world</b>');
  });

  it('handles empty to empty (no-op)', () => {
    const yText = makeEmptyYText();
    applyHtmlToYText(yText, '');
    expect(yTextToHtml(yText)).toBe('');
  });

  it('roundtrip: apply → read → apply again preserves content', () => {
    const yText = makeEmptyYText();
    const html = 'See <span class="mark-rid"><b>ASTM C33</b></span> and <span class="mark-srf">01 33 00</span>';
    applyHtmlToYText(yText, html);
    const readBack = yTextToHtml(yText);
    applyHtmlToYText(yText, readBack); // Should be a no-op
    expect(yTextToHtml(yText)).toBe(readBack);
  });
});

describe('two-doc CRDT merge', () => {
  function syncDocs(doc1, doc2) {
    const sv1 = Y.encodeStateVector(doc1);
    const sv2 = Y.encodeStateVector(doc2);
    const update1 = Y.encodeStateAsUpdate(doc1, sv2);
    const update2 = Y.encodeStateAsUpdate(doc2, sv1);
    Y.applyUpdate(doc1, update2);
    Y.applyUpdate(doc2, update1);
  }

  it('merges concurrent text insertions at different positions', () => {
    const doc1 = new Y.Doc(); const doc2 = new Y.Doc();
    const yt1 = doc1.getText('t'); const yt2 = doc2.getText('t');

    applyHtmlToYText(yt1, 'Hello world');
    syncDocs(doc1, doc2);

    applyHtmlToYText(yt1, 'Hello beautiful world');
    applyHtmlToYText(yt2, 'Hello cruel world');

    syncDocs(doc1, doc2);

    const result = yTextToHtml(yt1);
    expect(result).toContain('beautiful');
    expect(result).toContain('cruel');
    expect(yTextToHtml(yt1)).toBe(yTextToHtml(yt2));
  });

  it('merges concurrent formatting on non-overlapping ranges', () => {
    const doc1 = new Y.Doc(); const doc2 = new Y.Doc();
    const yt1 = doc1.getText('t'); const yt2 = doc2.getText('t');

    applyHtmlToYText(yt1, 'Hello world');
    syncDocs(doc1, doc2);

    applyHtmlToYText(yt1, '<b>Hello</b> world');
    applyHtmlToYText(yt2, 'Hello <span class="mark-rid">world</span>');

    syncDocs(doc1, doc2);

    const result = yTextToHtml(yt1);
    expect(result).toContain('<b>Hello</b>');
    expect(result).toContain('<span class="mark-rid">world</span>');
    expect(yTextToHtml(yt1)).toBe(yTextToHtml(yt2));
  });

  it('merges concurrent text edit + formatting on same word', () => {
    const doc1 = new Y.Doc(); const doc2 = new Y.Doc();
    const yt1 = doc1.getText('t'); const yt2 = doc2.getText('t');

    applyHtmlToYText(yt1, 'Hello world');
    syncDocs(doc1, doc2);

    applyHtmlToYText(yt1, 'Hello <b>world</b>');
    applyHtmlToYText(yt2, 'Hello world!');

    syncDocs(doc1, doc2);

    const r1 = yTextToHtml(yt1);
    const r2 = yTextToHtml(yt2);
    expect(r1).toBe(r2);
    // Yjs CRDT: the '!' appended after 'world' inherits bold because the
    // insertion point falls inside the bold run. The exact merge result is
    // deterministic but attribute-inheriting, so we check for both words and
    // the presence of bold markup rather than an exact substring.
    expect(r1).toContain('world');
    expect(r1).toContain('!');
    expect(r1).toContain('<b>');
  });
});
