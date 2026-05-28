# Block-Type Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user convert an existing block between any pair of txt/note/oli/item/lst types while preserving html, comments, lint cache, undo history, and the mounted PM EditorView.

**Architecture:** Same-id mutation. A new pure reducer verb (`convertBlockType`) flips `block.type` in place; the wrapper `<div key={…}>` in App.jsx drops its vestigial `-${block.type}` suffix so React reuses the existing PmEditableBlock instance instead of remounting. Two UI affordances trigger the verb: a gutter popover and a `Ctrl+Shift+M` floating palette.

**Tech Stack:** React 19, ProseMirror 1.x, y-prosemirror 1.x, Yjs 13.x, Vitest, Playwright (chromium project).

**Design spec:** [docs/superpowers/specs/2026-05-27-block-type-conversion-design.md](../specs/2026-05-27-block-type-conversion-design.md)

---

## Task 0: Pre-implementation audit

**Files:** none modified — informational pass.

- [ ] **Step 1: Verify lst structural dependencies**

Run: `grep -rn "block\.type === 'lst'" src/`

Expected sites (per spec §9):
- `src/components/PmEditableBlock.jsx:790` — visual styling check
- `src/lib/doc-export.js:82` — export class name
- `src/lib/numbering.js:122` — numbering builder
- `src/lib/sec-serializer.js:511` — SGML emission
- `src/lib/submittal-register.js:57` — SD submittal extraction

All five sites read `block.type` per call. A same-id `lst → txt` flip removes the block from numbering / submittal-register on the next compute cycle — intended behavior. No changes required.

- [ ] **Step 2: Verify no test fixture asserts wrapper-key shape**

Run: `grep -rn "block.type ===" tests/`

Expected: zero matches. (Per spec §9 audit run during writing-plans.)

- [ ] **Step 3: Verify block.section is not type-conditional anywhere**

Run: `grep -rn "block\.section\b" src/`

Expected sites:
- `src/lib/blocks.js:426` — spread in existing `convertBlock`
- `src/lib/submittal-register.js:84` — read for SD-NN section lookup

Neither branches on `block.type`. Spread-preserve in the new verb is correct.

- [ ] **Step 4: Inspect editor surface padding-left for gutter clip safety**

Read `src/App.jsx` around line 2500-2570 (the editor surface container that wraps the `blocks.map` render). Find the outermost `<div>` that contains the blocks render and any `padding`/`paddingLeft` style or className. Note the value.

If padding-left ≥ 32px, the gutter handle at `left: -22` stays inside the editor surface — proceed without modification.

If padding-left < 32px, append to this task: "Add CSS variable `--gutter-handle-clamp: max(-22px, calc(-1 * var(--editor-padding-left) + 4px))` and use that for `left:` on the gutter handle". Surface to the user before continuing to Task 1.

- [ ] **Step 5: Capture baseline E2E flake set**

Run: `npm run test:e2e -- --project=chromium tests/e2e/editor.spec.js tests/e2e/collab.spec.js 2>&1 | tee /tmp/baseline-failures.txt`

Note which tests fail. This is the BASELINE flake set — any test that fails here and after Task 9 is a flake, not a regression introduced by this work. Per CLAUDE.md rule 10.

---

## Task 1: Reducer — `convertBlockType` + `composeRevision` + `levelDelta`

**Files:**
- Modify: `src/lib/blocks.js` (add three new exports near the existing `convertBlock` at line 416)
- Create: `src/lib/__tests__/blocks-convert-type.test.js`

- [ ] **Step 1: Write the failing unit tests**

Create `src/lib/__tests__/blocks-convert-type.test.js`:

