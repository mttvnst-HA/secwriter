import { describe, it, expect } from 'vitest';
import { doesOptMatch, resolveTaiInHtml, cleanTaiClasses, BRANCHES, REGIONS, DELIVERY_METHODS } from '../tailor-profile.js';

describe('doesOptMatch', () => {
  const army = { branch: 'ARMY', region: null, deliveryMethod: null };
  const navy = { branch: 'NAVY', region: 'NAVFAC NW', deliveryMethod: null };
  const armyDBB = { branch: 'ARMY', region: null, deliveryMethod: 'DESIGN-BID-BUILD' };
  const navyDB = { branch: 'NAVY', region: 'NAVFAC SE', deliveryMethod: 'DESIGN-BUILD' };
  const airForce = { branch: 'AIR FORCE', region: null, deliveryMethod: null };

  // ─── Direct branch matching ─────────────────────────────────

  it('matches direct branch', () => {
    expect(doesOptMatch('ARMY', army)).toBe(true);
    expect(doesOptMatch('NAVY', navy)).toBe(true);
    expect(doesOptMatch('AIR FORCE', airForce)).toBe(true);
  });

  it('rejects wrong branch', () => {
    expect(doesOptMatch('ARMY', navy)).toBe(false);
    expect(doesOptMatch('NAVY', army)).toBe(false);
    expect(doesOptMatch('AIR FORCE', army)).toBe(false);
  });

  // ─── Delivery method matching ───────────────────────────────

  it('matches delivery method', () => {
    expect(doesOptMatch('DESIGN-BID-BUILD', armyDBB)).toBe(true);
    expect(doesOptMatch('DESIGN-BUILD', navyDB)).toBe(true);
  });

  it('rejects wrong delivery method', () => {
    expect(doesOptMatch('DESIGN-BUILD', armyDBB)).toBe(false);
  });

  // ─── Compound branch + delivery ─────────────────────────────

  it('matches compound branch + delivery', () => {
    expect(doesOptMatch('ARMY DESIGN-BID-BUILD', armyDBB)).toBe(true);
  });

  it('rejects compound when branch matches but delivery differs', () => {
    expect(doesOptMatch('ARMY DESIGN-BUILD', armyDBB)).toBe(false);
  });

  it('rejects compound when delivery matches but branch differs', () => {
    expect(doesOptMatch('NAVY DESIGN-BUILD', armyDBB)).toBe(false);
  });

  // ─── Region matching ────────────────────────────────────────

  it('matches exact NAVFAC region', () => {
    expect(doesOptMatch('NAVFAC NW', navy)).toBe(true);
  });

  it('generic NAVFAC matches any NAVY profile', () => {
    expect(doesOptMatch('NAVFAC', navy)).toBe(true);
    expect(doesOptMatch('NAVFAC', navyDB)).toBe(true);
  });

  it('rejects NAVFAC region for non-NAVY branch', () => {
    expect(doesOptMatch('NAVFAC NW', army)).toBe(false);
    expect(doesOptMatch('NAVFAC', army)).toBe(false);
  });

  it('rejects wrong NAVFAC region', () => {
    expect(doesOptMatch('NAVFAC SE', navy)).toBe(false);
  });

  // ─── Multi-branch (slash-separated) ─────────────────────────

  it('matches slash-separated branches', () => {
    expect(doesOptMatch('ARMY/AIR FORCE', army)).toBe(true);
    expect(doesOptMatch('ARMY/AIR FORCE', airForce)).toBe(true);
  });

  it('rejects slash-separated when neither matches', () => {
    expect(doesOptMatch('ARMY/AIR FORCE', navy)).toBe(false);
  });

  // ─── Negation patterns ──────────────────────────────────────

  it('matches NON-ARMY for non-Army branches', () => {
    expect(doesOptMatch('NON-ARMY', navy)).toBe(true);
    expect(doesOptMatch('NOT-ARMY', airForce)).toBe(true);
  });

  it('rejects NON-ARMY for Army branch', () => {
    expect(doesOptMatch('NON-ARMY', army)).toBe(false);
    expect(doesOptMatch('NOT-ARMY', army)).toBe(false);
  });

  // ─── Comma-separated OPT values ─────────────────────────────

  it('matches if any comma-separated value matches', () => {
    expect(doesOptMatch('ARMY,NAVY', navy)).toBe(true);
    expect(doesOptMatch('ARMY,NAVY', army)).toBe(true);
  });

  it('rejects when no comma-separated value matches', () => {
    expect(doesOptMatch('ARMY,NAVY', airForce)).toBe(false);
  });

  // ─── Edge cases ─────────────────────────────────────────────

  it('returns true for empty/null OPT (always included)', () => {
    expect(doesOptMatch('', army)).toBe(true);
    expect(doesOptMatch(null, army)).toBe(true);
    expect(doesOptMatch(undefined, army)).toBe(true);
  });

  it('returns true when profile has no branch set', () => {
    expect(doesOptMatch('ARMY', { branch: null })).toBe(true);
  });

  it('includes unrecognized project-specific tokens', () => {
    expect(doesOptMatch('ALUMINUM', army)).toBe(true);
    expect(doesOptMatch('BACNET', navy)).toBe(true);
  });

  // ─── NAVY variant tokens ────────────────────────────────────

  it('matches NAVY variant tokens for NAVY branch', () => {
    expect(doesOptMatch('NAVY DESIGN-BUILD', navyDB)).toBe(true);
    expect(doesOptMatch('NAVY WITH ACCEPTANCE ENGINEER', navy)).toBe(true);
  });

  it('rejects NAVY variant tokens for non-NAVY branch', () => {
    expect(doesOptMatch('NAVY DESIGN-BUILD', army)).toBe(false);
  });
});

