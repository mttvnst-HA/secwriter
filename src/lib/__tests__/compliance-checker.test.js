// NOTE: This file imports buildRules() indirectly via checkCompliance, which compiles ~81 regexes.
// If this file exceeds ~30 tests and OOMs, migrate to Node built-in runner
// (see compliance-rules.node-test.mjs for the pattern).
import { describe, it, expect } from 'vitest';
import { checkCompliance, getBlocksInScope, stripHtml, groupViolations, computeStats, MAX_VIOLATIONS } from '../compliance-checker.js';

const makeBlock = (id, type, html, opts = {}) => ({
  id, type, html, part: opts.part || 1, depth: opts.depth || 1,
  section: opts.section || 's1', ...opts,
});

describe('getBlocksInScope', () => {
  const blocks = [
    makeBlock('t1', 'title', 'GENERAL', { depth: 0, part: 1 }),
    makeBlock('b1', 'txt', 'First paragraph.', { part: 1 }),
    makeBlock('t2', 'title', 'DEFINITIONS', { depth: 1, part: 1 }),
    makeBlock('b2', 'txt', 'A definition.', { part: 1 }),
    makeBlock('b3', 'txt', 'Another paragraph.', { part: 1 }),
    makeBlock('t3', 'title', 'PRODUCTS', { depth: 0, part: 2 }),
    makeBlock('b4', 'txt', 'Product info.', { part: 2 }),
    makeBlock('pb', 'pagebreak', '', { part: 2 }),
    makeBlock('b5', 'txt', 'More product info.', { part: 2 }),
  ];

  it('returns single block for scope "block"', () => {
    const result = getBlocksInScope(blocks, 'block', 'b2');
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('b2');
  });

  it('returns subsection blocks until next heading at same/higher depth', () => {
    const result = getBlocksInScope(blocks, 'subsection', 't2');
    expect(result.map(b => b.id)).toEqual(['t2', 'b2', 'b3']);
  });

  it('returns all blocks in a PART', () => {
    const result = getBlocksInScope(blocks, 'part', 'b4');
    expect(result.map(b => b.id)).toEqual(['t3', 'b4', 'pb', 'b5']);
  });

  it('returns all non-pagebreak blocks for "document"', () => {
    const result = getBlocksInScope(blocks, 'document', null);
    expect(result.every(b => b.type !== 'pagebreak')).toBe(true);
    expect(result.length).toBe(blocks.length - 1); // minus pagebreak
  });

  it('returns empty for invalid anchor', () => {
    expect(getBlocksInScope(blocks, 'block', 'nonexistent')).toEqual([]);
  });
});

describe('stripHtml', () => {
  it('strips HTML tags', () => {
    expect(stripHtml('<b>bold</b> text')).toBe('bold text');
  });

  it('removes del content (TC deletions)', () => {
    expect(stripHtml('Keep <del class="mark-del">deleted</del> this')).toBe('Keep this');
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('A &amp; B &lt; C')).toBe('A & B < C');
  });

  it('handles empty input', () => {
    expect(stripHtml('')).toBe('');
    expect(stripHtml(null)).toBe('');
  });
});

