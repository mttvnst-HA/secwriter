import { describe, it, expect, afterEach } from 'vitest';
import {
  registerBlock, __resetBlockRegistry, getContextAtCoordsById,
} from '../block-registry.js';

afterEach(() => __resetBlockRegistry());

describe('getContextAtCoordsById', () => {
  it('returns null for an unregistered id', () => {
    expect(getContextAtCoordsById('nope', { x: 1, y: 2 })).toBeNull();
  });
  it('returns null when the handle lacks getContextAtCoords', () => {
    registerBlock('b1', { focus() {}, getDom: () => null, getEditable: () => null, getPlainText: () => '', setHtml() {} });
    expect(getContextAtCoordsById('b1', { x: 1, y: 2 })).toBeNull();
  });
  it('passes coords through to the handle method', () => {
    registerBlock('b1', {
      focus() {}, getDom: () => null, getEditable: () => null, getPlainText: () => '', setHtml() {},
      getContextAtCoords: ({ x, y }) => ({ blockId: 'b1', kind: 'pm', pos: x + y }),
    });
    expect(getContextAtCoordsById('b1', { x: 3, y: 4 })).toEqual({ blockId: 'b1', kind: 'pm', pos: 7 });
  });
  it('swallows a throwing handle and returns null', () => {
    registerBlock('b1', {
      focus() {}, getDom: () => null, getEditable: () => null, getPlainText: () => '', setHtml() {},
      getContextAtCoords: () => { throw new Error('mid-teardown'); },
    });
    expect(getContextAtCoordsById('b1', { x: 1, y: 2 })).toBeNull();
  });
});
