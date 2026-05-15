/**
 * pmdoc-html tests — PM Node / Y.XmlFragment ↔ HTML bidirectional conversion.
 *
 * Mirrors src/lib/__tests__/ytext-html.test.js. The receive direction
 * (pmFragmentToHtml) must produce HTML byte-identical to yTextToHtml for
 * any equivalent input — that's the interop gate (1d). The byte-stability
 * property test on 690 UFGS_M files runs separately as
 * tests/pmdoc-html-byte-stability.node-test.mjs (1c gate per Q30).
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { schema } from '../pm-schema.js';
import { pmFragmentToHtml, htmlToPmFragment } from '../pmdoc-html.js';
import { yTextToHtml, applyHtmlToYText } from '../ytext-html.js';

/** Build a single-paragraph PM doc whose paragraph contains the given inline children. */
function pmDoc(...inlineChildren) {
  return schema.node('doc', null, [schema.node('paragraph', null, inlineChildren)]);
}

const t = (text, ...marks) => schema.text(text, marks);
const m = {
  bold: () => schema.marks.bold.create(),
  italic: () => schema.marks.italic.create(),
  underline: () => schema.marks.underline.create(),
  rid: () => schema.marks.inlineMark.create({ kind: 'rid' }),
  srf: () => schema.marks.inlineMark.create({ kind: 'srf' }),
  tai: (opt) => schema.marks.inlineMark.create({ kind: 'tai', option: opt }),
  hls: () => schema.marks.inlineMark.create({ kind: 'hls' }),
  hl1: () => schema.marks.inlineMark.create({ kind: 'hl1' }),
  comment: (id, resolved = false) => schema.marks.comment.create({ id, resolved }),
  // 1g.6 (#87) — revision is three MarkTypes now. The legacy `kind` arg
  // routes to the right MarkType.
  revision: (kind, authorId = null, authorColor = null) => {
    const typeName = kind === 'add' ? 'revisionAdd' : kind === 'del' ? 'revisionDel' : kind === 'chg' ? 'revisionChg' : null;
    if (!typeName) throw new Error(`unknown revision kind: ${kind}`);
    return schema.marks[typeName].create({ authorId, authorColor });
  },
  // 1g.6 — direct MarkType accessors for tests that need to layer marks
  // (multi-kind cross-author scenarios introduced by the schema split).
  revisionAdd: (authorId = null, authorColor = null) =>
    schema.marks.revisionAdd.create({ authorId, authorColor }),
  revisionDel: (authorId = null, authorColor = null) =>
    schema.marks.revisionDel.create({ authorId, authorColor }),
  revisionChg: (authorId = null, authorColor = null) =>
    schema.marks.revisionChg.create({ authorId, authorColor }),
};

