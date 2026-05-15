// @vitest-environment jsdom
//
// pm-del-popup.test.js — sub-PR 1g.5 (issue #86) regression tests.
//
// The 1f.8 path was an HTML-string mutator (applyDelAction(html, delIndex,
// action)) operating on a serialized snapshot. The 1g.5 path is a PM-
// transaction dispatcher: it resolves the click target via view.posAtDOM,
// then delegates to applyInlineRevisionResolveTr (already covered by
// pm-toolbar-verbs.test.js for the inner range / mark-strip / range-delete
// logic). What THIS file pins:
//
//   1. Position resolution via posAtDOM — the click target is mapped to a
//      PM doc position, not a DOM-index against a serialized HTML string.
//   2. Adjacent same-author marks are NOT conflated — clicking one resolves
//      only that one, not its neighbor.
//   3. Adjacent different-authorId marks (PM treats them as separate Mark
//      instances) are correctly distinguished by position.
//   4. Idempotent re-accept returns null (the mark is already gone, so
//      findMarkRangeAt returns null inside applyInlineRevisionResolveTr).
//   5. setBlockHtml is NEVER called from this module — grep invariant
//      pinned by import-shape check.
//   6. Defensive guards: bad action, detached element, missing view.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { schema } from '../pm-schema.js';
import { dispatchDelAction } from '../pm-del-popup.js';

let root;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  root?.remove();
});

// Build a doc with up to four text segments around two configurable del
// marks. Mark instances are separate when authorIds differ — and post-1g.6
// (#87) the revisionDel MarkType declares `excludes: ''`, so two
// revisionDel instances with different attrs can also coexist on the same
// character. For the test corpus here, the dels are placed on disjoint
// adjacent text segments, so they render as adjacent separate <del>
// elements regardless.
function docWithDels({ author1 = 'A', author2 = 'A' } = {}) {
  const del1 = schema.marks.revisionDel.create({ authorId: author1, authorColor: null });
  const del2 = schema.marks.revisionDel.create({ authorId: author2, authorColor: null });
  return schema.node('doc', null, [
    schema.node('paragraph', null, [
      schema.text('before '),
      schema.text('first', [del1]),
      schema.text(' mid '),
      schema.text('second', [del2]),
      schema.text(' after'),
    ]),
  ]);
}

function mountView(doc) {
  const state = EditorState.create({ doc, schema });
  return new EditorView(root, { state });
}