describe('checkCompliance', () => {
  it('finds "shall" violations in text blocks', async () => {
    const blocks = [
      makeBlock('b1', 'txt', 'The Contractor shall provide materials.'),
    ];
    const { violations, stats } = await checkCompliance(blocks, 'document', null);
    const shallV = violations.find(v => v.match.toLowerCase() === 'shall');
    expect(shallV).toBeTruthy();
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.high).toBeGreaterThan(0);
  });

  it('skips table blocks', async () => {
    const blocks = [
      makeBlock('t1', 'table', null, { table: { rows: [], columns: 2 } }),
    ];
    const { violations } = await checkCompliance(blocks, 'document', null);
    expect(violations.length).toBe(0);
  });

  it('skips ref blocks', async () => {
    const blocks = [
      makeBlock('r1', 'ref', null, { ref: { org: 'ASTM', entries: [] } }),
    ];
    const { violations } = await checkCompliance(blocks, 'document', null);
    expect(violations.length).toBe(0);
  });

  it('skips title blocks', async () => {
    const blocks = [
      makeBlock('h1', 'title', 'SECTION TITLE'),
    ];
    const { violations } = await checkCompliance(blocks, 'document', null);
    expect(violations.length).toBe(0);
  });

  it('skips hidden unit content when unitDisplay is eng or met', async () => {
    const blocks = [
      makeBlock('b1', 'txt', 'Compact to <span class="mark-eng">120 pounds per cubic foot</span> <span class="mark-met">1920 kg per cubic meter</span>.'),
    ];
    // When showing English only, metric content should be stripped before checking
    const engResult = await checkCompliance(blocks, 'document', null, { unitDisplay: 'eng' });
    const engPerV = engResult.violations.filter(v => v.match?.toLowerCase() === 'per');
    // "per cubic foot" is a valid unit expression — should not be flagged
    // And "per cubic meter" (metric) should be stripped entirely
    expect(engPerV.length).toBe(0);

    // When showing metric only, English content should be stripped
    const metResult = await checkCompliance(blocks, 'document', null, { unitDisplay: 'met' });
    const metPerV = metResult.violations.filter(v => v.match?.toLowerCase() === 'per');
    expect(metPerV.length).toBe(0);
  });

  it('skips note blocks entirely (notes exempt from UFS 1-300-02)', async () => {
    const blocks = [
      makeBlock('n1', 'note', 'The engineer should review per the specifications and shall verify etc.'),
    ];
    const { violations } = await checkCompliance(blocks, 'document', null);
    expect(violations.length).toBe(0);
  });

  it('groups violations by rule ID', async () => {
    const blocks = [
      makeBlock('b1', 'txt', 'The Contractor shall provide materials.'),
      makeBlock('b2', 'txt', 'Materials shall be placed per the specifications.'),
    ];
    const { groups } = await checkCompliance(blocks, 'document', null);
    // There should be a group for "shall"
    const shallGroup = groups.find(g => g.instances.some(i => i.match.toLowerCase() === 'shall'));
    expect(shallGroup).toBeTruthy();
    expect(shallGroup.instances.length).toBeGreaterThanOrEqual(2);
  });

  it('sorts groups by severity then instance count', async () => {
    const blocks = [
      makeBlock('b1', 'txt', 'The Contractor shall provide  materials per the spec.'),
    ];
    const { groups } = await checkCompliance(blocks, 'document', null);
    // High severity groups should come first
    if (groups.length >= 2) {
      const severityOrder = { high: 0, medium: 1, low: 2 };
      for (let i = 1; i < groups.length; i++) {
        const prevSev = severityOrder[groups[i - 1].severity] || 9;
        const currSev = severityOrder[groups[i].severity] || 9;
        if (prevSev === currSev) {
          expect(groups[i - 1].instances.length).toBeGreaterThanOrEqual(groups[i].instances.length);
        } else {
          expect(prevSev).toBeLessThanOrEqual(currSev);
        }
      }
    }
  });

  it('provides representative context for each group', async () => {
    const blocks = [
      makeBlock('b1', 'txt', 'The Contractor shall provide a minimum of 24 inches of cover.'),
    ];
    const { groups } = await checkCompliance(blocks, 'document', null);
    const shallGroup = groups.find(g => g.instances.some(i => i.match.toLowerCase() === 'shall'));
    if (shallGroup) {
      expect(shallGroup.representative).toBeTruthy();
      expect(shallGroup.representative.sentence).toBeTruthy();
      expect(shallGroup.representative.sentence.length).toBeGreaterThan(10);
    }
  });
});

