// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// ── Fake collab session ──────────────────────────────────────────────────
// createCollabSession is mocked so the tests never open a real WebSocket.
// The fake captures the param bag (so tests can fire onRemote* by hand) and
// records every published method call (so tests can assert ordering).

let fakeSessions = [];
let nextSessionShouldThrow = null; // when set, next publishBlocks throws this

function makeFakeSession(params) {
  const session = {
    params,
    calls: [],
    destroyed: false,
    publishBlocks: vi.fn((b) => {
      session.calls.push(['publishBlocks', b]);
      if (nextSessionShouldThrow) {
        const err = nextSessionShouldThrow;
        nextSessionShouldThrow = null;
        throw err;
      }
    }),
    publishMeta: vi.fn((m) => session.calls.push(['publishMeta', m])),
    publishTc: vi.fn((tc) => session.calls.push(['publishTc', tc])),
    dispatchComment: vi.fn((env) => session.calls.push(['dispatchComment', env])),
    setCursor: vi.fn((c) => session.calls.push(['setCursor', c])),
    undo: vi.fn(() => session.calls.push(['undo'])),
    redo: vi.fn(() => session.calls.push(['redo'])),
    canUndo: vi.fn(() => true),
    canRedo: vi.fn(() => true),
    destroy: vi.fn(() => { session.destroyed = true; }),
  };
  fakeSessions.push(session);
  return session;
}

vi.mock('../../lib/collab.js', () => {
  class FakeDocSizeLimitError extends Error {
    constructor(actualBytes, maxBytes) {
      super('doc size limit');
      this.name = 'DocSizeLimitError';
      this.actualBytes = actualBytes;
      this.maxBytes = maxBytes;
    }
  }
  // makeFakeSession is hoisted-safe (function declaration in this module
  // scope); the mock factory references it lazily at call time.
  return {
    createCollabSession: (params) => makeFakeSession(params),
    DocSizeLimitError: FakeDocSizeLimitError,
  };
});

import { useCollabSession } from '../useCollabSession.js';
import { DocSizeLimitError } from '../../lib/collab.js';

// ── Test helpers ─────────────────────────────────────────────────────────
// Stable references for anything the lifecycle effect's deps array
// captures. If `identity` were a fresh object on every rerender, the
// lifecycle would tear down and rebuild the session, losing readyRef
// state that the publish effects depend on.
const STABLE_IDENTITY = { id: 'u1', name: 'User One', color: '#abc' };

function defaultParams(overrides = {}) {
  return {
    inRoom: true,
    roomId: 'r1',
    identity: STABLE_IDENTITY,
    authToken: null,
    getTokenFn: undefined,
    blocks: [{ id: 'n1', type: 'txt', html: 'hello' }],
    sectionMeta: { sectionNumber: '01 00 00', sectionTitle: 'X', date: '01/26' },
    fileName: 'x.SEC',
    tcState: { enabled: false, snapshots: {}, publishSeq: 0 },
    getPublishableTc: vi.fn((s) => ({ enabled: s.enabled, snapshots: s.snapshots })),
    getInitialBlocks: vi.fn(() => [{ id: 'n1', type: 'txt', html: 'hello' }]),
    getInitialMeta: vi.fn(() => ({ sectionNumber: '01 00 00' })),
    onBlocksReceived: vi.fn(),
    onMetaReceived: vi.fn(),
    onTcReceived: vi.fn(),
    onCommentsReceived: vi.fn(),
    onPresenceChange: vi.fn(),
    onStatusChange: vi.fn(),
    pushToast: vi.fn(),
    ...overrides,
  };
}

function lastSession() {
  return fakeSessions[fakeSessions.length - 1];
}

beforeEach(() => {
  fakeSessions = [];
  nextSessionShouldThrow = null;
});

