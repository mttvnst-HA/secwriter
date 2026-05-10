// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerBlock,
  unregisterBlock,
  focusBlockById,
  getBlockHandle,
  getBlockDom,
  getBlockEditable,
  listRegisteredBlockIds,
  listBlocksInDocumentOrder,
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

  it('listBlocksInDocumentOrder sorts by DOM order, not insertion order', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const domA = document.createElement('div');
    const domB = document.createElement('div');
    const domC = document.createElement('div');
    root.appendChild(domA);
    root.appendChild(domB);
    root.appendChild(domC);
    // Register out of document order: c, a, b. Insertion-order would be c,a,b.
    registerBlock('c', { focus: () => {}, getDom: () => domC, getEditable: () => null, getPlainText: () => '', setHtml: () => {} });
    registerBlock('a', { focus: () => {}, getDom: () => domA, getEditable: () => null, getPlainText: () => '', setHtml: () => {} });
    registerBlock('b', { focus: () => {}, getDom: () => domB, getEditable: () => null, getPlainText: () => '', setHtml: () => {} });
    expect(listBlocksInDocumentOrder().map(e => e.id)).toEqual(['a', 'b', 'c']);
    document.body.removeChild(root);
  });

  it('listBlocksInDocumentOrder skips handles whose DOM is null or disconnected', () => {
    const dom = document.createElement('div');
    document.body.appendChild(dom);
    registerBlock('attached', { focus: () => {}, getDom: () => dom, getEditable: () => null, getPlainText: () => '', setHtml: () => {} });
    registerBlock('null-dom', { focus: () => {}, getDom: () => null, getEditable: () => null, getPlainText: () => '', setHtml: () => {} });
    registerBlock('detached', { focus: () => {}, getDom: () => document.createElement('div'), getEditable: () => null, getPlainText: () => '', setHtml: () => {} });
    expect(listBlocksInDocumentOrder().map(e => e.id)).toEqual(['attached']);
    document.body.removeChild(dom);
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