describe('pmFragmentToHtml — PM Node input', () => {
  it.each([
    ['plain text', () => pmDoc(t('Hello world')), 'Hello world'],
    ['bold', () => pmDoc(t('Hello '), t('bold', m.bold()), t(' world')), 'Hello <b>bold</b> world'],
    ['italic', () => pmDoc(t('Hello '), t('italic', m.italic())), 'Hello <i>italic</i>'],
    ['underline', () => pmDoc(t('underlined', m.underline())), '<u>underlined</u>'],
    ['mark-rid', () => pmDoc(t('See '), t('ASTM C33', m.rid()), t(' for details')),
      'See <span class="mark-rid">ASTM C33</span> for details'],
    ['tai mark with option', () => pmDoc(t('tailored text', m.tai('OPTION_A'))),
      '<span class="mark-tai" data-opt="OPTION_A">tailored text</span>'],
    ['mark-hls (Q26 sibling kind)', () => pmDoc(t('highlighted', m.hls())),
      '<span class="mark-hls">highlighted</span>'],
    ['mark-hl1 (Q26 enum)', () => pmDoc(t('h1', m.hl1())),
      '<span class="mark-hl1">h1</span>'],
    ['revision add', () => pmDoc(t('added text', m.revision('add'))),
      '<ins class="mark-add">added text</ins>'],
    ['revision del', () => pmDoc(t('deleted', m.revision('del'))),
      '<del class="mark-del">deleted</del>'],
    ['revision chg', () => pmDoc(t('changed', m.revision('chg'))),
      '<span class="mark-chg">changed</span>'],
    ['revision add with author color', () => pmDoc(t('added', m.revision('add', null, '#ff6b6b'))),
      '<ins class="mark-add" style="--author-color:#ff6b6b">added</ins>'],
    ['revision add with author id and color', () =>
      pmDoc(t('added', m.revision('add', 'alice', '#ff6b6b'))),
      '<ins class="mark-add" data-author-id="alice" style="--author-color:#ff6b6b">added</ins>'],
    ['comment open', () => pmDoc(t('commented', m.comment('comment-123'))),
      '<span class="mark-comment" data-comment-id="comment-123">commented</span>'],
    ['comment resolved', () => pmDoc(t('resolved', m.comment('c1', true))),
      '<span class="mark-comment-resolved" data-comment-id="c1">resolved</span>'],
  ])('converts %s', (_name, build, expected) => {
    expect(pmFragmentToHtml(build())).toBe(expected);
  });

  it('emits stacked marks in canonical layering: comment > revision > inlineMark > format', () => {
    // bold + mark-rid
    expect(pmFragmentToHtml(pmDoc(t('ASTM D2487', m.bold(), m.rid()))))
      .toBe('<span class="mark-rid"><b>ASTM D2487</b></span>');

    // revision + mark + bold
    expect(pmFragmentToHtml(pmDoc(t('new ref', m.bold(), m.rid(), m.revision('add')))))
      .toBe('<ins class="mark-add"><span class="mark-rid"><b>new ref</b></span></ins>');

    // comment outermost
    expect(pmFragmentToHtml(pmDoc(t('cited', m.bold(), m.rid(), m.comment('c1')))))
      .toBe('<span class="mark-comment" data-comment-id="c1"><span class="mark-rid"><b>cited</b></span></span>');
  });

  it('merges adjacent runs with identical attrs', () => {
    const node = pmDoc(t('hello', m.bold()), t(' world', m.bold()));
    expect(pmFragmentToHtml(node)).toBe('<b>hello world</b>');
  });

  it('escapes HTML entities and attribute injection from peers', () => {
    expect(pmFragmentToHtml(pmDoc(t('3 < 5 & 5 > 3'))))
      .toBe('3 &lt; 5 &amp; 5 &gt; 3');

    // revisionAuthorColor injection
    const xss = pmDoc(t('text', m.revision('add', null, 'hsl(0,0%,0%)" onmouseover="alert(1)')));
    const out = pmFragmentToHtml(xss);
    expect(out).toContain('--author-color:hsl(0,0%,0%)&quot; onmouseover=&quot;alert(1)');
    expect(out).not.toMatch(/style="[^"]*"[^"]*onmouseover/);

    // comment id injection
    const cxss = pmDoc(t('text', m.comment('c1" onload="alert(2)')));
    expect(pmFragmentToHtml(cxss))
      .toContain('data-comment-id="c1&quot; onload=&quot;alert(2)"');

    // tai option injection
    const txss = pmDoc(t('text', m.tai('OPT" onfocus="alert(3)')));
    expect(pmFragmentToHtml(txss))
      .toContain('data-opt="OPT&quot; onfocus=&quot;alert(3)"');
  });

  it('emits <br> for hard_break with surrounding marks intact', () => {
    const hb = schema.nodes.hard_break.create();
    // a<br>b plain
    const plain = pmDoc(t('a'), hb, t('b'));
    expect(pmFragmentToHtml(plain)).toBe('a<br>b');
    // bold spanning the break
    const bold = pmDoc(t('a', m.bold()), schema.nodes.hard_break.create(null, null, [m.bold()]), t('b', m.bold()));
    expect(pmFragmentToHtml(bold)).toBe('<b>a<br>b</b>');
  });

  it('returns empty string for null/undefined/unknown input', () => {
    expect(pmFragmentToHtml(null)).toBe('');
    expect(pmFragmentToHtml(undefined)).toBe('');
    expect(pmFragmentToHtml({})).toBe('');
    expect(pmFragmentToHtml('not a node')).toBe('');
  });

  it('returns empty string for empty PM doc', () => {
    const empty = schema.node('doc', null, [schema.node('paragraph')]);
    expect(pmFragmentToHtml(empty)).toBe('');
  });
});

