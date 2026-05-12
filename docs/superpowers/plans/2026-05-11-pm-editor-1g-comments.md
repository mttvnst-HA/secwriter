# PM Editor 1g — Comments via PM Mark + Decoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate editable-block comments from the DOM-span-plus-metadata pattern to a PM-native pattern (existing `comment` schema mark for storage, new `activeCommentPlugin` for active-highlight decoration, substrate-side reconcile via PM transactions under a `COMMENT_RECONCILE_META` sentinel). Ref/table blocks and legacy mode unchanged.

**Architecture:** Two new modules (`active-comment.js` plugin, `pm-comments.js` reconcile verb). PmEditableBlock registers the plugin and dispatches reconcile transactions from a per-block effect on `commentsState`. App passes `commentsState` as a prop and wires `setActiveComment` against the correct view via `block-registry`. CommentPopup's imperative `setAttribute` becomes mode-conditional; CSS gains `.mark-comment-active` rules alongside the existing `[data-active="true"]` attribute selector.

**Tech Stack:** ProseMirror (prosemirror-state, prosemirror-view, prosemirror-model), y-prosemirror (`ySyncPlugin`, `ySyncPluginKey`), Yjs (Y.XmlFragment, Y.Map), React (useEffect, useRef, useMemo), Vitest, Playwright.

**Spec reference:** [docs/superpowers/specs/2026-05-11-pm-editor-1g-comments-design.md](../specs/2026-05-11-pm-editor-1g-comments-design.md).

---

## Task 0: Baseline verification

**Files:** none — verification only.

- [ ] **Step 0.1: Confirm baseline tests pass**

Run: `npm test -- --run`
Expected: all tests pass (the 4 `setblockhtml-echo-behavior.test.js` tests included).

- [ ] **Step 0.2: Confirm Playwright projects pass**

Run: `npm run test:e2e -- --grep "FloatingToolbar"` (a small subset is enough)
Expected: zero failures under both `chromium-legacy` and `chromium` projects.

- [ ] **Step 0.3: Note any pre-existing failures**

If any baseline test fails, **stop**. Either the working tree is dirty or the assumed starting point is wrong. Resolve before proceeding.

---

## Task 1: Add `shouldSkip` predicate to `cm.reconcileBlocks`

**Files:**
- Modify: `src/lib/comments.js` (`reconcileBlocks` function, lines 211-247)
- Test: `src/lib/__tests__/comments.test.js`

- [ ] **Step 1.1: Add a failing test for shouldSkip**

Append to `src/lib/__tests__/comments.test.js`:

```js
describe('reconcileBlocks shouldSkip predicate', () => {
  it('skips blocks for which shouldSkip returns true (leaves their html untouched)', () => {
    // Block b1 has an orphan mark-comment span; with default shouldSkip the
    // span would be unwrapped. With shouldSkip returning true for b1, the
    // verb must return the same `blocks` reference (no work done).
    const blocks = [
      { id: 'b1', type: 'txt', html: '<p>before <span class="mark-comment" data-comment-id="dead">orphan</span> after</p>' },
      { id: 'b2', type: 'txt', html: '<p>plain text</p>' },
    ];
    const state = comments.createInitial(); // empty byId — everything is orphaned
    const result = comments.reconcileBlocks(blocks, state, {
      shouldSkip: (id) => id === 'b1',
    });
    // b1 untouched
    expect(result).toBe(blocks); // identity preserved when no real changes
  });

  it('respects shouldSkip on a per-block basis (b2 reconciled, b1 skipped)', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: '<p><span class="mark-comment" data-comment-id="dead">x</span></p>' },
      { id: 'b2', type: 'txt', html: '<p><span class="mark-comment" data-comment-id="dead">y</span></p>' },
    ];
    const state = comments.createInitial();
    const result = comments.reconcileBlocks(blocks, state, {
      shouldSkip: (id) => id === 'b1',
    });
    expect(result).not.toBe(blocks); // b2 changed; new array returned
    const b1 = result.find((b) => b.id === 'b1');
    const b2 = result.find((b) => b.id === 'b2');
    expect(b1.html).toBe(blocks[0].html); // b1 untouched
    expect(b2.html).not.toContain('mark-comment'); // b2 orphan unwrapped
  });

  it('omitting shouldSkip preserves backward-compat (all blocks reconciled)', () => {
    const blocks = [
      { id: 'b1', type: 'txt', html: '<p><span class="mark-comment" data-comment-id="dead">x</span></p>' },
    ];
    const state = comments.createInitial();
    const result = comments.reconcileBlocks(blocks, state); // no opts arg
    expect(result[0].html).not.toContain('mark-comment');
  });
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/comments.test.js -t shouldSkip`
Expected: 3 failing tests, error like "reconcileBlocks is not a function with the expected signature" or "Cannot read properties of undefined (reading 'shouldSkip')".

- [ ] **Step 1.3: Modify `reconcileBlocks` to accept the predicate**

Open `src/lib/comments.js`. The current signature is `export function reconcileBlocks(blocks, state)`. Change to:

```js
export function reconcileBlocks(blocks, state, { shouldSkip = () => false } = {}) {
  if (typeof document === 'undefined') return blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) return blocks;
  let anyChanged = false;
  const next = blocks.map((b) => {
    if (shouldSkip(b.id)) return b;
    if (!b || typeof b.html !== 'string' || !b.html.includes('mark-comment')) return b;
    // ... rest of existing body unchanged ...
```

The single new line is `if (shouldSkip(b.id)) return b;` inserted at the top of the map callback. No other changes.

- [ ] **Step 1.4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/comments.test.js -t shouldSkip`
Expected: all 3 tests pass.

- [ ] **Step 1.5: Run the full file to verify no regression in pre-existing tests**

Run: `npx vitest run src/lib/__tests__/comments.test.js`
Expected: all tests pass (including pre-existing reconcileBlocks tests).

- [ ] **Step 1.6: Commit**

```bash
git add src/lib/comments.js src/lib/__tests__/comments.test.js
git commit -m "feat(comments): add shouldSkip predicate to reconcileBlocks (#47 1g)"
```

---

## Task 2: Create `pm-comments.js` verb skeleton + idempotency

**Files:**
- Create: `src/lib/pm-comments.js`
- Create: `src/lib/__tests__/pm-comments.test.js`

- [ ] **Step 2.1: Write failing test for "doc matches state → null tr"**

Create `src/lib/__tests__/pm-comments.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { EditorState } from 'prosemirror-state';

import { schema } from '../pm-schema.js';
import { htmlToPmFragment } from '../pmdoc-html.js';
import { reconcileCommentMarks, COMMENT_RECONCILE_META } from '../pm-comments.js';

function stateFromHtml(html) {
  // Create a PM EditorState by parsing html via the schema. Mirrors the test
  // shape in pm-toolbar-verbs.test.js (no view mount required).
  const doc = htmlToPmFragment(html);
  return EditorState.create({ schema, doc });
}

function commentsState(comments) {
  const byId = new Map();
  for (const c of comments) byId.set(c.id, c);
  return { byId, seenRemoteIds: new Set() };
}

