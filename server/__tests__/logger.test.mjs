import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('logger', () => {
  let origEnv;
  beforeEach(() => { origEnv = process.env.SIM_LOG_FORMAT; });
  afterEach(() => {
    if (origEnv === undefined) delete process.env.SIM_LOG_FORMAT;
    else process.env.SIM_LOG_FORMAT = origEnv;
  });

  it('outputs JSON when SIM_LOG_FORMAT=json', () => {
    process.env.SIM_LOG_FORMAT = 'json';
    delete require.cache[require.resolve('../../server/logger.cjs')];
    const { createLogger } = require('../../server/logger.cjs');
    const lines = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    logger.info('room.persist', { roomId: 'demo', ms: 42 });
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.event, 'room.persist');
    assert.equal(parsed.roomId, 'demo');
    assert.equal(parsed.ms, 42);
    assert.ok(parsed.ts);
  });

  it('outputs plain text when SIM_LOG_FORMAT is unset', () => {
    delete process.env.SIM_LOG_FORMAT;
    delete require.cache[require.resolve('../../server/logger.cjs')];
    const { createLogger } = require('../../server/logger.cjs');
    const lines = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    logger.info('room.persist', { roomId: 'demo' });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('[collab]'));
    assert.ok(lines[0].includes('room.persist'));
    assert.ok(lines[0].includes('roomId=demo'));
  });

  it('error level includes err field', () => {
    process.env.SIM_LOG_FORMAT = 'json';
    delete require.cache[require.resolve('../../server/logger.cjs')];
    const { createLogger } = require('../../server/logger.cjs');
    const lines = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    logger.error('persist.failed', { roomId: 'x', err: 'EPERM' });
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.level, 'error');
    assert.equal(parsed.err, 'EPERM');
  });
});