```js
// Unit tests for blocks.convertBlockType + composeRevision + levelDelta.
// Mirrors the mock pattern from blocks.test.js (block-html-store +
// block-registry stubs).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../block-html-store.js', () => ({
  setBlockHtml: vi.fn(),
  setBlockHtmlSilent: vi.fn(),
  getBlockHtml: vi.fn(),
  seedBlockArray: vi.fn(),
  resetBlockArray: vi.fn(),
}));

vi.mock('../block-registry.js', () => ({
  flushPendingUpdateById: vi.fn(),
  flushAllPendingUpdates: vi.fn(),
  focusBlockById: vi.fn(),
  getBlockHandle: vi.fn(),
  getBlockView: vi.fn(),
}));

vi.mock('../../components/SearchBar.jsx', () => ({
  replaceMatchInHtml: (h) => h,
  default: () => null,
}));

import { convertBlockType, composeRevision, levelDelta } from '../blocks.js';

const FAMILY_A = ['txt', 'note', 'oli', 'item', 'lst'];
const tcOff = { enabled: false, publishSeq: 0 };
const tcOn = { enabled: true, publishSeq: 0 };

function blk(overrides = {}) {
  return {
    id: 'b1',
    type: 'txt',
    part: 1,
    depth: 0,
    section: 'n0',
    html: '<p>hello</p>',
    ...overrides,
  };
}

describe('convertBlockType', () => {
  describe('preconditions', () => {
    it('returns null when blockId not found', () => {
      expect(convertBlockType([blk()], 'missing', 'note', { tcState: tcOff })).toBeNull();
    });
    it('returns null when newType not in Family A', () => {
      expect(convertBlockType([blk()], 'b1', 'title', { tcState: tcOff })).toBeNull();
      expect(convertBlockType([blk()], 'b1', 'table', { tcState: tcOff })).toBeNull();
      expect(convertBlockType([blk()], 'b1', 'ref', { tcState: tcOff })).toBeNull();
      expect(convertBlockType([blk()], 'b1', 'pagebreak', { tcState: tcOff })).toBeNull();
    });
    it('returns null when source block type not in Family A', () => {
      const b = blk({ type: 'title', depth: 1 });
      expect(convertBlockType([b], 'b1', 'note', { tcState: tcOff })).toBeNull();
    });
    it('returns null when newType equals current type', () => {
      expect(convertBlockType([blk({ type: 'note' })], 'b1', 'note', { tcState: tcOff })).toBeNull();
    });
  });

  describe('preserves html across all 20 ordered Family A pairs', () => {
    const html = '<p>preserve me <span class="mark-comment" data-comment-id="c1">word</span></p>';
    for (const from of FAMILY_A) {
      for (const to of FAMILY_A) {
        if (from === to) continue;
        it(`${from} -> ${to}`, () => {
          const b = blk({ type: from, html, ...(from === 'oli' ? { level: 2 } : {}) });
          const result = convertBlockType([b], 'b1', to, { tcState: tcOff });
          expect(result).not.toBeNull();
          expect(result.state[0].type).toBe(to);
          expect(result.state[0].html).toBe(html);
        });
      }
    }
  });

  describe('level delta', () => {
    it('entering oli with no prior level sets level=1', () => {
      const result = convertBlockType([blk({ type: 'txt' })], 'b1', 'oli', { tcState: tcOff });
      expect(result.state[0].level).toBe(1);
    });
    it('entering oli with stashed level restores it', () => {
      const result = convertBlockType([blk({ type: 'txt', level: 3 })], 'b1', 'oli', { tcState: tcOff });
      expect(result.state[0].level).toBe(3);
    });
    it('leaving oli preserves level on the block (stash)', () => {
      const result = convertBlockType([blk({ type: 'oli', level: 4 })], 'b1', 'txt', { tcState: tcOff });
      expect(result.state[0].level).toBe(4);
    });
    it('non-oli pair does not touch level', () => {
      const result = convertBlockType([blk({ type: 'txt' })], 'b1', 'note', { tcState: tcOff });
      expect(result.state[0]).not.toHaveProperty('level');
    });
  });

  describe('TC composition', () => {
    it('undefined revision under TC ON -> chg', () => {
      const result = convertBlockType([blk()], 'b1', 'note', { tcState: tcOn });
      expect(result.state[0].revision).toBe('chg');
    });
    it("'add' revision under TC ON preserved", () => {
      const result = convertBlockType([blk({ revision: 'add' })], 'b1', 'note', { tcState: tcOn });
      expect(result.state[0].revision).toBe('add');
    });
    it("'del' revision under TC ON preserved", () => {
      const result = convertBlockType([blk({ revision: 'del' })], 'b1', 'note', { tcState: tcOn });
      expect(result.state[0].revision).toBe('del');
    });
    it("'chg' revision under TC ON idempotent", () => {
      const result = convertBlockType([blk({ revision: 'chg' })], 'b1', 'note', { tcState: tcOn });
      expect(result.state[0].revision).toBe('chg');
    });
    it('TC OFF leaves revision unchanged (undefined stays undefined)', () => {
      const result = convertBlockType([blk()], 'b1', 'note', { tcState: tcOff });
      expect(result.state[0].revision).toBeUndefined();
    });
    it("TC OFF leaves 'chg' unchanged", () => {
      const result = convertBlockType([blk({ revision: 'chg' })], 'b1', 'note', { tcState: tcOff });
      expect(result.state[0].revision).toBe('chg');
    });
  });

  describe('__convertedFrom transient field', () => {
    it('sets __convertedFrom when TC ON', () => {
      const result = convertBlockType([blk({ type: 'txt' })], 'b1', 'note', { tcState: tcOn });
      expect(result.state[0].__convertedFrom).toBe('txt');
    });
    it('does not set __convertedFrom when TC OFF', () => {
      const result = convertBlockType([blk({ type: 'txt' })], 'b1', 'note', { tcState: tcOff });
      expect(result.state[0]).not.toHaveProperty('__convertedFrom');
    });
  });

  describe('effects', () => {
    it('framing is newFrame', () => {
      const result = convertBlockType([blk()], 'b1', 'note', { tcState: tcOff });
      expect(result.effects.framing).toEqual({ kind: 'newFrame' });
    });
    it('substrateWrites is empty (type rides scalar publish)', () => {
      const result = convertBlockType([blk()], 'b1', 'note', { tcState: tcOff });
      expect(result.effects.substrateWrites).toEqual([]);
    });
    it('flush is null and focus is null (UI components own caret)', () => {
      const result = convertBlockType([blk()], 'b1', 'note', { tcState: tcOff });
      expect(result.effects.flush).toBeNull();
      expect(result.effects.focus).toBeNull();
    });
  });
});

describe('composeRevision', () => {
  it('TC ON, undefined -> chg', () => {
    expect(composeRevision(undefined, tcOn)).toBe('chg');
  });
  it('TC ON, add -> add', () => {
    expect(composeRevision('add', tcOn)).toBe('add');
  });
  it('TC ON, del -> del', () => {
    expect(composeRevision('del', tcOn)).toBe('del');
  });
  it('TC ON, chg -> chg', () => {
    expect(composeRevision('chg', tcOn)).toBe('chg');
  });
  it('TC OFF leaves all values unchanged', () => {
    expect(composeRevision(undefined, tcOff)).toBeUndefined();
    expect(composeRevision('add', tcOff)).toBe('add');
    expect(composeRevision('del', tcOff)).toBe('del');
    expect(composeRevision('chg', tcOff)).toBe('chg');
  });
});

describe('levelDelta', () => {
  it('entering oli with no prior level => { level: 1 }', () => {
    expect(levelDelta('txt', 'oli', undefined)).toEqual({ level: 1 });
  });
  it('entering oli with prior level => { level: priorLevel }', () => {
    expect(levelDelta('txt', 'oli', 3)).toEqual({ level: 3 });
  });
  it('leaving oli preserves level on block (returns {})', () => {
    expect(levelDelta('oli', 'txt', 4)).toEqual({});
  });
  it('non-oli pair returns {}', () => {
    expect(levelDelta('txt', 'note', undefined)).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/blocks-convert-type.test.js`

Expected: all tests FAIL with "convertBlockType is not a function" (or similar export-missing errors).

- [ ] **Step 3: Implement the three exports in `src/lib/blocks.js`**

Add at the end of the file (after the existing `convertBlock` at line 416-460):

```js
// ── convertBlockType / composeRevision / levelDelta (Family A in-place flip) ─

const FAMILY_A = new Set(['txt', 'note', 'oli', 'item', 'lst']);

/**
 * Compose the block-level revision flag for a type-conversion under TC.
 * Under TC ON: undefined -> 'chg'; existing add/del/chg preserved.
 * Under TC OFF: unchanged (no block-level revision implication from a
 * type flip when tracking is disabled).
 */
export function composeRevision(prev, tcState) {
  if (!tcState || !tcState.enabled) return prev;
  if (prev === 'add' || prev === 'del' || prev === 'chg') return prev;
  return 'chg';
}

/**
 * Compute the level-field delta for an oli-boundary conversion. Returns a
 * spreadable object (`{}` for no change, `{ level: N }` for set).
 *
 *   any -> oli  : restore stashed level if present, else level=1.
 *   oli -> any  : return {} so the spread preserves block.level as a stash.
 *   non-oli pair: return {}.
 *
 * The "stash" lives on the block itself (block.level remains after leaving
 * oli). Non-oli renderers ignore the field; .SEC serialization only emits
 * LEVEL for oli.
 */
export function levelDelta(fromType, toType, currentLevel) {
  if (toType === 'oli') {
    if (typeof currentLevel === 'number' && currentLevel >= 1 && currentLevel <= 4) {
      return { level: currentLevel };
    }
    return { level: 1 };
  }
  return {};
}

/**
 * Family-A in-place block-type conversion. Same id, preserves html. The
 * mounted PmEditableBlock and its EditorView survive across the flip
 * because (a) the wrapper key is block.id only (App.jsx — see plan Task 2)
 * and (b) all Family A types are editable, so PmEditableBlock's mount-effect
 * `editable` dep doesn't flip.
 *
 * Preconditions:
 *   - blockId must exist
 *   - both block.type and newType must be Family A
 *   - newType must differ from block.type
 * Returns null on any violation.
 */
export function convertBlockType(blocks, blockId, newType, { tcState } = {}) {
  if (!FAMILY_A.has(newType)) return null;
  const idx = blocks.findIndex(b => b.id === blockId);
  if (idx < 0) return null;
  const block = blocks[idx];
  if (!FAMILY_A.has(block.type)) return null;
  if (newType === block.type) return null;

  const next = blocks.slice();
  const composed = composeRevision(block.revision, tcState);
  const newBlock = {
    ...block,
    type: newType,
    ...levelDelta(block.type, newType, block.level),
  };
  if (composed !== block.revision) {
    newBlock.revision = composed;
  }
  // Transient UX hint: when TC is on and the convert introduces or carries
  // a 'chg' marker, surface the original type so accept/reject tooltips can
  // warn the user that type changes are not rolled back. Local-only; never
  // persisted, never synced (lives outside Y.Map SCALAR_KEYS).
  if (tcState?.enabled) {
    newBlock.__convertedFrom = block.type;
  }
  next[idx] = newBlock;

  return {
    state: next,
    effects: {
      framing: { kind: 'newFrame' },
      substrateWrites: [],
      flush: null,
      focus: null,
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/__tests__/blocks-convert-type.test.js`