describe('htmlToPmFragment — HTML → PM Node', () => {
  it.each([
    ['plain text', 'Hello'],
    ['bold', 'a<b>B</b>c'],
    ['italic via <i>', '<i>x</i>'],
    ['underline', '<u>x</u>'],
    ['mark-rid', '<span class="mark-rid">ASTM</span>'],
    ['mark-tai with data-opt', '<span class="mark-tai" data-opt="OPT_A">x</span>'],
    ['ins mark-add', '<ins class="mark-add">x</ins>'],
    ['del mark-del', '<del class="mark-del">x</del>'],
    ['span mark-chg', '<span class="mark-chg">x</span>'],
    ['mark-comment', '<span class="mark-comment" data-comment-id="c1">x</span>'],
    ['mark-comment-resolved', '<span class="mark-comment-resolved" data-comment-id="c1">x</span>'],
  ])('round-trips %s through pmFragmentToHtml(htmlToPmFragment(html))', (_name, html) => {
    expect(pmFragmentToHtml(htmlToPmFragment(html))).toBe(html);
  });

  it('normalizes <em> → <i> and <strong> → <b> on first pass (matches yTextToHtml canonicalization)', () => {
    // yTextToHtml emits canonical <i> / <b> tags. parseDOM accepts <em> /
    // <strong> as italic / bold but the receive direction emits the
    // canonical form. The byte-stability test below confirms one
    // normalization pass is the fixed point.
    expect(pmFragmentToHtml(htmlToPmFragment('<em>x</em>'))).toBe('<i>x</i>');
    expect(pmFragmentToHtml(htmlToPmFragment('<strong>x</strong>'))).toBe('<b>x</b>');
  });

  it('round-trips ins with --author-color', () => {
    const html = '<ins class="mark-add" style="--author-color:#ff6b6b">x</ins>';
    expect(pmFragmentToHtml(htmlToPmFragment(html))).toBe(html);
  });

  it('round-trips ins with author id and color', () => {
    const html = '<ins class="mark-add" data-author-id="alice" style="--author-color:#ff6b6b">x</ins>';
    expect(pmFragmentToHtml(htmlToPmFragment(html))).toBe(html);
  });

  it('handles nested marks and stripped tag-label spans, empty input, entities', () => {
    expect(pmFragmentToHtml(htmlToPmFragment('<span class="mark-rid"><b>X</b></span>')))
      .toBe('<span class="mark-rid"><b>X</b></span>');

    // tag-label spans are skipped (no mark applied)
    const taglbl = pmFragmentToHtml(htmlToPmFragment(
      '<span class="tag-label" contenteditable="false">[RID]</span>ASTM'
    ));
    expect(taglbl).toBe('ASTM');

    // empty
    expect(pmFragmentToHtml(htmlToPmFragment(''))).toBe('');

    // entities
    expect(pmFragmentToHtml(htmlToPmFragment('a&amp;b'))).toBe('a&amp;b');
    expect(pmFragmentToHtml(htmlToPmFragment('3 &lt; 5'))).toBe('3 &lt; 5');
  });

  it('round-trips <br> through PM hard_break', () => {
    expect(pmFragmentToHtml(htmlToPmFragment('a<br>b'))).toBe('a<br>b');
    expect(pmFragmentToHtml(htmlToPmFragment('<b>a<br>b</b>'))).toBe('<b>a<br>b</b>');
    expect(pmFragmentToHtml(htmlToPmFragment('<span class="mark-rid">a<br>b</span>')))
      .toBe('<span class="mark-rid">a<br>b</span>');
  });

  it('byte-stability: html → PM → html === html → PM → html → PM → html (idempotent after one normalization pass)', () => {
    // Per Q30: round-trip applied twice is the identity.
    const corpus = [
      'Hello world',
      'Hello <b>bold</b> world',
      '<span class="mark-rid">ASTM C33</span>',
      '<ins class="mark-add" data-author-id="bob" style="--author-color:#aabbcc">added</ins>',
      '<span class="mark-comment" data-comment-id="c1"><span class="mark-rid"><b>x</b></span></span>',
      'a<br>b<br>c',
      '<span class="mark-tai" data-opt="ARMY">army-only text</span>',
    ];
    for (const html of corpus) {
      const pass1 = pmFragmentToHtml(htmlToPmFragment(html));
      const pass2 = pmFragmentToHtml(htmlToPmFragment(pass1));
      expect(pass2).toBe(pass1);
    }
  });
});