describe('reconcileCommentMarks — idempotency', () => {
  it('returns null when the doc has no comment marks and state is empty', () => {
    const state = stateFromHtml('<p>plain text</p>');
    const tr = reconcileCommentMarks(state, commentsState([]));
    expect(tr).toBeNull();
  });

  it('returns null when the doc and state already agree', () => {
    const state = stateFromHtml('<p><span class="mark-comment" data-comment-id="c1">x</span></p>');
    const tr = reconcileCommentMarks(state, commentsState([
      { id: 'c1', blockId: 'b1', status: 'open' },
    ]));
    expect(tr).toBeNull();
  });
});
```

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `npx vitest run src/lib/__tests__/pm-comments.test.js`
Expected: failure — module doesn't exist yet.

- [ ] **Step 2.3: Create skeleton `pm-comments.js`**

Create `src/lib/pm-comments.js`:

```js
/**
 * pm-comments.js — Substrate-side comment reconciliation (sub-PR 1g, issue #47).
 *
 * `reconcileCommentMarks` is a pure verb that compares PM `comment` marks
 * in `state.doc` against the canonical `commentsState.byId`. For each
 * disagreement it builds a transaction that either removes the mark
 * (orphan: id ∉ byId) or removes + re-adds with corrected `resolved` attr
 * (status flip). Returns null when the doc already agrees with state — so
 * receiving peers (whose substrate is already correct via the originator's
 * ySyncPlugin op) dispatch no work.
 *
 * The returned tr is tagged with `COMMENT_RECONCILE_META`. PmEditableBlock's
 * `dispatchTransaction` reads this meta and skips both the synthesized
 * 'input' event (no linter re-run for mark-only changes) and the `onUpdate`
 * debounce (no setBlockHtml echo via the 'local-publish' origin — see
 * `src/lib/__tests__/setblockhtml-echo-behavior.test.js` for the empirical
 * basis of that gate).
 *
 * Walks text nodes end → start so each tr.removeMark/addMark doesn't shift
 * positions of unprocessed ranges. Uses mark INSTANCE (not markType) in
 * removeMark so adjacent comment marks with different ids are preserved.
 */

// Sentinel object exported from this module. Identity-compared in
// PmEditableBlock's dispatchTransaction via tr.getMeta(COMMENT_RECONCILE_META).
export const COMMENT_RECONCILE_META = {};

export function reconcileCommentMarks(state, commentsState) {
  const commentMarkType = state.schema.marks.comment;
  if (!commentMarkType) return null;
  const byId = commentsState?.byId;
  if (!(byId instanceof Map)) return null;

  // Collect ranges first so iteration uses indices that survive splicing.
  const ranges = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type !== commentMarkType) continue;
      ranges.push({ from: pos, to: pos + node.nodeSize, mark: m });
    }
    return true;
  });

  let tr = state.tr;
  let dirty = false;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const { from, to, mark } = ranges[i];
    const comment = byId.get(mark.attrs.id);
    if (!comment) {
      tr = tr.removeMark(from, to, mark);
      dirty = true;
      continue;
    }
    const wantResolved = comment.status === 'resolved';
    if (mark.attrs.resolved !== wantResolved) {
      tr = tr
        .removeMark(from, to, mark)
        .addMark(from, to, commentMarkType.create({ id: mark.attrs.id, resolved: wantResolved }));
      dirty = true;
    }
  }

  if (!dirty) return null;
  return tr.setMeta(COMMENT_RECONCILE_META, true);
}
```

- [ ] **Step 2.4: Run the test to verify it passes**

Run: `npx vitest run src/lib/__tests__/pm-comments.test.js`
Expected: 2 tests pass.

- [ ] **Step 2.5: Commit**

```bash
git add src/lib/pm-comments.js src/lib/__tests__/pm-comments.test.js
git commit -m "feat(pm-editor): pm-comments.js verb skeleton with idempotency (#47 1g)"
```

---

## Task 3: Verb — orphan removal

**Files:**
- Test: `src/lib/__tests__/pm-comments.test.js`

- [ ] **Step 3.1: Append failing tests for orphan removal**

```js
describe('reconcileCommentMarks — orphan removal', () => {
  it('removes a mark whose id is not in byId', () => {
    const state = stateFromHtml('<p>before <span class="mark-comment" data-comment-id="dead">x</span> after</p>');
    const tr = reconcileCommentMarks(state, commentsState([]));
    expect(tr).not.toBeNull();
    const newDoc = state.apply(tr).doc;
    const commentMarkType = schema.marks.comment;
    let foundComment = false;
    newDoc.descendants((node) => {
      if (node.isText && node.marks.some((m) => m.type === commentMarkType)) {
        foundComment = true;
      }
      return true;
    });
    expect(foundComment).toBe(false);
  });

  it('preserves adjacent comment marks with DIFFERENT ids when one is orphan', () => {
    const state = stateFromHtml(
      '<p><span class="mark-comment" data-comment-id="keep">A</span><span class="mark-comment" data-comment-id="dead">B</span></p>',
    );
    const tr = reconcileCommentMarks(state, commentsState([
      { id: 'keep', blockId: 'b1', status: 'open' },
    ]));
    expect(tr).not.toBeNull();
    const newDoc = state.apply(tr).doc;
    const commentMarkType = schema.marks.comment;
    const surviving = [];
    newDoc.descendants((node) => {
      if (!node.isText) return true;
      for (const m of node.marks) {
        if (m.type === commentMarkType) surviving.push(m.attrs.id);
      }
      return true;
    });
    expect(surviving).toEqual(['keep']);
  });

  it('tags the returned tr with COMMENT_RECONCILE_META', () => {
    const state = stateFromHtml('<p><span class="mark-comment" data-comment-id="dead">x</span></p>');
    const tr = reconcileCommentMarks(state, commentsState([]));
    expect(tr.getMeta(COMMENT_RECONCILE_META)).toBe(true);
  });
});
```

Also add the import at the top of the file (it should already be there from Task 2 but verify): `import { schema } from '../pm-schema.js';`

- [ ] **Step 3.2: Run the tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/pm-comments.test.js -t "orphan removal"`
Expected: 3 tests pass (the verb already implements orphan removal — these tests just lock the contract).

If they fail, the verb impl from Task 2 is wrong; fix it before commit.

- [ ] **Step 3.3: Commit**

```bash
git add src/lib/__tests__/pm-comments.test.js
git commit -m "test(pm-editor): pin orphan-removal contract for pm-comments verb (#47 1g)"
```

---

## Task 4: Verb — status flip + idempotency-after-flip

**Files:**
- Test: `src/lib/__tests__/pm-comments.test.js`

- [ ] **Step 4.1: Append failing tests**

```js
describe('reconcileCommentMarks — status flip', () => {
  it('flips resolved attr to match commentsState.status (open → resolved)', () => {
    const state = stateFromHtml('<p><span class="mark-comment" data-comment-id="c1">x</span></p>');
    const tr = reconcileCommentMarks(state, commentsState([
      { id: 'c1', blockId: 'b1', status: 'resolved' },
    ]));
    expect(tr).not.toBeNull();
    const newDoc = state.apply(tr).doc;
    const commentMarkType = schema.marks.comment;
    let resolvedAttr = null;
    newDoc.descendants((node) => {
      if (!node.isText) return true;
      for (const m of node.marks) {
        if (m.type === commentMarkType) resolvedAttr = m.attrs.resolved;
      }
      return true;
    });
    expect(resolvedAttr).toBe(true);
  });

  it('idempotency: running again on the reconciled doc returns null', () => {
    const state = stateFromHtml('<p><span class="mark-comment" data-comment-id="c1">x</span></p>');
    const cs = commentsState([{ id: 'c1', blockId: 'b1', status: 'resolved' }]);
    const tr1 = reconcileCommentMarks(state, cs);
    expect(tr1).not.toBeNull();
    const state2 = state.apply(tr1);
    const tr2 = reconcileCommentMarks(state2, cs);
    expect(tr2).toBeNull();
  });

  it('preserves a same-id mark when its resolved attr already matches', () => {
    const state = stateFromHtml('<p><span class="mark-comment-resolved" data-comment-id="c1">x</span></p>');
    const tr = reconcileCommentMarks(state, commentsState([
      { id: 'c1', blockId: 'b1', status: 'resolved' },
    ]));
    expect(tr).toBeNull();
  });
});
```

