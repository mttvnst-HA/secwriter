import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Test the undo/redo history logic directly by simulating the hook's behavior.
 * We test the core algorithm without React rendering.
 */

const MAX_HISTORY = 100;

function createHistory(initialBlocks) {
  let blocks = initialBlocks;
  let tcSnapshots = new Map();
  const history = { past: [], future: [] };
  let paused = false;

  function setBlocks(updater) {
    const prev = blocks;
    const next = typeof updater === 'function' ? updater(prev) : updater;

    if (!paused) {
      history.past.push({ blocks: prev, tcSnapshots: new Map(tcSnapshots) });
      if (history.past.length > MAX_HISTORY) history.past.shift();
      history.future = [];
      paused = true;
    }

    blocks = next;
    return blocks;
  }

  function setTcSnapshots(updater) {
    tcSnapshots = typeof updater === 'function' ? updater(tcSnapshots) : updater;
    return tcSnapshots;
  }

  function resumeHistory() {
    paused = false;
  }

  function clearHistory() {
    history.past = [];
    history.future = [];
    paused = false;
  }

  function undo() {
    if (history.past.length === 0) return false;
    const snapshot = history.past.pop();
    history.future.push({ blocks, tcSnapshots: new Map(tcSnapshots) });
    blocks = snapshot.blocks;
    tcSnapshots = new Map(snapshot.tcSnapshots);
    paused = false;
    return true;
  }

  function redo() {
    if (history.future.length === 0) return false;
    const snapshot = history.future.pop();
    history.past.push({ blocks, tcSnapshots: new Map(tcSnapshots) });
    blocks = snapshot.blocks;
    tcSnapshots = new Map(snapshot.tcSnapshots);
    paused = false;
    return true;
  }

  return {
    getBlocks: () => blocks,
    getTcSnapshots: () => tcSnapshots,
    setBlocks,
    setTcSnapshots,
    undo,
    redo,
    canUndo: () => history.past.length > 0,
    canRedo: () => history.future.length > 0,
    clearHistory,
    resumeHistory,
  };
}

describe('undo/redo history', () => {
  let h;

  beforeEach(() => {
    h = createHistory([{ id: '1', html: 'initial' }]);
  });

  it('undo restores previous state', () => {
    h.resumeHistory();
    h.setBlocks([{ id: '1', html: 'changed' }]);
    expect(h.getBlocks()[0].html).toBe('changed');

    h.undo();
    expect(h.getBlocks()[0].html).toBe('initial');
  });

  it('redo restores undone state', () => {
    h.resumeHistory();
    h.setBlocks([{ id: '1', html: 'changed' }]);
    h.undo();
    expect(h.getBlocks()[0].html).toBe('initial');

    h.redo();
    expect(h.getBlocks()[0].html).toBe('changed');
  });

  it('multiple undo steps work correctly', () => {
    h.resumeHistory();
    h.setBlocks([{ id: '1', html: 'step1' }]);
    h.resumeHistory();
    h.setBlocks([{ id: '1', html: 'step2' }]);
    h.resumeHistory();
    h.setBlocks([{ id: '1', html: 'step3' }]);

    h.undo();
    expect(h.getBlocks()[0].html).toBe('step2');
    h.undo();
    expect(h.getBlocks()[0].html).toBe('step1');
    h.undo();
    expect(h.getBlocks()[0].html).toBe('initial');
  });

  it('redo stack cleared on new mutation after undo', () => {
    h.resumeHistory();
    h.setBlocks([{ id: '1', html: 'step1' }]);
    h.resumeHistory();
    h.setBlocks([{ id: '1', html: 'step2' }]);

    h.undo();
    expect(h.canRedo()).toBe(true);

    // New mutation clears redo
    h.setBlocks([{ id: '1', html: 'diverged' }]);
    expect(h.canRedo()).toBe(false);
  });

  it('max history drops oldest entries', () => {
    for (let i = 0; i < 105; i++) {
      h.resumeHistory();
      h.setBlocks([{ id: '1', html: `step${i}` }]);
    }
    // Should have exactly MAX_HISTORY entries
    let undoCount = 0;
    while (h.canUndo()) {
      h.undo();
      undoCount++;
    }
    expect(undoCount).toBe(MAX_HISTORY);
  });

  it('clearHistory resets everything', () => {
    h.resumeHistory();
    h.setBlocks([{ id: '1', html: 'changed' }]);
    expect(h.canUndo()).toBe(true);

    h.clearHistory();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });

  it('pause suppresses snapshot capture (typing debounce)', () => {
    // First setBlocks captures snapshot and auto-pauses
    h.resumeHistory();
    h.setBlocks([{ id: '1', html: 'type1' }]);
    // Subsequent calls while paused don't capture
    h.setBlocks([{ id: '1', html: 'type2' }]);
    h.setBlocks([{ id: '1', html: 'type3' }]);

    // Only one undo step should exist (back to initial)
    h.undo();
    expect(h.getBlocks()[0].html).toBe('initial');
    expect(h.canUndo()).toBe(false);
  });

  it('resumeHistory enables next capture', () => {
    h.resumeHistory();
    h.setBlocks([{ id: '1', html: 'typing...' }]);
    // Auto-paused now

    h.resumeHistory(); // structural action coming
    h.setBlocks([{ id: '1', html: 'after enter' }]);

    // Should have 2 undo steps
    h.undo();
    expect(h.getBlocks()[0].html).toBe('typing...');
    h.undo();
    expect(h.getBlocks()[0].html).toBe('initial');
  });

  it('tcSnapshots captured alongside blocks', () => {
    h.setTcSnapshots(new Map([['b1', 'original text']]));

    h.resumeHistory();
    h.setBlocks([{ id: '1', html: 'changed' }]);
    h.setTcSnapshots(new Map([['b1', 'changed text']]));

    expect(h.getTcSnapshots().get('b1')).toBe('changed text');

    h.undo();
    // Should restore pre-mutation tcSnapshots
    expect(h.getTcSnapshots().get('b1')).toBe('original text');
  });

  it('canUndo and canRedo flags are correct', () => {
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);

    h.resumeHistory();
    h.setBlocks([{ id: '1', html: 'changed' }]);
    expect(h.canUndo()).toBe(true);
    expect(h.canRedo()).toBe(false);

    h.undo();
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);

    h.redo();
    expect(h.canUndo()).toBe(true);
    expect(h.canRedo()).toBe(false);
  });

  it('undo with no history is a no-op', () => {
    expect(h.undo()).toBe(false);
    expect(h.getBlocks()[0].html).toBe('initial');
  });

  it('redo with no future is a no-op', () => {
    expect(h.redo()).toBe(false);
    expect(h.getBlocks()[0].html).toBe('initial');
  });
});
