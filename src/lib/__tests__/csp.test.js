/**
 * CSP guardrail — fails CI if index.html's Content-Security-Policy ever
 * grows a non-loopback ws:// or wss:// origin.
 *
 * The collab prototype deliberately allows only ws://127.0.0.1:1234 and
 * ws://localhost:1234 in connect-src. The relay has no TLS, no auth, and
 * no rate limiting (see CLAUDE.md "Multi-user collaboration (prototype)"
 * and server/collab-server.cjs), so broadening the CSP to a remote host
 * without first shipping TLS + auth would expose CUI spec content over
 * the network.
 *
 * This test is the "CI gate" before any hosted deployment. If the CSP
 * needs to point at a real relay, it must be paired with:
 *   - wss:// (never plain ws://)
 *   - Real auth (tokens, not stub identity)
 *   - Origin check + rate limiting on the server
 *   - A conscious code review that deletes or updates this test
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = resolve(__dirname, '../../../index.html');

/** Loopback hostnames that are safe for prototype use. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function extractCspContent(html) {
  const match = html.match(
    /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=["']([^"']+)["']/i,
  );
  return match ? match[1] : null;
}

function extractWsOrigins(csp) {
  // Match ws:// or wss:// up to the next whitespace, semicolon, or quote.
  const re = /\b(wss?:\/\/[^\s;'"]+)/gi;
  const out = [];
  let m;
  while ((m = re.exec(csp)) !== null) out.push(m[1]);
  return out;
}

function hostOf(url) {
  try {
    // URL can't parse ws:// in all environments, but Node supports it.
    const u = new URL(url);
    return u.hostname;
  } catch {
    return null;
  }
}

describe('CSP guardrail', () => {
  const html = readFileSync(INDEX_HTML, 'utf8');
  const csp = extractCspContent(html);

  it('index.html has a Content-Security-Policy meta tag', () => {
    expect(csp).toBeTruthy();
  });

  it('CSP only allows ws:// / wss:// origins bound to loopback', () => {
    const origins = extractWsOrigins(csp);
    const nonLoopback = origins.filter((origin) => {
      const host = hostOf(origin);
      return !host || !LOOPBACK_HOSTS.has(host);
    });
    if (nonLoopback.length > 0) {
      throw new Error(
        'Non-loopback ws:// or wss:// origin found in CSP:\n  ' +
        nonLoopback.join('\n  ') +
        '\n\nThe collab prototype relay has no TLS / auth / rate limiting.' +
        ' Broadening CSP to a remote host is blocked until those ship.' +
        ' See src/lib/__tests__/csp.test.js for the gate.',
      );
    }
    expect(nonLoopback).toEqual([]);
  });

  it('CSP disallows plain http:// (non-loopback) origins in connect-src', () => {
    // Match connect-src directive and extract its sources.
    const match = csp.match(/connect-src\s+([^;]+)/i);
    if (!match) return; // no connect-src → nothing to check
    const sources = match[1].trim().split(/\s+/);
    const badHttp = sources.filter((s) => {
      if (!/^http:\/\//i.test(s)) return false;
      const host = hostOf(s);
      return !host || !LOOPBACK_HOSTS.has(host);
    });
    expect(badHttp).toEqual([]);
  });
});
