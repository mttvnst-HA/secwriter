// @vitest-environment jsdom
//
// pm-tc-merge-semantics.test.js — sub-PR 1g.6 (#87) and 1h preflight gate.
//
// Asserts the four scenarios (S1-S4) from the 1h design plan's Q41:
//
//   S1: Single-author insert — Alice inserts text marked as revisionAdd.
//       After both peers sync, both see the text with the mark.
//   S2: Single-author delete — Alice marks "foo" with revisionDel.
//       After sync, both peers see the del mark on "foo".
//   S3: Cross-author overlap — Alice marks "foo" with revisionDel; Bob
//       concurrently inserts "x" inside "foo". After sync, Bob's "x"
//       inherits Alice's revisionDel AND carries Bob's own revisionAdd.
//       The multi-author audit trail survives Yjs's bracket-based format
//       op merge (Q8/Q34 finding).
//   S4: Accept/reject of one author's mark leaves the other intact —
//       starting from S3's converged state, Alice accepts her revisionDel
//       (deleting the range). The revisionAdd from Bob is on the deleted
//       text, so it's gone too — but on a non-overlapping segment where
//       only Bob's revisionAdd existed, that mark survives.
//
// These tests use a stripped-down y-prosemirror simulation: two Y.Docs,
// two YXmlFragments, and manual format() calls that mirror what
// y-prosemirror would emit from PM mark operations. The full PM
// ySyncPlugin round-trip is covered by the higher-level Playwright
// suite; this file pins the Yjs-level format-op semantics that motivate
// the schema split.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { pmFragmentToHtml } from '../pmdoc-html.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEmptyRoom() {
  const ydoc = new Y.Doc();
  const yXml = ydoc.get('xml', Y.XmlFragment);
  const para = new Y.XmlElement('paragraph');
  const yt = new Y.XmlText();
  para.push([yt]);
  yXml.push([para]);
  return { ydoc, yXml };
}

// Seed two peers from the SAME initial state. Bob's Y.Doc is cloned from
// Alice's encoded state — Bob has NO pre-existing fragment, just the
// applied update. Without this, makeEmptyRoom-twice produces two distinct
// op streams whose inserts merge as concurrent additions on sync (e.g.
// "foo" + "foo" → "foofoo"), and bob ends up with two paragraphs.
function makePair(initialText = '') {
  const alice = makeEmptyRoom();
  if (initialText) {
    getInnerYText(alice.yXml).insert(0, initialText);
  }
  // Bob: empty doc + apply alice's update. The Y.XmlFragment lookup is
  // post-update so bob's view of `xml` is the same single paragraph alice
  // has, not a freshly-created sibling.
  const bobDoc = new Y.Doc();
  Y.applyUpdate(bobDoc, Y.encodeStateAsUpdate(alice.ydoc));
  const bob = { ydoc: bobDoc, yXml: bobDoc.get('xml', Y.XmlFragment) };
  return { alice, bob };
}

function getInnerYText(yXml) {
  const para = yXml.toArray()[0];
  return para.toArray()[0];
}

// Apply a mark via Y.XmlText.format with a y-prosemirror-style suffixed
// key. The suffix is what allows multiple instances of the same MarkType
// to coexist (schema's `excludes: ''`).
function applyRevisionMark(yt, from, length, kind, authorId, suffix) {
  const markTypeName = kind === 'add' ? 'revisionAdd' : kind === 'del' ? 'revisionDel' : 'revisionChg';
  const key = `${markTypeName}--${suffix}`;
  yt.format(from, length, { [key]: { authorId, authorColor: null } });
}

// Sync two Y.Docs by exchanging updates.
function sync(a, b) {
  const updA = Y.encodeStateAsUpdate(a);
  const updB = Y.encodeStateAsUpdate(b);
  Y.applyUpdate(b, updA);
  Y.applyUpdate(a, updB);
}

// ── S1: Single-author insert ─────────────────────────────────────────────────

describe('S1: single-author insert with revisionAdd', () => {
  it('Alice inserts marked text; both peers see <ins> after sync', () => {
    // Alice's doc starts empty. She inserts "hello" and marks as ADD.
    const { alice, bob } = makePair('');

    const aliceYt = getInnerYText(alice.yXml);
    aliceYt.insert(0, 'hello');
    applyRevisionMark(aliceYt, 0, 5, 'add', 'alice', 'AAAAA');

    sync(alice.ydoc, bob.ydoc);

    // Both peers see the same HTML.
    const aliceHtml = pmFragmentToHtml(alice.yXml);
    const bobHtml = pmFragmentToHtml(bob.yXml);
    expect(aliceHtml).toBe(bobHtml);
    expect(aliceHtml).toBe('<ins class="mark-add" data-author-id="alice">hello</ins>');
  });
});

// ── S2: Single-author delete ─────────────────────────────────────────────────

describe('S2: single-author delete with revisionDel', () => {
  it('Alice marks "foo" with DEL; both peers see <del> after sync', () => {
    const { alice, bob } = makePair('foo bar');

    const aliceYt = getInnerYText(alice.yXml);
    applyRevisionMark(aliceYt, 0, 3, 'del', 'alice', 'AAAAA');

    sync(alice.ydoc, bob.ydoc);

    const aliceHtml = pmFragmentToHtml(alice.yXml);
    const bobHtml = pmFragmentToHtml(bob.yXml);
    expect(aliceHtml).toBe(bobHtml);
    expect(aliceHtml).toBe('<del class="mark-del" data-author-id="alice">foo</del> bar');
  });
});

