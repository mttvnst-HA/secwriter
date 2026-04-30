/**
 * ytext-html tests — Y.Text ↔ HTML bidirectional conversion.
 *
 * Consolidated to ≤30 it() blocks per CLAUDE.md rule: data-driven tests
 * use it.each(), related assertions are batched in single it() blocks.
 */

import { describe, it, expect, vi } from 'vitest';
import * as Y from 'yjs';
import { yTextToHtml, htmlToAttrList, applyHtmlToYText, seedYTextFromHtml } from '../ytext-html.js';

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
  it.each([
    ['plain text', [{ insert: 'Hello world' }], 'Hello world'],
    ['bold', [{ insert: 'Hello ' }, { insert: 'bold', attributes: { bold: true } }, { insert: ' world' }], 'Hello <b>bold</b> world'],
    ['italic', [{ insert: 'Hello ' }, { insert: 'italic', attributes: { italic: true } }], 'Hello <i>italic</i>'],
    ['underline', [{ insert: 'underlined', attributes: { underline: true } }], '<u>underlined</u>'],
    ['mark-rid', [{ insert: 'See ' }, { insert: 'ASTM C33', attributes: { mark: 'rid' } }, { insert: ' for details' }], 'See <span class="mark-rid">ASTM C33</span> for details'],
    ['tai mark with markOption', [{ insert: 'tailored text', attributes: { mark: 'tai', markOption: 'OPTION_A' } }], '<span class="mark-tai" data-opt="OPTION_A">tailored text</span>'],
    ['revision add', [{ insert: 'added text', attributes: { revision: 'add' } }], '<ins class="mark-add">added text</ins>'],
    ['revision del', [{ insert: 'deleted', attributes: { revision: 'del' } }], '<del class="mark-del">deleted</del>'],
    ['revision chg', [{ insert: 'changed', attributes: { revision: 'chg' } }], '<span class="mark-chg">changed</span>'],
    ['revision add with author color', [{ insert: 'added', attributes: { revision: 'add', revisionAuthorColor: '#ff6b6b' } }], '<ins class="mark-add" style="--author-color:#ff6b6b">added</ins>'],
    ['chg revision with author color', [{ insert: 'changed', attributes: { revision: 'chg', revisionAuthorColor: '#aabbcc' } }], '<span class="mark-chg" style="--author-color:#aabbcc">changed</span>'],
    ['comment', [{ insert: 'commented', attributes: { comment: 'comment-123' } }], '<span class="mark-comment" data-comment-id="comment-123">commented</span>'],
    ['commentResolved', [{ insert: 'resolved', attributes: { comment: 'c1', commentResolved: true } }], '<span class="mark-comment-resolved" data-comment-id="c1">resolved</span>'],
  ])('converts %s', (_name, deltas, expected) => {
    const yText = makeYText(deltas);
    expect(yTextToHtml(yText)).toBe(expected);
  });

  it('escapes Y.Doc attributes to prevent XSS from malicious peers', () => {
    // revisionAuthorColor injection — quotes are escaped so attribute can't break out
    const xssColor = makeYText([
      { insert: 'text', attributes: { revision: 'add', revisionAuthorColor: 'hsl(0,0%,0%)" onmouseover="alert(1)' } },
    ]);
    const colorHtml = yTextToHtml(xssColor);
    // The " chars in the injected value are escaped to &quot; — attribute can't break out
    expect(colorHtml).toContain('--author-color:hsl(0,0%,0%)&quot; onmouseover=&quot;alert(1)');
    expect(colorHtml).not.toMatch(/style="[^"]*"[^"]*onmouseover/);

    // revisionAuthor injection
    const xssAuthor = makeYText([
      { insert: 'text', attributes: { revision: 'del', revisionAuthor: 'user" onclick="alert(2)' } },
    ]);
    const authorHtml = yTextToHtml(xssAuthor);
    expect(authorHtml).toContain('data-author-id="user&quot; onclick=&quot;alert(2)"');

    // comment id injection
    const xssComment = makeYText([
      { insert: 'text', attributes: { comment: 'c1" onload="alert(3)' } },
    ]);
    const commentHtml = yTextToHtml(xssComment);
    expect(commentHtml).toContain('data-comment-id="c1&quot; onload=&quot;alert(3)"');

    // markOption injection
    const xssOpt = makeYText([
      { insert: 'text', attributes: { mark: 'tai', markOption: 'OPT" onfocus="alert(4)' } },
    ]);
    const optHtml = yTextToHtml(xssOpt);
    expect(optHtml).toContain('data-opt="OPT&quot; onfocus=&quot;alert(4)"');
  });

  it('handles stacked attributes, adjacent merging, empty text, and HTML entities', () => {
    // Stacked: bold + mark-rid
    const stacked1 = makeYText([
      { insert: 'ASTM D2487', attributes: { bold: true, mark: 'rid' } },
    ]);
    expect(yTextToHtml(stacked1)).toBe('<span class="mark-rid"><b>ASTM D2487</b></span>');

    // Stacked: revision + mark + format
    const stacked2 = makeYText([
      { insert: 'new ref', attributes: { revision: 'add', mark: 'rid', bold: true } },
    ]);
    expect(yTextToHtml(stacked2)).toBe('<ins class="mark-add"><span class="mark-rid"><b>new ref</b></span></ins>');

    // Adjacent segments with same attribute merging
    const adjacent = makeYText([
      { insert: 'hello', attributes: { bold: true } },
      { insert: ' world', attributes: { bold: true } },
    ]);
    expect(yTextToHtml(adjacent)).toBe('<b>hello world</b>');

    // Empty Y.Text
    const ydoc = new Y.Doc();
    const emptyYText = ydoc.getText('test');
    expect(yTextToHtml(emptyYText)).toBe('');

    // HTML entities
    const entities = makeYText([{ insert: '3 < 5 & 5 > 3' }]);
    expect(yTextToHtml(entities)).toBe('3 &lt; 5 &amp; 5 &gt; 3');
  });
});

