import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock harper.js — WASM/Worker can't run in Node
vi.mock('harper.js', () => {
  let mockLintResults = [];
  let mockReady = false;
  let mockWords = [];
  let mockConfig = {};

  const mockLinter = {
    setup: vi.fn(async () => { mockReady = true; }),
    lint: vi.fn(async (text) => mockLintResults),
    importWords: vi.fn(async (words) => { mockWords.push(...words); }),
    exportWords: vi.fn(async () => mockWords),
    getLintConfig: vi.fn(async () => ({ ...mockConfig })),
    setLintConfig: vi.fn(async (config) => { mockConfig = config; }),
    applySuggestion: vi.fn(async (text, lint, suggestion) => {
      const span = lint.span();
      return text.slice(0, span.start) + suggestion.get_replacement_text() + text.slice(span.end);
    }),
    dispose: vi.fn(async () => {}),
  };

  // Helpers to control mock from tests
  mockLinter.__setResults = (results) => { mockLintResults = results; };
  mockLinter.__setReady = (ready) => { mockReady = ready; };
  mockLinter.__reset = () => {
    mockLintResults = [];
    mockReady = false;
    mockWords = [];
    mockConfig = {};
    vi.clearAllMocks();
  };

  class WorkerLinter {
    constructor() {
      Object.assign(this, mockLinter);
    }
  }

  return {
    WorkerLinter,
    binary: {},
    Dialect: { American: 0 },
    __mockLinter: mockLinter,
  };
});

// Helper: create a mock Harper Lint result
function createMockLint({ start, end, message, kind, problemText, suggestions = [] }) {
  return {
    span: () => ({ start, end, len: () => end - start }),
    message: () => message,
    lint_kind: () => kind,
    lint_kind_pretty: () => kind,
    get_problem_text: () => problemText,
    suggestion_count: () => suggestions.length,
    suggestions: () => suggestions.map(text => ({
      get_replacement_text: () => text,
      kind: () => 0, // Replace
    })),
  };
}

describe('grammar-checker', () => {
  let mockLinter;

  beforeEach(async () => {
    const { __mockLinter } = await import('harper.js');
    mockLinter = __mockLinter;
    mockLinter.__reset();
    // Reset module state
    vi.resetModules();
  });

  describe('initGrammarChecker', () => {
    it('initializes the WorkerLinter and imports custom words', async () => {
      const { initGrammarChecker, isGrammarReady } = await import('../grammar-checker.js');

      expect(isGrammarReady()).toBe(false);
      await initGrammarChecker();
      expect(isGrammarReady()).toBe(true);
      expect(mockLinter.setup).toHaveBeenCalled();
      expect(mockLinter.importWords).toHaveBeenCalled();
    });

    it('only initializes once on repeated calls', async () => {
      const { initGrammarChecker } = await import('../grammar-checker.js');

      await initGrammarChecker();
      await initGrammarChecker();
      expect(mockLinter.setup).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkGrammar', () => {
    it('returns violations mapped to standard shape', async () => {
      const { initGrammarChecker, checkGrammar } = await import('../grammar-checker.js');

      mockLinter.__setResults([
        createMockLint({
          start: 4,
          end: 7,
          message: 'Did you mean "is"?',
          kind: 'SubjectVerbAgreement',
          problemText: 'are',
          suggestions: ['is'],
        }),
      ]);

      await initGrammarChecker();
      const violations = await checkGrammar('The concrete are placed.', 'block-1');

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({
        ruleId: 'GRAMMAR-SubjectVerbAgreement',
        blockId: 'block-1',
        match: 'are',
        index: 4,
        severity: 'low',
        message: 'Did you mean "is"?',
      });
    });

    it('returns empty array when grammar checker is not ready', async () => {
      const { checkGrammar } = await import('../grammar-checker.js');
      const violations = await checkGrammar('Some text.', 'block-2');
      expect(violations).toEqual([]);
    });

    it('creates fixFn from Harper suggestions', async () => {
      const { initGrammarChecker, checkGrammar } = await import('../grammar-checker.js');

      mockLinter.__setResults([
        createMockLint({
          start: 13,
          end: 16,
          message: 'Subject-verb disagreement',
          kind: 'Grammar',
          problemText: 'are',
          suggestions: ['is'],
        }),
      ]);

      await initGrammarChecker();
      const violations = await checkGrammar('The concrete are placed.', 'block-3');

      expect(violations[0].fixFn).toBeDefined();
      expect(typeof violations[0].fixFn).toBe('function');
    });

    it('sets fixFn to null when no suggestions available', async () => {
      const { initGrammarChecker, checkGrammar } = await import('../grammar-checker.js');

      mockLinter.__setResults([
        createMockLint({
          start: 0,
          end: 5,
          message: 'Unclear phrasing',
          kind: 'Clarity',
          problemText: 'stuff',
          suggestions: [],
        }),
      ]);

      await initGrammarChecker();
      const violations = await checkGrammar('stuff is here.', 'block-4');

      expect(violations[0].fixFn).toBeNull();
    });
  });

  describe('custom dictionary', () => {
    it('imports engineering terms on initialization', async () => {
      const { initGrammarChecker } = await import('../grammar-checker.js');
      await initGrammarChecker();

      // Should have imported words containing common engineering terms
      const importCall = mockLinter.importWords.mock.calls[0][0];
      expect(importCall).toContain('ASTM');
      expect(importCall).toContain('AASHTO');
      expect(importCall).toContain('NAVFAC');
    });
  });

  describe('destroyGrammarChecker', () => {
    it('disposes the linter and resets ready state', async () => {
      const { initGrammarChecker, destroyGrammarChecker, isGrammarReady } = await import('../grammar-checker.js');

      await initGrammarChecker();
      expect(isGrammarReady()).toBe(true);

      destroyGrammarChecker();
      expect(isGrammarReady()).toBe(false);
    });
  });

  describe('stale result handling', () => {
    it('getVersion increments on each checkGrammar call', async () => {
      const { initGrammarChecker, checkGrammar, getVersion } = await import('../grammar-checker.js');
      mockLinter.__setResults([]);

      await initGrammarChecker();
      const v1 = getVersion();
      await checkGrammar('text one', 'b1');
      const v2 = getVersion();
      await checkGrammar('text two', 'b2');
      const v3 = getVersion();

      expect(v2).toBeGreaterThan(v1);
      expect(v3).toBeGreaterThan(v2);
    });
  });
});
