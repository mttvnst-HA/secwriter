import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { diffWords, stripHtml, diffChars, refineWordDiff, annotateDomWithDiff } from '../text-diff.js';

// Shared linkedom document for DOM-based tests.
//
// We only attach to globalThis.document when nothing has claimed it yet —
// defensive against a future Vitest config change (jsdom environment, single
// worker pool, etc.) that would otherwise let this overwrite a real document
// or leak into sibling test files.
const { document: linkedomDoc } = parseHTML('<!DOCTYPE html><html><body></body></html>');
if (typeof globalThis.document === 'undefined') {
  globalThis.document = linkedomDoc;
}

// linkedom Text nodes lack splitText — polyfill it on the prototype
{
  const probe = linkedomDoc.createTextNode('x');
  const TextProto = Object.getPrototypeOf(probe);
  if (typeof TextProto.splitText !== 'function') {
    TextProto.splitText = function splitText(offset) {
      const before = this.textContent.slice(0, offset);
      const after = this.textContent.slice(offset);
      this.textContent = before;
      const newNode = linkedomDoc.createTextNode(after);
      if (this.nextSibling) {
        this.parentNode.insertBefore(newNode, this.nextSibling);
      } else {
        this.parentNode.appendChild(newNode);
      }
      return newNode;
    };
  }
}

function makeContainer(text) {
  const el = linkedomDoc.createElement('div');
  // Use innerHTML (wrapped in a span) so we get a proper element child,
  // giving text nodes a stable parentNode for splitText operations.
  el.innerHTML = `<span>${text}</span>`;
  return el;
}

describe('diffWords', () => {
  it('returns empty for identical text', () => {
    const result = diffWords('hello world', 'hello world');
    expect(result).toEqual([{ type: 'keep', words: ['hello', 'world'] }]);
  });

  it('detects added words at end', () => {
    const result = diffWords('hello', 'hello world');
    expect(result).toEqual([
      { type: 'keep', words: ['hello'] },
      { type: 'add', words: ['world'] },
    ]);
  });

  it('detects added words at beginning', () => {
    const result = diffWords('world', 'hello world');
    expect(result).toEqual([
      { type: 'add', words: ['hello'] },
      { type: 'keep', words: ['world'] },
    ]);
  });

  it('detects deleted words', () => {
    const result = diffWords('hello beautiful world', 'hello world');
    expect(result).toEqual([
      { type: 'keep', words: ['hello'] },
      { type: 'del', words: ['beautiful'] },
      { type: 'keep', words: ['world'] },
    ]);
  });

  it('detects replaced words', () => {
    const result = diffWords('hello old world', 'hello new world');
    expect(result).toEqual([
      { type: 'keep', words: ['hello'] },
      { type: 'del', words: ['old'] },
      { type: 'add', words: ['new'] },
      { type: 'keep', words: ['world'] },
    ]);
  });

  it('handles empty old text', () => {
    const result = diffWords('', 'hello world');
    expect(result).toEqual([
      { type: 'add', words: ['hello', 'world'] },
    ]);
  });

  it('handles empty new text', () => {
    const result = diffWords('hello world', '');
    expect(result).toEqual([
      { type: 'del', words: ['hello', 'world'] },
    ]);
  });

  it('handles both empty', () => {
    const result = diffWords('', '');
    expect(result).toEqual([]);
  });

  it('detects multiple additions', () => {
    const result = diffWords('A C', 'A B C D');
    expect(result).toEqual([
      { type: 'keep', words: ['A'] },
      { type: 'add', words: ['B'] },
      { type: 'keep', words: ['C'] },
      { type: 'add', words: ['D'] },
    ]);
  });

  it('handles complete replacement', () => {
    const result = diffWords('old text here', 'new content now');
    // Complete replacement
    expect(result.some(op => op.type === 'del')).toBe(true);
    expect(result.some(op => op.type === 'add')).toBe(true);
  });
});

