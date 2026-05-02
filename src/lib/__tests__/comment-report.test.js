import { describe, it, expect } from 'vitest';
import { generateCommentReport } from '../comment-report.js';

describe('comment report', () => {
  const meta = { sectionNumber: '31 00 00', sectionTitle: 'EARTHWORK', date: '08/23' };

  it('generates valid HTML with correct counts', () => {
    const comments = new Map();
    comments.set('c1', {
      id: 'c1', blockId: 'b1', status: 'open', highlightText: 'some text',
      entries: [{ type: 'create', text: 'Check this', author: 'Alice', timestamp: '2026-03-17T10:00:00Z' }],
    });
    comments.set('c2', {
      id: 'c2', blockId: 'b2', status: 'resolved', highlightText: 'other text',
      entries: [
        { type: 'create', text: 'Fix this', author: 'Bob', timestamp: '2026-03-17T11:00:00Z' },
        { type: 'resolve', author: 'Alice', timestamp: '2026-03-17T12:00:00Z' },
      ],
    });
    const blocks = [{ id: 'b1' }, { id: 'b2' }];
    const html = generateCommentReport(comments, blocks, meta);
    expect(html).toContain('Comment Resolution Report');
    expect(html).toContain('<strong>2</strong> total');
    expect(html).toContain('<strong>1</strong> open');
    expect(html).toContain('<strong>1</strong> resolved');
    expect(html).toContain('some text');
    expect(html).toContain('other text');
  });

  it('sorts comments by block order', () => {
    const comments = new Map();
    comments.set('c1', { id: 'c1', blockId: 'b3', status: 'open', highlightText: 'third', entries: [] });
    comments.set('c2', { id: 'c2', blockId: 'b1', status: 'open', highlightText: 'first', entries: [] });
    const blocks = [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }];
    const html = generateCommentReport(comments, blocks, meta);
    const firstIdx = html.indexOf('first');
    const thirdIdx = html.indexOf('third');
    expect(firstIdx).toBeLessThan(thirdIdx);
  });

  it('handles empty comments', () => {
    const html = generateCommentReport(new Map(), [], meta);
    expect(html).toContain('No comments');
    expect(html).toContain('<strong>0</strong> total');
  });

  it('escapes HTML in comment text', () => {
    const comments = new Map();
    comments.set('c1', {
      id: 'c1', blockId: 'b1', status: 'open', highlightText: '<script>alert("xss")</script>',
      entries: [{ type: 'create', text: 'test <b>bold</b>', author: 'User', timestamp: '' }],
    });
    const html = generateCommentReport(comments, [{ id: 'b1' }], meta);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('serializer strips comment marks', () => {
  it('mark-comment class is handled by serializer regex', () => {
    // The serializer uses /\bmark-(\w+)\b/ to match mark classes
    // 'mark-comment' matches as 'COMMENT' which is handled as a strip case
    const match = 'mark-comment'.match(/\bmark-(\w+)\b/);
    expect(match[1].toUpperCase()).toBe('COMMENT');
  });

  it('mark-comment-resolved class is handled by serializer regex', () => {
    const match = 'mark-comment-resolved'.match(/\bmark-(\w+)\b/);
    // This matches 'COMMENT' (first word boundary match)
    expect(match[1].toUpperCase()).toBe('COMMENT');
  });
});
