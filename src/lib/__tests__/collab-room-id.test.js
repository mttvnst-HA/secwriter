import { describe, it, expect } from 'vitest';
import { isValidRoomId, getRoomFromUrl } from '../collab.js';

// Gate for splicing a room id into a request path (CodeQL
// js/client-side-request-forgery in useFileSession's download handlers).
describe('isValidRoomId', () => {
  it('accepts the server sanitize charset up to 64 chars', () => {
    expect(isValidRoomId('abc-123_XYZ')).toBe(true);
    expect(isValidRoomId('a'.repeat(64))).toBe(true);
  });
  it('rejects path-shaped, empty, oversized, and non-string ids', () => {
    for (const bad of ['../admin', 'x/share', 'a?b', 'a b', '', 'a'.repeat(65), null, undefined, 42]) {
      expect(isValidRoomId(bad)).toBe(false);
    }
  });
  it('always accepts what getRoomFromUrl produces', () => {
    const orig = globalThis.window;
    globalThis.window = { location: { search: '?room=../evil%2Fshare%3Fx' } };
    try {
      const id = getRoomFromUrl();
      expect(id).toBe('evilsharex');
      expect(isValidRoomId(id)).toBe(true);
    } finally {
      globalThis.window = orig;
    }
  });
});
