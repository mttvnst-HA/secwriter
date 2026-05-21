import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSystemPrompt, chunkViolations, estimateTokens, estimateCost, parseAIResponse } from '../compliance-ai.js';

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
