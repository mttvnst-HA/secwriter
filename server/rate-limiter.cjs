/**
 * In-memory sliding-window rate limiter.
 *
 * Interface: createRateLimiter() → { checkLimit(key, bucket, maxPerMinute) → { allowed, retryAfter } }
 *
 * Uses a Map<compositeKey, timestamps[]> with automatic cleanup every 60s.
 * Pluggable: a future Redis backend would implement the same checkLimit interface.
 */

function createRateLimiter() {
  const windows = new Map();
  const WINDOW_MS = 60_000;

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, timestamps] of windows) {
      const valid = timestamps.filter(t => now - t < WINDOW_MS);
      if (valid.length === 0) windows.delete(key);
      else windows.set(key, valid);
    }
  }, 60_000);
  if (cleanupInterval.unref) cleanupInterval.unref();

  return {
    checkLimit(key, bucket, maxPerMinute) {
      const compositeKey = `${bucket}:${key}`;
      const now = Date.now();
      let timestamps = windows.get(compositeKey);
      if (!timestamps) {
        timestamps = [];
        windows.set(compositeKey, timestamps);
      }

      while (timestamps.length > 0 && now - timestamps[0] >= WINDOW_MS) {
        timestamps.shift();
      }

      if (timestamps.length >= maxPerMinute) {
        const oldestValid = timestamps[0];
        const retryAfter = Math.ceil((oldestValid + WINDOW_MS - now) / 1000);
        return { allowed: false, retryAfter: Math.max(1, retryAfter) };
      }

      timestamps.push(now);
      return { allowed: true, retryAfter: 0 };
    },
  };
}

module.exports = { createRateLimiter };