describe('dispatchDelAction — sub-PR 1g.5 (#86)', () => {
  it('accept removes the clicked del; adjacent same-author del survives', () => {
    const view = mountView(docWithDels({ author1: 'A', author2: 'A' }));
    const dels = view.dom.querySelectorAll('del.mark-del');
    expect(dels.length).toBe(2);

    const tr = dispatchDelAction(view, dels[0], 'accept');
    expect(tr).not.toBeNull();
    expect(tr.docChanged).toBe(true);
    // 'first' text is gone, 'second' stays
    expect(view.state.doc.textContent).toBe('before  mid second after');
    // Surviving del still has the right author
    const survivingDels = view.dom.querySelectorAll('del.mark-del');
    expect(survivingDels.length).toBe(1);
    expect(survivingDels[0].textContent).toBe('second');

    view.destroy();
  });

  it('reject strips the mark on the clicked del; adjacent same-author del survives', () => {
    const view = mountView(docWithDels({ author1: 'A', author2: 'A' }));
    const dels = view.dom.querySelectorAll('del.mark-del');

    const tr = dispatchDelAction(view, dels[0], 'reject');
    expect(tr).not.toBeNull();
    // Text content unchanged (reject keeps the content, strips the mark)
    expect(view.state.doc.textContent).toBe('before first mid second after');
    // Only one del remains — the second one
    const survivingDels = view.dom.querySelectorAll('del.mark-del');
    expect(survivingDels.length).toBe(1);
    expect(survivingDels[0].textContent).toBe('second');

    view.destroy();
  });

  it('adjacent different-authorId dels are independently resolvable (multi-author audit trail)', () => {
    // PM treats marks with different authorIds as different Mark instances.
    // findMarkRangeAt expands by m.eq(targetMark), so the expansion stops
    // at the boundary between A's del and B's del — the resolution targets
    // only the clicked author's del, leaving the other intact.
    const view = mountView(docWithDels({ author1: 'A', author2: 'B' }));
    const dels = view.dom.querySelectorAll('del.mark-del');
    expect(dels.length).toBe(2);

    // Click B's del; A's del must survive
    const tr = dispatchDelAction(view, dels[1], 'accept');
    expect(tr).not.toBeNull();
    expect(view.state.doc.textContent).toBe('before first mid  after');
    const survivingDels = view.dom.querySelectorAll('del.mark-del');
    expect(survivingDels.length).toBe(1);
    expect(survivingDels[0].textContent).toBe('first');
    expect(survivingDels[0].getAttribute('data-author-id')).toBe('A');

    view.destroy();
  });

  it('multi-author overlap: rejecting A leaves B intact', () => {
    const view = mountView(docWithDels({ author1: 'A', author2: 'B' }));
    const dels = view.dom.querySelectorAll('del.mark-del');

    const tr = dispatchDelAction(view, dels[0], 'reject');
    expect(tr).not.toBeNull();
    // 'first' restored (mark stripped), 'second' still marked
    expect(view.state.doc.textContent).toBe('before first mid second after');
    const survivingDels = view.dom.querySelectorAll('del.mark-del');
    expect(survivingDels.length).toBe(1);
    expect(survivingDels[0].textContent).toBe('second');
    expect(survivingDels[0].getAttribute('data-author-id')).toBe('B');

    view.destroy();
  });

  it('returns null when the del element has been detached (peer-edit race)', () => {
    // Scenario: popup opens on a del, then a peer's edit removes that del
    // from the doc before the local user clicks accept. PmEditableBlock
    // also guards via delPopup.el.isConnected, and dispatchDelAction's
    // own view.dom.contains check is the defense in depth. PM may reuse
    // DOM nodes across diffs (a removed mark's element can be repurposed
    // to wrap surviving text), so the realistic idempotency scenario is
    // an explicit detachment, not a second call on the same element.
    const view = mountView(docWithDels({ author1: 'A', author2: 'A' }));
    const dels = view.dom.querySelectorAll('del.mark-del');
    const target = dels[0];
    target.remove();

    const tr = dispatchDelAction(view, target, 'accept');
    expect(tr).toBeNull();

    view.destroy();
  });

  it('returns null for an unknown action', () => {
    const view = mountView(docWithDels());
    const dels = view.dom.querySelectorAll('del.mark-del');
    expect(dispatchDelAction(view, dels[0], 'bogus')).toBeNull();
    // Doc unchanged
    expect(view.dom.querySelectorAll('del.mark-del').length).toBe(2);
    view.destroy();
  });

  it('returns null for missing view or delEl, or for a detached element', () => {
    expect(dispatchDelAction(null, document.createElement('del'), 'accept')).toBeNull();
    const view = mountView(docWithDels());
    expect(dispatchDelAction(view, null, 'accept')).toBeNull();
    // An element not inside view.dom — peer-edit-removed-the-del race
    const orphan = document.createElement('del');
    orphan.className = 'mark-del';
    orphan.textContent = 'gone';
    expect(dispatchDelAction(view, orphan, 'accept')).toBeNull();
    view.destroy();
  });

  it('multi-author overlap: clicking the <del> resolves Alice\'s revisionDel even when Bob\'s revisionAdd overlaps', () => {
    // The 1g.6 + 1g.5 composition case. Alice has marked "shared" with
    // revisionDel; Bob's revisionAdd covers the same range (S3 from
    // pm-tc-merge-semantics). Both marks coexist on the same character
    // (excludes: '' on both MarkTypes). The user clicks Alice's <del>
    // popup. Without kindHint, applyInlineRevisionResolveTr would try
    // revisionAdd → revisionDel → revisionChg in declared rank order and
    // resolve Bob's ADD first (silently wrong — strips the wrong author's
    // mark). With kindHint: 'del' (1g.5/#86), the resolver targets Alice's
    // DEL as the user intended.
    const add = schema.marks.revisionAdd.create({ authorId: 'B', authorColor: null });
    const del = schema.marks.revisionDel.create({ authorId: 'A', authorColor: null });
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [
        schema.text('xx'),
        schema.text('shared', [add, del]),
        schema.text('yy'),
      ]),
    ]);
    const view = mountView(doc);
    const delEl = view.dom.querySelector('del.mark-del');
    expect(delEl).not.toBeNull();

    // Accept Alice's DEL → range deleted, Bob's ADD on that range is also
    // gone (range no longer exists). Surrounding text 'xx' + 'yy' survives.
    // Crucially: Bob's revisionAdd was NOT resolved by stripping the mark
    // on a surviving range — the resolution targeted the del, not the add.
    const tr = dispatchDelAction(view, delEl, 'accept');
    expect(tr).not.toBeNull();
    expect(view.state.doc.textContent).toBe('xxyy');
    // No <ins> survives — the marked range was deleted entirely, so the
    // revisionAdd is gone along with it. This proves the action took the
    // DEL-accept path (delete range), not the ADD-accept path (strip
    // mark, keep content). If ADD-accept had run, textContent would be
    // 'xxsharedyy' with one del mark still present.
    expect(view.dom.querySelectorAll('ins.mark-add').length).toBe(0);
    expect(view.dom.querySelectorAll('del.mark-del').length).toBe(0);

    view.destroy();
  });

  it('handleClick uses the clicked element as the target, not a DOM-order index', () => {
    // The 1f.8 path identified the del by querySelector('del.mark-del').indexOf —
    // this pinned a regression where a peer's insertion of a new del before
    // the clicked one shifted the index and the wrong del got resolved.
    // The new path uses the captured DOM reference directly through
    // view.posAtDOM, so identity tracks the element across structural shifts.
    const view = mountView(docWithDels({ author1: 'A', author2: 'A' }));
    const dels = view.dom.querySelectorAll('del.mark-del');
    const secondDel = dels[1];

    const tr = dispatchDelAction(view, secondDel, 'accept');
    expect(tr).not.toBeNull();
    expect(view.state.doc.textContent).toBe('before first mid  after');
    const surviving = view.dom.querySelectorAll('del.mark-del');
    expect(surviving.length).toBe(1);
    expect(surviving[0].textContent).toBe('first');

    view.destroy();
  });
});

describe('pm-del-popup grep invariants', () => {
  it('module does not import or call setBlockHtml (code, not comments)', () => {
    // Acceptance criterion: "No setBlockHtml call from the del-popup path
    // (grep-able invariant)." This test fails if a future refactor
    // reintroduces the snapshot-shaped write that 1g.5 removed. The check
    // strips comments first — the module's docstring mentions the legacy
    // setBlockHtml path for context, and that mention is allowed.
    const filePath = resolve(dirname(fileURLToPath(import.meta.url)), '../pm-del-popup.js');
    const src = readFileSync(filePath, 'utf8');
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, '')  // /* ... */ blocks (including docstrings)
      .replace(/\/\/.*$/gm, '');          // // line comments
    expect(codeOnly.includes('setBlockHtml')).toBe(false);
    expect(codeOnly.includes('block-html-store')).toBe(false);
  });
});
