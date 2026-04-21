/**
 * Structured logger for SecWriter collab server.
 *
 * When SIM_LOG_FORMAT=json, outputs one JSON line per log call.
 * Otherwise outputs plain-text format matching existing console.log style.
 *
 * Usage:
 *   const { log } = require('./logger.cjs');
 *   log.info('room.persist', { roomId: 'demo', ms: 42 });
 *   log.warn('persist.failed', { roomId: 'demo', err: err.message });
 *   log.error('alert', { roomId: 'demo', failures: 3 });
 */

function createLogger(sink) {
  const out = sink || { write: (line) => process.stdout.write(line + '\n') };
  const isJson = process.env.SIM_LOG_FORMAT === 'json';

  function emit(level, event, fields = {}) {
    if (isJson) {
      out.write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
    } else {
      const extras = Object.entries(fields)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      out.write(`[collab] ${level}: ${event}${extras ? ' ' + extras : ''}`);
    }
  }

  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}

const log = createLogger();

module.exports = { createLogger, log };