describe('diffChars', () => {
  it('detects single character change within a word', () => {
    const result = diffChars('test', 'text');
    expect(result).toEqual([
      { type: 'keep', text: 'te' },
      { type: 'del', text: 's' },
      { type: 'add', text: 'x' },
      { type: 'keep', text: 't' },
    ]);
  });

  it('detects appended character', () => {
    const result = diffChars('specification', 'specifications');
    expect(result).toEqual([
      { type: 'keep', text: 'specification' },
      { type: 'add', text: 's' },
    ]);
  });

  it('handles completely different strings', () => {
    const result = diffChars('cat', 'dog');
    expect(result.some(op => op.type === 'del')).toBe(true);
    expect(result.some(op => op.type === 'add')).toBe(true);
  });

  it('handles identical strings', () => {
    const result = diffChars('hello', 'hello');
    expect(result).toEqual([{ type: 'keep', text: 'hello' }]);
  });
});

describe('refineWordDiff', () => {
  it('refines del→add pairs with high similarity into charDiff', () => {
    const ops = [
      { type: 'keep', words: ['hello'] },
      { type: 'del', words: ['test'] },
      { type: 'add', words: ['text'] },
      { type: 'keep', words: ['world'] },
    ];
    const refined = refineWordDiff(ops);
    expect(refined.length).toBe(3);
    expect(refined[0].type).toBe('keep');
    expect(refined[1].type).toBe('charDiff');
    expect(refined[1].ops.some(o => o.type === 'del' && o.text === 's')).toBe(true);
    expect(refined[1].ops.some(o => o.type === 'add' && o.text === 'x')).toBe(true);
    expect(refined[2].type).toBe('keep');
  });

  it('does not refine completely different word pairs', () => {
    const ops = [
      { type: 'del', words: ['cat'] },
      { type: 'add', words: ['dog'] },
    ];
    const refined = refineWordDiff(ops);
    // "cat" vs "dog" have 0 common chars → no refinement
    expect(refined.length).toBe(2);
    expect(refined[0].type).toBe('del');
    expect(refined[1].type).toBe('add');
  });

  it('passes through keep-only diffs unchanged', () => {
    const ops = [{ type: 'keep', words: ['hello', 'world'] }];
    expect(refineWordDiff(ops)).toEqual(ops);
  });
});

describe('stripHtml', () => {
  it('strips HTML tags', () => {
    expect(stripHtml('<b>hello</b> <span class="mark-rid">world</span>'))
      .toBe('hello world');
  });

  it('strips zero-width spaces', () => {
    expect(stripHtml('hello\u200Bworld')).toBe('helloworld');
  });

  it('handles null/empty', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml('')).toBe('');
  });
});

describe('annotateDomWithDiff — author attribution', () => {
  const ALICE = { id: 'u-alice', name: 'Alice', color: '#7a3' };

  it('sets data-author-* and --author-color on <del> nodes when author is provided', () => {
    const container = makeContainer('the fox');
    annotateDomWithDiff(container, 'the quick fox', ALICE);
    const del = container.querySelector('del.mark-del');
    expect(del).toBeTruthy();
    expect(del.getAttribute('data-author-id')).toBe('u-alice');
    expect(del.getAttribute('data-author-name')).toBe('Alice');
    expect(del.getAttribute('data-author-color')).toBe('#7a3');
    const style = del.getAttribute('style') || '';
    expect(style).toContain('--author-color');
    expect(style).toContain('#7a3');
  });

  it('sets data-author-* and --author-color on <ins> wrappers when author is provided', () => {
    const container = makeContainer('the slow fox');
    annotateDomWithDiff(container, 'the quick fox', ALICE);
    const ins = container.querySelector('ins.mark-add');
    expect(ins).toBeTruthy();
    expect(ins.getAttribute('data-author-id')).toBe('u-alice');
    expect(ins.getAttribute('data-author-name')).toBe('Alice');
    expect(ins.getAttribute('data-author-color')).toBe('#7a3');
    const style = ins.getAttribute('style') || '';
    expect(style).toContain('--author-color');
    expect(style).toContain('#7a3');
  });

  it('does NOT set author attributes when called without author (back-compat)', () => {
    const container = makeContainer('the slow fox');
    annotateDomWithDiff(container, 'the quick fox'); // no author
    const ins = container.querySelector('ins.mark-add');
    const del = container.querySelector('del.mark-del');
    if (ins) {
      expect(ins.getAttribute('data-author-id')).toBeFalsy();
      expect(ins.getAttribute('data-author-color')).toBeFalsy();
    }
    if (del) {
      expect(del.getAttribute('data-author-id')).toBeFalsy();
      expect(del.getAttribute('data-author-color')).toBeFalsy();
    }
  });
});
