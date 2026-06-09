/**
 * Compliance rules tests using Node's built-in test runner.
 * Run with: node --test src/lib/__tests__/compliance-rules.node-test.mjs
 *
 * Uses node:test instead of Vitest because the compliance rule engine
 * creates 80+ regex objects that exhaust Vitest's worker memory.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Load JSON and module manually (bypass Vite's JSON transform)
const rulesData = JSON.parse(readFileSync(new URL('../../data/ufs-1-300-02-rules.json', import.meta.url), 'utf8'));

// Dynamic import of the compliance-rules module won't work directly (it uses
// `import ... from '../data/...' with { type: 'json' }` syntax). So we
// inline the essential functions here for testing purposes.
// This is intentional — these tests validate the RULES and PATTERNS, not the module loader.

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Rebuild the rules from JSON (same logic as compliance-rules.js buildRules)
function buildRules() {
  const rules = [];
  const seenTerms = new Set();

  // Prohibited terms
  rulesData.prohibitedTerms.forEach((entry, i) => {
    const term = entry.term.toLowerCase();
    seenTerms.add(term);
    let pattern;
    if (term === 'per') {
      pattern = /\bper\b(?!\s*(cent|annum|capita|diem|se\b|hour|min|second|day|week|month|year|cubic|sq|linear|foot|feet|inch|yard|mile|meter|metre|liter|litre|gal|pound|ton|acre|hectare|km|mph|psf|psi|pcf|plf|ksf|ksi|kcf|klf|mil))/gi;
    } else if (term === 'any') {
      pattern = /\bany\b(?!\s*(of the following|one of|other))/gi;
    } else if (term === 'properly') {
      // Mirrors compliance-rules.js: adjective "proper" is the same vagueness
      // as the listed adverb; exclude "proper operation" and "specified proper".
      pattern = /(?<!\bspecified\s)\bproper(?:ly)?\b(?!\s+operation\b)/gi;
    } else {
      const escaped = escapeRegex(entry.term);
      const endsWithWord = /\w$/.test(entry.term);
      pattern = new RegExp(`\\b${escaped}${endsWithWord ? '\\b' : ''}`, 'gi');
    }
    rules.push({
      id: entry.ruleId || `TERM-${String(i + 1).padStart(3, '0')}`,
      category: 'prohibited-term',
      severity: 'high',
      pattern,
      message: `Prohibited: "${entry.term}" — ${entry.replacement || 'needs rewrite'}`,
      ufsRef: `UFS 1-300-02 §${entry.section}`,
      fix: null, // simplified for testing
    });
  });

  // Formatting rules (hardcoded)
  // NOTE: FMT-001 (double spaces) removed — UFS 1-300-02 does NOT prohibit double spaces
  rules.push(
    { id: 'FMT-002', category: 'formatting', severity: 'low', pattern: /\u2014/g, message: 'Em-dash should be hyphen-minus', ufsRef: 'UFS 1-300-02 §2-3', fix: (t) => t.replace(/\u2014/g, '-') },
    { id: 'FMT-003', category: 'formatting', severity: 'low', pattern: /[\u201C\u201D\u2018\u2019]/g, message: 'Smart quotes should be straight', ufsRef: 'UFS 1-300-02 §2-3', fix: (t) => t.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'") },
    { id: 'FMT-004', category: 'formatting', severity: 'low', pattern: /\bper cent\b/gi, message: '"per cent" should be "percent"', ufsRef: 'UFS 1-300-02 §2-3', fix: (t) => t.replace(/\bper cent\b/gi, 'percent') },
  );

  // Capitalization rules
  rulesData.requiredCapitalization.forEach((entry) => {
    const lower = entry.term.toLowerCase();
    rules.push({
      id: `CAP-${entry.term.replace(/\s+/g, '')}`,
      category: 'capitalization',
      severity: 'low',
      pattern: new RegExp(`(?<![A-Za-z])${escapeRegex(lower)}(?![A-Za-z])`, 'g'),
      message: `${entry.rule}: "${entry.term}"`,
      ufsRef: `UFS 1-300-02 §${entry.section}`,
      fix: (text) => text.replace(new RegExp(`(?<![A-Za-z])${escapeRegex(lower)}(?![A-Za-z])`, 'g'), entry.term),
    });
  });

  // Symbols
  rulesData.prohibitedSymbols.forEach((entry, i) => {
    if (['-', '/', 'x', '+', "'", '"'].includes(entry.symbol)) return; // too many false positives
    rules.push({
      id: entry.ruleId || `SYM-${String(i + 1).padStart(3, '0')}`,
      category: 'prohibited-symbol',
      severity: 'medium',
      pattern: new RegExp(escapeRegex(entry.symbol), 'g'),
      message: `Symbol "${entry.symbol}" should be spelled out as "${entry.replacement}"`,
      ufsRef: 'UFS 1-300-02 §2-4.4',
      fix: null,
    });
  });

  // Colloquial
  rulesData.colloquialTerms.forEach((entry) => {
    rules.push({
      id: `COLLOQ-${entry.term}`,
      category: 'terminology',
      severity: 'medium',
      pattern: new RegExp(`\\b${escapeRegex(entry.term)}\\b`, 'gi'),
      message: `Colloquial: use "${entry.correctTerm}" instead of "${entry.term}"`,
      ufsRef: `UFS 1-300-02 §${entry.section}`,
      fix: (text) => text.replace(new RegExp(`\\b${escapeRegex(entry.term)}\\b`, 'gi'), entry.correctTerm),
    });
  });

  return rules;
}

function runStaticRules(plainText, blockId, rules, options = {}) {
  const { skipBrackets = true, isNoteBlock = false } = options;
  const violations = [];
  if (!plainText?.trim()) return violations;
  if (isNoteBlock) return violations;

  let bracketRanges = [];
  if (skipBrackets) {
    const bp = /\[[^\]]*\]/g;
    let m;
    while ((m = bp.exec(plainText)) !== null) {
      bracketRanges.push({ start: m.index, end: m.index + m[0].length });
    }
  }

  for (const rule of rules) {
    if (!rule.pattern) continue;
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(plainText)) !== null) {
      const ms = match.index, me = ms + match[0].length;
      if (skipBrackets && bracketRanges.some(r => (ms >= r.start && me <= r.end) || (me >= r.start - 1 && ms <= r.end + 1))) continue;
      if (rule.id === 'COLLOQ-deck') {
        const before = plainText.slice(Math.max(0, ms - 15), ms).toLowerCase();
        const after = plainText.slice(me, me + 10).toLowerCase();
        if (before.match(/bridge|concrete|roof|steel/) || after.match(/^\s*(plate|drain|coating|slab)/)) continue;
      }
      if (rule.id === 'COLLOQ-head') {
        const before = plainText.slice(Math.max(0, ms - 20), ms).toLowerCase();
        const after = plainText.slice(me, me + 15).toLowerCase();
        if (before.match(/bolt|shower|screw|cutting|spanner|washer|square|finished-?|cast-?brass|static|pile|dead|pressure|pump|suction|discharge|net positive|total|friction|large/) ||
            after.match(/^\s*(screw|bolt|nut|cap|face|plate|anchor|mount|room|loss|pressure|wall|space|pin|rail)/)) continue;
        if (after.match(/^\s*in\s*(feet|meters|metres|inches|mm|m\b)/)) continue;
      }
      violations.push({ ruleId: rule.id, blockId, match: match[0], index: ms, fixFn: rule.fix || null, severity: rule.severity, category: rule.category });
    }
  }
  return violations;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const rules = buildRules();

describe('buildRules', () => {
  it('generates 30+ rules from JSON', () => { assert.ok(rules.length > 30); });
  it('includes TERM rules', () => { assert.ok(rules.filter(r => r.id.startsWith('TERM-')).length > 20); });
  it('includes FMT rules', () => { assert.equal(rules.filter(r => r.id.startsWith('FMT-')).length, 3); });
  it('includes CAP rules', () => { assert.equal(rules.filter(r => r.id.startsWith('CAP-')).length, 4); });
  it('includes SYM rules', () => { assert.ok(rules.filter(r => r.id.startsWith('SYM-')).length > 0); });
  it('includes COLLOQ rules', () => { assert.equal(rules.filter(r => r.id.startsWith('COLLOQ-')).length, 2); });
  it('every rule has required fields', () => {
    for (const r of rules) {
      assert.ok(r.id); assert.ok(r.category); assert.ok(r.pattern instanceof RegExp);
      assert.ok(r.message); assert.match(r.severity, /^(high|medium|low)$/);
    }
  });
});

describe('prohibited terms', () => {
  it('detects "shall"', () => {
    const v = runStaticRules('The Contractor shall provide materials.', 'b1', rules);
    assert.ok(v.find(x => x.match.toLowerCase() === 'shall'));
  });
  it('detects "etc."', () => {
    assert.ok(runStaticRules('Use gravel, sand, etc.', 'b1', rules).find(x => x.match === 'etc.'));
  });
  it('detects "and/or"', () => {
    assert.ok(runStaticRules('Provide sand and/or gravel.', 'b1', rules).find(x => x.match === 'and/or'));
  });
  it('detects "per" in non-unit context', () => {
    assert.ok(runStaticRules('Install per the spec.', 'b1', rules).find(x => x.match.toLowerCase() === 'per'));
  });
  it('does not flag "per" in unit expressions', () => {
    for (const t of ['3.5 miles per hour.', '120 pounds per cubic foot.', '50 parts per million.', '2 gallons per square yard.']) {
      assert.equal(runStaticRules(t, 'b1', rules).find(x => x.match.toLowerCase() === 'per'), undefined, `FP in: ${t}`);
    }
  });
  it('detects "furnish"', () => {
    assert.ok(runStaticRules('Furnish all materials.', 'b1', rules).find(x => x.match.toLowerCase() === 'furnish'));
  });
  it('detects vague "securely"', () => {
    assert.ok(runStaticRules('Fasten bolts securely.', 'b1', rules).find(x => x.match.toLowerCase() === 'securely'));
  });
});

describe('formatting', () => {
  it('does NOT flag double spaces (removed FMT-001 — no UFS basis)', () => {
    // UFS 1-300-02 does not prohibit double spaces. USACE .SEC files
    // conventionally use double spaces after periods.
    const v = runStaticRules('Install the  pipe.  Verify alignment.', 'b1', rules);
    assert.equal(v.find(x => x.ruleId === 'FMT-001'), undefined);
  });
  it('detects em-dash', () => {
    assert.ok(runStaticRules('Materials \u2014 as specified.', 'b1', rules).find(x => x.ruleId === 'FMT-002'));
  });
  it('detects smart quotes', () => {
    assert.ok(runStaticRules('Use \u201Capproved\u201D materials.', 'b1', rules).find(x => x.ruleId === 'FMT-003'));
  });
  it('detects "per cent"', () => {
    assert.ok(runStaticRules('Use 50 per cent.', 'b1', rules).find(x => x.ruleId === 'FMT-004'));
  });
});

describe('capitalization', () => {
  it('detects lowercase "contractor"', () => {
    assert.ok(runStaticRules('The contractor provides.', 'b1', rules).find(x => x.ruleId === 'CAP-Contractor'));
  });
  it('does not flag "Contractor" (capitalized)', () => {
    assert.equal(runStaticRules('The Contractor provides.', 'b1', rules).find(x => x.ruleId === 'CAP-Contractor'), undefined);
  });
  it('detects lowercase "government"', () => {
    assert.ok(runStaticRules('The government provides.', 'b1', rules).find(x => x.ruleId === 'CAP-Government'));
  });
});

describe('colloquial', () => {
  it('detects "deck" → "floor"', () => {
    const v = runStaticRules('Install on the deck.', 'b1', rules);
    assert.ok(v.find(x => x.ruleId === 'COLLOQ-deck'));
  });
  it('does not flag "bridge deck"', () => {
    assert.equal(runStaticRules('The bridge deck is thick.', 'b1', rules).find(x => x.ruleId === 'COLLOQ-deck'), undefined);
  });
});

describe('TERM-properly adjective form', () => {
  it('matches "proper" and "properly" with collocation exclusions', () => {
    // UFS 1-300-02 §2-4.4 prohibits "properly"; the adjective "proper"
    // ("proper cement") is the same unspecified-standard vagueness.
    const flagged = (text) =>
      runStaticRules(text, 'b1', rules).some(x => x.ruleId === 'TERM-properly');
    // Adjective form — the 11 dirty-corpus misses are all this shape
    assert.ok(flagged('Use proper cement for the repair.'), 'proper cement');
    assert.ok(flagged('Provide valves of the proper type.'), 'proper type');
    assert.ok(flagged('Proper Stockpile Management'), 'capitalized heading form');
    // Adverb form still detected
    assert.ok(flagged('Labels must be properly affixed.'), 'properly affixed');
    // Exclusions — legitimate UFGS master usage (clean-corpus evidence)
    assert.equal(flagged('Test breakers for proper operation.'), false, 'proper operation collocation');
    assert.equal(flagged('Set sleeves in the specified proper and permanent location.'), false, 'specified-anchored');
    // Word-boundary safety
    assert.equal(flagged('The property owner agrees.'), false, 'property');
  });
});

describe('bracket exclusion', () => {
  it('skips violations inside brackets', () => {
    const v = runStaticRules('Provide [any approved type] of material.', 'b1', rules);
    assert.equal(v.find(x => x.match === 'any' && x.index > 8 && x.index < 25), undefined);
  });
  it('catches violations outside brackets', () => {
    assert.ok(runStaticRules('The Contractor shall provide [600 mm].', 'b1', rules).find(x => x.match.toLowerCase() === 'shall'));
  });
});

describe('note block exclusion', () => {
  it('skips ALL rules for note blocks', () => {
    const v = runStaticRules('The contractor shall provide etc.', 'b1', rules, { isNoteBlock: true });
    assert.equal(v.length, 0);
  });
});

describe('false positive regression', () => {
  const cases = [
    ['Perform the installation.', 'TERM-per', 'per inside Perform'],
    ['The property owner agrees.', 'TERM-per', 'per inside property'],
    ['Temperature not exceed 100 F.', 'TERM-per', 'per inside Temperature'],
    ['50 parts per million.', 'TERM-per', 'per million'],
    ['120 pounds per cubic foot.', 'TERM-per', 'per cubic foot'],
    ['The Contractor is responsible.', 'CAP-Contract', 'Contractor ≠ Contract'],
    ['Notify the Contracting Officer.', 'CAP-Contract', 'Contracting ≠ Contract'],
    ['Each subcontractor must comply.', 'CAP-Contract', 'subcontractor ≠ contract'],
    ['Per the Contract requirements.', 'CAP-Contract', 'Contract capitalized'],
    ['The company provides materials.', 'TERM-any', 'any inside company'],
    ['The bridge deck is thick.', 'COLLOQ-deck', 'bridge deck legit'],
    ['Government-furnished equipment.', 'CAP-Government', 'Government capitalized'],
    ['Provide [any suitable material].', 'TERM-', 'brackets exclude'],
    ['95 percent of maximum density.', 'FMT-004', 'percent not per cent'],
    ['The total head is at least 20 feet greater than 25 gpm.', 'COLLOQ-head', 'total head = hydraulic'],
    ['Nails must be galvanized large-head roofing nails.', 'COLLOQ-head', 'large-head = fastener type'],
  ];
  for (const [text, prefix, desc] of cases) {
    it(`no FP: ${desc}`, () => {
      const v = runStaticRules(text, 'test', rules);
      const fp = v.find(x => x.ruleId.startsWith(prefix));
      assert.equal(fp, undefined, `FALSE POSITIVE: ${fp?.ruleId} matched "${fp?.match}" in "${text}"`);
    });
  }
});
