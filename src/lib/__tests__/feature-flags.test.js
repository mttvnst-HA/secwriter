// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { isPmEditorEnabled } from '../feature-flags.js';

afterEach(() => {
  if (typeof window !== 'undefined') {
    delete window.__SIM_FORCE_PM_EDITOR;
  }
});

describe('feature-flags / isPmEditorEnabled', () => {
  it('returns false by default (no env, no override)', () => {
    expect(isPmEditorEnabled()).toBe(false);
  });

  it('window.__SIM_FORCE_PM_EDITOR=true returns true', () => {
    window.__SIM_FORCE_PM_EDITOR = true;
    expect(isPmEditorEnabled()).toBe(true);
  });

  it('window.__SIM_FORCE_PM_EDITOR="1" returns true', () => {
    window.__SIM_FORCE_PM_EDITOR = '1';
    expect(isPmEditorEnabled()).toBe(true);
  });

  it('window.__SIM_FORCE_PM_EDITOR="false" returns false (string parsed)', () => {
    window.__SIM_FORCE_PM_EDITOR = 'false';
    expect(isPmEditorEnabled()).toBe(false);
  });

  it('window.__SIM_FORCE_PM_EDITOR="" returns false', () => {
    window.__SIM_FORCE_PM_EDITOR = '';
    expect(isPmEditorEnabled()).toBe(false);
  });

  it('window.__SIM_FORCE_PM_EDITOR=undefined falls through to URL/env (QC minor-9)', () => {
    // With no URL ?pm= and no env, base case is false — but the important
    // assertion is the fallthrough behavior: the URL takes precedence over
    // an assigned-undefined global, not the other way around.
    window.__SIM_FORCE_PM_EDITOR = undefined;
    expect(isPmEditorEnabled()).toBe(false);
    // URL fallback should still work when global is assigned undefined.
    try {
      window.history.replaceState(null, '', '?pm=1');
      expect(isPmEditorEnabled()).toBe(true);
    } finally {
      window.history.replaceState(null, '', window.location.pathname);
    }
  });

  it('mixed-case truthy variants accepted', () => {
    for (const v of ['Yes', 'TRUE', 'on', 'ON']) {
      window.__SIM_FORCE_PM_EDITOR = v;
      expect(isPmEditorEnabled()).toBe(true);
    }
  });

  describe('URL ?pm= override', () => {
    let originalSearch;
    beforeEach(() => {
      originalSearch = window.location.search;
    });
    afterEach(() => {
      // jsdom doesn't let us reassign location, but pushState clears search.
      try { window.history.replaceState(null, '', window.location.pathname); } catch { /* ignore */ }
    });

    it('?pm=1 returns true when no global override present', () => {
      window.history.replaceState(null, '', '?pm=1');
      expect(isPmEditorEnabled()).toBe(true);
    });

    it('?pm=true returns true', () => {
      window.history.replaceState(null, '', '?pm=true');
      expect(isPmEditorEnabled()).toBe(true);
    });

    it('?pm=0 returns false', () => {
      window.history.replaceState(null, '', '?pm=0');
      expect(isPmEditorEnabled()).toBe(false);
    });

    it('global override beats URL', () => {
      window.history.replaceState(null, '', '?pm=1');
      window.__SIM_FORCE_PM_EDITOR = 'false';
      expect(isPmEditorEnabled()).toBe(false);
    });

    it('?pm absent → falls through to env (default false)', () => {
      window.history.replaceState(null, '', '?other=x');
      expect(isPmEditorEnabled()).toBe(false);
    });
  });
});

