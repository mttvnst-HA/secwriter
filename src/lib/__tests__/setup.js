/**
 * Test setup: polyfill DOMParser for Node.js environment.
 * The SEC parser and serializer use browser DOMParser, which doesn't
 * exist in Node. linkedom provides a lightweight implementation.
 */
import { parseHTML } from 'linkedom';
import WebSocket from 'ws';

const { DOMParser } = parseHTML('');
globalThis.DOMParser = DOMParser;

// y-websocket's WebsocketProvider reads globalThis.WebSocket at construction.
// Node exposes it natively only from v22; CI (Node 20) needs a polyfill.
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = WebSocket;
}
