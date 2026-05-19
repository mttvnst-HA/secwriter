// @vitest-environment jsdom
//
// Task b1.5 regression test — when the Y.Map for a block has a Y.Text html
// slot (migrationPartial leftover from the 1d migration broker; per-block
// conversion failed), PmEditableBlock must NOT try to mount its EditorView
// (ySyncPlugin requires Y.XmlFragment). Instead, render a read-only banner
// asking the operator to re-run conversion. Mirrors the duck-typing in
// block-html-store.js's deriveHtml.
//
// Why this matters: PmEditableBlock bails silently on the Y.Text shape
// (its ySyncPlugin requires Y.XmlFragment). Without a banner, the user
// sees an invisible-but-uneditable block — breaking ADR-0006's
// "half-migrated rooms remain editable" promise. The banner is the
// user-facing fallback for Y.Text-slot blocks in migrationPartial rooms.
//
// Test fixture mirrors PmEditableBlock-mount-race.test.jsx — props are the
// minimum shape PmEditableBlock destructures, linting disabled to avoid
// CSS.highlights (not implemented in jsdom).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';

import PmEditableBlock from '../../components/PmEditableBlock.jsx';
import { htmlToPmFragment } from '../pmdoc-html.js';
import { seedYTextFromHtml } from '../block-html-store.js';
import * as linting from '../linting.js';

function defaultProps(overrides = {}) {
  return {
    block: { id: 'mp1', type: 'txt', html: '<p>legacy</p>' },
    yStore: null,
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
    identity: { name: 'tester' },
    onAcceptRevision: vi.fn(),
    onRejectRevision: vi.fn(),
    onRevisionAction: vi.fn(),
    commentsState: null,
    onCommentClick: vi.fn(),
    onInlineFix: vi.fn(),
    lintingState: linting.createInitial({ enabled: false }),
    lintingDispatch: vi.fn(),
    showTags: false,
    readOnly: false,
    ...overrides,
  };
}

// Mirrors applyBlocksToYDoc's per-block seed in the Y.XmlFragment shape.
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
    prosemirrorToYXmlFragment(htmlToPmFragment(html || ''), yXml);
  }, 'local-apply');
}

// Mirrors the migrationPartial shape — a Y.Map with a Y.Text html slot.
// This is the leftover state from a 1d migration broker run that hit a
// per-block conversion error.
function seedSlotV1Legacy(yStore, ydoc, blockId, html) {
  ydoc.transact(() => {
    const yMap = new Y.Map();
    yMap.set('type', 'txt');
    yMap.set('part', 1);
    yMap.set('depth', 0);
    yMap.set('section', null);
    yMap.set('level', 1);
    yMap.set('revision', null);
    yMap.set('isNew', false);
    const yText = new Y.Text();
    yMap.set('html', yText);
    yStore.set(blockId, yMap);
    seedYTextFromHtml(yText, html || '');
  }, 'local-apply');
}

describe('migrationPartial blocks render a read-only banner', () => {
  let ydoc;
  let yStore;

  beforeEach(() => {
    ydoc = new Y.Doc();
    yStore = ydoc.getMap('store');
  });

  afterEach(() => {
    ydoc?.destroy?.();
  });

  it('renders the banner when html slot is Y.Text (not Y.XmlFragment)', async () => {
    // Seed BEFORE first render so PmEditableBlock's subscribe snapshot
    // already sees the yMap on mount.
    seedSlotV1Legacy(yStore, ydoc, 'mp1', '<p>legacy</p>');

    let container;
    await act(async () => {
      ({ container } = render(<PmEditableBlock {...defaultProps({ yStore })} />));
    });

    const banner = container.querySelector('.migration-partial-banner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('needs re-migration');
    // No PM EditorView mounted — no contenteditable div for this block.
    expect(container.querySelector('[contenteditable="true"]')).toBeNull();
    expect(container.querySelector('[data-pm-editor="true"]')).toBeNull();
  });

  it('does NOT render the banner when html slot is Y.XmlFragment', async () => {
    // Seed with the v2 (post-1d) shape — the normal case.
    seedSlotV2(yStore, ydoc, 'mp2', '<p>hello</p>');

    let container;
    await act(async () => {
      ({ container } = render(
        <PmEditableBlock {...defaultProps({
          yStore,
          block: { id: 'mp2', type: 'txt', html: '<p>hello</p>' },
        })} />,
      ));
    });

    expect(container.querySelector('.migration-partial-banner')).toBeNull();
    // The full EditorView mount path in jsdom is exercised by
    // PmEditableBlock-mount-race.test.jsx; here we only need to confirm the
    // banner does NOT swallow the v2-shape case.
  });

  it('unmounts the banner when the broker swaps Y.Text → Y.XmlFragment mid-session', async () => {
    // Regression for collab.spec.js:169 ("two-tab text sync") — the server
    // seeds a fresh room with Y.Text slots, then the 1d broker swaps them
    // to Y.XmlFragment on the next WS upgrade. The clients already
    // connected at seed time receive the swap via yMap.set('html', frag)
    // — same yMap reference, NEW html slot reference.
    //
    // Without subscribing to the slot identity (the pre-fix bug),
    // useSyncExternalStore's Object.is on the unchanged yMap would
    // dedupe the re-render, leaving the banner stuck on screen and the
    // EditorView unmounted forever on the original client.
    seedSlotV1Legacy(yStore, ydoc, 'mp3', '<p>legacy</p>');

    let container;
    await act(async () => {
      ({ container } = render(
        <PmEditableBlock {...defaultProps({
          yStore,
          block: { id: 'mp3', type: 'txt', html: '<p>legacy</p>' },
        })} />,
      ));
    });

    // Pre-condition: banner is showing.
    expect(container.querySelector('.migration-partial-banner')).not.toBeNull();

    // Simulate the broker: replace the Y.Text slot with a Y.XmlFragment.
    // The outer yMap identity is unchanged — only the inner 'html' slot
    // gets a new reference. This mirrors migrate-pm-substrate.cjs's
    // per-block conversion under its 'migrate-v2' origin.
    await act(async () => {
      ydoc.transact(() => {
        const yMap = yStore.get('mp3');
        const yXml = new Y.XmlFragment();
        yMap.set('html', yXml);
        prosemirrorToYXmlFragment(htmlToPmFragment('<p>migrated</p>'), yXml);
      }, 'migrate-v2');
    });

    // Banner must be gone. (We don't assert the EditorView mounts
    // synchronously — jsdom-based EditorView mount has known quirks; the
    // contract that matters here is "the migration-partial gate releases
    // when the slot swaps." The Playwright two-tab text-sync test pins
    // the live mount + sync end-to-end.)
    expect(container.querySelector('.migration-partial-banner')).toBeNull();
  });
});
