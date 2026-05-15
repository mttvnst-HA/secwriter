/**
 * pm-schema tests — verify mark / node definitions, layering, parseDOM
 * routing, and Q26 enum membership.
 *
 * Sub-PR 1g.6 (#87) update — the `revision` MarkType is split into three
 * separate MarkTypes: revisionAdd, revisionDel, revisionChg. Their
 * declaration order is pinned (Add → Del → Chg) by the rank order test
 * below — a regression would either reorder rendering nesting in unexpected
 * ways or change toggle-off semantics in pm-toolbar verbs.
 */

import { describe, it, expect } from 'vitest';
import {
  schema,
  INLINE_MARK_KINDS,
  VALID_MARKS,
  MARK_CLASSES,
  REVISION_KINDS,
  REVISION_MARK_TYPE_NAMES,
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

  it('REVISION_KINDS contains add/del/chg', () => {
    expect([...REVISION_KINDS].sort()).toEqual(['add', 'chg', 'del']);
  });

  it('REVISION_MARK_TYPE_NAMES maps kind to MarkType name', () => {
    expect(REVISION_MARK_TYPE_NAMES.add).toBe('revisionAdd');
    expect(REVISION_MARK_TYPE_NAMES.del).toBe('revisionDel');
    expect(REVISION_MARK_TYPE_NAMES.chg).toBe('revisionChg');
  });
});

describe('schema mark order (rank = nesting outer→inner)', () => {
  it('mark types are declared in layering order: comment, revisionAdd, revisionDel, revisionChg, inlineMark, bold, italic, underline', () => {
    const names = Object.keys(schema.marks);
    expect(names).toEqual([
      'comment',
      'revisionAdd',
      'revisionDel',
      'revisionChg',
      'inlineMark',
      'bold',
      'italic',
      'underline',
    ]);
  });

  it('rank reflects declaration order (lower rank = outer = earlier)', () => {
    expect(schema.marks.comment.rank).toBeLessThan(schema.marks.revisionAdd.rank);
    expect(schema.marks.revisionAdd.rank).toBeLessThan(schema.marks.revisionDel.rank);
    expect(schema.marks.revisionDel.rank).toBeLessThan(schema.marks.revisionChg.rank);
    expect(schema.marks.revisionChg.rank).toBeLessThan(schema.marks.inlineMark.rank);
    expect(schema.marks.inlineMark.rank).toBeLessThan(schema.marks.bold.rank);
    expect(schema.marks.bold.rank).toBeLessThan(schema.marks.italic.rank);
    expect(schema.marks.italic.rank).toBeLessThan(schema.marks.underline.rank);
  });

  it('revision MarkType rank order is strictly Add < Del < Chg (1g.6 regression)', () => {
    // This pins the issue #87 acceptance criterion: "Mark declaration order
    // regression test asserts revisionAdd.rank < revisionDel.rank <
    // revisionChg.rank." A future refactor that reorders these would change
    // the render nesting for cross-kind overlap and break 1h's assumed
    // dispatchTransaction iteration order.
    expect(schema.marks.revisionAdd.rank).toBeLessThan(schema.marks.revisionDel.rank);
    expect(schema.marks.revisionDel.rank).toBeLessThan(schema.marks.revisionChg.rank);
  });
});

describe('schema revision mark attrs and coexistence', () => {
  it('revisionAdd has authorId/authorColor with null defaults; no `kind` attr (encoded in MarkType)', () => {
    const m = schema.marks.revisionAdd.create();
    expect(m.attrs).toEqual({ authorId: null, authorColor: null });
    const m2 = schema.marks.revisionAdd.create({ authorId: 'alice', authorColor: '#f00' });
    expect(m2.attrs).toEqual({ authorId: 'alice', authorColor: '#f00' });
  });

  it('revisionDel and revisionChg have the same attr shape as revisionAdd', () => {
    const del = schema.marks.revisionDel.create({ authorId: 'bob' });
    expect(del.attrs).toEqual({ authorId: 'bob', authorColor: null });
    const chg = schema.marks.revisionChg.create({ authorColor: '#0f0' });
    expect(chg.attrs).toEqual({ authorId: null, authorColor: '#0f0' });
  });

  it('each revision MarkType declares excludes: "" (allows same-MarkType coexistence with different attrs)', () => {
    // PM's default excludes (unset) is "self-only", which would silently
    // replace Alice's revisionAdd when Bob applies his own. excludes: ''
    // is what lets the multi-author audit trail survive Yjs format-op
    // merge (Q8/Q34 in #47 1h plan).
    expect(schema.marks.revisionAdd.spec.excludes).toBe('');
    expect(schema.marks.revisionDel.spec.excludes).toBe('');
    expect(schema.marks.revisionChg.spec.excludes).toBe('');
  });

  it('cross-MarkType coexistence — revisionAdd and revisionDel can coexist on one character', () => {
    // PM allows different MarkTypes to coexist by default. With the schema
    // split, this is the cross-kind audit-trail case: Bob's insert inside
    // Alice's deletion carries BOTH revisionDel:Alice AND revisionAdd:Bob.
    const add = schema.marks.revisionAdd.create({ authorId: 'B' });
    const del = schema.marks.revisionDel.create({ authorId: 'A' });
    const text = schema.text('x', [add, del]);
    const marksOnText = text.marks;
    expect(marksOnText.some((m) => m.type.name === 'revisionAdd')).toBe(true);
    expect(marksOnText.some((m) => m.type.name === 'revisionDel')).toBe(true);
  });
});

