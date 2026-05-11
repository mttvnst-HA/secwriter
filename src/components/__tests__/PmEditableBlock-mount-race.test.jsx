// @vitest-environment jsdom
//
// Regression test for the new-block mount race in PmEditableBlock.
//
// Symptom (PM-mode E2E suite): tests that create a new block via Enter or
// slash-menu (~33 tests in the chromium project once the TDZ regression
// at PR #61 had been fixed) saw the new block render in React but with no
// EditorView — no contenteditable, no PM DOM, no caret. Typing went nowhere.
//
// Root cause: child useEffects fire before parent useEffects in React's
// commit phase. PmEditableBlock's mount effect runs and calls
// `yStore.get(block.id)`, which returns undefined because App's seeding
// effect (`applyBlocksToYDoc` in App.jsx for out-of-room, or the publish
// effect in `useCollabSession` for in-room) is a parent effect that hasn't
// run yet. The mount effect bails. The yStore reference is unchanged when
// seeding does finally happen, so the mount effect never re-fires.
//
// Fix: subscribe to `yStore` for the specific `block.id` via
// useSyncExternalStore + `subscribeBlock` from block-html-store.js. The
// snapshot is the yMap reference (or null). When the slot appears after
// mount, the observer fires, React re-renders, and the mount effect's
// dep array (which now includes the yMap binding) triggers re-mount.
//
// What this test pins:
//   1. PmEditableBlock renders its outer host container even when the
//      yStore slot is absent at first render.
//   2. After yStore.set(block.id, yMap) runs in a 'local-apply' transaction
//      (matching what applyBlocksToYDoc does), the EditorView mounts —
//      surfaced as a `data-pm-editor="true"` attribute on the PM root.
//
// We don't drive a full PmEditableBlock through every prop here — only
// the props the mount effect reads. Linting is constructed disabled to
// avoid CSS.highlights (not implemented in jsdom).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

import PmEditableBlock from '../PmEditableBlock.jsx';
import { htmlToPmFragment } from '../../lib/pmdoc-html.js';
import * as linting from '../../lib/linting.js';

// Mirrors applyBlocksToYDoc's per-block seed (collab.js blockToYMapSkeleton +
// populateBlockHtml) for the post-1d Y.XmlFragment substrate shape. We can't
// import the internal helpers (not exported); replicating them keeps the test
// honest about what App actually does at seed time.
function seedSlotV2(yStore, ydoc, blockId, html) {
  ydoc.transact(() => {
    const yMap = new Y.Map();
    yMap.set('type', 'txt');
    yMap.set('part', 1);
    yMap.set('depth', 0);
    yMap.set('section', null);
    yMap.set('level', 1);
    yMap.set('revision', null);
    yMap.set('isNew', false);
    const yXml = new Y.XmlFragment();
    yMap.set('html', yXml);
    yStore.set(blockId, yMap);
    // Populate AFTER attachment (Y.XmlFragment must be attached to its
    // parent before prosemirrorToYXmlFragment runs — the
    // skeleton-then-populate invariant in CLAUDE.md).
    prosemirrorToYXmlFragment(htmlToPmFragment(html || ''), yXml);
  }, 'local-apply');
}

function defaultProps(overrides = {}) {
  return {
    block: { id: 'b1', type: 'txt', html: 'hello', isNew: true },
    yStore: null, // intentionally null in the "slot missing at mount" test
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
    resolveHtml: (html) => html,
    tailorKey: null,
    trackChanges: false,
    snapshotText: vi.fn(() => ''),
    identity: { name: 'tester' },
    onAcceptRevision: vi.fn(),
    onRejectRevision: vi.fn(),
    onRevisionAction: vi.fn(),
    comments: null,
    onCommentClick: vi.fn(),
    onInlineFix: vi.fn(),
    lintingState: linting.createInitial({ enabled: false }),
    lintingDispatch: vi.fn(),
    showTags: false,
    readOnly: false,
    ...overrides,
  };
}

describe('PmEditableBlock — new-block mount race against yStore seeding', () => {
  let ydoc;
  let yStore;

  beforeEach(() => {
    ydoc = new Y.Doc();
    yStore = ydoc.getMap('store');
  });

  afterEach(() => {
    ydoc?.destroy?.();
  });

  it('renders host container even when yStore slot is absent at first render', () => {
    // yStore is empty for block.id 'b1' — App's seed effect has not run.
    const { container } = render(<PmEditableBlock {...defaultProps({ yStore })} />);
    // Outer host renders regardless of substrate state.
    expect(container.firstChild).toBeTruthy();
    // No PM root yet — the mount effect bailed because yStore.get('b1') === undefined.
    expect(container.querySelector('[data-pm-editor="true"]')).toBeNull();
  });

  it('mounts EditorView after yStore slot is seeded post-render (the race fix)', async () => {
    const { container } = render(<PmEditableBlock {...defaultProps({ yStore })} />);

    // Pre-condition: no EditorView (slot missing).
    expect(container.querySelector('[data-pm-editor="true"]')).toBeNull();

    // Simulate App's parent-scope seed effect running after PmEditableBlock's
    // child-scope mount effect. subscribeBlock's yStore observer fires, the
    // useSyncExternalStore snapshot flips from null to the yMap reference,
    // React re-renders, and the mount effect re-fires with the yMap available.
    await act(async () => {
      seedSlotV2(yStore, ydoc, 'b1', '<p>hello</p>');
    });

    // Post-condition: the EditorView is now mounted.
    const pmRoot = container.querySelector('[data-pm-editor="true"]');
    expect(pmRoot).toBeTruthy();
    expect(pmRoot.getAttribute('data-block-id')).toBe('b1');
  });
});
