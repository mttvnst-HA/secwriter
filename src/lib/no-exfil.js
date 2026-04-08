// Attribute set applied to every typing surface (contentEditable, input, textarea)
// to prevent browser/extension features from sending CUI spec text to third-party
// servers. Spread as React props: {...NO_EXFIL_PROPS}.
//
// Threats covered:
// - Chrome "Help me write" / Edge Copilot writing assistance (writingsuggestions)
// - Chrome enhanced spellcheck (spellCheck)
// - Browser autofill / autocomplete sync (autoComplete)
// - Mobile autocorrect / autocapitalize text mutation
// - Grammarly and similar extensions (data-gramm*)
//
// See CLAUDE.md "Browser data exfiltration prevention" and the regression
// test at src/lib/__tests__/no-exfil.test.js before changing this.
export const NO_EXFIL_PROPS = Object.freeze({
  spellCheck: false,
  autoCorrect: 'off',
  autoCapitalize: 'off',
  autoComplete: 'off',
  'data-gramm': 'false',
  'data-gramm_editor': 'false',
  'data-enable-grammarly': 'false',
  writingsuggestions: 'false',
});
