/**
 * Polyfill DOMParser for Node.js using linkedom.
 *
 * The SEC serializer and parser use browser DOMParser for XML parsing.
 * This file provides the same polyfill used by the Vitest test setup
 * (src/lib/__tests__/setup.js) but in CJS for the collab server.
 *
 * Call require('./dom-polyfill.cjs') once at server startup, before
 * any dynamic import() of the ESM serializer/parser modules.
 */
'use strict';

if (typeof globalThis.DOMParser === 'undefined') {
  const { parseHTML } = require('linkedom');
  const { DOMParser } = parseHTML('');
  globalThis.DOMParser = DOMParser;
}
