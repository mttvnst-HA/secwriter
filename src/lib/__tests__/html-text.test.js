import { describe, it, expect } from 'vitest';
import { stripTags, decodeEntities, htmlToPlainText } from '../html-text.js';

describe('stripTags', () => {
  it('removes simple tags', () => {
    expect(stripTags('<b>hello</b> <span class="mark-rid">world</span>')).toBe('hello world');
  });

  it('handles empty/null input', () => {
    expect(stripTags(null)).toBe('');
    expect(stripTags('')).toBe('');
  });

  it('re-scans until no tag-like construct remains (nested/malformed tags)', () => {
    // A single non-looping pass over "<<script>script>" would remove
    // "<<script>" (up to the first ">") and leave "script>" behind — no
    // longer a tag. A second removed layer must not reconstitute one either.
    expect(stripTags('<<script>script>')).not.toMatch(/<[^>]*>/);
    expect(stripTags('<a><b><c>text</c></b></a>')).toBe('text');
  });

  it('supports a replacement string to avoid fusing adjacent words', () => {
    expect(stripTags('a</span> <span>b', ' ')).toBe('a   b');
  });
});

describe('decodeEntities', () => {
  it('decodes the standard named/numeric entities', () => {
    expect(decodeEntities('A &amp; B &lt; C &gt; D &quot;E&quot; &apos;F&apos; &#39;G&#39; H&nbsp;I'))
      .toBe(`A & B < C > D "E" 'F' 'G' H I`);
  });

  it('does not cascade a doubly-escaped sequence into the wrong character', () => {
    // "&amp;lt;" is the correct escaping of literal text "&lt;" — it must
    // decode ONCE, to "&lt;", not twice into "<".
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeEntities('&amp;amp;')).toBe('&amp;');
  });

  it('handles empty/null input', () => {
    expect(decodeEntities(null)).toBe('');
    expect(decodeEntities('')).toBe('');
  });
});

describe('htmlToPlainText', () => {
  it('strips tags, decodes entities, and drops zero-width spaces', () => {
    const zwsp = String.fromCharCode(0x200b);
    expect(htmlToPlainText(`<b>hello</b>${zwsp}world &amp; friends`)).toBe('helloworld & friends');
  });

  it('handles empty/null input', () => {
    expect(htmlToPlainText(null)).toBe('');
    expect(htmlToPlainText('')).toBe('');
  });
});
