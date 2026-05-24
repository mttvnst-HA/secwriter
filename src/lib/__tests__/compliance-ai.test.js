import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildSystemPrompt,
  chunkViolations,
  estimateTokens,
  estimateCost,
  parseAIResponse,
  filterViolationsForAI,
  postFilterRewrites,
} from '../compliance-ai.js';
import {
  createInitial,
  ignoreFinding,
  muteNlpRule,
  unignoreFinding,
  computeIgnoreKey,
} from '../linting.js';
import { fingerprintBlock } from '../lint-sidecar.js';

describe('buildSystemPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.length).toBeGreaterThan(100);
  });

  it('includes prohibited terms from JSON data', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"shall"');
    expect(prompt).toContain('"etc."');
    expect(prompt).toContain('"per"');
  });

  it('includes vague terms from JSON data', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"securely"');
    expect(prompt).toContain('"properly"');
  });

  it('includes imperative mood instruction', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('imperative mood');
  });

  it('includes JSON response format', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('"rewrites"');
    expect(prompt).toContain('"blockId"');
  });
});

describe('chunkViolations', () => {
  const makeBlock = (id) => ({ id, html: `Block ${id} text` });
  const makeViolation = (blockId) => ({ blockId, ruleId: 'TEST', match: 'test' });

  it('returns a single chunk for small input', () => {
    const blocks = [makeBlock('b1'), makeBlock('b2')];
    const violations = [makeViolation('b1'), makeViolation('b2')];
    const chunks = chunkViolations(blocks, violations);
    expect(chunks.length).toBe(1);
    expect(chunks[0].blocks.length).toBe(2);
    expect(chunks[0].violations.length).toBe(2);
  });

  it('chunks large input into groups of 20 blocks', () => {
    const blocks = Array.from({ length: 50 }, (_, i) => makeBlock(`b${i}`));
    const violations = blocks.map(b => makeViolation(b.id));
    const chunks = chunkViolations(blocks, violations);
    expect(chunks.length).toBe(3); // 20 + 20 + 10
    expect(chunks[0].blocks.length).toBe(20);
    expect(chunks[1].blocks.length).toBe(20);
    expect(chunks[2].blocks.length).toBe(10);
  });

  it('groups violations with their blocks', () => {
    const blocks = [makeBlock('b1'), makeBlock('b2'), makeBlock('b3')];
    const violations = [makeViolation('b1'), makeViolation('b1'), makeViolation('b3')];
    const chunks = chunkViolations(blocks, violations);
    expect(chunks.length).toBe(1);
    expect(chunks[0].violations.filter(v => v.blockId === 'b1').length).toBe(2);
  });
});

describe('estimateTokens', () => {
  it('returns a positive number', () => {
    const blocks = [{ id: 'b1', html: 'Some text content here.' }];
    const violations = [{ blockId: 'b1', ruleId: 'TEST', match: 'test', message: 'test' }];
    const tokens = estimateTokens(blocks, violations);
    expect(tokens).toBeGreaterThan(0);
  });

  it('scales with input size', () => {
    const small = [{ id: 'b1', html: 'Short.' }];
    const large = [{ id: 'b1', html: 'A much longer text that contains many words and should result in more tokens.' }];
    const v = [{ blockId: 'b1', ruleId: 'T', match: 'x', message: 'y' }];
    expect(estimateTokens(large, v)).toBeGreaterThan(estimateTokens(small, v));
  });
});

describe('estimateCost', () => {
  it('returns a positive number for positive tokens', () => {
    expect(estimateCost(1000)).toBeGreaterThan(0);
  });

  it('returns zero for zero tokens', () => {
    expect(estimateCost(0)).toBe(0);
  });

  it('cost increases with tokens', () => {
    expect(estimateCost(10000)).toBeGreaterThan(estimateCost(1000));
  });
});

