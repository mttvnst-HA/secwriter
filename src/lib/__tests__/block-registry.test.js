import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerBlock,
  unregisterBlock,
  focusBlockById,
  getBlockHandle,
  getBlockDom,
  getBlockEditable,
  listRegisteredBlockIds,
  __resetBlockRegistry,
} from '../block-registry.js';

beforeEach(() => __resetBlockRegistry());

function makeFakeHandle(id, focusFn = () => {}) {
  return {
    focus: focusFn,
    getDom: () => ({ id: `dom-${id}` }),
    getEditable: () => ({ id: `editable-${id}` }),
    getPlainText: () => `text-${id}`,
    setHtml: () => {},
  };
}

describe('block-registry', () => {
  it('register + lookup + unregister', () => {
    registerBlock('a', makeFakeHandle('a'));
    expect(getBlockHandle('a')).toBeTruthy();
    expect(getBlockDom('a')).toEqual({ id: 'dom-a' });
    expect(getBlockEditable('a')).toEqual({ id: 'editable-a' });
    unregisterBlock('a');
    expect(getBlockHandle('a')).toBeNull();
    expect(getBlockDom('a')).toBeNull();
  });

  it('focusBlockById returns true on registered, false on missing', () => {
    let focused = null;
    registerBlock('a', makeFakeHandle('a', (opts) => { focused = opts; }));
    expect(focusBlockById('a', { atEnd: true })).toBe(true);
    expect(focused).toEqual({ atEnd: true });
    expect(focusBlockById('missing')).toBe(false);
  });

  it('focusBlockById uses default atEnd=true when no opts', () => {
    let focused = null;
    registerBlock('a', makeFakeHandle('a', (opts) => { focused = opts; }));
    focusBlockById('a');
    expect(focused).toEqual({ atEnd: true });
  });

  it('focus errors are caught (registry returns false instead of throwing)', () => {
    registerBlock('crash', { focus: () => { throw new Error('boom'); }, getDom: () => null, getEditable: () => null, getPlainText: () => '', setHtml: () => {} });
    expect(focusBlockById('crash')).toBe(false);
  });

  it('listRegisteredBlockIds reflects current state', () => {
    registerBlock('a', makeFakeHandle('a'));
    registerBlock('b', makeFakeHandle('b'));
    expect(new Set(listRegisteredBlockIds())).toEqual(new Set(['a', 'b']));
    unregisterBlock('a');
    expect(listRegisteredBlockIds()).toEqual(['b']);
  });

  it('register with same id replaces previous handle', () => {
    let focused = 0;
    registerBlock('a', { focus: () => { focused = 1; }, getDom: () => null, getEditable: () => null, getPlainText: () => '', setHtml: () => {} });
    registerBlock('a', { focus: () => { focused = 2; }, getDom: () => null, getEditable: () => null, getPlainText: () => '', setHtml: () => {} });
    focusBlockById('a');
    expect(focused).toBe(2);
  });

  it('safe with falsy inputs', () => {
    expect(focusBlockById(null)).toBe(false);
    expect(getBlockDom(undefined)).toBeNull();
    expect(getBlockEditable('')).toBeNull();
    // these should not throw
    registerBlock(null, makeFakeHandle('a'));
    registerBlock('a', null);
    unregisterBlock(null);
    unregisterBlock('nonexistent');
  });
});
