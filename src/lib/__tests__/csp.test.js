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

/**
 * Remote origins explicitly approved via code review for the deployed app.
 * Adding to this list means: the relay at this host has wss://, rate
 * limiting, and an auth provider configured (even if SIM_AUTH_PROVIDER=none
 * for the dev/test deployment, the surface is bounded — see render.yaml).
 */
const ALLOWED_REMOTE_HOSTS = new Set([
  // Render deployment of secwriter-collab — wss://, server-side rate
  // limits via SIM_RATE_LIMIT_*, R2-backed persistence. Origin pinned
  // here so a typo or a different service name is caught by CI.
  'secwriter-collab.onrender.com',
]);

function extractCspContent(html) {
  // The attribute value is quoted by either `"` or `'`. We capture the
  // opening delimiter in group 1 and use a backref to terminate the
  // value, so CSP content containing the other quote character (e.g.
  // `'self'`) is not truncated.
  const match = html.match(
    /<meta\s+http-equiv=(["'])Content-Security-Policy\1\s+content=(["'])([\s\S]*?)\2/i,
  );
  return match ? match[3] : null;
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

  it('CSP only allows ws:// / wss:// origins on the loopback or allowlist', () => {
    const origins = extractWsOrigins(csp);
    const unapproved = origins.filter((origin) => {
      const host = hostOf(origin);
      if (!host) return true;
      if (LOOPBACK_HOSTS.has(host)) return false;
      if (ALLOWED_REMOTE_HOSTS.has(host)) return false;
      return true;
    });
    if (unapproved.length > 0) {
      throw new Error(
        'Unapproved ws:// or wss:// origin in CSP:\n  ' +
        unapproved.join('\n  ') +
        '\n\nA remote relay must be on ALLOWED_REMOTE_HOSTS in this test' +
        ' (added via conscious code review) AND ship with wss://, server' +
        '-side rate limiting, and an auth surface. See src/lib/__tests__/' +
        'csp.test.js for the gate.',
      );
    }
    expect(unapproved).toEqual([]);
  });

  it('CSP disallows plain http:// (non-loopback) origins in connect-src', () => {
    // Match connect-src directive and extract its sources.
    const match = csp.match(/connect-src\s+([^;]+)/i);
    // N3 — fail loudly if connect-src is missing. Without it, browsers
    // fall back to default-src 'self' which is strictly safer, but the
    // absence of an explicit directive means this test is no longer
    // guarding what it claims to guard and should be updated.
    expect(match, 'CSP must have an explicit connect-src directive').toBeTruthy();
    const sources = match[1].trim().split(/\s+/);
    const badHttp = sources.filter((s) => {
      if (!/^http:\/\//i.test(s)) return false;
      const host = hostOf(s);
      return !host || !LOOPBACK_HOSTS.has(host);
    });
    expect(badHttp).toEqual([]);
  });

  it('CSP connect-src loopback origins use port 1234 (matching server/collab-server.cjs)', () => {
    const match = csp.match(/connect-src\s+([^;]+)/i);
    expect(match, 'CSP must have an explicit connect-src directive').toBeTruthy();
    const sources = match[1].trim().split(/\s+/);
    const loopback = sources.filter((s) => {
      const host = hostOf(s);
      return host && LOOPBACK_HOSTS.has(host);
    });
    const wrongPort = loopback.filter((s) => {
      try {
        const u = new URL(s);
        return u.port && u.port !== '1234';
      } catch {
        return false;
      }
    });
    if (wrongPort.length > 0) {
      throw new Error(
        'CSP loopback origin on wrong port (server listens on 1234):\n  ' +
        wrongPort.join('\n  '),
      );
    }
    expect(wrongPort).toEqual([]);
  });
});
