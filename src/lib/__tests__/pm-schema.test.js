/**
 * pm-schema tests — verify mark / node definitions, layering, parseDOM
 * routing, and Q26 enum membership.
 */

import { describe, it, expect } from 'vitest';
import {
  schema,
  INLINE_MARK_KINDS,
  VALID_MARKS,
  MARK_CLASSES,
} from '../pm-schema.js';

describe('INLINE_MARK_KINDS / VALID_MARKS / MARK_CLASSES', () => {
  it('INLINE_MARK_KINDS contains all 14 kinds (Q26 includes hl1-hl4 + hls)', () => {
    const expected = ['rid', 'srf', 'sub', 'eng', 'met', 'tai', 'tst', 'url', 'att', 'hls', 'hl1', 'hl2', 'hl3', 'hl4'];
    for (const k of expected) expect(INLINE_MARK_KINDS.has(k)).toBe(true);
    expect(INLINE_MARK_KINDS.size).toBe(expected.length);
  });

  it('VALID_MARKS gates receive direction (includes comment as separate layer)', () => {
    expect(VALID_MARKS.has('comment')).toBe(true);
    for (const k of INLINE_MARK_KINDS) expect(VALID_MARKS.has(k)).toBe(true);
    expect(VALID_MARKS.size).toBe(INLINE_MARK_KINDS.size + 1);
  });

  it('MARK_CLASSES gates parse direction (hls is a sibling kind, no comment)', () => {
    expect(MARK_CLASSES.has('hls')).toBe(true);
    expect(MARK_CLASSES.has('comment')).toBe(false);
    expect(MARK_CLASSES.size).toBe(INLINE_MARK_KINDS.size);
  });
});

describe('schema mark order (rank = nesting outer→inner)', () => {
  it('mark types are declared in layering order: comment, revision, inlineMark, bold, italic, underline', () => {
    const names = Object.keys(schema.marks);
    expect(names).toEqual(['comment', 'revision', 'inlineMark', 'bold', 'italic', 'underline']);
  });

  it('rank reflects declaration order (lower rank = outer = earlier)', () => {
    expect(schema.marks.comment.rank).toBeLessThan(schema.marks.revision.rank);
    expect(schema.marks.revision.rank).toBeLessThan(schema.marks.inlineMark.rank);
    expect(schema.marks.inlineMark.rank).toBeLessThan(schema.marks.bold.rank);
    expect(schema.marks.bold.rank).toBeLessThan(schema.marks.italic.rank);
    expect(schema.marks.italic.rank).toBeLessThan(schema.marks.underline.rank);
  });
});

describe('schema mark attrs', () => {
  it('comment has id (default empty) and resolved (default false)', () => {
    const m = schema.marks.comment.create();
    expect(m.attrs).toEqual({ id: '', resolved: false });
    const m2 = schema.marks.comment.create({ id: 'c1', resolved: true });
    expect(m2.attrs).toEqual({ id: 'c1', resolved: true });
  });

  it('revision has kind/authorId/authorColor with sensible defaults', () => {
    const m = schema.marks.revision.create();
    expect(m.attrs).toEqual({ kind: 'add', authorId: null, authorColor: null });
    const m2 = schema.marks.revision.create({ kind: 'del', authorId: 'bob', authorColor: '#fff' });
    expect(m2.attrs).toEqual({ kind: 'del', authorId: 'bob', authorColor: '#fff' });
  });

  it('inlineMark has kind/option with default kind=rid', () => {
    const m = schema.marks.inlineMark.create();
    expect(m.attrs).toEqual({ kind: 'rid', option: null });
    const m2 = schema.marks.inlineMark.create({ kind: 'tai', option: 'ARMY' });
    expect(m2.attrs).toEqual({ kind: 'tai', option: 'ARMY' });
  });

  it('format marks (bold/italic/underline) carry no attrs', () => {
    expect(schema.marks.bold.create().attrs).toEqual({});
    expect(schema.marks.italic.create().attrs).toEqual({});
    expect(schema.marks.underline.create().attrs).toEqual({});
  });
});

