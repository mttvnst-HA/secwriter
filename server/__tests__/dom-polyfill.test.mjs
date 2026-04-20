import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('server DOMParser polyfill', () => {
  it('makes sec-serializer usable from Node after polyfill', async () => {
    require('../dom-polyfill.cjs');

    const { serializeSEC } = await import('../../src/lib/sec-serializer.js');
    const blocks = [
      { id: 'b1', type: 'title', part: 1, depth: 0, html: 'GENERAL' },
      { id: 'b2', type: 'txt', part: 1, depth: 0, section: 'b1', html: 'Hello world.' },
    ];
    const xml = serializeSEC(blocks, { sectionNumber: '01 00 00', sectionTitle: 'TEST' });
    assert.ok(xml.includes('<?xml'), 'should produce XML declaration');
    assert.ok(xml.includes('Hello world.'), 'should contain block text');
    assert.ok(xml.includes('<TXT>'), 'should contain TXT tags');
  });

  it('makes sec-parser usable from Node after polyfill', async () => {
    require('../dom-polyfill.cjs');

    const { serializeSEC } = await import('../../src/lib/sec-serializer.js');
    const { parseSEC } = await import('../../src/lib/sec-parser.js');
    const blocks = [
      { id: 'b1', type: 'title', part: 1, depth: 0, html: 'GENERAL' },
      { id: 'b2', type: 'txt', part: 1, depth: 0, section: 'b1', html: 'Test paragraph.' },
    ];
    const xml = serializeSEC(blocks, { sectionNumber: '01 00 00', sectionTitle: 'TEST' });
    const parsed = parseSEC(xml);
    assert.ok(parsed.length >= 2, 'should parse at least 2 blocks');
    assert.ok(parsed.some(b => b.type === 'txt'), 'should have a txt block');
  });
});