describe('resolveTaiInHtml', () => {
  const profile = { branch: 'ARMY', region: null, deliveryMethod: null };

  it('adds tai-included class to matching TAI spans', () => {
    const html = '<span class="mark-tai" data-opt="ARMY">Army text</span>';
    const result = resolveTaiInHtml(html, profile);
    expect(result).toContain('tai-included');
    expect(result).toContain('data-opt="ARMY"');
  });

  it('adds tai-excluded class to non-matching TAI spans', () => {
    const html = '<span class="mark-tai" data-opt="NAVY">Navy text</span>';
    const result = resolveTaiInHtml(html, profile);
    expect(result).toContain('tai-excluded');
    expect(result).not.toContain('tai-included');
  });

  it('adds tai-excluded-visible when showAll is true', () => {
    const html = '<span class="mark-tai" data-opt="NAVY">Navy text</span>';
    const result = resolveTaiInHtml(html, profile, true);
    expect(result).toContain('tai-excluded-visible');
    expect(result).not.toContain('"tai-excluded"');
  });

  it('handles TAI without data-opt (always included)', () => {
    const html = '<span class="mark-tai">Generic</span>';
    const result = resolveTaiInHtml(html, profile);
    expect(result).toContain('tai-included');
  });

  it('handles multiple TAI spans in one HTML string', () => {
    const html = '<span class="mark-tai" data-opt="ARMY">Army</span> and <span class="mark-tai" data-opt="NAVY">Navy</span>';
    const result = resolveTaiInHtml(html, profile);
    expect(result).toContain('tai-included');
    expect(result).toContain('tai-excluded');
  });

  it('returns original html when profile has no branch', () => {
    const html = '<span class="mark-tai" data-opt="ARMY">text</span>';
    const result = resolveTaiInHtml(html, { branch: null });
    expect(result).toBe(html);
  });

  it('replaces existing resolution classes', () => {
    const html = '<span class="mark-tai tai-excluded" data-opt="ARMY">text</span>';
    const result = resolveTaiInHtml(html, profile);
    expect(result).toContain('tai-included');
    expect(result).not.toContain('tai-excluded"');
  });
});

describe('cleanTaiClasses', () => {
  it('removes tai-included class', () => {
    const html = '<span class="mark-tai tai-included" data-opt="ARMY">text</span>';
    expect(cleanTaiClasses(html)).toContain('class="mark-tai"');
    expect(cleanTaiClasses(html)).not.toContain('tai-included');
  });

  it('removes tai-excluded class', () => {
    const html = '<span class="mark-tai tai-excluded" data-opt="NAVY">text</span>';
    expect(cleanTaiClasses(html)).toContain('class="mark-tai"');
    expect(cleanTaiClasses(html)).not.toContain('tai-excluded');
  });

  it('removes tai-excluded-visible class', () => {
    const html = '<span class="mark-tai tai-excluded-visible" data-opt="NAVY">text</span>';
    expect(cleanTaiClasses(html)).toContain('class="mark-tai"');
    expect(cleanTaiClasses(html)).not.toContain('tai-excluded-visible');
  });

  it('returns null/empty for null/empty input', () => {
    expect(cleanTaiClasses(null)).toBe(null);
    expect(cleanTaiClasses('')).toBe('');
  });
});

describe('constants', () => {
  it('exports expected branches', () => {
    expect(BRANCHES).toContain('ARMY');
    expect(BRANCHES).toContain('NAVY');
    expect(BRANCHES).toContain('AIR FORCE');
  });

  it('exports NAVFAC regions', () => {
    expect(REGIONS.length).toBeGreaterThan(5);
    expect(REGIONS).toContain('NAVFAC NW');
    expect(REGIONS).toContain('NAVFAC SE');
  });

  it('exports delivery methods', () => {
    expect(DELIVERY_METHODS).toContain('DESIGN-BUILD');
    expect(DELIVERY_METHODS).toContain('DESIGN-BID-BUILD');
  });
});
