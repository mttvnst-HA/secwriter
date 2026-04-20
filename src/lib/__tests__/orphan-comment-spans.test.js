import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { stripOrphanCommentSpans } from '../orphan-comment-spans.js';

// linkedom provides document for Node test env.
const { document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.document = document;

describe('stripOrphanCommentSpans', () => {
  it('returns the original reference when no blocks contain mark-comment', () => {
    const blocks = [
      { id: 'b1', html: '<p>plain text</p>' },
      { id: 'b2', html: 'no spans' },
    ];
    const out = stripOrphanCommentSpans(blocks, new Set(['comment-1']));
    expect(out).toBe(blocks);
  });

  it('returns the original reference when every mark-comment is valid', () => {
    const blocks = [
      { id: 'b1', html: 'hello <span class="mark-comment" data-comment-id="c1">world</span>' },
    ];
    const out = stripOrphanCommentSpans(blocks, new Set(['c1']));
    expect(out).toBe(blocks);
  });

  it('unwraps orphan mark-comment spans while preserving their text', () => {
    const blocks = [
      { id: 'b1', html: 'hi <span class="mark-comment" data-comment-id="orphan">friend</span>!' },
    ];
    const out = stripOrphanCommentSpans(blocks, new Set());
    expect(out).not.toBe(blocks);
    expect(out[0].html).toContain('friend');
    expect(out[0].html).not.toContain('mark-comment');
    expect(out[0].html).not.toContain('data-comment-id');
  });

  it('unwraps orphans but keeps valid mark-comment spans in the same block', () => {
    const blocks = [
      {
        id: 'b1',
        html:
          '<span class="mark-comment" data-comment-id="keep">A</span> ' +
          '<span class="mark-comment" data-comment-id="drop">B</span>',
      },
    ];
    const out = stripOrphanCommentSpans(blocks, new Set(['keep']));
    expect(out).not.toBe(blocks);
    expect(out[0].html).toContain('data-comment-id="keep"');
    expect(out[0].html).toContain('A');
    expect(out[0].html).toContain('B');
    expect(out[0].html).not.toContain('data-comment-id="drop"');
  });

  it('handles the mark-comment-resolved class', () => {
    const blocks = [
      { id: 'b1', html: '<span class="mark-comment-resolved" data-comment-id="orphan">x</span>' },
    ];
    const out = stripOrphanCommentSpans(blocks, new Set());
    expect(out[0].html).toBe('x');
  });

  it('leaves unchanged blocks by reference when another block is cleaned', () => {
    const blocks = [
      { id: 'b1', html: '<p>unchanged</p>' },
      { id: 'b2', html: '<span class="mark-comment" data-comment-id="orphan">x</span>' },
    ];
    const out = stripOrphanCommentSpans(blocks, new Set());
    expect(out).not.toBe(blocks);
    expect(out[0]).toBe(blocks[0]); // unchanged block preserved by reference
    expect(out[1]).not.toBe(blocks[1]);
  });

  it('unwraps nested orphan mark-comment spans', () => {
    const blocks = [
      {
        id: 'b1',
        html:
          '<span class="mark-comment" data-comment-id="outer">' +
          '<span class="mark-comment" data-comment-id="inner">x</span>' +
          '</span>',
      },
    ];
    const out = stripOrphanCommentSpans(blocks, new Set());
    expect(out[0].html).toBe('x');
  });

  it('ignores spans without data-comment-id', () => {
    const blocks = [
      { id: 'b1', html: '<span class="mark-rid">RID</span>' },
    ];
    const out = stripOrphanCommentSpans(blocks, new Set());
    expect(out).toBe(blocks);
  });
});