afterEach(() => {
  cleanup();
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('useCollabSession — lifecycle', () => {
  it('does not create a session when not in a room', () => {
    renderHook((props) => useCollabSession(props), { initialProps: defaultParams({ inRoom: false }) });
    expect(fakeSessions).toHaveLength(0);
  });

  it('does not create a session when identity is null', () => {
    renderHook((props) => useCollabSession(props), { initialProps: defaultParams({ identity: null }) });
    expect(fakeSessions).toHaveLength(0);
  });

  it('creates a session when in room with identity', () => {
    renderHook((props) => useCollabSession(props), { initialProps: defaultParams() });
    expect(fakeSessions).toHaveLength(1);
    expect(lastSession().params.room).toBe('r1');
    expect(lastSession().params.identity.id).toBe('u1');
  });

  it('passes initial blocks/meta from the supplied closures', () => {
    const params = defaultParams({
      getInitialBlocks: () => [{ id: 'seed', type: 'txt', html: 'init' }],
      getInitialMeta: () => ({ sectionNumber: '99 99 99' }),
    });
    renderHook((p) => useCollabSession(p), { initialProps: params });
    expect(lastSession().params.initialBlocks).toEqual([{ id: 'seed', type: 'txt', html: 'init' }]);
    expect(lastSession().params.initialMeta).toEqual({ sectionNumber: '99 99 99' });
  });

  it('destroys the session and clears window.__collab on unmount', () => {
    const { unmount } = renderHook((p) => useCollabSession(p), { initialProps: defaultParams() });
    const s = lastSession();
    expect(s.destroyed).toBe(false);
    if (typeof window !== 'undefined' && import.meta.env?.DEV) {
      expect(window.__collab).toBeDefined();
    }
    unmount();
    expect(s.destroyed).toBe(true);
    if (typeof window !== 'undefined' && import.meta.env?.DEV) {
      expect(window.__collab).toBeUndefined();
    }
  });
});

describe('useCollabSession — publish blocks (echo + ready guards)', () => {
  it('does not publish before initial sync (sessionReadyRef gate)', () => {
    renderHook((p) => useCollabSession(p), { initialProps: defaultParams() });
    // No initial-sync callback yet — publish should not have happened.
    expect(lastSession().publishBlocks).not.toHaveBeenCalled();
  });

  it('publishes once the initial sync arrives and blocks change', () => {
    const initial = defaultParams();
    const { rerender } = renderHook((p) => useCollabSession(p), { initialProps: initial });
    // Simulate the server's initial sync.
    act(() => {
      lastSession().params.onRemoteBlocks(initial.blocks, { initial: true });
    });
    // Initial sync alone does not trigger a publish — same blocks ref.
    expect(lastSession().publishBlocks).not.toHaveBeenCalled();
    // Local edit: rerender with a NEW blocks array.
    const next = [{ id: 'n1', type: 'txt', html: 'hello world' }];
    rerender(defaultParams({ blocks: next }));
    expect(lastSession().publishBlocks).toHaveBeenCalledTimes(1);
    expect(lastSession().publishBlocks).toHaveBeenCalledWith(next);
  });

  it('skips the publish when the blocks ref matches the last remote payload (echo guard)', () => {
    const initial = defaultParams();
    const { rerender } = renderHook((p) => useCollabSession(p), { initialProps: initial });
    // Initial sync.
    act(() => { lastSession().params.onRemoteBlocks(initial.blocks, { initial: true }); });
    // A remote update arrives and is then mirrored into App state via the
    // same array reference.
    const remoteBlocks = [{ id: 'n1', type: 'txt', html: 'remote text' }];
    act(() => { lastSession().params.onRemoteBlocks(remoteBlocks, { initial: false }); });
    // App's onBlocksReceived would call setBlocks(remoteBlocks); simulate
    // by re-rendering with that same reference.
    rerender(defaultParams({ blocks: remoteBlocks }));
    expect(lastSession().publishBlocks).not.toHaveBeenCalled();
  });
});

describe('useCollabSession — publish meta (ready gate)', () => {
  it('does not publishMeta until both sync AND first remote meta have arrived', () => {
    const { rerender } = renderHook((p) => useCollabSession(p), { initialProps: defaultParams() });
    // Sync only — no meta gate yet.
    act(() => { lastSession().params.onRemoteBlocks([{ id: 'n1', type: 'txt', html: 'x' }], { initial: true }); });
    rerender(defaultParams({ sectionMeta: { sectionNumber: '02 00 00' } }));
    expect(lastSession().publishMeta).not.toHaveBeenCalled();
    // Now first remote meta arrives — gate opens.
    act(() => { lastSession().params.onRemoteMeta({ sectionNumber: '01 00 00' }, { initial: true }); });
    rerender(defaultParams({ sectionMeta: { sectionNumber: '03 00 00' } }));
    expect(lastSession().publishMeta).toHaveBeenCalledTimes(1);
    expect(lastSession().publishMeta.mock.calls[0][0]).toMatchObject({ sectionNumber: '03 00 00' });
  });
});

describe('useCollabSession — publish TC (publishSeq gating)', () => {
  it('publishes when publishSeq advances past the gate', () => {
    const { rerender } = renderHook((p) => useCollabSession(p), { initialProps: defaultParams() });
    act(() => { lastSession().params.onRemoteBlocks([], { initial: true }); });
    // publishSeq goes 0 → 1 (a user verb).
    rerender(defaultParams({ tcState: { enabled: true, snapshots: { n1: 'hi' }, publishSeq: 1 } }));
    expect(lastSession().publishTc).toHaveBeenCalledTimes(1);
  });

  it('does NOT publish a remote-applied TC payload (markTcSeqApplied gate)', () => {
    const { result, rerender } = renderHook((p) => useCollabSession(p), { initialProps: defaultParams() });
    act(() => { lastSession().params.onRemoteBlocks([], { initial: true }); });
    // Remote TC arrives. App is expected to call markTcSeqApplied with the
    // resulting publishSeq inside its setTcState updater. We simulate that
    // directly: the next render carries the new state but the gate has
    // already been advanced, so no publish should fire.
    act(() => {
      lastSession().params.onRemoteTc({ enabled: true, snapshots: { n1: 'remote' } }, { initial: false });
      result.current.markTcSeqApplied(1);
    });
    rerender(defaultParams({ tcState: { enabled: true, snapshots: { n1: 'remote' }, publishSeq: 1 } }));
    expect(lastSession().publishTc).not.toHaveBeenCalled();
  });
});

describe('useCollabSession — DocSizeLimitError handling', () => {
  it('pushes a sticky error toast on first overflow only, then a success toast on recovery', () => {
    const pushToast = vi.fn();
    const { rerender } = renderHook((p) => useCollabSession(p), { initialProps: defaultParams({ pushToast }) });
    act(() => { lastSession().params.onRemoteBlocks([], { initial: true }); });

    // First overflow.
    nextSessionShouldThrow = new DocSizeLimitError(50 * 1024 * 1024, 5 * 1024 * 1024);
    rerender(defaultParams({ pushToast, blocks: [{ id: 'n1', type: 'txt', html: 'big' }] }));
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast.mock.calls[0][0]).toMatchObject({ kind: 'error', ttl: 0 });

    // Second overflow with a new blocks array — should NOT push another error toast (latched).
    nextSessionShouldThrow = new DocSizeLimitError(50 * 1024 * 1024, 5 * 1024 * 1024);
    rerender(defaultParams({ pushToast, blocks: [{ id: 'n1', type: 'txt', html: 'still big' }] }));
    expect(pushToast).toHaveBeenCalledTimes(1);

    // Recovery: publish succeeds — the latch clears with a "Sync resumed" toast.
    rerender(defaultParams({ pushToast, blocks: [{ id: 'n1', type: 'txt', html: 'small' }] }));
    expect(pushToast).toHaveBeenCalledTimes(2);
    expect(pushToast.mock.calls[1][0]).toMatchObject({ kind: 'success' });
  });
});

describe('useCollabSession — imperative API', () => {
  it('dispatchComment is a no-op when not in a room', () => {
    const { result } = renderHook((p) => useCollabSession(p), { initialProps: defaultParams({ inRoom: false }) });
    // Should not throw.
    act(() => { result.current.dispatchComment({ kind: 'create', commentId: 'c1', payload: {} }); });
    // No session exists, so nothing to assert on it.
    expect(fakeSessions).toHaveLength(0);
  });

  it('dispatchComment forwards to the session when in a room', () => {
    const { result } = renderHook((p) => useCollabSession(p), { initialProps: defaultParams() });
    const env = { kind: 'create', commentId: 'c1', payload: { x: 1 } };
    act(() => { result.current.dispatchComment(env); });
    expect(lastSession().dispatchComment).toHaveBeenCalledWith(env);
  });

  it('tryUndo / tryRedo return false when no session, true (and call session) when present', () => {
    // No session.
    const noRoom = renderHook((p) => useCollabSession(p), { initialProps: defaultParams({ inRoom: false }) });
    expect(noRoom.result.current.tryUndo()).toBe(false);
    expect(noRoom.result.current.tryRedo()).toBe(false);
    noRoom.unmount();

    // Session exists.
    const inRoom = renderHook((p) => useCollabSession(p), { initialProps: defaultParams() });
    expect(inRoom.result.current.tryUndo()).toBe(true);
    expect(lastSession().undo).toHaveBeenCalledTimes(1);
    expect(inRoom.result.current.tryRedo()).toBe(true);
    expect(lastSession().redo).toHaveBeenCalledTimes(1);
  });
});

describe('useCollabSession — cursor broadcast', () => {
  it('broadcasts setCursor(null) on selectionchange when no editable element is active', () => {
    renderHook((p) => useCollabSession(p), { initialProps: defaultParams() });
    act(() => { document.dispatchEvent(new Event('selectionchange')); });
    expect(lastSession().setCursor).toHaveBeenCalledWith(null);
  });

  it('does not attach selectionchange listener when not in a room', () => {
    renderHook((p) => useCollabSession(p), { initialProps: defaultParams({ inRoom: false }) });
    act(() => { document.dispatchEvent(new Event('selectionchange')); });
    expect(fakeSessions).toHaveLength(0);
  });
});
