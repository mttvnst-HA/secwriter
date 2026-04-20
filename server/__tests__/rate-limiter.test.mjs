import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('rate-limiter', () => {
  it('allows requests under the limit', () => {
    const { createRateLimiter } = require('../../server/rate-limiter.cjs');
    const limiter = createRateLimiter();
    for (let i = 0; i < 10; i++) {
      const result = limiter.checkLimit('127.0.0.1', 'http-read', 60);
      assert.equal(result.allowed, true);
    }
  });

  it('blocks requests over the limit', () => {
    const { createRateLimiter } = require('../../server/rate-limiter.cjs');
    const limiter = createRateLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.checkLimit('10.0.0.1', 'ws', 5);
    }
    const result = limiter.checkLimit('10.0.0.1', 'ws', 5);
    assert.equal(result.allowed, false);
    assert.ok(result.retryAfter > 0);
  });

  it('tracks separate buckets per key', () => {
    const { createRateLimiter } = require('../../server/rate-limiter.cjs');
    const limiter = createRateLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.checkLimit('a', 'ws', 5);
    }
    const result = limiter.checkLimit('b', 'ws', 5);
    assert.equal(result.allowed, true);
  });

  it('tracks separate buckets per bucket name', () => {
    const { createRateLimiter } = require('../../server/rate-limiter.cjs');
    const limiter = createRateLimiter();
    for (let i = 0; i < 5; i++) {
      limiter.checkLimit('c', 'ws', 5);
    }
    const result = limiter.checkLimit('c', 'http-read', 5);
    assert.equal(result.allowed, true);
  });
});