describe('byte-equivalence with yTextToHtml', () => {
  // The 1d interop gate: pmFragmentToHtml output must match yTextToHtml
  // output byte-for-byte for any equivalent input. We exercise it by
  // constructing Y.Text and PM Node from the same conceptual content
  // (a delta list), then comparing serializer output.
  //
  // We do NOT seed via applyHtmlToYText / seedYTextFromHtml here: those use
  // `attrs || undefined` on insert, which in Yjs inherits formatting from
  // the previous index. Passing explicit `{}` clears the inherited attrs,
  // which is the helper pattern in ytext-html.test.js.
  function makeYText(deltas) {
    const ydoc = new Y.Doc();
    const yText = ydoc.getText('t');
    ydoc.transact(() => {
      let pos = 0;
      for (const d of deltas) {
        yText.insert(pos, d.insert, d.attributes || {});
        pos += d.insert.length;
      }
    });
    return yText;
  }

  const cases = [
    {
      name: 'plain text',
      yDelta: [{ insert: 'Hello world' }],
      pmInline: () => [t('Hello world')],
    },
    {
      name: 'bold word with surrounding plain',
      yDelta: [
        { insert: 'Hello ' },
        { insert: 'bold', attributes: { bold: true } },
        { insert: ' world' },
      ],
      pmInline: () => [t('Hello '), t('bold', m.bold()), t(' world')],
    },
    {
      name: 'mark-rid with surrounding plain',
      yDelta: [
        { insert: 'See ' },
        { insert: 'ASTM C33', attributes: { mark: 'rid' } },
        { insert: ' for details' },
      ],
      pmInline: () => [t('See '), t('ASTM C33', m.rid()), t(' for details')],
    },
    {
      name: 'tai with option',
      yDelta: [{ insert: 'tailored', attributes: { mark: 'tai', markOption: 'OPTION_A' } }],
      pmInline: () => [t('tailored', m.tai('OPTION_A'))],
    },
    {
      name: 'revision add with author + color',
      yDelta: [{
        insert: 'added',
        attributes: { revision: 'add', revisionAuthor: 'alice', revisionAuthorColor: '#ff6b6b' },
      }],
      pmInline: () => [t('added', m.revision('add', 'alice', '#ff6b6b'))],
    },
    {
      name: 'revision del',
      yDelta: [{ insert: 'deleted', attributes: { revision: 'del' } }],
      pmInline: () => [t('deleted', m.revision('del'))],
    },
    {
      name: 'revision chg',
      yDelta: [{ insert: 'changed', attributes: { revision: 'chg' } }],
      pmInline: () => [t('changed', m.revision('chg'))],
    },
    {
      name: 'comment open',
      yDelta: [{ insert: 'commented', attributes: { comment: 'c1' } }],
      pmInline: () => [t('commented', m.comment('c1'))],
    },
    {
      name: 'comment resolved',
      yDelta: [{ insert: 'resolved', attributes: { comment: 'c1', commentResolved: true } }],
      pmInline: () => [t('resolved', m.comment('c1', true))],
    },
    {
      name: 'stacked: mark + bold',
      yDelta: [{ insert: 'nested', attributes: { mark: 'rid', bold: true } }],
      pmInline: () => [t('nested', m.bold(), m.rid())],
    },
    {
      name: 'underline',
      yDelta: [{ insert: 'underlined', attributes: { underline: true } }],
      pmInline: () => [t('underlined', m.underline())],
    },
  ];

  it.each(cases)('$name', ({ yDelta, pmInline }) => {
    const yText = makeYText(yDelta);
    const pmNode = pmDoc(...pmInline());
    expect(pmFragmentToHtml(pmNode)).toBe(yTextToHtml(yText));
  });

  it('hard_break / <br> is byte-identical', () => {
    // Newlines via Y.Text \n vs PM hard_break.
    const ydoc = new Y.Doc();
    const yText = ydoc.getText('t');
    yText.insert(0, 'a\nb');
    const yHtml = yTextToHtml(yText);

    const hb = schema.nodes.hard_break.create();
    const pmNode = pmDoc(t('a'), hb, t('b'));
    expect(pmFragmentToHtml(pmNode)).toBe(yHtml);
  });
});

