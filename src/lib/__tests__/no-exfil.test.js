import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NO_EXFIL_PROPS } from '../no-exfil.js';

const root = resolve(__dirname, '../../..');
const read = (rel) => readFileSync(resolve(root, rel), 'utf8');

describe('NO_EXFIL_PROPS shape', () => {
  it('contains every required exfiltration-prevention attribute', () => {
    expect(NO_EXFIL_PROPS).toEqual({
      spellCheck: false,
      autoCorrect: 'off',
      autoCapitalize: 'off',
      autoComplete: 'off',
      'data-gramm': 'false',
      'data-gramm_editor': 'false',
      'data-enable-grammarly': 'false',
      writingsuggestions: 'false',
    });
  });

  it('is frozen so callers cannot mutate it', () => {
    expect(Object.isFrozen(NO_EXFIL_PROPS)).toBe(true);
  });
});

describe('NO_EXFIL_PROPS is spread on every typing surface', () => {
  // Each entry: [file, expected spread occurrences].
  // If you add a new contentEditable / input / textarea that accepts spec or
  // comment text, add it here AND spread {...NO_EXFIL_PROPS} on the element.
  // 1i-b.2: EditableBlock.jsx retired; PmEditableBlock's typing surface is
  // covered by the NO_EXFIL_PM_ATTRS describe block below — PM uses
  // EditorProps.attributes (lowercase HTML names), not React {...spread}.
  const surfaces = [
    ['src/components/TitleBlock.jsx', 1],
    ['src/components/PreformattedBlock.jsx', 1],
    ['src/components/SearchBar.jsx', 2],       // find + replace
    ['src/components/CommentPopup.jsx', 3],    // author, body textarea, reply
    ['src/components/RefBlock.jsx', 3],        // org, RID, RTL
    ['src/components/RefWizard.jsx', 4],       // org search, ref search, custom RID, custom RTL
    ['src/components/TableBlock.jsx', 1],      // cell editor
    ['src/components/BracketReplace.jsx', 1],  // replacement input
    ['src/components/ConvertBlockPalette.jsx', 1], // block-type filter input
    ['src/App.jsx', 1],                        // sidebar search
  ];

  it.each(surfaces)('%s spreads NO_EXFIL_PROPS %i time(s)', (file, expected) => {
    const src = read(file);
    expect(src).toMatch(/from\s+["'][^"']*no-exfil\.js["']/);
    const matches = src.match(/\{\.\.\.NO_EXFIL_PROPS\}/g) || [];
    expect(matches.length).toBe(expected);
  });
});

// Sub-PR 1e (#47, v2 plan Q12/Q31/E2). PM EditorView renders its own DOM
// root; React props on a wrapper don't propagate. We translate camelCase
// React names into lowercase HTML attribute names and pass them via
// EditorProps.attributes. This block locks that translation in place.
describe('NO_EXFIL_PM_ATTRS (PM EditorProps) — lowercase HTML names', () => {
  it('PmEditableBlock exports NO_EXFIL_PM_ATTRS with every lowercase attribute', async () => {
    const mod = await import('../../components/PmEditableBlock.jsx');
    expect(mod.NO_EXFIL_PM_ATTRS).toEqual({
      spellcheck: 'false',
      autocorrect: 'off',
      autocapitalize: 'off',
      autocomplete: 'off',
      'data-gramm': 'false',
      'data-gramm_editor': 'false',
      'data-enable-grammarly': 'false',
      writingsuggestions: 'false',
    });
  });

  it('NO_EXFIL_PM_ATTRS is frozen', async () => {
    const mod = await import('../../components/PmEditableBlock.jsx');
    expect(Object.isFrozen(mod.NO_EXFIL_PM_ATTRS)).toBe(true);
  });

  it('PmEditableBlock wires NO_EXFIL_PM_ATTRS into EditorProps.attributes', () => {
    const src = read('src/components/PmEditableBlock.jsx');
    // Confirm the attributes object includes the spread of the lowercase set.
    expect(src).toMatch(/attributes:\s*\{\s*\.\.\.NO_EXFIL_PM_ATTRS/);
  });

  it('every NO_EXFIL_PROPS camelCase key has a matching NO_EXFIL_PM_ATTRS lowercase key', async () => {
    const mod = await import('../../components/PmEditableBlock.jsx');
    const camelToLower = {
      spellCheck: 'spellcheck',
      autoCorrect: 'autocorrect',
      autoCapitalize: 'autocapitalize',
      autoComplete: 'autocomplete',
      'data-gramm': 'data-gramm',
      'data-gramm_editor': 'data-gramm_editor',
      'data-enable-grammarly': 'data-enable-grammarly',
      writingsuggestions: 'writingsuggestions',
    };
    for (const camel of Object.keys(NO_EXFIL_PROPS)) {
      const lower = camelToLower[camel];
      expect(lower, `${camel} has a lowercase equivalent`).toBeDefined();
      expect(mod.NO_EXFIL_PM_ATTRS).toHaveProperty(lower);
    }
  });
});

describe('index.html security meta tags', () => {
  const html = read('index.html');

  it('has a Content-Security-Policy meta tag', () => {
    expect(html).toMatch(/<meta\s+http-equiv="Content-Security-Policy"/);
  });

  it('CSP allows the Anthropic API for compliance rewrites', () => {
    expect(html).toContain('connect-src');
    expect(html).toContain('https://api.anthropic.com');
  });

  it('CSP allows blob: workers for Harper.js WASM', () => {
    expect(html).toContain("worker-src 'self' blob:");
  });

  it('CSP forbids form submission to third parties', () => {
    expect(html).toContain("form-action 'none'");
  });

  it('sets referrer policy to no-referrer', () => {
    expect(html).toMatch(/<meta\s+name="referrer"\s+content="no-referrer"/);
  });

  it('disables Chrome auto-translate via notranslate meta', () => {
    expect(html).toMatch(/<meta\s+name="google"\s+content="notranslate"/);
  });

  it('blocks search engine indexing via robots meta', () => {
    expect(html).toMatch(/<meta\s+name="robots"\s+content="noindex/);
  });
});
