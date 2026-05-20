import { describe, it, expect } from 'vitest';
import { CURRENT_FILE_INITIAL, getDisplayName, getSidecarName } from '../current-file.js';

describe('current-file', () => {
  describe('getDisplayName priority', () => {
    it('returns handle.name when sec.handle is present', () => {
      const cf = { sec: { handle: { name: 'foo.SEC' }, fallbackName: 'unused.SEC' }, sidecar: { handle: null } };
      expect(getDisplayName(cf)).toBe('foo.SEC');
    });

    it('falls back to fallbackName when handle is null', () => {
      const cf = { sec: { handle: null, fallbackName: 'imported.SEC' }, sidecar: { handle: null } };
      expect(getDisplayName(cf)).toBe('imported.SEC');
    });

    it("uses 'output.SEC' when neither handle nor fallbackName", () => {
      const cf = { sec: { handle: null, fallbackName: null }, sidecar: { handle: null } };
      expect(getDisplayName(cf)).toBe('output.SEC');
    });
  });

  describe('getSidecarName', () => {
    it('replaces .sec with .comments.json (case-insensitive)', () => {
      const cf = { sec: { handle: null, fallbackName: 'spec.SEC' }, sidecar: { handle: null } };
      expect(getSidecarName(cf)).toBe('spec.comments.json');
    });

    it('derives sidecar from handle.name when present', () => {
      const cf = { sec: { handle: { name: 'on-disk.sec' }, fallbackName: 'fallback.SEC' }, sidecar: { handle: null } };
      expect(getSidecarName(cf)).toBe('on-disk.comments.json');
    });
  });

  describe('CURRENT_FILE_INITIAL', () => {
    it('has null handles and a non-empty fallbackName', () => {
      expect(CURRENT_FILE_INITIAL.sec.handle).toBeNull();
      expect(CURRENT_FILE_INITIAL.sidecar.handle).toBeNull();
      expect(typeof CURRENT_FILE_INITIAL.sec.fallbackName).toBe('string');
      expect(CURRENT_FILE_INITIAL.sec.fallbackName.length).toBeGreaterThan(0);
    });
  });
});