describe('htmlToAttrList', () => {
  it.each([
    ['plain text', 'Hello', [
      { char: 'H', attrs: {} }, { char: 'e', attrs: {} }, { char: 'l', attrs: {} },
      { char: 'l', attrs: {} }, { char: 'o', attrs: {} },
    ]],
    ['<b> as bold', 'a<b>B</b>c', [
      { char: 'a', attrs: {} }, { char: 'B', attrs: { bold: true } }, { char: 'c', attrs: {} },
    ]],
    ['<u> as underline', '<u>x</u>', [{ char: 'x', attrs: { underline: true } }]],
    ['mark-rid span', '<span class="mark-rid">ASTM</span>', [
      { char: 'A', attrs: { mark: 'rid' } }, { char: 'S', attrs: { mark: 'rid' } },
      { char: 'T', attrs: { mark: 'rid' } }, { char: 'M', attrs: { mark: 'rid' } },
    ]],
    ['mark-tai with data-opt', '<span class="mark-tai" data-opt="OPT_A">x</span>', [
      { char: 'x', attrs: { mark: 'tai', markOption: 'OPT_A' } },
    ]],
    ['ins mark-add', '<ins class="mark-add">x</ins>', [
      { char: 'x', attrs: { revision: 'add' } },
    ]],
    ['del mark-del', '<del class="mark-del">x</del>', [
      { char: 'x', attrs: { revision: 'del' } },
    ]],
    ['span mark-chg', '<span class="mark-chg">x</span>', [
      { char: 'x', attrs: { revision: 'chg' } },
    ]],
    ['ins with --author-color', '<ins class="mark-add" style="--author-color:#ff6b6b">x</ins>', [
      { char: 'x', attrs: { revision: 'add', revisionAuthorColor: '#ff6b6b' } },
    ]],
    ['mark-comment', '<span class="mark-comment" data-comment-id="c1">x</span>', [
      { char: 'x', attrs: { comment: 'c1' } },
    ]],
    ['mark-comment-resolved', '<span class="mark-comment-resolved" data-comment-id="c1">x</span>', [
      { char: 'x', attrs: { comment: 'c1', commentResolved: true } },
    ]],
  ])('parses %s', (_name, html, expected) => {
    expect(htmlToAttrList(html)).toEqual(expected);
  });

  it('parses <i> and <em> both as italic', () => {
    const r1 = htmlToAttrList('<i>x</i>');
    const r2 = htmlToAttrList('<em>x</em>');
    expect(r1).toEqual([{ char: 'x', attrs: { italic: true } }]);
    expect(r2).toEqual([{ char: 'x', attrs: { italic: true } }]);
  });

  it('handles nested marks, tag-label stripping, zero-width spaces, empty input, and entities', () => {
    // Nested: mark-rid + bold
    const nested = htmlToAttrList('<span class="mark-rid"><b>X</b></span>');
    expect(nested).toEqual([{ char: 'X', attrs: { mark: 'rid', bold: true } }]);

    // Strips tag-label spans
    const tagLabel = htmlToAttrList('<span class="tag-label" contenteditable="false">[RID]</span>ASTM');
    expect(tagLabel).toEqual([
      { char: 'A', attrs: {} }, { char: 'S', attrs: {} },
      { char: 'T', attrs: {} }, { char: 'M', attrs: {} },
    ]);

    // Strips zero-width spaces
    const zws = htmlToAttrList('\u200Bhello');
    expect(zws).toEqual([
      { char: 'h', attrs: {} }, { char: 'e', attrs: {} }, { char: 'l', attrs: {} },
      { char: 'l', attrs: {} }, { char: 'o', attrs: {} },
    ]);

    // Empty string
    expect(htmlToAttrList('')).toEqual([]);

    // HTML entities (&nbsp;, &mdash;, &amp;)
    const nbspResult = htmlToAttrList('a&nbsp;b');
    expect(nbspResult.map(t => t.char).join('')).toBe('a\u00A0b');
    const mdashResult = htmlToAttrList('x&mdash;y');
    expect(mdashResult.map(t => t.char).join('')).toBe('x\u2014y');
    const ampResult = htmlToAttrList('a&amp;b');
    expect(ampResult.map(t => t.char).join('')).toBe('a&b');
  });

  it('roundtrips: yTextToHtml → htmlToAttrList preserves chars+attrs', () => {
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

  it.each([
    ['seeds empty Y.Text from HTML', '', 'Hello <b>world</b>', 'Hello <b>world</b>'],
    ['appends text', 'Hello', 'Hello world', 'Hello world'],
    ['deletes text', 'Hello world', 'Hello', 'Hello'],
    ['replaces text in middle', 'Hello world', 'Hello earth', 'Hello earth'],
    ['adds formatting', 'Hello world', 'Hello <b>world</b>', 'Hello <b>world</b>'],
    ['removes formatting', 'Hello <b>world</b>', 'Hello world', 'Hello world'],
    ['adds mark', 'See ASTM C33', 'See <span class="mark-rid">ASTM C33</span>', 'See <span class="mark-rid">ASTM C33</span>'],
    ['handles simultaneous text + format change', 'old text', '<b>new text</b>', '<b>new text</b>'],
  ])('%s', (_name, initialHtml, applyHtml, expected) => {
    const yText = makeEmptyYText();
    if (initialHtml) applyHtmlToYText(yText, initialHtml);
    applyHtmlToYText(yText, applyHtml);
    expect(yTextToHtml(yText)).toBe(expected);
  });

  it('preserves Y.Text identity, no-ops on unchanged HTML, and handles empty-to-empty', () => {
    // Identity preservation
    const ydoc = new Y.Doc();
    const yText = ydoc.getText('test');
    applyHtmlToYText(yText, 'Hello');
    const ref1 = ydoc.getText('test');
    applyHtmlToYText(yText, 'Hello world');
    const ref2 = ydoc.getText('test');
    expect(ref1).toBe(ref2);

    // No-op when HTML unchanged
    const yText2 = makeEmptyYText();
    applyHtmlToYText(yText2, 'Hello <b>world</b>');
    const beforeLength = yText2.toDelta().length;
    applyHtmlToYText(yText2, 'Hello <b>world</b>');
    const afterLength = yText2.toDelta().length;
    expect(afterLength).toBe(beforeLength);
    expect(yTextToHtml(yText2)).toBe('Hello <b>world</b>');

    // Empty to empty
    const yText3 = makeEmptyYText();
    applyHtmlToYText(yText3, '');
    expect(yTextToHtml(yText3)).toBe('');
  });

  it('roundtrip: apply → read → apply again preserves content', () => {
    const yText = makeEmptyYText();
    const html = 'See <span class="mark-rid"><b>ASTM C33</b></span> and <span class="mark-srf">01 33 00</span>';
    applyHtmlToYText(yText, html);
    const readBack = yTextToHtml(yText);
    applyHtmlToYText(yText, readBack);
    expect(yTextToHtml(yText)).toBe(readBack);
  });
});

describe('lenient HTML parsing (recovers from contentEditable quirks)', () => {
  // Browsers' text/xml DOMParser is strict and returns a parsererror document
  // for inputs like bare <br> that contentEditable routinely emits. Switching
  // to text/html mode (the HTML5 parsing algorithm) is lenient by design and
  // accepts these without producing parsererror. This test mocks a browser-
  // accurate DOMParser (strict for text/xml, lenient for text/html) to verify
  // the implementation routes through text/html.
  function installBrowserAccurateDOMParser() {
    const { parseHTML } = require('linkedom');
    class BrowserAccurateDOMParser {
      parseFromString(str, mode) {
        if (mode === 'text/xml' && /<(br|img|hr)\b[^/>]*>(?!<\/)/i.test(str)) {
          // Simulate browser strict-XML failure on void HTML tags
          return parseHTML(
            '<!doctype html><html><body><parsererror>error on line 1: Opening and ending tag mismatch</parsererror></body></html>',
          ).document;
        }
        // text/html (or well-formed text/xml): use linkedom's lenient parser
        return parseHTML(str).document;
      }
    }
    vi.stubGlobal('DOMParser', BrowserAccurateDOMParser);
  }

  it('htmlToAttrList recovers from bare <br> via text/html parsing', () => {
    installBrowserAccurateDOMParser();
    try {
      const result = htmlToAttrList('Hello<br>world');
      expect(result.map(t => t.char).join('')).toBe('Helloworld');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('applyHtmlToYText persists content with bare <br> instead of dropping the edit', () => {
    const ydoc = new Y.Doc();
    const yText = ydoc.getText('test');
    applyHtmlToYText(yText, 'Original');

    installBrowserAccurateDOMParser();
    try {
      applyHtmlToYText(yText, 'Hello<br>world');
    } finally {
      vi.unstubAllGlobals();
    }

    expect(yTextToHtml(yText)).toBe('Helloworld');
  });

  it('seedYTextFromHtml seeds content with bare <br> cleanly', () => {
    const ydoc = new Y.Doc();
    const yText = ydoc.getText('seed');

    installBrowserAccurateDOMParser();
    try {
      seedYTextFromHtml(yText, 'a<br>b<br>c');
    } finally {
      vi.unstubAllGlobals();
    }

    expect(yTextToHtml(yText)).toBe('abc');
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

  it('merges concurrent text insertions, formatting, and text+format on same word', () => {
    // Concurrent text insertions at different positions
    const doc1 = new Y.Doc(); const doc2 = new Y.Doc();
    const yt1 = doc1.getText('t'); const yt2 = doc2.getText('t');
    applyHtmlToYText(yt1, 'Hello world');
    syncDocs(doc1, doc2);
    applyHtmlToYText(yt1, 'Hello beautiful world');
    applyHtmlToYText(yt2, 'Hello cruel world');
    syncDocs(doc1, doc2);
    let result = yTextToHtml(yt1);
    expect(result).toContain('beautiful');
    expect(result).toContain('cruel');
    expect(yTextToHtml(yt1)).toBe(yTextToHtml(yt2));

    // Concurrent formatting on non-overlapping ranges
    const doc3 = new Y.Doc(); const doc4 = new Y.Doc();
    const yt3 = doc3.getText('t2'); const yt4 = doc4.getText('t2');
    applyHtmlToYText(yt3, 'Hello world');
    syncDocs(doc3, doc4);
    applyHtmlToYText(yt3, '<b>Hello</b> world');
    applyHtmlToYText(yt4, 'Hello <span class="mark-rid">world</span>');
    syncDocs(doc3, doc4);
    result = yTextToHtml(yt3);
    expect(result).toContain('<b>Hello</b>');
    expect(result).toContain('<span class="mark-rid">world</span>');
    expect(yTextToHtml(yt3)).toBe(yTextToHtml(yt4));

    // Concurrent text edit + formatting on same word
    const doc5 = new Y.Doc(); const doc6 = new Y.Doc();
    const yt5 = doc5.getText('t3'); const yt6 = doc6.getText('t3');
    applyHtmlToYText(yt5, 'Hello world');
    syncDocs(doc5, doc6);
    applyHtmlToYText(yt5, 'Hello <b>world</b>');
    applyHtmlToYText(yt6, 'Hello world!');
    syncDocs(doc5, doc6);
    const r1 = yTextToHtml(yt5);
    const r2 = yTextToHtml(yt6);
    expect(r1).toBe(r2);
    expect(r1).toContain('world');
    expect(r1).toContain('!');
    expect(r1).toContain('<b>');
  });
});