- [ ] **Step 4.2: Run the tests**

Run: `npx vitest run src/lib/__tests__/pm-comments.test.js -t "status flip"`
Expected: 3 tests pass.

- [ ] **Step 4.3: Commit**

```bash
git add src/lib/__tests__/pm-comments.test.js
git commit -m "test(pm-editor): pin status-flip + idempotency contracts for pm-comments verb (#47 1g)"
```

---

## Task 5: Create `active-comment.js` plugin — state + setter

**Files:**
- Create: `src/lib/pm-plugins/active-comment.js`
- Create: `src/lib/pm-plugins/__tests__/active-comment.test.js`

- [ ] **Step 5.1: Write failing tests for setter + state**

Create `src/lib/pm-plugins/__tests__/active-comment.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';

import { schema } from '../../pm-schema.js';
import { htmlToPmFragment } from '../../pmdoc-html.js';
import {
  activeCommentPlugin,
  activeCommentPluginKey,
  setActiveComment,
} from '../active-comment.js';

let root;
beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  root?.remove();
});

function mountWithDoc(html) {
  const state = EditorState.create({
    schema,
    doc: htmlToPmFragment(html),
    plugins: [activeCommentPlugin()],
  });
  const view = new EditorView(root, { state });
  return view;
}

describe('activeCommentPlugin — initial state', () => {
  it('initializes with activeCommentId === null', () => {
    const view = mountWithDoc('<p>plain</p>');
    const pluginState = activeCommentPluginKey.getState(view.state);
    expect(pluginState.activeCommentId).toBeNull();
    view.destroy();
  });
});

describe('activeCommentPlugin — setActiveComment', () => {
  it('setActiveComment dispatches a meta tr that updates activeCommentId', () => {
    const view = mountWithDoc('<p>plain</p>');
    setActiveComment(view, 'c1');
    const pluginState = activeCommentPluginKey.getState(view.state);
    expect(pluginState.activeCommentId).toBe('c1');
    view.destroy();
  });

  it('setActiveComment(view, null) clears the activeCommentId', () => {
    const view = mountWithDoc('<p>plain</p>');
    setActiveComment(view, 'c1');
    setActiveComment(view, null);
    const pluginState = activeCommentPluginKey.getState(view.state);
    expect(pluginState.activeCommentId).toBeNull();
    view.destroy();
  });

  it('setActiveComment(view, sameId) is a no-op at the state level', () => {
    const view = mountWithDoc('<p>plain</p>');
    setActiveComment(view, 'c1');
    const stateBefore = activeCommentPluginKey.getState(view.state);
    setActiveComment(view, 'c1');
    const stateAfter = activeCommentPluginKey.getState(view.state);
    // Same object reference proves the reducer short-circuited.
    expect(stateAfter).toBe(stateBefore);
    view.destroy();
  });
});
```

- [ ] **Step 5.2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/pm-plugins/__tests__/active-comment.test.js`
Expected: failure — module doesn't exist yet.

- [ ] **Step 5.3: Create the plugin**

Create `src/lib/pm-plugins/active-comment.js`:

```js
/**
 * active-comment.js — PM plugin holding singleton activeCommentId state
 * (sub-PR 1g, issue #47).
 *
 * Replaces CommentPopup.jsx's imperative `setAttribute('data-active', ...)`
 * for PM-mounted blocks. App calls `setActiveComment(view, commentId)` when
 * the popup opens; the plugin renders an inline decoration applying
 * `class: 'mark-comment-active'` to the matching `comment` mark's range.
 * CSS selector `.mark-comment.mark-comment-active` (and the dark-mode
 * variant) provides the visual treatment.
 *
 * The DecorationSet is cached in plugin state and rebuilt only on
 * `tr.docChanged || activeCommentId changed`. The PM guide explicitly
 * recommends this pattern (Decorations section): "When you have a lot of
 * decorations, recreating the set on the fly for every redraw is likely to
 * be too expensive."
 *
 * Same-id meta short-circuit: re-dispatching `setActiveComment(view, sameId)`
 * returns the same plugin-state object reference, so the React-side wiring
 * effect can safely fire on any commentsState dep change without thrashing
 * the DecorationSet.
 */

import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export const activeCommentPluginKey = new PluginKey('active-comment');

function buildDecorations(doc, activeCommentId) {
  if (!activeCommentId) return DecorationSet.empty;
  const commentMarkType = doc.type.schema.marks.comment;
  if (!commentMarkType) return DecorationSet.empty;
  const decos = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type === commentMarkType && m.attrs.id === activeCommentId) {
        decos.push(
          Decoration.inline(pos, pos + node.nodeSize, { class: 'mark-comment-active' }),
        );
        break;
      }
    }
    return true;
  });
  return DecorationSet.create(doc, decos);
}

export function activeCommentPlugin() {
  return new Plugin({
    key: activeCommentPluginKey,
    state: {
      init(_config, state) {
        return {
          activeCommentId: null,
          decorations: buildDecorations(state.doc, null),
        };
      },
      apply(tr, prev, _oldState, newState) {
        const metaSet = tr.getMeta(activeCommentPluginKey);
        let activeCommentId = prev.activeCommentId;
        let needsRebuild = false;
        if (metaSet !== undefined) {
          if (metaSet !== prev.activeCommentId) {
            activeCommentId = metaSet;
            needsRebuild = true;
          }
        }
        if (tr.docChanged) needsRebuild = true;
        if (!needsRebuild) return prev;
        return {
          activeCommentId,
          decorations: buildDecorations(newState.doc, activeCommentId),
        };
      },
    },
    props: {
      decorations(state) {
        return activeCommentPluginKey.getState(state).decorations;
      },
    },
  });
}

export function setActiveComment(view, commentId) {
  view.dispatch(view.state.tr.setMeta(activeCommentPluginKey, commentId));
}
```

- [ ] **Step 5.4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/pm-plugins/__tests__/active-comment.test.js`
Expected: 4 tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add src/lib/pm-plugins/active-comment.js src/lib/pm-plugins/__tests__/active-comment.test.js
git commit -m "feat(pm-editor): activeCommentPlugin with state + setter (#47 1g)"
```

---

## Task 6: Plugin — decoration emission + cache invalidation

**Files:**
- Test: `src/lib/pm-plugins/__tests__/active-comment.test.js`

- [ ] **Step 6.1: Append failing tests for decoration emission**

```js
describe('activeCommentPlugin — decoration emission', () => {
  it('emits no decorations when activeCommentId is null', () => {
    const view = mountWithDoc('<p><span class="mark-comment" data-comment-id="c1">x</span></p>');
    const pluginState = activeCommentPluginKey.getState(view.state);
    expect(pluginState.decorations.find()).toHaveLength(0);
    view.destroy();
  });

  it('emits an inline decoration over the matching comment range', () => {
    const view = mountWithDoc('<p>before <span class="mark-comment" data-comment-id="c1">x</span> after</p>');
    setActiveComment(view, 'c1');
    const pluginState = activeCommentPluginKey.getState(view.state);
    const decos = pluginState.decorations.find();
    expect(decos.length).toBe(1);
    expect(decos[0].spec.class || decos[0].type?.attrs?.class).toBeDefined();
    view.destroy();
  });

  it('emits no decoration when activeCommentId does not match any mark', () => {
    const view = mountWithDoc('<p><span class="mark-comment" data-comment-id="c1">x</span></p>');
    setActiveComment(view, 'no-such-id');
    const pluginState = activeCommentPluginKey.getState(view.state);
    expect(pluginState.decorations.find()).toHaveLength(0);
    view.destroy();
  });
});