describe('Y.XmlFragment input — pmFragmentToHtml duck-types', () => {
  // Build a minimal Y.XmlFragment shape mirroring what y-prosemirror's
  // prosemirrorToYXmlFragment produces. Avoids importing y-prosemirror to
  // keep this test isolated from the dual-package hazard documented in Q22.
  function makeYXml(blocks) {
    const ydoc = new Y.Doc();
    const yXml = ydoc.get('xml', Y.XmlFragment);
    for (const block of blocks) {
      const para = new Y.XmlElement('paragraph');
      for (const child of block) {
        if (child.type === 'text') {
          const yt = new Y.XmlText();
          // Insert with attrs at offset 0; fall back to simple insert when no attrs.
          if (child.attrs) yt.insert(0, child.text, child.attrs);
          else yt.insert(0, child.text);
          para.push([yt]);
        } else if (child.type === 'hard_break') {
          para.push([new Y.XmlElement('hard_break')]);
        }
      }
      yXml.push([para]);
    }
    return yXml;
  }

  it('plain text', () => {
    const yXml = makeYXml([[{ type: 'text', text: 'Hello world' }]]);
    expect(pmFragmentToHtml(yXml)).toBe('Hello world');
  });

  it('bold via marksToAttributes shape ({bold: {}})', () => {
    const yXml = makeYXml([[
      { type: 'text', text: 'plain ' },
      { type: 'text', text: 'bold', attrs: { bold: {} } },
    ]]);
    expect(pmFragmentToHtml(yXml)).toBe('plain <b>bold</b>');
  });

  it('inlineMark with kind in attrs', () => {
    const yXml = makeYXml([[
      { type: 'text', text: 'See ' },
      { type: 'text', text: 'ASTM', attrs: { inlineMark: { kind: 'rid' } } },
    ]]);
    expect(pmFragmentToHtml(yXml)).toBe('See <span class="mark-rid">ASTM</span>');
  });

  it('revisionAdd with author/color (1g.6 per-MarkType key shape)', () => {
    // 1g.6 (#87): y-prosemirror writes Y delta attributes keyed by
    // MarkType name (revisionAdd / revisionDel / revisionChg), not by the
    // legacy `revision` key. The duck-type reader matches the new shape.
    const yXml = makeYXml([[
      { type: 'text', text: 'added',
        attrs: { revisionAdd: { authorId: 'bob', authorColor: '#aabbcc' } } },
    ]]);
    expect(pmFragmentToHtml(yXml))
      .toBe('<ins class="mark-add" data-author-id="bob" style="--author-color:#aabbcc">added</ins>');
  });

  it('revisionDel emits <del class="mark-del">', () => {
    const yXml = makeYXml([[
      { type: 'text', text: 'gone', attrs: { revisionDel: { authorId: 'A' } } },
    ]]);
    expect(pmFragmentToHtml(yXml)).toBe('<del class="mark-del" data-author-id="A">gone</del>');
  });

  it('multi-kind cross-author (1g.6): revisionAdd + revisionDel layer into nested wrappers', () => {
    // The audit-trail correctness case from Q34 — Bob's insert (revisionAdd:B)
    // inside Alice's deletion (revisionDel:A) renders nested. Declared rank
    // is Add < Del, so <ins> wraps <del>.
    const yXml = makeYXml([[
      { type: 'text', text: 'x', attrs: {
        revisionAdd: { authorId: 'B' },
        revisionDel: { authorId: 'A' },
      } },
    ]]);
    expect(pmFragmentToHtml(yXml)).toBe(
      '<ins class="mark-add" data-author-id="B">'
      + '<del class="mark-del" data-author-id="A">x</del>'
      + '</ins>',
    );
  });

  it('legacy `revision` key is silently dropped (post-1g.6 backward-incompat)', () => {
    // Pre-1g.6 rooms stored deltas with the legacy `revision` key. After
    // the schema split, the reader matches only revisionAdd/Del/Chg keys.
    // Unknown keys drop silently (Q31/E6 forward-compat), preserving text.
    // The schemaVersion bump in a future sub-PR (1i) cuts over pre-1g.6
    // rooms; for now the dropout is documented behavior.
    const yXml = makeYXml([[
      { type: 'text', text: 'added',
        attrs: { revision: { kind: 'add', authorId: 'bob' } } },
    ]]);
    expect(pmFragmentToHtml(yXml)).toBe('added');
  });

  it('comment with resolved flag', () => {
    const yXml = makeYXml([[
      { type: 'text', text: 'done',
        attrs: { comment: { id: 'c1', resolved: true } } },
    ]]);
    expect(pmFragmentToHtml(yXml))
      .toBe('<span class="mark-comment-resolved" data-comment-id="c1">done</span>');
  });

  it('hard_break inside paragraph emits <br>', () => {
    const yXml = makeYXml([[
      { type: 'text', text: 'a' },
      { type: 'hard_break' },
      { type: 'text', text: 'b' },
    ]]);
    expect(pmFragmentToHtml(yXml)).toBe('a<br>b');
  });

  it('byte-equivalent to yTextToHtml for the same content', () => {
    const yXml = makeYXml([[
      { type: 'text', text: 'See ' },
      { type: 'text', text: 'ASTM C33', attrs: { inlineMark: { kind: 'rid' } } },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'bold', attrs: { bold: {} } },
    ]]);
    // Build the equivalent Y.Text directly with explicit `{}` attrs for the
    // unmarked runs, to avoid the attr-inheritance footgun in
    // applyHtmlToYText / seedYTextFromHtml (out-of-scope to fix in 1c).
    const ydoc = new Y.Doc();
    const yText = ydoc.getText('t');
    ydoc.transact(() => {
      yText.insert(0, 'See ', {});
      yText.insert(4, 'ASTM C33', { mark: 'rid' });
      yText.insert(12, ' and ', {});
      yText.insert(17, 'bold', { bold: true });
    });
    expect(pmFragmentToHtml(yXml)).toBe(yTextToHtml(yText));
  });
});