describe('schema nodes', () => {
  it('has doc, paragraph, text, hard_break', () => {
    expect(schema.nodes.doc).toBeDefined();
    expect(schema.nodes.paragraph).toBeDefined();
    expect(schema.nodes.text).toBeDefined();
    expect(schema.nodes.hard_break).toBeDefined();
  });

  it('paragraph allows inline content; doc allows block+', () => {
    expect(schema.nodes.paragraph.contentMatch.matchType(schema.nodes.text)).toBeTruthy();
    expect(schema.nodes.doc.contentMatch.matchType(schema.nodes.paragraph)).toBeTruthy();
  });

  it('hard_break is inline and not selectable', () => {
    expect(schema.nodes.hard_break.isInline).toBe(true);
    expect(schema.nodes.hard_break.spec.selectable).toBe(false);
  });
});

describe('inlineMark.toDOM adversarial fallback (Q31/E6)', () => {
  it('unknown kind renders a plain span (no class), never throws', () => {
    // create() bypasses schema validation since attrs.kind has a default; force it.
    const mark = schema.marks.inlineMark.create({ kind: 'no-such-kind' });
    const out = mark.type.spec.toDOM(mark);
    // Plain span with placeholder content (0)
    expect(out).toEqual(['span', 0]);
  });

  it('known kinds render the class properly', () => {
    const rid = schema.marks.inlineMark.create({ kind: 'rid' });
    expect(rid.type.spec.toDOM(rid)).toEqual(['span', { class: 'mark-rid' }, 0]);
    const tai = schema.marks.inlineMark.create({ kind: 'tai', option: 'ARMY' });
    expect(tai.type.spec.toDOM(tai)).toEqual(['span', { class: 'mark-tai', 'data-opt': 'ARMY' }, 0]);
    // tai without option drops the data-opt attribute
    const taiPlain = schema.marks.inlineMark.create({ kind: 'tai' });
    expect(taiPlain.type.spec.toDOM(taiPlain)).toEqual(['span', { class: 'mark-tai' }, 0]);
  });
});

describe('parseDOM routing — hand-call getAttrs to confirm it dispatches correctly', () => {
  // PM's DOMParser is exercised end-to-end in pmdoc-html.test.js. Here we
  // just confirm the per-rule getAttrs return shapes — these are the seams
  // where parse direction can drift from receive direction.
  function span(cls, extra = {}) {
    const el = { tagName: 'SPAN', getAttribute: (k) => (k === 'class' ? cls : (extra[k] ?? null)) };
    return el;
  }

  it('comment.getAttrs matches mark-comment / mark-comment-resolved only', () => {
    const rule = schema.marks.comment.spec.parseDOM[0];
    expect(rule.getAttrs(span('mark-comment', { 'data-comment-id': 'c1' }))).toEqual({ id: 'c1', resolved: false });
    expect(rule.getAttrs(span('mark-comment-resolved', { 'data-comment-id': 'c2' }))).toEqual({ id: 'c2', resolved: true });
    expect(rule.getAttrs(span('mark-rid'))).toBe(false);
  });

  it('inlineMark.getAttrs returns false for comment/revision/tag-label, kind otherwise', () => {
    const rules = schema.marks.inlineMark.spec.parseDOM;
    const rule = rules[0];
    expect(rule.getAttrs(span('mark-rid'))).toEqual({ kind: 'rid', option: null });
    expect(rule.getAttrs(span('mark-tai', { 'data-opt': 'NAVY' }))).toEqual({ kind: 'tai', option: 'NAVY' });
    expect(rule.getAttrs(span('mark-comment'))).toBe(false);
    expect(rule.getAttrs(span('mark-chg'))).toBe(false);
    expect(rule.getAttrs(span('tag-label'))).toBe(false);
    expect(rule.getAttrs(span('mark-foobar'))).toBe(false); // Q31/E6
    expect(rule.getAttrs(span(''))).toBe(false);
  });

  it('revision.getAttrs extracts author/color for each kind', () => {
    const ruleAdd = schema.marks.revision.spec.parseDOM[0];
    const elAdd = {
      tagName: 'INS',
      getAttribute: (k) => ({
        'class': 'mark-add',
        'data-author-id': 'alice',
        'style': '--author-color:#ff6b6b',
      }[k] ?? null),
    };
    expect(ruleAdd.getAttrs(elAdd)).toEqual({ kind: 'add', authorId: 'alice', authorColor: '#ff6b6b' });

    const ruleChg = schema.marks.revision.spec.parseDOM[2];
    const elChg = {
      tagName: 'SPAN',
      getAttribute: (k) => ({ class: 'mark-chg' }[k] ?? null),
    };
    expect(ruleChg.getAttrs(elChg)).toEqual({ kind: 'chg', authorId: null, authorColor: null });
  });
});