describe('activeCommentPlugin — cache invalidation', () => {
  it('rebuilds the DecorationSet on docChanged', () => {
    const view = mountWithDoc('<p><span class="mark-comment" data-comment-id="c1">x</span></p>');
    setActiveComment(view, 'c1');
    const stateBefore = activeCommentPluginKey.getState(view.state);
    // Force a doc-changing transaction.
    view.dispatch(view.state.tr.insertText(' more', view.state.doc.content.size - 1));
    const stateAfter = activeCommentPluginKey.getState(view.state);
    // New plugin-state object means the reducer ran with needsRebuild=true.
    expect(stateAfter).not.toBe(stateBefore);
    expect(stateAfter.activeCommentId).toBe('c1');
    view.destroy();
  });
});
```

- [ ] **Step 6.2: Run the tests**

Run: `npx vitest run src/lib/pm-plugins/__tests__/active-comment.test.js`
Expected: all 8 tests pass.

If the "emits an inline decoration" test fails because the assertion on `decos[0].spec` doesn't match PM's actual shape, replace the assertion with `expect(decos[0]).toBeDefined()` and inspect the structure manually via a `console.log(decos[0])` in the test, then write a more precise assertion. The exact internal field name varies across PM versions.

- [ ] **Step 6.3: Commit**

```bash
git add src/lib/pm-plugins/__tests__/active-comment.test.js
git commit -m "test(pm-editor): pin decoration emission + cache invalidation (#47 1g)"
```

---

## Task 7: PmEditableBlock — register plugin + dispatchTransaction gate

**Files:**
- Modify: `src/components/PmEditableBlock.jsx`
- Test (new): `src/components/__tests__/PmEditableBlock-comment-reconcile.test.jsx`

- [ ] **Step 7.1: Write failing test for dispatchTransaction gate**

Create `src/components/__tests__/PmEditableBlock-comment-reconcile.test.jsx`:

```js
// @vitest-environment jsdom
//
// Pins the dispatchTransaction COMMENT_RECONCILE_META gate. A reconcile-
// tagged tr must NOT fire the synthesized 'input' event (no linter re-run)
// and must NOT schedule an onUpdate debounce (no setBlockHtml echo).
// Also pins the per-block reconcile effect — when commentsState changes
// such that the block has an orphan, the effect dispatches the reconcile tr.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

import { htmlToPmFragment } from '../../lib/pmdoc-html.js';
import { COMMENT_RECONCILE_META } from '../../lib/pm-comments.js';
import PmEditableBlock from '../PmEditableBlock.jsx';

function setupYStore(blockId, html) {
  const ydoc = new Y.Doc();
  const yStore = ydoc.getMap('blocks');
  const yMap = new Y.Map();
  const yXml = new Y.XmlFragment();
  yMap.set('html', yXml);
  yStore.set(blockId, yMap);
  prosemirrorToYXmlFragment(htmlToPmFragment(html), yXml);
  return { ydoc, yStore };
}

let container;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  container?.remove();
});