describe('adversarial input / Q31/E6 fallback', () => {
  it('unknown inlineMark kind in PM is dropped (text preserved)', () => {
    // Forge a node tree with an unknown kind. inlineMark.create will accept
    // arbitrary kind because the attr has a default; we rely on the
    // serializer dropping it.
    const badMark = schema.marks.inlineMark.create({ kind: 'unknown-kind' });
    const node = pmDoc(t('text', badMark));
    // Serializer drops mark; emits plain text.
    expect(pmFragmentToHtml(node)).toBe('text');
  });

  it('1g.6: revisionAdd with null attrs renders plain wrapper (defaults preserved)', () => {
    // After the schema split, "unknown kind" can't occur at the MarkType
    // level — there are only three known MarkTypes. The closest equivalent
    // is a revisionAdd with no authorId/authorColor; it should still emit
    // the canonical wrapper with no extra attrs.
    const m = schema.marks.revisionAdd.create();
    const node = pmDoc(t('text', m));
    expect(pmFragmentToHtml(node)).toBe('<ins class="mark-add">text</ins>');
  });

  it('Y.XmlFragment with unknown inlineMark.kind drops the mark, keeps text', () => {
    const ydoc = new Y.Doc();
    const yXml = ydoc.get('xml', Y.XmlFragment);
    const para = new Y.XmlElement('paragraph');
    const yt = new Y.XmlText();
    yt.insert(0, 'text', { inlineMark: { kind: 'unknown-kind' } });
    para.push([yt]);
    yXml.push([para]);
    expect(pmFragmentToHtml(yXml)).toBe('text');
  });

  it('Y.XmlFragment with malformed mark attrs (revision missing kind) drops the mark', () => {
    const ydoc = new Y.Doc();
    const yXml = ydoc.get('xml', Y.XmlFragment);
    const para = new Y.XmlElement('paragraph');
    const yt = new Y.XmlText();
    yt.insert(0, 'text', { revision: { not_kind: 'add' } });
    para.push([yt]);
    yXml.push([para]);
    expect(pmFragmentToHtml(yXml)).toBe('text');
  });

  it('Y.XmlFragment with bogus child (no toDelta or nodeName) is skipped without throwing', () => {
    const ydoc = new Y.Doc();
    const yXml = ydoc.get('xml', Y.XmlFragment);
    const para = new Y.XmlElement('paragraph');
    const yt = new Y.XmlText();
    yt.insert(0, 'kept');
    para.push([yt]);
    yXml.push([para]);
    // Synthetic top-level garbage: a fake duck-typed child with a broken toArray.
    const fakeChild = { nodeName: 'unknown', toArray: () => { throw new Error('boom'); } };
    const wrappedYXml = {
      toArray: () => [...yXml.toArray(), fakeChild],
    };
    expect(() => pmFragmentToHtml(wrappedYXml)).not.toThrow();
    expect(pmFragmentToHtml(wrappedYXml)).toBe('kept');
  });

  it('Y.XmlFragment with non-array toArray returns empty without throwing', () => {
    const broken = { toArray: () => null };
    expect(() => pmFragmentToHtml(broken)).not.toThrow();
    expect(pmFragmentToHtml(broken)).toBe('');
  });
});

