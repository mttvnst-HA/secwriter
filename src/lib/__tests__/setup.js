/**
 * Test setup: polyfill DOMParser for Node.js environment.
 * The SEC parser and serializer use browser DOMParser, which doesn't
 * exist in Node. linkedom provides a lightweight implementation.
 */
import { parseHTML } from 'linkedom';

const { DOMParser } = parseHTML('');
globalThis.DOMParser = DOMParser;
