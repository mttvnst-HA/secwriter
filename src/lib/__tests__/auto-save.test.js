import { describe, it, expect, beforeEach } from 'vitest';
import { autoSave, loadAutoSave, clearAutoSave, getAutoSaveTimestamp } from '../auto-save.js';

// Mock localStorage
const store = {};
const mockStorage = {
  getItem: (key) => store[key] || null,
  setItem: (key, val) => { store[key] = val; },
  removeItem: (key) => { delete store[key]; },
};
Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, writable: true });

describe('autoSave', () => {
  beforeEach(() => {
    Object.keys(store).forEach(k => delete store[k]);
  });

  it('saves blocks and metadata to localStorage', () => {
    const blocks = [{ id: 'b1', type: 'txt', html: 'Hello' }];
    const meta = { sectionNumber: '31 00 00', sectionTitle: 'EARTHWORK', date: '08/23' };
    const comments = new Map();
    autoSave(blocks, meta, comments, 'test.SEC');

    const saved = loadAutoSave();
    expect(saved).not.toBeNull();
    expect(saved.blocks).toHaveLength(1);
    expect(saved.blocks[0].id).toBe('b1');
    expect(saved.fileName).toBe('test.SEC');
    expect(saved.sectionMeta.sectionNumber).toBe('31 00 00');
  });

  it('saves comments as array', () => {
    const blocks = [{ id: 'b1', type: 'txt', html: 'text' }];
    const meta = { sectionNumber: '31 00 00' };
    const comments = new Map();
    comments.set('c1', { id: 'c1', blockId: 'b1', entries: [{ text: 'note' }] });
    autoSave(blocks, meta, comments, 'test.SEC');

    const saved = loadAutoSave();
    expect(saved.comments).toHaveLength(1);
    expect(saved.comments[0].id).toBe('c1');
  });

  it('sets timestamp', () => {
    autoSave([{ id: 'b1', type: 'txt', html: 'x' }], {}, new Map(), 'f.SEC');
    const ts = getAutoSaveTimestamp();
    expect(ts).not.toBeNull();
    expect(new Date(ts).getTime()).toBeGreaterThan(0);
  });
});

describe('loadAutoSave', () => {
  beforeEach(() => {
    Object.keys(store).forEach(k => delete store[k]);
  });

  it('returns null when no auto-save exists', () => {
    expect(loadAutoSave()).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    store['sim-autosave'] = 'not json';
    expect(loadAutoSave()).toBeNull();
  });

  it('returns null for empty blocks array', () => {
    store['sim-autosave'] = JSON.stringify({ blocks: [], fileName: 'x.SEC' });
    expect(loadAutoSave()).toBeNull();
  });
});

describe('clearAutoSave', () => {
  it('removes auto-save data', () => {
    autoSave([{ id: 'b1', type: 'txt', html: 'x' }], {}, new Map(), 'f.SEC');
    expect(loadAutoSave()).not.toBeNull();
    clearAutoSave();
    expect(loadAutoSave()).toBeNull();
    expect(getAutoSaveTimestamp()).toBeNull();
  });
});