describe('parseAIResponse', () => {
  const wrap = (jsonText) => ({ content: [{ text: jsonText }] });
  const validRewrite = { blockId: 'n42', original: 'foo', proposed: 'bar', changes: ['x'] };

  let warnSpy;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('parses well-formed JSON without warning', () => {
    const data = wrap(JSON.stringify({ rewrites: [validRewrite] }));
    const rewrites = parseAIResponse(data);
    expect(rewrites).toEqual([validRewrite]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns [] when no JSON object found', () => {
    const rewrites = parseAIResponse(wrap('not json at all'));
    expect(rewrites).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('repairs trailing comma via jsonrepair fallback', () => {
    const malformed = '{ "rewrites": [ { "blockId": "n42", "original": "foo", "proposed": "bar", "changes": ["x"], }, ] }';
    const rewrites = parseAIResponse(wrap(malformed));
    expect(rewrites).toEqual([validRewrite]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/jsonrepair salvaged/);
  });

  it('repairs Python True/None literals via jsonrepair fallback', () => {
    const malformed = '{ "rewrites": [ { "blockId": "n42", "original": "foo", "proposed": "bar", "ok": True, "skip": None } ] }';
    const rewrites = parseAIResponse(wrap(malformed));
    expect(rewrites.length).toBe(1);
    expect(rewrites[0].blockId).toBe('n42');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('repairs unterminated string via jsonrepair fallback', () => {
    const malformed = '{ "rewrites": [ { "blockId": "n42", "original": "foo", "proposed": "bar';
    const rewrites = parseAIResponse(wrap(malformed));
    expect(rewrites.length).toBe(1);
    expect(rewrites[0].blockId).toBe('n42');
    expect(rewrites[0].proposed).toBe('bar');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not log the response text (only the error message)', () => {
    const secret = 'CONFIDENTIAL_SPEC_TEXT_DO_NOT_LEAK';
    const malformed = `{ "rewrites": [ { "blockId": "n1", "original": "${secret}", "proposed": "bar", }, ] }`;
    parseAIResponse(wrap(malformed));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0].join(' ');
    expect(logged).not.toContain(secret);
  });

  it('returns [] when repair also fails (unrepairable)', () => {
    // Garbage that even jsonrepair can't salvage into a parseable object
    // with a `rewrites` array. After repair this becomes something whose
    // parsed shape lacks `rewrites`.
    const garbage = '{ this is not even close to JSON ::: ??? }';
    const rewrites = parseAIResponse(wrap(garbage));
    expect(rewrites).toEqual([]);
  });

  it('filters rewrites missing blockId/proposed or where proposed === original', () => {
    const data = wrap(JSON.stringify({
      rewrites: [
        validRewrite,
        { blockId: 'n2', proposed: 'same', original: 'same' }, // dropped
        { proposed: 'x' }, // dropped (no blockId)
        { blockId: 'n3' }, // dropped (no proposed)
      ],
    }));
    const rewrites = parseAIResponse(data);
    expect(rewrites).toEqual([validRewrite]);
  });
});

// ── #141: pre-filter, prompt section, post-filter ────────────────────────────

describe('filterViolationsForAI', () => {
  const blockA = { id: 'n1', html: 'The Contractor shall furnish materials.' };
  const blockB = { id: 'n2', html: 'Place materials properly.' };
  const vShall = { blockId: 'n1', ruleId: 'TERM-shall', match: 'shall', message: 'use imperative' };
  const vFurnish = { blockId: 'n1', ruleId: 'COLLOQ-furnish', match: 'furnish', message: 'use provide' };
  const vProperly = { blockId: 'n2', ruleId: 'TERM-properly', match: 'properly', message: 'specify how' };

  it('passes all violations through when lintingState has no ignored/muted entries', async () => {
    const state = createInitial();
    const { kept, droppedByBlock } = await filterViolationsForAI(
      [vShall, vFurnish, vProperly], [blockA, blockB], state);
    expect(kept).toEqual([vShall, vFurnish, vProperly]);
    expect(droppedByBlock.size).toBe(0);
  });

  it('drops a violation whose (ruleId, blockHash, match) was previously ignored', async () => {
    const hashA = await fingerprintBlock(blockA.html);
    const ignoreKey = await computeIgnoreKey('TERM-shall', hashA, 'shall');
    let state = createInitial();
    state = ignoreFinding(state, { ignoreKey, ruleId: 'TERM-shall', blockHash: hashA, match: 'shall', identity: { id: 'u1' }, ts: 1 });

    const { kept, droppedByBlock } = await filterViolationsForAI(
      [vShall, vFurnish, vProperly], [blockA, blockB], state);
    expect(kept).toEqual([vFurnish, vProperly]);
    expect(droppedByBlock.get('n1')).toBe(1);
  });

  it('drops all violations of a muted ruleId', async () => {
    // muteNlpRule guards on the 'NLP-' prefix (see linting.js:492). The AI tier
    // doesn't process NLP findings in practice — but the filter's mute branch
    // is contract-level defense: if an NLP-prefixed violation ever reaches
    // here AND its rule is muted, drop it. Use a synthetic NLP-prefixed
    // ruleId on one of the existing block fixtures to pin the contract.
    const vNlp = { blockId: 'n1', ruleId: 'NLP-passive', match: 'is furnished', message: 'passive voice' };
    let state = createInitial();
    state = muteNlpRule(state, { ruleId: 'NLP-passive', identity: { id: 'u1' }, ts: 1 });

    const { kept, droppedByBlock } = await filterViolationsForAI(
      [vNlp, vFurnish, vProperly], [blockA, blockB], state);
    expect(kept).toEqual([vFurnish, vProperly]);
    expect(droppedByBlock.get('n1')).toBe(1);
  });

  it('keeps a violation when its ignored entry is tombstoned (un-ignored)', async () => {
    const hashA = await fingerprintBlock(blockA.html);
    const ignoreKey = await computeIgnoreKey('TERM-shall', hashA, 'shall');
    let state = createInitial();
    state = ignoreFinding(state, { ignoreKey, ruleId: 'TERM-shall', blockHash: hashA, match: 'shall', identity: { id: 'u1' }, ts: 1 });
    state = unignoreFinding(state, { ignoreKey, ts: 2 });

    const { kept } = await filterViolationsForAI([vShall], [blockA], state);
    expect(kept).toEqual([vShall]);
  });

  it('treats curly-quote and ASCII-quote match variants as distinct (no hidden normalization)', async () => {
    // Dismissed entry uses ASCII apostrophe; incoming violation uses a curly apostrophe.
    // They must NOT be coerced equal — the static engine emits one or the other; symmetric
    // comparison means the user has to dismiss each variant they actually encountered.
    const block = { id: 'n3', html: "It's a test." };
    const violation = { blockId: 'n3', ruleId: 'R-1', match: "It’s" };  // curly
    const hash = await fingerprintBlock(block.html);
    const ignoreKey = await computeIgnoreKey('R-1', hash, "It's");  // ASCII
    let state = createInitial();
    state = ignoreFinding(state, { ignoreKey, ruleId: 'R-1', blockHash: hash, match: "It's", identity: { id: 'u1' }, ts: 1 });

    const { kept } = await filterViolationsForAI([violation], [block], state);
    expect(kept).toEqual([violation]);
  });

  it('reports per-block drop counts via droppedByBlock', async () => {
    const hashA = await fingerprintBlock(blockA.html);
    const keyShall = await computeIgnoreKey('TERM-shall', hashA, 'shall');
    const keyFurnish = await computeIgnoreKey('COLLOQ-furnish', hashA, 'furnish');
    let state = createInitial();
    state = ignoreFinding(state, { ignoreKey: keyShall, ruleId: 'TERM-shall', blockHash: hashA, match: 'shall', identity: { id: 'u1' }, ts: 1 });
    state = ignoreFinding(state, { ignoreKey: keyFurnish, ruleId: 'COLLOQ-furnish', blockHash: hashA, match: 'furnish', identity: { id: 'u1' }, ts: 2 });

    const { kept, droppedByBlock } = await filterViolationsForAI(
      [vShall, vFurnish, vProperly], [blockA, blockB], state);
    expect(kept).toEqual([vProperly]);
    expect(droppedByBlock.get('n1')).toBe(2);
    expect(droppedByBlock.has('n2')).toBe(false);
  });

  it('passes violations through unchanged when lintingState is null/undefined', async () => {
    const violations = [vShall, vProperly];
    const r1 = await filterViolationsForAI(violations, [blockA, blockB], null);
    const r2 = await filterViolationsForAI(violations, [blockA, blockB], undefined);
    expect(r1.kept).toEqual(violations);
    expect(r2.kept).toEqual(violations);
  });
});

describe('buildSystemPrompt with ignoredInChunk', () => {
  it('does not append a negative-constraint section when ignoredInChunk is empty or absent', () => {
    const baseline = buildSystemPrompt();
    expect(buildSystemPrompt({ ignoredInChunk: [] })).toBe(baseline);
    expect(buildSystemPrompt({})).toBe(baseline);
    expect(buildSystemPrompt()).toBe(baseline);
    // Sanity: the negative-constraint header is absent.
    expect(baseline).not.toContain('Do not propose rewrites');
  });

  it('appends a "Do not propose rewrites" section listing ruleId + match per entry', () => {
    const prompt = buildSystemPrompt({
      ignoredInChunk: [
        { ruleId: 'TERM-shall', match: 'shall' },
        { ruleId: 'TERM-properly', match: 'properly' },
      ],
    });
    expect(prompt).toContain('Do not propose rewrites');
    expect(prompt).toContain('TERM-shall');
    expect(prompt).toContain('"shall"');
    expect(prompt).toContain('TERM-properly');
    expect(prompt).toContain('"properly"');
  });

  it('keeps existing prohibited/vague/JSON-format content intact when section is appended', () => {
    const prompt = buildSystemPrompt({
      ignoredInChunk: [{ ruleId: 'TERM-shall', match: 'shall' }],
    });
    expect(prompt).toContain('"shall"');           // prohibited terms list still present
    expect(prompt).toContain('imperative mood');   // rules list still present
    expect(prompt).toContain('"rewrites"');        // JSON format still present
  });
});

describe('postFilterRewrites', () => {
  let warnSpy;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('keeps rewrites whose blockId has at least one surviving violation', () => {
    const rewrites = [
      { blockId: 'n1', original: 'a', proposed: 'b' },
      { blockId: 'n2', original: 'c', proposed: 'd' },
    ];
    const surviving = new Set(['n1', 'n2']);
    const kept = postFilterRewrites(rewrites, surviving);
    expect(kept).toEqual(rewrites);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('drops rewrites for blockIds with no surviving violations and logs once per drop', () => {
    const rewrites = [
      { blockId: 'n1', original: 'a', proposed: 'b' },
      { blockId: 'n2', original: 'c', proposed: 'd' },  // model volunteered — dropped
      { blockId: 'n3', original: 'e', proposed: 'f' },
    ];
    const surviving = new Set(['n1', 'n3']);  // n2 not in surviving set
    const kept = postFilterRewrites(rewrites, surviving);
    expect(kept.map(r => r.blockId)).toEqual(['n1', 'n3']);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/n2/);
  });

  it('returns rewrites unchanged when surviving set is empty (no input pre-filtering happened)', () => {
    // Defensive: if caller passes an empty set it means "all blocks survived" by convention,
    // OR "no violations existed" — either way we should not drop. Caller must pass a non-empty
    // set only when at least one block was pre-filtered.
    const rewrites = [{ blockId: 'n1', original: 'a', proposed: 'b' }];
    const kept = postFilterRewrites(rewrites, null);
    expect(kept).toEqual(rewrites);
  });
});