Expected: all tests PASS.

- [ ] **Step 5: Run the existing blocks suite to verify no regression**

Run: `npx vitest run src/lib/__tests__/blocks.test.js`

Expected: all existing tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/blocks.js src/lib/__tests__/blocks-convert-type.test.js
git commit -m "feat(blocks): add convertBlockType pure verb for Family A

Same-id in-place flip across txt/note/oli/item/lst. Preserves html,
composes TC revision via composeRevision helper, restores stashed
oli level on re-entry via levelDelta helper, sets transient
__convertedFrom field under TC for accept/reject UX tooltip.

Spec: docs/superpowers/specs/2026-05-27-block-type-conversion-design.md"
```

---

## Task 2: Drop wrapper-key type-suffix + persistence regression test

**Files:**
- Modify: `src/App.jsx:2669` (one-line key change)
- Create: `src/components/__tests__/PmEditableBlock-convert-persist.test.jsx`

- [ ] **Step 1: Write the failing PmEditableBlock persistence test**

Create `src/components/__tests__/PmEditableBlock-convert-persist.test.jsx`. Pattern mirrors `PmEditableBlock-mount-race.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// Regression test for the wrapper-key drop (App.jsx:2669, dropping the
// `-${block.type}` suffix). Pins that PmEditableBlock keeps its mounted
// EditorView across a Family A type flip with the same block id.
//
// If a future change re-introduces a remount on type change (e.g. by
// adding `block.type` back into the wrapper key, or by changing
// PmEditableBlock's `editable` memo to exclude one of the Family A
// types), this test fires.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

import PmEditableBlock from '../PmEditableBlock.jsx';
import { htmlToPmFragment } from '../../lib/pmdoc-html.js';
import * as registry from '../../lib/block-registry.js';
import * as linting from '../../lib/linting.js';

function seedSlotV2(yStore, ydoc, blockId, html, type) {
  ydoc.transact(() => {
    const yMap = new Y.Map();
    yMap.set('type', type);
    yMap.set('part', 1);
    yMap.set('depth', 0);
    yMap.set('section', null);
    yMap.set('level', 1);
    yMap.set('revision', null);
    yMap.set('isNew', false);
    const yXml = new Y.XmlFragment();
    yMap.set('html', yXml);
    yStore.set(blockId, yMap);
    prosemirrorToYXmlFragment(htmlToPmFragment(html || ''), yXml);
  }, 'local-apply');
}

function defaultProps(block, yStore) {
  return {
    block,
    yStore,
    onUpdate: vi.fn(),
    onEnterKey: vi.fn(),
    isFocused: false,
    onFocus: vi.fn(),
    oliLabel: null,
    onDelete: vi.fn(),
    onFocusPrev: vi.fn(),
    onFocusNext: vi.fn(),
    onConvertBlock: vi.fn(),
    onChangeOliLevel: vi.fn(),
    resolveHtml: (h) => h,
    tailorKey: '',
    trackChanges: { enabled: false, publishSeq: 0 },
    identity: { authorId: 'a1', authorName: 'A', authorColor: '#000' },
    readOnly: false,
    onAcceptRevision: vi.fn(),
    onRejectRevision: vi.fn(),
    lintSeverity: null,
    lintingActive: false,
    lintingState: linting.createInitial(),
    onLintAction: vi.fn(),
  };
}