describe('prosemirrorToYXmlFragment integration (issue #64 regression)', () => {
  // Issue #64 alleged that y-prosemirror's prosemirrorToYXmlFragment drops
  // the `comment` mark during serialization. Empirically false against
  // y-prosemirror 1.3.7: the mark survives the diff-and-merge round-trip
  // in both create and update paths. The actual failure that triggered the
  // issue was a Playwright test using legacy `el.innerHTML` injection in
  // PM mode (PM's domObserver doesn't reliably handle wholesale innerHTML
  // replacement); unrelated to mark-attribute serialization. This test
  // pins the contract so any future regression on y-prosemirror's part is
  // caught at unit-test time.
  it('prosemirrorToYXmlFragment preserves comment mark on update (diff-and-merge)', async () => {
    const { prosemirrorToYXmlFragment } = await import('y-prosemirror');
    const ydoc = new Y.Doc();
    const yXml = ydoc.get('block', Y.XmlFragment);
    // Seed with plain text.
    prosemirrorToYXmlFragment(htmlToPmFragment('the selected text here'), yXml);
    // Add a comment via diff-and-merge (the production setBlockHtml path).
    prosemirrorToYXmlFragment(
      htmlToPmFragment(
        'the <span class="mark-comment" data-comment-id="c-1">selected text</span> here',
      ),
      yXml,
    );
    expect(pmFragmentToHtml(yXml)).toBe(
      'the <span class="mark-comment" data-comment-id="c-1">selected text</span> here',
    );
    // The YXmlText delta should carry the comment as an attribute on the
    // commented run — the substrate-level evidence the issue claimed was missing.
    const para = yXml.toArray()[0];
    const ytext = para.toArray()[0];
    const delta = ytext.toDelta();
    const commented = delta.find((d) => d.attributes?.comment);
    expect(commented).toBeDefined();
    expect(commented.insert).toBe('selected text');
    expect(commented.attributes.comment).toEqual({ id: 'c-1', resolved: false });
  });
});
