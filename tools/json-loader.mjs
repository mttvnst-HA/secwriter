/**
 * Custom Node.js module loader that handles bare JSON imports.
 * Required because compliance-rules.js uses `import data from './file.json'`
 * without the `with { type: 'json' }` attribute (works in Vite, not raw Node).
 *
 * Usage: node --import ./tools/json-loader.mjs tools/run-corpus-test.mjs
 */
import { register } from 'node:module';

register(new URL('./json-loader-hooks.mjs', import.meta.url));