describe('PmEditableBlock — comment reconcile dispatchTransaction gate', () => {
  it('reconcile tr does NOT fire synthesized "input" event on the DOM root', async () => {
    const { yStore } = setupYStore('b1', '<p><span class="mark-comment" data-comment-id="dead">x</span></p>');
    const onUpdate = vi.fn();
    const block = { id: 'b1', type: 'txt', html: '<p><span class="mark-comment" data-comment-id="dead">x</span></p>', isNew: false };
    const commentsState = { byId: new Map(), seenRemoteIds: new Set() };

    const root = createRoot(container);
    let inputEventCount = 0;
    await act(async () => {
      root.render(
        <PmEditableBlock
          block={block}
          yStore={yStore}
          commentsState={commentsState}
          onUpdate={onUpdate}
          identity={{ id: 'u', name: 'U', color: '#000' }}
          showTags={false}
        />,
      );
    });
    // Wait for mount + ySyncPlugin initial sync.
    await new Promise((r) => setTimeout(r, 50));
    // Attach the input listener AFTER mount so we only count events from the
    // reconcile-driven dispatch the effect fires.
    const editorEl = container.querySelector('[data-pm-editor="true"]');
    expect(editorEl).toBeTruthy();
    editorEl.addEventListener('input', () => { inputEventCount += 1; });
    // The per-block reconcile effect should have fired by now and dispatched
    // a reconcile tr (because the mounted doc has an orphan mark for id "dead"
    // and commentsState.byId is empty).
    await new Promise((r) => setTimeout(r, 50));
    // ... but the reconcile tr is gated, so input event count is 0.
    expect(inputEventCount).toBe(0);
    // onUpdate is also gated (debounce never schedules for reconcile trs).
    await new Promise((r) => setTimeout(r, 500)); // wait past the 400ms window
    expect(onUpdate).not.toHaveBeenCalled();
    root.unmount();
  });
});
```

- [ ] **Step 7.2: Run the test to verify it fails**

Run: `npx vitest run src/components/__tests__/PmEditableBlock-comment-reconcile.test.jsx`
Expected: failure — likely "Cannot find module" or "reconcile tr fired input event" (current dispatchTransaction has no gate).

- [ ] **Step 7.3: Modify PmEditableBlock.jsx — add plugin import + register in plugin list**

Open `src/components/PmEditableBlock.jsx`. Find the existing imports for `tag-labels.js` and `keymap.js`:

```js
import { tagLabelsPlugin, setTagsVisible } from '../lib/pm-plugins/tag-labels.js';
import { blockKeymap } from '../lib/pm-plugins/keymap.js';
```

Add a new import:

```js
import { activeCommentPlugin } from '../lib/pm-plugins/active-comment.js';
import { COMMENT_RECONCILE_META, reconcileCommentMarks } from '../lib/pm-comments.js';
```

Find the `plugins` array inside the mount useEffect (around line 248-263):

```js
const plugins = [
  ySyncPlugin(yXml),
  slashMenuPlugin(),
  tagLabelsPlugin({ initialVisible: !!showTags }),
  blockKeymap({ ... }),
];
```

Insert `activeCommentPlugin()` after `tagLabelsPlugin`:

```js
const plugins = [
  ySyncPlugin(yXml),
  slashMenuPlugin(),
  tagLabelsPlugin({ initialVisible: !!showTags }),
  activeCommentPlugin(),
  blockKeymap({ ... }),
];
```

- [ ] **Step 7.4: Modify PmEditableBlock.jsx — add dispatchTransaction gate**

Find the `dispatchTransaction(tr) { ... }` method (around line 356-416). The existing `if (tr.docChanged)` body needs two new gates.

Locate this block:

```js
if (tr.docChanged) {
  // Q27 re-lint trigger: synthesize an 'input' event so
  // useBlockLinting's debounce fires. PM doesn't dispatch input
  // events natively on transactions. Fire on every doc change
  // (local + remote) so a peer's edit triggers a re-lint pass.
  if (this.dom) {
    try {
      this.dom.dispatchEvent(new Event('input', { bubbles: true }));
    } catch { /* SSR / jsdom safety */ }
  }
  // hasInlineRevisions recompute (gutter buttons).
  setHasInlineRevisions(docHasInlineRevisions(newState.doc));

  // ... existing isRemote / onUpdate block ...
  const isRemote = tr.getMeta(ySyncPluginKey) != null;
  if (!isRemote) {
    // Push html back to App's React state...
```

Replace it with:

```js
if (tr.docChanged) {
  const isRemote = tr.getMeta(ySyncPluginKey) != null;
  const isReconcile = tr.getMeta(COMMENT_RECONCILE_META) === true;
  // Q27 re-lint trigger: synthesize an 'input' event so
  // useBlockLinting's debounce fires. Skipped for reconcile (mark-attr-only
  // changes don't affect text — linter has nothing new to find).
  if (!isReconcile && this.dom) {
    try {
      this.dom.dispatchEvent(new Event('input', { bubbles: true }));
    } catch { /* SSR / jsdom safety */ }
  }
  // hasInlineRevisions recompute (gutter buttons). Cheap; always run.
  setHasInlineRevisions(docHasInlineRevisions(newState.doc));

  // QC critical-1: only the *local* user's edits should round-trip
  // through onUpdate → setBlockHtml ('local-publish' origin →
  // UndoManager). Remote ySyncPlugin-applied transactions carry
  // ySyncPluginKey on the transaction meta; reconcile-tagged transactions
  // are also skipped — setBlockHtml('local-publish') on the post-reconcile
  // html would produce an echo Yjs op that enters the UndoManager
  // (verified empirically by setblockhtml-echo-behavior.test.js).
  if (!isRemote && !isReconcile) {
    if (onUpdateDebounceRef.current) clearTimeout(onUpdateDebounceRef.current);
    onUpdateDebounceRef.current = setTimeout(() => {
      onUpdateDebounceRef.current = null;
      const html = pmFragmentToHtml(newState.doc);
      onUpdateRef.current?.(block.id, html);
    }, 400);
  }
}
```

Remove the old `const isRemote = tr.getMeta(ySyncPluginKey) != null; if (!isRemote) { ... }` block — it's now folded into the new combined block above.

- [ ] **Step 7.5: Run the existing PmEditableBlock tests to verify no regression**

Run: `npx vitest run src/components/__tests__/PmEditableBlock-mount-race.test.jsx`
Expected: passes.

Run: `npx vitest run src/lib/__tests__/pm-editor-mount.test.js`
Expected: passes.

- [ ] **Step 7.6: Run the new comment-reconcile test**

Run: `npx vitest run src/components/__tests__/PmEditableBlock-comment-reconcile.test.jsx`
Expected: the "no input event" test passes; the per-block reconcile effect dispatching is partly covered (depends on whether the effect is wired yet — if not, see Task 8 which wires it).

Note: this test may STILL fail at this stage if the per-block reconcile effect isn't wired yet — that's Task 8. If so, mark this step partial and move on.

- [ ] **Step 7.7: Commit**

```bash
git add src/components/PmEditableBlock.jsx src/components/__tests__/PmEditableBlock-comment-reconcile.test.jsx
git commit -m "feat(pm-editor): register activeCommentPlugin + dispatchTransaction gate (#47 1g)"
```

---

## Task 8: PmEditableBlock — per-block reconcile effect + commentsState prop

**Files:**
- Modify: `src/components/PmEditableBlock.jsx`

- [ ] **Step 8.1: Add `commentsState` to the props destructuring**

Find the function signature in `PmEditableBlock.jsx`:

```js
function PmEditableBlock({
  block,
  yStore,
  onUpdate,
  ...
  comments,     // eslint-disable-line no-unused-vars  -- comments rendered via marks (1g)
  onCommentClick,
  ...
}) {
```

Replace `comments` (the placeholder prop) with `commentsState`:

```js
  commentsState,    // 1g: drives per-block reconcile effect via reconcileCommentMarks
  onCommentClick,
```

Remove the `// eslint-disable-next-line no-unused-vars  -- comments rendered via marks (1g)` comment if present.

- [ ] **Step 8.2: Add commentsState ref**

Inside the component body, near the other refs (e.g. after `const trackChangesRef = useRef(trackChanges); trackChangesRef.current = trackChanges;`), add:

```js
const commentsStateRef = useRef(commentsState);
commentsStateRef.current = commentsState;
```

- [ ] **Step 8.3: Add the per-block reconcile effect**

After the existing useEffects (after the auto-focus effect at line ~462, and the imperative-handle effect at line ~478-551), add a new effect:

```js
// ── Per-block comment reconcile (1g) ────────────────────────────────────
// Dispatches a PM tr that synchronizes the block's `comment` marks with the
// canonical commentsState. Verb returns null when no work is needed, so the
// effect is cheap for blocks without comments and idempotent for blocks
// where the substrate already agrees with state.
//
// The dispatched tr is tagged with COMMENT_RECONCILE_META; dispatchTransaction
// skips both the synthesized 'input' event (no linter re-run) and the onUpdate
// debounce (no setBlockHtml echo via 'local-publish').
useEffect(() => {
  const view = viewRef.current;
  if (!view) return;
  const tr = reconcileCommentMarks(view.state, commentsStateRef.current);
  if (tr) view.dispatch(tr);
}, [commentsState]);
```

- [ ] **Step 8.4: Run the comment-reconcile test from Task 7**

Run: `npx vitest run src/components/__tests__/PmEditableBlock-comment-reconcile.test.jsx`
Expected: passes (effect now fires the reconcile dispatch which the gate suppresses from `input` event + `onUpdate`).

- [ ] **Step 8.5: Add a positive test that the reconcile dispatch DOES remove the orphan mark**

Append to `src/components/__tests__/PmEditableBlock-comment-reconcile.test.jsx`:

```js
describe('PmEditableBlock — per-block reconcile effect', () => {
  it('removes orphan comment mark from substrate when commentsState lacks the id', async () => {
    const { yStore } = setupYStore('b1', '<p><span class="mark-comment" data-comment-id="dead">x</span></p>');
    const block = { id: 'b1', type: 'txt', html: '<p><span class="mark-comment" data-comment-id="dead">x</span></p>', isNew: false };
    const commentsState = { byId: new Map(), seenRemoteIds: new Set() };

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <PmEditableBlock
          block={block}
          yStore={yStore}
          commentsState={commentsState}
          onUpdate={() => {}}
          identity={{ id: 'u', name: 'U', color: '#000' }}
          showTags={false}
        />,
      );
    });
    await new Promise((r) => setTimeout(r, 100));
    // After the per-block reconcile effect fires, the substrate's YXmlText
    // delta should have no `comment` attribute.
    const yMap = yStore.get('b1');
    const yXml = yMap.get('html');
    const para = yXml.toArray()[0];
    const ytext = para.toArray()[0];
    const delta = ytext.toDelta();
    const hasComment = delta.some((d) => d.attributes?.comment);
    expect(hasComment).toBe(false);
    root.unmount();
  });
});
```

- [ ] **Step 8.6: Run all PmEditableBlock tests**

Run: `npx vitest run src/components/__tests__/PmEditableBlock`
Expected: all pass.

- [ ] **Step 8.7: Commit**

```bash
git add src/components/PmEditableBlock.jsx src/components/__tests__/PmEditableBlock-comment-reconcile.test.jsx
git commit -m "feat(pm-editor): per-block comment reconcile effect (#47 1g)"
```

---

## Task 9: App.jsx — pass commentsState to PmEditableBlock + add `pmMountedIds` to shouldSkip

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 9.1: Find the PmEditableBlock render site**

Search `src/App.jsx` for `<PmEditableBlock` (or `EditableBlock` depending on conditional rendering). Find the props passed to the editable-block component.

Typically the block-rendering loop is in App's main render body. The block component receives `block`, `yStore`, `onUpdate`, `comments`, etc.

- [ ] **Step 9.2: Pass `commentsState` prop**

In the JSX where `PmEditableBlock` (or the unified editable block component) is rendered, add:

```jsx
commentsState={commentsState}
```

Adjacent to the existing `comments={comments}` prop. Keep `comments` for now (other consumers may use it; 1g doesn't remove it).

- [ ] **Step 9.3: Find the App-level reconcile effect (App.jsx:754-767)**

The current effect:

```js
useEffect(() => {
  setBlocksDirect(prev => {
    const next = cm.reconcileBlocks(prev, commentsState);
    const yStore = activeYStoreRef.current;
    if (next !== prev && yStore) {
      for (const b of next) {
        if (typeof b.html !== 'string') continue;
        const before = prev.find(p => p.id === b.id);
        if (before && before.html !== b.html) setBlockHtml(yStore, b.id, b.html);
      }
    }
    return next;
  });
}, [blocks, commentsState, setBlocksDirect]);
```

- [ ] **Step 9.4: Modify the effect to compute `pmMountedIds` and pass `shouldSkip`**

Add an import at the top of `src/App.jsx` if not already present:

```js
import { getBlockView } from './lib/block-registry.js';
```

Replace the effect body:

```js
useEffect(() => {
  setBlocksDirect(prev => {
    // 1g: PM-mounted blocks own their comment reconcile via the per-block
    // PM effect in PmEditableBlock.jsx (reconcileCommentMarks dispatch).
    // Skip them here so the html walk doesn't redundantly rewrite their
    // mark spans (which would then be clobbered by the PM dispatch anyway).
    const pmMountedIds = new Set();
    for (const b of prev) {
      if (getBlockView(b.id) != null) pmMountedIds.add(b.id);
    }
    const next = cm.reconcileBlocks(prev, commentsState, {
      shouldSkip: (id) => pmMountedIds.has(id),
    });
    const yStore = activeYStoreRef.current;
    if (next !== prev && yStore) {
      for (const b of next) {
        if (typeof b.html !== 'string') continue;
        const before = prev.find(p => p.id === b.id);
        if (before && before.html !== b.html) setBlockHtml(yStore, b.id, b.html);
      }
    }
    return next;
  });
}, [blocks, commentsState, setBlocksDirect]);
```

- [ ] **Step 9.5: Verify the unit tests still pass**

Run: `npx vitest run`
Expected: all tests pass. If `comments.test.js` fails because the App-level path isn't being tested here, that's expected — those tests cover `comments.js`, not App.

- [ ] **Step 9.6: Commit**

```bash
git add src/App.jsx
git commit -m "feat(pm-editor): App passes commentsState + pmMountedIds shouldSkip (#47 1g)"
```

---

## Task 10: App.jsx — setActiveComment wiring effect

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 10.1: Add imports**

At the top of `src/App.jsx` add (or extend existing import from block-registry):

```js
import { getBlockView } from './lib/block-registry.js';
import { setActiveComment } from './lib/pm-plugins/active-comment.js';
```

- [ ] **Step 10.2: Add the wiring effect**

Find `handleCommentClick` at approximately line 735:

```js
const handleCommentClick = useCallback((commentId, rect) => {
  setOpenCommentId(commentId);
  setCommentRect(rect);
}, []);
```

Below it, add:

```js
// 1g — wire setActiveComment against the right PM view via block-registry.
// Tracks the previously-highlighted view in `prevViewRef` so a comment that
// moves between blocks (or simply closes) cleanly clears the old highlight.
// Plugin reducer detects same-id no-op meta dispatches.
const prevActiveViewRef = useRef(null);
const activeBlockId = openCommentId
  ? commentsState.byId.get(openCommentId)?.blockId ?? null
  : null;
useEffect(() => {
  const nextView = activeBlockId ? getBlockView(activeBlockId) : null;
  if (prevActiveViewRef.current && prevActiveViewRef.current !== nextView) {
    try { setActiveComment(prevActiveViewRef.current, null); } catch { /* destroyed */ }
  }
  if (nextView) {
    try { setActiveComment(nextView, openCommentId); } catch { /* destroyed */ }
  }
  prevActiveViewRef.current = nextView;
}, [openCommentId, activeBlockId]);
```

The `try/catch` guards against dispatching on a destroyed EditorView (block unmounted while popup was open).

- [ ] **Step 10.3: Verify the app still loads under both flag values**

Run: `npm run dev` in one terminal, open the app in browser. With `VITE_PM_EDITOR=true` (or `?pm=1`), click a comment in the sample doc, confirm popup opens and visible highlight appears. Close popup, confirm highlight removes.

Then verify under `VITE_PM_EDITOR=false` (or default): click a comment, confirm popup opens and the legacy `data-active` attribute highlight still works.

- [ ] **Step 10.4: Commit**

```bash
git add src/App.jsx
git commit -m "feat(pm-editor): App-side setActiveComment wiring effect (#47 1g)"
```

---

## Task 11: CommentPopup.jsx — mode-conditional `setAttribute`

**Files:**
- Modify: `src/components/CommentPopup.jsx`

- [ ] **Step 11.1: Import `getBlockView`**

At the top of `src/components/CommentPopup.jsx`, add:

```js
import { getBlockView } from "../lib/block-registry.js";
```

- [ ] **Step 11.2: Gate the existing `useEffect` (lines 78-83)**

Find:

```js
useEffect(() => {
  const el = document.querySelector(`[data-comment-id="${comment.id}"]`);
  if (!el) return undefined;
  el.setAttribute('data-active', 'true');
  return () => { el.removeAttribute('data-active'); };
}, [comment.id]);
```

Replace with:

```js
// 1g: PM-mounted blocks have a registered EditorView and own the active
// highlight via activeCommentPlugin's inline decoration (class
// 'mark-comment-active'). Legacy editable blocks have no PM view registered
// — their comment spans are html-injected and we still need to set
// `data-active` imperatively. Ref/table blocks also have no PM view; the
// imperative setAttribute is a harmless duplicate of the React-rendered
// `data-active` prop those components emit.
useEffect(() => {
  if (getBlockView(comment.blockId) != null) return undefined;
  const el = document.querySelector(`[data-comment-id="${comment.id}"]`);
  if (!el) return undefined;
  el.setAttribute('data-active', 'true');
  return () => { el.removeAttribute('data-active'); };
}, [comment.id, comment.blockId]);
```

- [ ] **Step 11.3: Verify in dev**

`npm run dev`, click a comment in PM mode: highlight appears via decoration class. Click a comment in legacy mode: highlight appears via `data-active` attribute. Close popups: highlight clears in both modes.

- [ ] **Step 11.4: Commit**

```bash
git add src/components/CommentPopup.jsx
git commit -m "feat(comments): mode-conditional setAttribute in CommentPopup (#47 1g)"
```

---

## Task 12: CSS — add `.mark-comment-active` selectors

**Files:**
- Modify: `src/styles/editor.css`

- [ ] **Step 12.1: Add the new selectors alongside the existing `[data-active]` rules**

Open `src/styles/editor.css`. Find the existing rule:

```css
.mark-comment[data-active="true"] {
  background: #f6c744;
}
```

Replace with:

```css
.mark-comment[data-active="true"],
.mark-comment.mark-comment-active {
  background: #f6c744;
}
```

Find:

```css
.mark-comment-resolved[data-active="true"] {
  background: #d2d4d8;
}
```

Replace with:

```css
.mark-comment-resolved[data-active="true"],
.mark-comment-resolved.mark-comment-active {
  background: #d2d4d8;
}
```

Find the dark-mode block:

```css
.dark-mode .mark-comment[data-active="true"] { background: #a16207; }
.dark-mode .mark-comment-resolved { background: #374151; }
.dark-mode .mark-comment-resolved[data-active="true"] { background: #4b5563; }
```

Replace with:

```css
.dark-mode .mark-comment[data-active="true"],
.dark-mode .mark-comment.mark-comment-active { background: #a16207; }
.dark-mode .mark-comment-resolved { background: #374151; }
.dark-mode .mark-comment-resolved[data-active="true"],
.dark-mode .mark-comment-resolved.mark-comment-active { background: #4b5563; }
```

- [ ] **Step 12.2: Verify in dev**

`npm run dev`, both flag values, click a comment in each — confirm the active highlight color is identical between PM and legacy modes.

- [ ] **Step 12.3: Commit**

```bash
git add src/styles/editor.css
git commit -m "feat(comments): CSS selectors for mark-comment-active decoration class (#47 1g)"
```

---

## Task 13: CLAUDE.md — update Comments Architecture + invariants + PM plugin module set

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 13.1: Update Comments Architecture item 6**

Find item 6 in the "Comments Architecture" section. The current text describes `data-active` attribute as the universal mechanism. Replace with text that describes the mode-conditional pattern.

Existing (approximately):

```markdown
6. **Active highlight is an attribute.** For editable blocks, `CommentPopup` sets `data-active="true"` on the comment span on mount and removes it on unmount; CSS is `.mark-comment[data-active="true"]` (light + dark). Reconcile owns the className exclusively, so an in-flight popup close cannot leave a stale class out of sync with `comment.status`. For ref/table blocks, `data-active` is React-rendered from `activeCommentId`; the popup's imperative `setAttribute` is a harmless no-op there since the React-rendered value is already correct.
```

Replace with:

```markdown
6. **Active highlight is mode-conditional (1g).** PM-mounted editable blocks: the `activeCommentPlugin` (`src/lib/pm-plugins/active-comment.js`) holds a singleton `activeCommentId` plugin state; App calls `setActiveComment(view, commentId)` via `block-registry.getBlockView`. The plugin emits an inline `Decoration.inline(from, to, { class: 'mark-comment-active' })` over the matching `comment` mark's range. CSS rule: `.mark-comment.mark-comment-active` and `.mark-comment-resolved.mark-comment-active` (light + dark). DecorationSet is cached in plugin state per the PM guide's Decorations recommendation. — Legacy editable blocks: `CommentPopup`'s `useEffect` falls back to `document.querySelector('[data-comment-id]').setAttribute('data-active', 'true')` (gated on `getBlockView(blockId) == null`). — Ref/table blocks: React renders `data-active="true"` from the `activeCommentId` prop. The popup's `setAttribute` is also gated for those (their `getBlockView` returns null too, so the `setAttribute` runs but is a harmless duplicate of the React-rendered value). Reconcile (item 10) owns the className transitions across `comment.status` flips.
```

- [ ] **Step 13.2: Update Comments Architecture item 10**

Item 10 already mentions PR #67's resolution. Append a paragraph about 1g's reconcile path:

After the existing item 10 content, add:

```markdown

**Substrate-side reconcile (1g).** For PM-mounted blocks, a per-block `useEffect([commentsState])` in `PmEditableBlock.jsx` calls `reconcileCommentMarks(view.state, commentsState)` (`src/lib/pm-comments.js`) and dispatches the returned tr. The verb is idempotent — receiving peers (whose substrate is already updated via the originator's ySyncPlugin op) get a null tr and dispatch nothing. The tr is tagged with `COMMENT_RECONCILE_META`; `dispatchTransaction` skips the synthesized `'input'` event and the `onUpdate` debounce for reconcile-tagged trs. The latter is empirically necessary (see `src/lib/__tests__/setblockhtml-echo-behavior.test.js`) — un-gated `onUpdate` would call `setBlockHtml(..., 'local-publish')` and produce an echo Yjs op the UndoManager captures. Legacy blocks continue to use `cm.reconcileBlocks` (html walk) — the App-level effect uses a `shouldSkip` predicate so PM-mounted blocks are skipped from the html walk.
```

- [ ] **Step 13.3: Update the "Nine non-obvious invariants" section**

Find the invariants section (currently 9 items, or however many it has). Add a new invariant after the existing reserved-origin discussion:

```markdown
- **`COMMENT_RECONCILE_META` is a PM-meta sentinel, NOT a Yjs origin (1g).** Defined in `src/lib/pm-comments.js` as `export const COMMENT_RECONCILE_META = {}` (sentinel object — identity-compared). Set via `tr.setMeta(COMMENT_RECONCILE_META, true)`. `dispatchTransaction` in `PmEditableBlock.jsx` reads it via `tr.getMeta(COMMENT_RECONCILE_META) === true` and skips the synthesized `'input'` event (linter) + `onUpdate` debounce (no `setBlockHtml` echo). The corresponding Yjs op produced by ySyncPlugin still uses origin `ySyncPluginKey` — the meta only governs PM-side filtering, not the substrate write path. Don't conflate this with a Yjs origin like `'local-publish'`.
```

- [ ] **Step 13.4: Update the "PM plugin module set" entry**

Find the entry under 1e in the "Nine non-obvious invariants" section describing `src/lib/pm-plugins/`. Currently lists `slash-menu.js`, `tag-labels.js`, `keymap.js`, `relpos-selection.js`. Add `active-comment.js`:

Find:

```markdown
**PM plugin module set (1e).** `src/lib/pm-plugins/` contains: `slash-menu.js` (...); `tag-labels.js` (...); `keymap.js` (...); `relpos-selection.js` (...).
```

Add `active-comment.js` to the list:

```markdown
**PM plugin module set (1e / 1g).** `src/lib/pm-plugins/` contains: `slash-menu.js` (...); `tag-labels.js` (...); `keymap.js` (...); `relpos-selection.js` (...); `active-comment.js` (singleton `activeCommentId` plugin state, inline `Decoration` applying `mark-comment-active` class to matching `comment` mark range; imperative setter `setActiveComment(view, commentId)` via meta dispatch; same-id meta short-circuit + DecorationSet cache rebuilt only on `tr.docChanged || activeCommentId changed` per PM guide Decorations section).
```

(The exact wording of the existing entries varies; preserve their style.)

- [ ] **Step 13.5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): comments architecture + invariants for 1g (#47)"
```

---

## Task 14: E2E — pm-helpers + editor.spec.js comment-highlight tests

**Files:**
- Modify: `tests/e2e/pm-helpers.js`
- Modify: `tests/e2e/editor.spec.js`

- [ ] **Step 14.1: Add `pmGetActiveCommentId` helper (DOM-based detection)**

Open `tests/e2e/pm-helpers.js`. Add at the bottom:

```js
/**
 * Returns the data-comment-id of the currently-active comment span (the one
 * with class 'mark-comment-active', applied by activeCommentPlugin's inline
 * decoration). Returns null when no comment is active. 1g — DOM-based so no
 * test-utils plugin-state exposure is needed.
 */
export async function pmGetActiveCommentId(page) {
  return await page.evaluate(() => {
    const el = document.querySelector('.mark-comment.mark-comment-active, .mark-comment-resolved.mark-comment-active');
    return el?.getAttribute('data-comment-id') ?? null;
  });
}
```

No App.jsx test-utils changes needed (the decoration is observable via DOM directly).

- [ ] **Step 14.2: Find the existing comment-creation test to copy the seeding pattern from**

Run: `grep -n "mark-comment\|onCommentCreate\|comment button" tests/e2e/editor.spec.js | head -20`

Note the test that creates a comment via the toolbar. The expected pattern is: select text, click the toolbar's comment button (look for the emoji 💬 or a button with `title*="Comment"`), fill the popup textarea, click "Comment" or press Enter. The block-id selector pattern is `[data-block-id="<id>"]` — see other tests for how blockId is obtained from the seeded fixture.

- [ ] **Step 14.3: Add E2E test for comment-highlight in both modes**

Append to `tests/e2e/editor.spec.js`. Replace the `<COPY SEEDING FROM STEP 14.2>` markers with the seeding code from the existing comment test you identified:

```js
test.describe('Comment active highlight', () => {
  test('clicking a comment span applies the active-highlight class (PM mode)', async ({ page, forcePmEditor }) => {
    test.skip(!forcePmEditor, 'PM-only test');
    await page.goto('/');
    // <COPY SEEDING FROM STEP 14.2> — seed a comment so .mark-comment span exists.
    // Click the span.
    const span = page.locator('.mark-comment').first();
    await span.click();
    // The decoration adds the class on the rendered DOM. CSS dual selector
    // means the existing data-active still gets bg color too in PM mode; we
    // only care that mark-comment-active is present.
    await expect(span).toHaveClass(/mark-comment-active/);
    // Close popup via Escape.
    await page.keyboard.press('Escape');
    await expect(span).not.toHaveClass(/mark-comment-active/);
  });

  test('clicking a comment span sets data-active attribute (legacy mode)', async ({ page, forcePmEditor }) => {
    test.skip(forcePmEditor, 'Legacy-only test');
    await page.goto('/');
    // <COPY SEEDING FROM STEP 14.2>
    const span = page.locator('.mark-comment').first();
    await span.click();
    await expect(span).toHaveAttribute('data-active', 'true');
    await page.keyboard.press('Escape');
    await expect(span).not.toHaveAttribute('data-active', 'true');
  });
});
```

`forcePmEditor` is the project fixture defined in `tests/e2e/fixtures.js` (per CLAUDE.md). `test.skip(condition, reason)` is the Playwright primitive for conditional skip.

- [ ] **Step 14.4: Run the E2E tests**

Run: `npm run test:e2e -- --grep "Comment active highlight"`
Expected: both projects pass.

- [ ] **Step 14.5: Commit**

```bash
git add tests/e2e/pm-helpers.js tests/e2e/editor.spec.js
git commit -m "test(e2e): comment active-highlight tests under both projects (#47 1g)"
```

---

## Task 15: E2E — collab.spec.js peer-delete scenario

**Files:**
- Modify: `tests/e2e/collab.spec.js`

- [ ] **Step 15.1: Find the existing two-tab pattern to copy**

Run: `grep -n "newContext\|newPage\|roomId\|baseURL" tests/e2e/collab.spec.js | head -30`

Identify the existing test that opens two browser contexts in the same room — copy its setup verbatim (context creation, room id generation, identity seeding, initial sync wait). Note the helper function or fixture that creates the test room and seeds the initial doc.

- [ ] **Step 15.2: Add the test**

Append to `tests/e2e/collab.spec.js`, replacing `<COPY 2-TAB SETUP FROM STEP 15.1>` with the setup code you identified:

```js
test('peer deletes a comment while local popup is open — substrate mark unwraps', async ({ browser, baseURL }, testInfo) => {
  // <COPY 2-TAB SETUP FROM STEP 15.1> — yields page1, page2 in the same room,
  // both synced and with a block ready for comment creation.

  // Page 1: select text in the first editable block, click toolbar comment
  // button, fill popup, submit. (Copy the comment-seeding pattern from
  // editor.spec.js identified in Task 14 step 14.2.)

  // Wait for sync.
  await page1.waitForTimeout(200);

  // Page 1: open the popup by clicking the comment span.
  await page1.locator('.mark-comment').first().click();

  // Page 2: click the same comment span (sync should have delivered it),
  // open the popup, click the delete button. Selector for delete varies —
  // look at CommentPopup.jsx for the title attribute or button text.
  await page2.locator('.mark-comment').first().click();
  await page2.locator('button[title="Delete"]').click();

  // Wait for page 1 to receive the substrate update.
  await page1.waitForTimeout(500);

  // Page 1's substrate should no longer have the comment mark.
  // Read via the test-utils getBlockHtml (substrate-derived, not React state).
  const firstBlockId = await page1.evaluate(() => {
    const el = document.querySelector('[data-block-id]');
    return el?.getAttribute('data-block-id') ?? null;
  });
  expect(firstBlockId).toBeTruthy();
  const peerHtml = await page1.evaluate((id) => {
    return window.__simEditorTestUtils?.getBlockHtml?.(id) ?? null;
  }, firstBlockId);
  // After reconcile, no comment mark span survives in the substrate.
  expect(peerHtml).not.toContain('mark-comment');
});
```

- [ ] **Step 15.3: Run the E2E test**

Run: `npm run test:e2e tests/e2e/collab.spec.js -- --grep "peer deletes a comment"`
Expected: passes under both projects.

- [ ] **Step 15.4: Commit**

```bash
git add tests/e2e/collab.spec.js
git commit -m "test(e2e): peer-delete-during-popup collab scenario (#47 1g)"
```

- [ ] **Step 15.2: Run the E2E test**

Run: `npm run test:e2e tests/e2e/collab.spec.js`
Expected: passes under both projects.

- [ ] **Step 15.3: Commit**

```bash
git add tests/e2e/collab.spec.js
git commit -m "test(e2e): peer-delete-during-popup collab scenario (#47 1g)"
```

---

## Task 16: Full test suite + integration smoke check

**Files:** none — verification only.

- [ ] **Step 16.1: Run full unit test suite**

Run: `npm test -- --run`
Expected: all tests pass.

- [ ] **Step 16.2: Run server tests**

Run: `npm run test:server`
Expected: all pass.

- [ ] **Step 16.3: Run compliance tests**

Run: `npm run test:compliance`
Expected: all pass.

- [ ] **Step 16.4: Run UFGS interop tests**

Run: `npm run test:ufgs`
Expected: all pass (1g doesn't touch serialization, but verify).

- [ ] **Step 16.5: Run full E2E suite under both projects**

Run: `npm run test:e2e`
Expected: zero failures under both `chromium-legacy` and `chromium` projects.

- [ ] **Step 16.6: Manual smoke check in dev**

`npm run dev`. With `VITE_PM_EDITOR=true` (or `?pm=1`):
- Create a comment via the FloatingToolbar; verify it persists.
- Click the comment; verify the highlight appears with the new class.
- Resolve the comment; verify the class transitions to `mark-comment-resolved`.
- Reopen the comment; verify it transitions back.
- Delete the comment; verify the span unwraps and the popup closes.

With `VITE_PM_EDITOR=false`:
- Same flows; verify the legacy `data-active` attribute path still works.

Open the app in two browser windows (different localStorage identities) under the same room:
- Create a comment in window A.
- Verify window B sees it via collab.
- Resolve in window A; verify window B's class transitions via reconcile.
- Delete in window A; verify window B's span unwraps.

- [ ] **Step 16.7: If everything passes, mark the implementation complete**

Comment on issue #47 with a status update referencing this plan.

- [ ] **Step 16.8: (Optional) Final commit if any cleanup occurred during verification**

```bash
git commit -m "chore(pm-editor): 1g smoke check + final cleanup (#47)" --allow-empty
```

(Use `--allow-empty` only if no changes were needed.)

---

## Notes

- **No flag flip.** 1g lands behind the existing `VITE_PM_EDITOR` flag. Sub-PR 1i removes the flag and the legacy code path; that's where `CommentPopup`'s mode-conditional collapse and the `shouldSkip` predicate's removal happen.
- **No issue-tracker comment until Task 16 passes.** Don't comment "1g done" until both projects are green.
- **Each task ends in a commit.** Frequent commits are intentional — rolling back a single task is cheap. Don't squash unless a maintainer requests it post-PR.