describe('schema mark attrs — non-revision marks unchanged', () => {
  it('comment has id (default empty) and resolved (default false)', () => {
    const m = schema.marks.comment.create();
    expect(m.attrs).toEqual({ id: '', resolved: false });
    const m2 = schema.marks.comment.create({ id: 'c1', resolved: true });
    expect(m2.attrs).toEqual({ id: 'c1', resolved: true });
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
    const mark = schema.marks.inlineMark.create({ kind: 'no-such-kind' });
    const out = mark.type.spec.toDOM(mark);
    expect(out).toEqual(['span', 0]);
  });

  it('known kinds render the class properly', () => {
    const rid = schema.marks.inlineMark.create({ kind: 'rid' });
    expect(rid.type.spec.toDOM(rid)).toEqual(['span', { class: 'mark-rid' }, 0]);
    const tai = schema.marks.inlineMark.create({ kind: 'tai', option: 'ARMY' });
    expect(tai.type.spec.toDOM(tai)).toEqual(['span', { class: 'mark-tai', 'data-opt': 'ARMY' }, 0]);
    const taiPlain = schema.marks.inlineMark.create({ kind: 'tai' });
    expect(taiPlain.type.spec.toDOM(taiPlain)).toEqual(['span', { class: 'mark-tai' }, 0]);
  });
});

describe('revision mark toDOM — emits canonical wrapper per MarkType', () => {
  function elFor(mark) {
    return mark.type.spec.toDOM(mark);
  }

  it('revisionAdd → <ins class="mark-add">', () => {
    const m = schema.marks.revisionAdd.create({ authorId: 'alice', authorColor: '#f00' });
    expect(elFor(m)).toEqual([
      'ins',
      { class: 'mark-add', 'data-author-id': 'alice', style: '--author-color:#f00' },
      0,
    ]);
  });

  it('revisionDel → <del class="mark-del">', () => {
    const m = schema.marks.revisionDel.create({ authorId: 'bob' });
    expect(elFor(m)).toEqual(['del', { class: 'mark-del', 'data-author-id': 'bob' }, 0]);
  });

  it('revisionChg → <span class="mark-chg">', () => {
    const m = schema.marks.revisionChg.create();
    expect(elFor(m)).toEqual(['span', { class: 'mark-chg' }, 0]);
  });

  it('omits data-author-id and style when attrs are null', () => {
    const m = schema.marks.revisionAdd.create();
    expect(elFor(m)).toEqual(['ins', { class: 'mark-add' }, 0]);
  });
});

describe('parseDOM routing — per-MarkType detection', () => {
  function span(cls, extra = {}) {
    const el = { tagName: 'SPAN', getAttribute: (k) => (k === 'class' ? cls : (extra[k] ?? null)) };
    return el;
  }
  function ins(extra = {}) {
    return {
      tagName: 'INS',
      getAttribute: (k) => (k === 'class' ? 'mark-add' : (extra[k] ?? null)),
    };
  }
  function del(extra = {}) {
    return {
      tagName: 'DEL',
      getAttribute: (k) => (k === 'class' ? 'mark-del' : (extra[k] ?? null)),
    };
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
    expect(rule.getAttrs(span('mark-foobar'))).toBe(false);
    expect(rule.getAttrs(span(''))).toBe(false);
  });

  it('revisionAdd.getAttrs matches ins.mark-add, extracts author info', () => {
    const rule = schema.marks.revisionAdd.spec.parseDOM[0];
    expect(rule.tag).toBe('ins.mark-add');
    const attrs = rule.getAttrs(ins({ 'data-author-id': 'alice', 'style': '--author-color:#f00' }));
    expect(attrs).toEqual({ authorId: 'alice', authorColor: '#f00' });
  });

  it('revisionDel.getAttrs matches del.mark-del, extracts author info', () => {
    const rule = schema.marks.revisionDel.spec.parseDOM[0];
    expect(rule.tag).toBe('del.mark-del');
    const attrs = rule.getAttrs(del({ 'data-author-id': 'bob' }));
    expect(attrs).toEqual({ authorId: 'bob', authorColor: null });
  });

  it('revisionChg.getAttrs matches span.mark-chg', () => {
    const rule = schema.marks.revisionChg.spec.parseDOM[0];
    expect(rule.tag).toBe('span.mark-chg');
    const attrs = rule.getAttrs(span('mark-chg'));
    expect(attrs).toEqual({ authorId: null, authorColor: null });
  });
});