describe('PmEditableBlock — convert persistence', () => {
  beforeEach(() => {
    registry.__resetBlockRegistry();
  });

  afterEach(() => {
    registry.__resetBlockRegistry();
  });

  it('keeps the same registered handle across txt -> note', async () => {
    const ydoc = new Y.Doc();
    const yStore = ydoc.getMap('store');
    seedSlotV2(yStore, ydoc, 'b1', '<p>hello</p>', 'txt');
    const block = { id: 'b1', type: 'txt', html: '<p>hello</p>' };
    const { rerender } = render(<PmEditableBlock {...defaultProps(block, yStore)} />);
    await act(async () => {});

    const handleBefore = registry.getBlockHandle('b1');
    expect(handleBefore).not.toBeNull();
    const domBefore = handleBefore.getEditable();

    // Same id, type flipped to note. This is what `handleConvertBlockType`
    // produces.
    const blockAfter = { ...block, type: 'note' };
    rerender(<PmEditableBlock {...defaultProps(blockAfter, yStore)} />);
    await act(async () => {});

    const handleAfter = registry.getBlockHandle('b1');
    expect(handleAfter).not.toBeNull();
    expect(Object.is(handleBefore, handleAfter)).toBe(true);

    // Belt-and-suspenders: PM EditorView DOM root identity is preserved.
    const domAfter = handleAfter.getEditable();
    expect(domBefore).not.toBeNull();
    expect(Object.is(domBefore, domAfter)).toBe(true);
  });

  it('keeps the same handle across oli -> item -> lst (chain)', async () => {
    const ydoc = new Y.Doc();
    const yStore = ydoc.getMap('store');
    seedSlotV2(yStore, ydoc, 'b1', '<p>x</p>', 'oli');
    const props = defaultProps({ id: 'b1', type: 'oli', level: 2, html: '<p>x</p>' }, yStore);
    const { rerender } = render(<PmEditableBlock {...props} />);
    await act(async () => {});

    const handle1 = registry.getBlockHandle('b1');

    rerender(<PmEditableBlock {...defaultProps({ id: 'b1', type: 'item', html: '<p>x</p>' }, yStore)} />);
    await act(async () => {});
    const handle2 = registry.getBlockHandle('b1');
    expect(Object.is(handle1, handle2)).toBe(true);

    rerender(<PmEditableBlock {...defaultProps({ id: 'b1', type: 'lst', html: '<p>x</p>' }, yStore)} />);
    await act(async () => {});
    const handle3 = registry.getBlockHandle('b1');
    expect(Object.is(handle1, handle3)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the persistence test against current code (still failing — pre-fix)**

Run: `npx vitest run src/components/__tests__/PmEditableBlock-convert-persist.test.jsx`

Expected: FAIL. Today, `<App>` wraps PmEditableBlock with `key={\`${block.id}-${block.type}\`}` so a type-flipped re-render remounts. But this test renders PmEditableBlock directly without that wrapper — it will probably PASS even without the App-side fix, because the test bypasses the wrapper. **Verify behavior:** if it passes anyway, the test is correct but the App fix is still needed because real users see the wrapper. Add a `// NOTE: This test confirms PmEditableBlock itself supports same-id reuse; the wrapper-key drop in App.jsx (next step) makes that reuse reachable from the App render path.` comment to the test's first `it` description.

If the test FAILS (PmEditableBlock has internal remount-on-type behavior), debug PmEditableBlock — that's a separate issue not addressed by this plan.

- [ ] **Step 3: Drop the type-suffix from App.jsx wrapper key**

Modify `src/App.jsx:2669`:

```diff
-              <div key={`${block.id}-${block.type}`}>
+              <div key={block.id}>
```

- [ ] **Step 4: Run the persistence test, the existing mount-race test, and the full PmEditableBlock test set**

Run: `npx vitest run src/components/__tests__/PmEditableBlock-convert-persist.test.jsx src/components/__tests__/PmEditableBlock-mount-race.test.jsx`

Expected: both PASS.

Run: `npx vitest run src/components/__tests__/`

Expected: all PASS.

- [ ] **Step 5: Run unit + lib tests for any wrapper-key fallout**

Run: `npm test`

Expected: all PASS. If anything fails, inspect the failure — the wrapper-key drop should be invisible to non-conversion flows because no other path mutates `block.type` without also changing `block.id` (verified in spec §4.3 audit).

- [ ] **Step 6: Commit**

```bash
git add src/App.jsx src/components/__tests__/PmEditableBlock-convert-persist.test.jsx
git commit -m "feat(editor): drop vestigial type-suffix from block wrapper key

Wrapper key was '\${block.id}-\${block.type}' since the initial commit;
verified vestigial via audit (no existing path mutates type without
also changing id). Drop enables same-id type-conversion to reuse the
mounted PmEditableBlock + its EditorView.

Regression test (PmEditableBlock-convert-persist) pins the new
invariant — handle identity preserved across txt/note/oli/item/lst flips."
```

---

## Task 3: App handler + prop plumbing

**Files:**
- Modify: `src/App.jsx` — add `handleConvertBlockType` near existing `handleConvertBlock` (~line 1231), pass new prop on PmEditableBlock (~line 2681).
- Modify: `src/components/PmEditableBlock.jsx` — accept new `onConvertBlockType` prop, mirror existing `onConvertBlock` ref pattern at line 183-184.

- [ ] **Step 1: Add `handleConvertBlockType` in App.jsx**

Locate the existing `handleConvertBlock` at `src/App.jsx:1231-1234`. Add immediately after it:

```js
const handleConvertBlockType = useCallback((blockId, newType) => {
  dispatchBlocks((b) => Blocks.convertBlockType(b, blockId, newType, { tcState: tcStateRef.current }));
  setLintingState((s) => linting.clearBlock(s, blockId));
  setOpenCommentId((id) => {
    if (!id) return id;
    const c = commentsStateRef.current?.byId.get(id);
    return c?.blockId === blockId ? null : id;
  });
}, [dispatchBlocks]);
```

Notes for the implementer:
- `tcStateRef` already exists (verify by `grep -n tcStateRef src/App.jsx`). If a `tcStateRef` is not present but `tcState` is in scope, add `const tcStateRef = useRef(tcState); tcStateRef.current = tcState;` near the `setTcState` declaration at line 151.
- `commentsStateRef` already exists (line 200: `commentsStateRef.current = commentsState;`).
- `linting.clearBlock` is the existing pure verb at `src/lib/linting.js:172`.
- No dep on `commentsState` in the useCallback array — reading via the ref so the callback identity stays stable.

- [ ] **Step 2: Wire the new prop on PmEditableBlock**

In `src/App.jsx` at the PmEditableBlock render around line 2681, add:

```diff
                  onConvertBlock={handleConvertBlock}
+                  onConvertBlockType={handleConvertBlockType}
                  onChangeOliLevel={handleChangeOliLevel}
```

- [ ] **Step 3: Accept the prop in PmEditableBlock + ref pattern**

In `src/components/PmEditableBlock.jsx`:

(a) Add `onConvertBlockType` to the destructured props list near line 124 (right after `onConvertBlock`):

```diff
   onConvertBlock,
+  onConvertBlockType,
   onChangeOliLevel,
```

(b) Add the ref mirror near line 183 (right after `onConvertBlockRef`):

```diff
   const onConvertBlockRef = useRef(onConvertBlock);
   onConvertBlockRef.current = onConvertBlock;
+  const onConvertBlockTypeRef = useRef(onConvertBlockType);
+  onConvertBlockTypeRef.current = onConvertBlockType;
```

(c) Add JSDoc entry at the top of the file's existing doc-comment block (search for the existing `* - onConvertBlock, onChangeOliLevel` line around line 13):

```diff
- *   - onConvertBlock, onChangeOliLevel
+ *   - onConvertBlock, onConvertBlockType, onChangeOliLevel
```

- [ ] **Step 4: Run vitest + existing E2E smoke to ensure nothing is broken**

Run: `npm test`

Expected: all PASS.

Run: `npx playwright test --project=chromium --grep "creates a new block"` (smoke — confirm App renders, slash convert still works)

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx src/components/PmEditableBlock.jsx
git commit -m "feat(app): handleConvertBlockType + plumbing

Wire convertBlockType verb to App via handleConvertBlockType:
- dispatchBlocks(convertBlockType)
- setLintingState(clearBlock) drops stale findings (spec §5#3)
- setOpenCommentId closes any comment popup anchored to the
  converted block (positional drift after type flip)

PmEditableBlock accepts new onConvertBlockType prop mirroring
existing onConvertBlock ref pattern. UI components in subsequent
tasks consume the ref."
```

---

## Task 4: BlockGutterMenu UI component

**Files:**
- Create: `src/components/BlockGutterMenu.jsx`
- Modify: `src/components/PmEditableBlock.jsx` — render the gutter menu inline in the block's outer container, gated on Family A + non-revisioned + non-readonly.

- [ ] **Step 1: Create `src/components/BlockGutterMenu.jsx`**

```jsx
import { useEffect, useRef, useState } from 'react';

// Family A targets exposed in the convert menu. Note: `title` is NOT
// included — title conversion is a separate flow (slash menu / delete +
// recreate). The 4 entries shown are always "the OTHER family A types".
const FAMILY_A_LABELS = {
  txt: { label: 'Paragraph', icon: '¶' },
  note: { label: 'Designer Note', icon: '✉' },
  oli: { label: 'Ordered List', icon: 'a.' },
  item: { label: 'List Item', icon: '•' },
  lst: { label: 'List Header', icon: '☰' },
};
const FAMILY_A_ORDER = ['txt', 'note', 'oli', 'item', 'lst'];

/**
 * BlockGutterMenu — left-gutter popover for converting between Family A
 * block types. Visible only on hover of the parent PmEditableBlock; the
 * parent controls the hover state via its own :hover listener and passes
 * `visible` to this component.
 *
 * Click flow:
 *   onMouseDown(button)   — preventDefault to keep PM focus
 *   onClick(button)       — toggle popover open
 *   onClick(menu item)    — call onConvert(newType); close popover
 *
 * After dispatch, the parent re-focuses the PM EditorView via the block
 * registry (handled in PmEditableBlock — see Task 4 step 2).
 */
export default function BlockGutterMenu({ currentType, visible, onConvert, anchorLeft = -22 }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!visible && !open) return null;

  const targets = FAMILY_A_ORDER.filter(t => t !== currentType);

  return (
    <div ref={ref} style={{ position: 'absolute', left: anchorLeft, top: 4, zIndex: 12 }}>
      <button
        type="button"
        aria-label="Convert block"
        title="Convert block type"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen(o => !o)}
        style={{
          width: 14, height: 14, border: '1px solid #cbd5e1',
          borderRadius: 3, backgroundColor: '#ffffff', color: '#64748b',
          fontSize: 11, cursor: 'pointer', padding: 0, lineHeight: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >&#8645;</button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', left: 18, top: 0, zIndex: 1000,
            backgroundColor: '#ffffff', border: '1px solid #e2e8f0',
            borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
            width: 220, padding: '4px 0', overflow: 'hidden',
          }}
        >
          <div style={{
            padding: '6px 12px 4px', fontSize: 10, color: '#94a3b8',
            fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>Turn into</div>
          {targets.map(t => (
            <div
              key={t}
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false);
                onConvert(t);
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '6px 12px', cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#f1f5f9'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              <span style={{
                width: 24, height: 24, borderRadius: 4, backgroundColor: '#f1f5f9',
                border: '1px solid #e2e8f0', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                fontSize: 13, fontWeight: 700, color: '#475569',
              }}>{FAMILY_A_LABELS[t].icon}</span>
              <span style={{ fontSize: 13, color: '#1e293b' }}>{FAMILY_A_LABELS[t].label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount BlockGutterMenu in PmEditableBlock**

In `src/components/PmEditableBlock.jsx`, near the top of the file's imports add:

```js
import BlockGutterMenu from './BlockGutterMenu.jsx';
import { getBlockHandle } from '../lib/block-registry.js';
```

(If `getBlockHandle` is already imported via a barrel, skip the second import.)

In the JSX render around line 852-906 (the main `<div id={\`block-${block.id}\`}` wrapper), add a hover state and render the menu just before the existing revision buttons. Pattern:

```jsx
// near other useState / useRef at the top of the render body
const [hovering, setHovering] = useState(false);

const isFamilyA = block.type === 'txt' || block.type === 'note' ||
                  block.type === 'oli' || block.type === 'item' || block.type === 'lst';
const showGutterMenu = isFamilyA && !block.revision && !readOnly;

// ... inside the return, around line 853:
return (
  <div
    id={`block-${block.id}`}
    style={{ position: 'relative' }}
    className={revisionClass}
    data-tag={sgmlTag}
    data-block-type={block.type}
    onMouseEnter={() => setHovering(true)}
    onMouseLeave={() => setHovering(false)}
  >
    {showGutterMenu && (
      <BlockGutterMenu
        currentType={block.type}
        visible={hovering}
        onConvert={(newType) => {
          onConvertBlockTypeRef.current?.(block.id, newType);
          // Re-focus the EditorView after dispatch so the caret returns
          // to the editor body (the gutter button stole focus on click).
          // The handle identity is preserved across the type flip (Task 2
          // wrapper-key drop), so this targets the same view.
          requestAnimationFrame(() => {
            const handle = getBlockHandle(block.id);
            handle?.focus?.({ atEnd: false });
          });
        }}
      />
    )}
    {(block.revision || hasInlineRevisions) && onAcceptRevision && (
      // ... existing accept/reject button block stays unchanged ...
    )}
    // ... rest unchanged ...
  </div>
);
```

**Important:**
- Add `data-block-type={block.type}` to the outer wrapper — the E2E tests in Task 7 assert on this attribute.
- The hover state is local to PmEditableBlock (`useState`), not lifted to App.
- `showGutterMenu` deliberately hides when `block.revision` is set (collision rule per spec §4.5).

- [ ] **Step 3: Spot-check the dev server**

Run: `npm run dev`

Open `http://localhost:5173/` in a browser, open a sample doc, hover a txt block. Expected: small ↕ button appears at the left gutter. Click it. Expected: popover lists 4 options (Designer Note, Ordered List, List Item, List Header). Click "Designer Note". Expected: block converts to a note with the yellow left border + amber background. Type a character into the converted block. Expected: text enters as normal — PM view is alive.

Hover a TXT block that has revision marks. Expected: gutter handle does NOT appear (collision rule).

Stop the dev server.

- [ ] **Step 4: Run vitest**

Run: `npm test`

Expected: all PASS. (No new unit test for the menu itself — Task 7's E2E covers it. The component is small enough that the E2E is the right granularity.)

- [ ] **Step 5: Commit**

```bash
git add src/components/BlockGutterMenu.jsx src/components/PmEditableBlock.jsx
git commit -m "feat(editor): gutter handle for Family A block-type conversion

Hover-revealed ↕ button at left:-22 opens a popover listing the
4 other Family A types. onMouseDown preventDefault keeps PM focus
across the click. After dispatch, requestAnimationFrame re-focuses
the EditorView via block-registry.

Hides when block has block-level revision (collision rule per
spec §4.5) and when readOnly. Adds data-block-type attribute on
the wrapper for E2E assertions."
```

---

## Task 5: ConvertBlockPalette + keyboard shortcut

**Files:**
- Create: `src/components/ConvertBlockPalette.jsx`
- Modify: `src/App.jsx` — mount the palette, wire `Ctrl+Shift+M` into the existing global keydown handler around line 1677-1727.

- [ ] **Step 1: Create `src/components/ConvertBlockPalette.jsx`**

```jsx
import { useEffect, useMemo, useRef, useState } from 'react';

const FAMILY_A_ENTRIES = [
  { type: 'txt', label: 'Paragraph', icon: '¶' },
  { type: 'note', label: 'Designer Note', icon: '✉' },
  { type: 'oli', label: 'Ordered List', icon: 'a.' },
  { type: 'item', label: 'List Item', icon: '•' },
  { type: 'lst', label: 'List Header', icon: '☰' },
];

/**
 * ConvertBlockPalette — floating filterable list opened by Ctrl+Shift+M
 * when focus is in a Family A block. Caret preservation: the parent
 * (App) captures the PM selection BEFORE opening; on close (Esc or
 * selection) the parent restores it via the block-registry view handle.
 *
 * Props:
 *   currentType, anchorRect (DOMRect | null), onConvert(newType), onClose
 */
export default function ConvertBlockPalette({ currentType, anchorRect, onConvert, onClose }) {
  const [filter, setFilter] = useState('');
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef(null);
  const containerRef = useRef(null);

  // Exclude the currentType, then filter by typed prefix.
  const items = useMemo(() => {
    const q = filter.toLowerCase();
    return FAMILY_A_ENTRIES
      .filter(e => e.type !== currentType)
      .filter(e => !q || e.label.toLowerCase().startsWith(q));
  }, [filter, currentType]);

  // Clamp selection on filter changes.
  useEffect(() => {
    setSelectedIdx(prev => Math.min(prev, Math.max(items.length - 1, 0)));
  }, [items.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on outside click.
  useEffect(() => {
    const onDocClick = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose]);

  const top = anchorRect ? anchorRect.top + 24 : 80;
  const left = anchorRect ? Math.max(8, anchorRect.left) : 80;

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Convert block type"
      style={{
        position: 'fixed', top, left, zIndex: 2000,
        backgroundColor: '#ffffff', border: '1px solid #cbd5e1',
        borderRadius: 8, boxShadow: '0 10px 30px rgba(0,0,0,0.15)',
        width: 260, padding: 6,
      }}
    >
      <input
        ref={inputRef}
        type="text"
        placeholder="Convert to…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIdx((i) => Math.min(i + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const choice = items[selectedIdx];
            if (choice) onConvert(choice.type);
          }
        }}
        style={{
          width: '100%', padding: '6px 8px', border: '1px solid #e2e8f0',
          borderRadius: 4, fontSize: 13, outline: 'none', boxSizing: 'border-box',
        }}
      />
      <div style={{ marginTop: 4, maxHeight: 220, overflowY: 'auto' }}>
        {items.length === 0 && (
          <div style={{ padding: 8, fontSize: 12, color: '#94a3b8' }}>No matches</div>
        )}
        {items.map((item, i) => (
          <div
            key={item.type}
            role="option"
            aria-selected={i === selectedIdx}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onConvert(item.type)}
            onMouseEnter={() => setSelectedIdx(i)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 8px', cursor: 'pointer', borderRadius: 4,
              backgroundColor: i === selectedIdx ? '#f1f5f9' : 'transparent',
            }}
          >
            <span style={{
              width: 24, height: 24, borderRadius: 4, backgroundColor: '#f1f5f9',
              border: '1px solid #e2e8f0', display: 'flex',
              alignItems: 'center', justifyContent: 'center',
              fontSize: 13, fontWeight: 700, color: '#475569',
            }}>{item.icon}</span>
            <span style={{ fontSize: 13, color: '#1e293b' }}>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add palette state + keyboard shortcut in App.jsx**

In `src/App.jsx`, add near the other UI state declarations (e.g. after `setSearchOpen` around line 1707):

```js
const [convertPalette, setConvertPalette] = useState(null);
// { blockId, currentType, anchorRect, savedSelection } | null
```

Add an import at the top of `src/App.jsx`:

```js
import ConvertBlockPalette from './components/ConvertBlockPalette.jsx';
```

(If imports are grouped by source, add it with other `./components/` imports.)

In the global keydown handler at `src/App.jsx:1677-1727`, add a new branch BEFORE the closing `}`. Pattern: between the Ctrl+0 branch (line 1721) and the closing brace:

```js
} else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
  e.preventDefault();
  if (!focusedBlockId) return;
  const focusedBlock = blocks.find(b => b.id === focusedBlockId);
  if (!focusedBlock) return;
  const isFamilyA = ['txt', 'note', 'oli', 'item', 'lst'].includes(focusedBlock.type);
  if (!isFamilyA) return;
  if (collabReadOnly) return;
  // Capture the PM selection so we can restore the caret post-dispatch.
  const view = getBlockView(focusedBlockId);
  const savedSelection = view ? { from: view.state.selection.from, to: view.state.selection.to } : null;
  const dom = document.querySelector(`[data-block-id="${focusedBlockId}"]`)
    || document.getElementById(`block-${focusedBlockId}`);
  const anchorRect = dom ? dom.getBoundingClientRect() : null;
  setConvertPalette({ blockId: focusedBlockId, currentType: focusedBlock.type, anchorRect, savedSelection });
}
```

Add `getBlockView` to the imports if not already present:

```js
import { getBlockView } from './lib/block-registry.js';
```

Add `blocks, focusedBlockId, collabReadOnly` to the existing useEffect's dep array on the keydown listener (current deps end at line 1733 — locate and append).

- [ ] **Step 3: Render the palette + handle convert/close**

In App.jsx's JSX, near where other floating overlays render (search for the SearchBar / FloatingToolbar render around the bottom of the return statement), add:

```jsx
Add an import at the top of `src/App.jsx` (group with other PM imports if any):

```js
import { TextSelection } from 'prosemirror-state';
```

Add this in App.jsx's JSX near where other floating overlays render (search for the SearchBar / FloatingToolbar render around the bottom of the return statement):

```jsx
{convertPalette && (
  <ConvertBlockPalette
    currentType={convertPalette.currentType}
    anchorRect={convertPalette.anchorRect}
    onConvert={(newType) => {
      const { blockId, savedSelection } = convertPalette;
      handleConvertBlockType(blockId, newType);
      setConvertPalette(null);
      // Restore PM caret + focus after dispatch. requestAnimationFrame
      // gives React time to flush the re-render so the EditorView's
      // selection state matches the doc.
      requestAnimationFrame(() => {
        const view = getBlockView(blockId);
        if (!view) return;
        view.focus();
        if (savedSelection) {
          try {
            const docSize = view.state.doc.content.size;
            const safeFrom = Math.min(savedSelection.from, docSize);
            const safeTo = Math.min(savedSelection.to, docSize);
            const tr = view.state.tr.setSelection(
              TextSelection.create(view.state.doc, safeFrom, safeTo)
            );
            view.dispatch(tr);
          } catch { /* defensive — selection restore is best-effort */ }
        }
      });
    }}
    onClose={() => {
      const { blockId } = convertPalette;
      setConvertPalette(null);
      requestAnimationFrame(() => {
        const view = getBlockView(blockId);
        if (view) view.focus();
      });
    }}
  />
)}
```

- [ ] **Step 4: Run vitest**

Run: `npm test`

Expected: all PASS.

- [ ] **Step 5: Manual smoke in dev server**

Run: `npm run dev`

Open `http://localhost:5173/`, click into a paragraph block, position the caret in the middle of a word. Press `Ctrl+Shift+M`. Expected: palette appears anchored near the block. Type `n` — list filters to "Designer Note". Press Enter. Expected: block converts to note, caret returns to the original word position.

Press `Ctrl+Shift+M` again, press Escape. Expected: palette closes, focus returns to the block.

Click into a table block, press `Ctrl+Shift+M`. Expected: nothing happens (Family A guard).

Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add src/components/ConvertBlockPalette.jsx src/App.jsx
git commit -m "feat(editor): Ctrl+Shift+M palette for block-type conversion

Floating filterable palette for Family A conversions. Captures PM
selection on open; restores caret via TextSelection dispatch after
re-rendering completes (requestAnimationFrame guard).

Guards: only opens when focused block is Family A and not readOnly.
Closes on Escape, click outside, or selection."
```

---

## Task 6: Accept/Reject __convertedFrom tooltip + clear on accept/reject

**Files:**
- Modify: `src/lib/blocks.js` — `acceptBlockRevision` and `rejectBlockRevision` clear `__convertedFrom` along with `revision`.
- Modify: `src/components/PmEditableBlock.jsx` — accept/reject buttons get extended `title` attribute when `block.__convertedFrom` is set.
- Modify: `src/lib/__tests__/blocks-convert-type.test.js` — add tests for __convertedFrom clear behavior.

- [ ] **Step 1: Add failing tests for __convertedFrom clear**

Append to `src/lib/__tests__/blocks-convert-type.test.js`:

```js
import { acceptBlockRevision, rejectBlockRevision } from '../blocks.js';

describe('acceptBlockRevision clears __convertedFrom', () => {
  it("clears __convertedFrom alongside 'chg' revision", () => {
    const b = blk({ revision: 'chg', __convertedFrom: 'txt', type: 'note' });
    const result = acceptBlockRevision([b], 'b1');
    expect(result).not.toBeNull();
    expect(result.state[0].revision).toBeUndefined();
    expect(result.state[0]).not.toHaveProperty('__convertedFrom');
    expect(result.state[0].type).toBe('note'); // type IS preserved (audit limit)
  });

  it("clears __convertedFrom alongside 'add' revision", () => {
    const b = blk({ revision: 'add', __convertedFrom: 'txt', type: 'note' });
    const result = acceptBlockRevision([b], 'b1');
    expect(result.state[0]).not.toHaveProperty('__convertedFrom');
  });
});

describe('rejectBlockRevision clears __convertedFrom', () => {
  it("clears __convertedFrom alongside 'chg' revision", () => {
    const b = blk({ revision: 'chg', __convertedFrom: 'txt', type: 'note' });
    const result = rejectBlockRevision([b], 'b1');
    expect(result).not.toBeNull();
    expect(result.state[0].revision).toBeUndefined();
    expect(result.state[0]).not.toHaveProperty('__convertedFrom');
    expect(result.state[0].type).toBe('note'); // type IS preserved (audit limit)
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/__tests__/blocks-convert-type.test.js -t "__convertedFrom"`

Expected: tests FAIL because acceptBlockRevision/rejectBlockRevision don't currently touch `__convertedFrom`.

- [ ] **Step 3: Update acceptBlockRevision and rejectBlockRevision in `src/lib/blocks.js`**

Add a tiny helper near the top of the file's other small helpers (e.g. near `htmlWrite`):

```js
function withoutConvertedFrom(block) {
  if (!('__convertedFrom' in block)) return block;
  const next = { ...block };
  delete next.__convertedFrom;
  return next;
}
```

In `acceptBlockRevision` at line 502-527, wrap each `next[idx] = { ...block, revision: undefined, ... }` site with `withoutConvertedFrom`. Two write sites:

```diff
   const next = blocks.slice();
   if (typeof block.html === 'string') {
     const html = acceptAllInline(block.html);
-    next[idx] = { ...block, revision: undefined, html };
+    next[idx] = withoutConvertedFrom({ ...block, revision: undefined, html });
     const writes = block.html !== html ? [htmlWrite(blockId, html)] : [];
     return {
       state: next,
       effects: { framing: { kind: 'newFrame' }, substrateWrites: writes, flush: null, focus: null },
     };
   }
-  next[idx] = { ...block, revision: undefined };
+  next[idx] = withoutConvertedFrom({ ...block, revision: undefined });
   return withForceFrame(next);
```

Apply the same two-site replacement to `rejectBlockRevision` at line 529-554.

(The `revision === 'del'` early-return paths drop the block entirely, so no `__convertedFrom` cleanup is needed there.)

- [ ] **Step 4: Add title attribute to accept/reject buttons in PmEditableBlock**

In `src/components/PmEditableBlock.jsx` around line 854-869, modify the buttons' `title` props:

```diff
+  const convertedFromHint = block.__convertedFrom
+    ? ` (block was converted from ${block.__convertedFrom}; the type change is preserved on accept and NOT rolled back on reject — use Ctrl+Z to undo type changes)`
+    : '';
+
       {(block.revision || hasInlineRevisions) && onAcceptRevision && (
         <div style={{
           position: 'absolute', left: -4, top: 4, display: 'flex',
           flexDirection: 'column', gap: 2, zIndex: 10,
         }}>
           <button
             onClick={() => onAcceptRevision(block.id)}
-            title={block.revision ? `Accept ${block.revision}` : 'Accept inline changes'}
+            title={(block.revision ? `Accept ${block.revision}` : 'Accept inline changes') + convertedFromHint}
             style={gutterBtn('#008000', '#f0fdf4')}
           >✓</button>
           <button
             onClick={() => onRejectRevision(block.id)}
-            title={block.revision ? `Reject ${block.revision}` : 'Reject inline changes'}
+            title={(block.revision ? `Reject ${block.revision}` : 'Reject inline changes') + convertedFromHint}
             style={gutterBtn('#ff4444', '#fef2f2')}
           >✗</button>
         </div>
       )}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/lib/__tests__/blocks-convert-type.test.js`

Expected: all PASS including the new __convertedFrom tests.

Run: `npm test`

Expected: all PASS (no regression in acceptBlockRevision/rejectBlockRevision callers).

- [ ] **Step 6: Commit**

```bash
git add src/lib/blocks.js src/components/PmEditableBlock.jsx src/lib/__tests__/blocks-convert-type.test.js
git commit -m "feat(blocks): clear __convertedFrom on accept/reject + UX tooltip

Accept/reject now also clear the transient __convertedFrom field
alongside the revision flag. PmEditableBlock's accept/reject buttons
get an extended title attribute when __convertedFrom is set, warning
the user that type changes survive accept and require Ctrl+Z to undo.

Audit-trail limitation per spec §4.4: type change is NOT rolled back
by reject; this is intentional (avoids parallel logic in resolution
paths)."
```

---

## Task 7: E2E scenarios

**Files:**
- Modify: `tests/e2e/editor.spec.js` — append 5 new tests (4 spec scenarios + level-loss regression).

- [ ] **Step 1: Audit existing E2E helpers before writing the new tests**

Run these checks and note results:

1. `grep -n "pmGetSelection\|pmSetSelection" tests/e2e/pm-helpers.js` — confirm both exist. (CLAUDE.md mentions these as added in 1f.9.)
2. `grep -n "function createFreshBlock\|export function createFreshBlock" tests/e2e/` — find the existing block-creation helper. Note its signature.
3. `grep -n "ensureTcOn\|ensureTcOff\|setTrackChanges" tests/e2e/` — find the TC toggle helper. If absent, find the existing TC-on/off pattern in `editor.spec.js` and extract into a helper.
4. `grep -n "addCommentOnRange\|createComment" tests/e2e/` — find the comment-creation helper.
5. `grep -n "loadSample\|loadSpec\|gotoEditor" tests/e2e/` — find the sample-doc loader.
6. `grep -n "data-lint-rule\|data-rule-id" src/` — find what attribute the lint highlights emit. The test at step 2 below uses `[data-lint-rule="TERM-shall"]`; adjust to whatever the codebase actually uses.
7. `grep -n "data-test=\"oli-label\"\|data-oli-label" src/` — check if a test-friendly attribute exists on the oli label span. If not, the test at step 2 needs to assert via the label's text content alone.

If any helper is missing, add it as a small (5-20 LOC) addition to `tests/e2e/pm-helpers.js` or the existing helpers file, following the codebase style. Surface the additions to the user as part of this step.

- [ ] **Step 2: Append the new tests to `tests/e2e/editor.spec.js`**

Locate the bottom of the file and append a new `test.describe` block:

```js
test.describe('block-type conversion (Family A)', () => {

  test('gutter handle preserves comments across txt -> note', async ({ page }) => {
    await loadSample(page);  // existing helper — adjust to whatever fixture loader the file uses
    // Disable TC for this scenario so the block-level wrapper class
    // is unchanged across conversion.
    await ensureTcOff(page);

    // Create a txt block with content + a comment.
    const blockId = await createFreshBlock(page, 'txt', 'paragraph with comment');
    const commentId = await addCommentOnRange(page, blockId, /* startOffset */ 9, /* endOffset */ 16);

    // Open the gutter handle on hover, click "Designer Note".
    await page.locator(`[data-block-id="${blockId}"]`).hover();
    await page.locator(`[data-block-id="${blockId}"] [aria-label="Convert block"]`).click();
    await page.locator('[role="menu"] [role="menuitem"]:has-text("Designer Note")').click();

    // Assertions.
    await expect(page.locator(`[data-block-id="${blockId}"]`)).toHaveAttribute('data-block-type', 'note');
    // Inner html (mark span) preserved.
    await expect(
      page.locator(`[data-block-id="${blockId}"] .mark-comment[data-comment-id="${commentId}"]`)
    ).toBeVisible();
    // Comment popup closed by handleConvertBlockType.
    await expect(page.locator('[data-test="comment-popup"]')).toHaveCount(0);
  });

  test('keyboard shortcut preserves caret across txt -> oli', async ({ page }) => {
    await loadSample(page);
    await ensureTcOff(page);

    const blockId = await createFreshBlock(page, 'txt', 'hello world');
    await focusBlock(page, blockId);
    await pmSetSelection(page, blockId, 5, 5);  // caret after 'hello'

    await page.keyboard.press('Control+Shift+M');
    await expect(page.locator('[role="dialog"][aria-label="Convert block type"]')).toBeVisible();
    await page.keyboard.type('o');  // filter to oli
    await page.keyboard.press('Enter');

    await expect(page.locator(`[data-block-id="${blockId}"]`)).toHaveAttribute('data-block-type', 'oli');
    const sel = await pmGetSelection(page, blockId);
    expect(sel.from).toBe(5);
  });

  test('stale lint clears on conversion txt -> note', async ({ page }) => {
    await loadSample(page);
    await ensureTcOff(page);

    const blockId = await createFreshBlock(page, 'txt', '');
    await focusBlock(page, blockId);
    // Type "shall" — triggers TERM-shall compliance flag.
    await page.keyboard.type('The contractor shall provide.');
    // Confirm the highlight rendered (CSS.highlights -> .mark-compliance somewhere
    // in the DOM, or a data-test marker on the linter dot).
    await expect(page.locator(`[data-block-id="${blockId}"] [data-lint-rule="TERM-shall"]`).first()).toBeVisible();

    // Convert via shortcut.
    await page.keyboard.press('Control+Shift+M');
    await page.keyboard.type('n');
    await page.keyboard.press('Enter');

    // Flag cleared within one render frame.
    await expect(
      page.locator(`[data-block-id="${blockId}"] [data-lint-rule="TERM-shall"]`)
    ).toHaveCount(0);
  });

  test('TC mode: convert + accept preserves type (audit-trail limitation)', async ({ page }) => {
    await loadSample(page);
    await ensureTcOn(page);

    const blockId = await createFreshBlock(page, 'txt', 'tracked content');
    await focusBlock(page, blockId);

    await page.keyboard.press('Control+Shift+M');
    await page.keyboard.type('n');
    await page.keyboard.press('Enter');

    // Block carries the chg styling.
    await expect(page.locator(`[data-block-id="${blockId}"]`)).toHaveClass(/block-revision-chg/);

    // Accept via the gutter accept button.
    await page.locator(`[data-block-id="${blockId}"] button[title*="Accept"]`).click();

    // Type IS preserved (intentional limitation per spec §4.4).
    await expect(page.locator(`[data-block-id="${blockId}"]`)).toHaveAttribute('data-block-type', 'note');
    await expect(page.locator(`[data-block-id="${blockId}"]`)).not.toHaveClass(/block-revision-chg/);
  });

  test('oli level survives txt round-trip (regression)', async ({ page }) => {
    await loadSample(page);
    await ensureTcOff(page);

    const blockId = await createFreshBlock(page, 'oli', 'list item');
    await focusBlock(page, blockId);
    // Tab three times to reach level 3.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    // Confirm level 3 visible (oliLabel is "(1)" at level 2, "(a)" at level 3 — verify
    // against numbering.js semantics during implementation).

    // Convert to txt.
    await page.keyboard.press('Control+Shift+M');
    await page.keyboard.type('p');
    await page.keyboard.press('Enter');
    await expect(page.locator(`[data-block-id="${blockId}"]`)).toHaveAttribute('data-block-type', 'txt');

    // Convert back to oli.
    await page.keyboard.press('Control+Shift+M');
    await page.keyboard.type('o');
    await page.keyboard.press('Enter');
    await expect(page.locator(`[data-block-id="${blockId}"]`)).toHaveAttribute('data-block-type', 'oli');

    // Level still 3 — read from oliLabel rendering or query block state.
    // Pattern: check that the oli label is the level-3 marker, not level-1.
    // Adjust the selector to match what numbering produces at level 3.
    const oliLabel = await page.locator(`[data-block-id="${blockId}"] [data-test="oli-label"]`).textContent();
    expect(oliLabel).toMatch(/^[a-z]\./);  // level-3 lettered marker — confirm against your numbering output
  });
});
```

**Notes for the implementer:**
- The helpers `loadSample`, `ensureTcOff`, `ensureTcOn`, `createFreshBlock`, `addCommentOnRange`, `focusBlock`, `pmSetSelection`, `pmGetSelection` are referenced as if they exist. If any are missing in `tests/e2e/` or `pm-helpers.js`, add minimal implementations (5-15 LOC each) — the existing patterns in `editor.spec.js` use Page Object Model functions; match the style.
- `[data-lint-rule="TERM-shall"]` selector — verify this attribute is emitted by the linting render path. If not, add a `data-lint-rule` to the highlight render in App.jsx or use whatever selector the existing lint tests use.
- `[data-test="oli-label"]` likewise — if absent, add a `data-test` attribute to the oli label span in PmEditableBlock.jsx (line 877-883).
- `[data-test="comment-popup"]` — verify against existing comment popup tests.

- [ ] **Step 3: Run the new E2E tests in isolation**

Run: `npx playwright test --project=chromium --grep "block-type conversion"`

Expected: all 5 tests PASS. If any fail, debug — likely root causes: missing helper, selector mismatch, missing `data-block-type` attribute (Task 4 step 2).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/editor.spec.js
git commit -m "test(e2e): block-type conversion scenarios

Five scenarios per spec §6.3:
- Gutter handle preserves comments
- Keyboard shortcut preserves caret offset
- Stale lint clears on type flip
- TC mode: convert + accept preserves type (intentional)
- Level-loss regression: oli(L=3) -> txt -> oli stays at level 3"
```

---

## Task 8: Full suite gate

**Files:** none modified — verification only.

- [ ] **Step 1: Run the full editor + collab E2E suites under chromium**

Run: `npm run test:e2e -- --project=chromium tests/e2e/editor.spec.js tests/e2e/collab.spec.js 2>&1 | tee /tmp/post-impl-failures.txt`

- [ ] **Step 2: Diff against baseline from Task 0 step 5**

Compare `/tmp/baseline-failures.txt` to `/tmp/post-impl-failures.txt`. Any test that fails in post-impl but NOT in baseline is a candidate regression.

- [ ] **Step 3: For each candidate regression, re-run isolated under chromium**

For each test name `T` in the candidate-regression set:

Run: `npx playwright test --project=chromium --grep "T" --repeat-each=5 --workers=1`

- 5/5 fail: real regression. Debug the test, find the root cause, fix it.
- 3-4/5 fail: likely a real regression with a flaky component. Investigate.
- 0-2/5 fail: flake (matches CLAUDE.md rule 10). Add to known-flakes list and proceed.

- [ ] **Step 4: Run the full unit suite + compliance suite + server suite**

Run: `npm test && npm run test:compliance && npm run test:server`

Expected: all PASS.

- [ ] **Step 5: Final commit if any debugging fixes were made**

If steps 1-4 surfaced real regressions and fixes were made:

```bash
git add <whatever files were touched>
git commit -m "fix: address regressions from block-type conversion landing

<describe the specific fix>"
```

If no regressions surfaced, no commit needed for this step.

- [ ] **Step 6: Push the branch and open the PR**

This step requires explicit user permission per CLAUDE.md "Feature branch + PR" rule. Surface to the user:

> "All tasks complete. Branch `claude/cranky-newton-9d24c1` has the full feature. Want me to push and open a PR?"

Wait for explicit user approval before running `git push` or `gh pr create`.

---

## Self-Review Notes

**Spec coverage check (after writing the plan):**
- §4.1 reducer + ofx → Task 1 ✓
- §4.2 levelDelta → Task 1 ✓
- §4.3 wrapper key drop → Task 2 ✓
- §4.4 composeRevision + __convertedFrom + tooltip → Task 1 (verb) + Task 6 (tooltip + clear) ✓
- §4.5 BlockGutterMenu + ConvertBlockPalette → Tasks 4 + 5 ✓
- §4.6 App handler → Task 3 ✓
- §4.7 collab path (no change required) → covered implicitly; type rides existing SCALAR_KEYS publish
- §5 edge cases — comments survival → Task 7 scenario 1; lint stale clear → Task 7 scenario 3; level round-trip → Task 7 final test; TC composition → Task 1 + Task 7 scenario 4
- §6.1 unit tests → Task 1 ✓
- §6.2 PmEditableBlock persistence → Task 2 ✓
- §6.3 E2E → Task 7 ✓
- §6.4 full suite gate → Task 8 ✓
- §9 pre-impl greps → Task 0 ✓

**No spec gaps.**