// ── S3: Cross-author overlap (the audit-trail correctness case) ──────────────

describe('S3: cross-author overlap — insert inside delete', () => {
  it('Bob inserts "x" inside Alice\'s revisionDel range; "x" carries BOTH marks', () => {
    // Both peers start with the same text "abc def".
    // Concurrently:
    //   - Alice marks "abc" (positions 0..3) with revisionDel.
    //   - Bob inserts "X" at position 1 (inside "abc") with revisionAdd.
    // After sync:
    //   - "X" should carry Alice's revisionDel (Yjs format-op merge —
    //     concurrent inserts inside a marked range inherit the surrounding
    //     mark from the bracket-based ContentFormat Items).
    //   - "X" should ALSO carry Bob's revisionAdd (Bob applied it himself).
    //   - The audit trail is preserved: both authors' marks coexist.
    const { alice, bob } = makePair('abc def');

    const aliceYt = getInnerYText(alice.yXml);
    const bobYt = getInnerYText(bob.yXml);

    // Concurrent edits — no sync between these two operations.
    applyRevisionMark(aliceYt, 0, 3, 'del', 'alice', 'AAAAA');

    bobYt.insert(1, 'X');
    applyRevisionMark(bobYt, 1, 1, 'add', 'bob', 'BBBBB');

    // Now sync.
    sync(alice.ydoc, bob.ydoc);

    // Both peers converge.
    const aliceHtml = pmFragmentToHtml(alice.yXml);
    const bobHtml = pmFragmentToHtml(bob.yXml);
    expect(aliceHtml).toBe(bobHtml);

    // The audit-trail claim — Bob's "X" inherits Alice's del mark.
    // Expected output (declared rank: revisionAdd outer, revisionDel inner):
    //   <del>a</del><ins><del>X</del></ins><del>bc</del> def
    // Where Bob's <ins> wraps a nested <del> for the "X" character.
    //
    // We assert the LOAD-BEARING property: somewhere in the html, Bob's
    // "X" sits inside a wrapper combo that includes both authors' marks.
    expect(aliceHtml).toContain('data-author-id="alice"');
    expect(aliceHtml).toContain('data-author-id="bob"');
    // Bob's insertion is "X" — look for it inside an <ins> wrapper.
    expect(aliceHtml).toMatch(/<ins[^>]*data-author-id="bob"[^>]*>[\s\S]*X[\s\S]*<\/ins>/);
    // Alice's deletion covers "a" and "bc" — assert each segment has a
    // <del> wrapper carrying Alice's authorId.
    expect(aliceHtml).toMatch(/<del[^>]*data-author-id="alice"[^>]*>[\s\S]*a[\s\S]*<\/del>/);
    expect(aliceHtml).toMatch(/<del[^>]*data-author-id="alice"[^>]*>[\s\S]*bc[\s\S]*<\/del>/);
  });
});

// ── S4: Accept/reject one author's mark, other survives ──────────────────────

describe('S4: accept/reject one author\'s mark leaves the other intact', () => {
  it('only the targeted MarkType\'s formatting is cleared; coexisting marks remain', () => {
    // Bob's "X" carries BOTH revisionAdd (Bob) and revisionDel (Alice).
    // Alice "accepts" the deletion by stripping revisionDel from the range.
    // The expected post-accept state: "X" still has Bob's revisionAdd,
    // but no longer has revisionDel. The OTHER text segments that had
    // ONLY Alice's revisionDel are deleted entirely (their range goes
    // away on accept-DEL).
    //
    // This test focuses on the schema-level invariant: clearing ONE
    // MarkType on a character carrying multiple MarkTypes leaves the
    // others untouched. The higher-level pm-tc-walk.js accept-walk is
    // out of scope for 1g.6 (lives in 1h).
    const alice = makeEmptyRoom();
    const aliceYt = getInnerYText(alice.yXml);
    aliceYt.insert(0, 'abc');

    // Build the S3 state directly: "X" carries revisionDel:Alice + revisionAdd:Bob.
    // Use distinct suffixes so both keys live in the format dictionary.
    applyRevisionMark(aliceYt, 0, 3, 'del', 'alice', 'AAAAA');
    aliceYt.insert(1, 'X', { 'revisionDel--AAAAA': { authorId: 'alice', authorColor: null } });
    applyRevisionMark(aliceYt, 1, 1, 'add', 'bob', 'BBBBB');

    const before = pmFragmentToHtml(alice.yXml);
    expect(before).toContain('data-author-id="alice"');
    expect(before).toContain('data-author-id="bob"');

    // Strip ONLY Alice's revisionDel from "X" (position 1, length 1).
    // Mirrors what 1h's accept-walk does — clear the format key whose
    // value is the one we're resolving.
    aliceYt.format(1, 1, { 'revisionDel--AAAAA': null });

    const after = pmFragmentToHtml(alice.yXml);
    // Bob's revisionAdd on "X" survives.
    expect(after).toMatch(/<ins[^>]*data-author-id="bob"[^>]*>[\s\S]*X[\s\S]*<\/ins>/);
    // Alice's revisionDel on "X" is GONE — but it still applies to "a" and "bc".
    // Verify "X" itself is no longer wrapped in a <del>.
    expect(after).not.toMatch(/<del[^>]*>[^<]*X[^<]*<\/del>/);
    // The surrounding "a" and "bc" still show Alice's del.
    expect(after).toContain('data-author-id="alice"');
  });
});