describe('computeStats', () => {
  it('computes correct severity counts', () => {
    const fn = () => 'fixed';
    const violations = [
      { severity: 'high', fixFn: fn, category: 'prohibited-term' },
      { severity: 'high', fixFn: null, category: 'prohibited-term' },
      { severity: 'medium', fixFn: null, category: 'vague-language' },
      { severity: 'low', fixFn: fn, category: 'formatting' },
      { severity: 'low', fixFn: fn, category: 'formatting' },
    ];
    const stats = computeStats(violations);
    expect(stats.total).toBe(5);
    expect(stats.high).toBe(2);
    expect(stats.medium).toBe(1);
    expect(stats.low).toBe(2);
    expect(stats.autoFixable).toBe(3);
    expect(stats.needsAI).toBe(2);
  });

  it('counts by category', () => {
    const violations = [
      { severity: 'high', fixFn: null, category: 'prohibited-term' },
      { severity: 'high', fixFn: null, category: 'prohibited-term' },
      { severity: 'low', fixFn: () => 'fixed', category: 'formatting' },
    ];
    const stats = computeStats(violations);
    expect(stats.byCategory['prohibited-term']).toBe(2);
    expect(stats.byCategory['formatting']).toBe(1);
  });
});

// ── Performance regression test ───────────────────────────────────────────────

describe('performance', () => {
  it('completes a 400-block document scan in under 5 seconds', async () => {
    // Generate a realistic 400-block document with mixed content
    const blocks = [];
    const sampleTexts = [
      'The Contractor shall provide materials per the specifications.',
      'Compact to 95 percent of maximum dry density.',
      'Excavate to the depth indicated and remove unsuitable materials.',
      'Submit a Borrow Plan prepared and sealed by a registered professional engineer.',
      'Provide acid and alkali-resistant polyethylene plastic tape the width specified.',
      'Place fill in horizontal layers not exceeding 8 inches in loose thickness.',
      'Grade surfaces to drain and prevent ponding of water.',
      'Obtain borrow material from approved private sources.',
      'The Contracting Officer will review submittals within 14 days.',
      'Maintain excavations free from detrimental quantities of water.',
    ];
    for (let i = 0; i < 400; i++) {
      blocks.push(makeBlock(`perf-${i}`, 'txt', sampleTexts[i % sampleTexts.length], { part: Math.ceil((i + 1) / 130) }));
    }

    const start = performance.now();
    const { violations, stats } = await checkCompliance(blocks, 'document', null);
    const elapsed = performance.now() - start;

    // Must complete in under 5 seconds (generous budget — typically ~200-500ms)
    expect(elapsed).toBeLessThan(5000);
    // Should find violations (sanity check — "shall", "per", etc. are in the sample text)
    expect(stats.total).toBeGreaterThan(0);
    expect(violations.length).toBeGreaterThan(0);
  });

  it('caps violations at MAX_VIOLATIONS and sets truncated flag', async () => {
    // Generate a large document that will exceed MAX_VIOLATIONS
    const blocks = [];
    // Text with many violations per block to exceed the cap quickly
    const heavyText = 'The Contractor shall furnish any and/or all etc. per the requirements. ' +
      'The contractor should furnish any and/or all etc. per the specifications. ' +
      'The Contractor shall furnish any and/or all etc. per the standard.';
    for (let i = 0; i < 500; i++) {
      blocks.push(makeBlock(`cap-${i}`, 'txt', heavyText, { part: 1 }));
    }
    const result = await checkCompliance(blocks, 'document', null);
    expect(result.violations.length).toBeLessThanOrEqual(MAX_VIOLATIONS);
    expect(result.truncated).toBe(true);
  });

  it('returns truncated: false when under the cap', async () => {
    const blocks = [makeBlock('t1', 'txt', 'Place fill in horizontal layers.', { part: 1 })];
    const result = await checkCompliance(blocks, 'document', null);
    expect(result.truncated).toBe(false);
  });
});
