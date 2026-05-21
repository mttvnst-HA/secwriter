/**
 * lint-sidecar — Encode/decode for the `.lint.json` block-granular finding
 * cache (issue #138, phase 1).
 *
 * Pure module: no DOM, no React, no engine access. Callers (App on .SEC
 * import/save, the linting reducer's `prefillFromSidecar`) drive I/O and
 * state-store wiring; this module owns only the cache shape, the
 * fingerprint contract, and the round-trip.
 *
 * ## Fingerprint
 *
 * SHA-256 of the block html, truncated to the first 24 hex chars (96 bits).
 * Matches the WriterAgent payload (KeithCu/writeragent) so future migration
 * to sentence-level keying — see ADR-0015 for why we *don't* go there in v1
 * — would share the same primitive.
 *
 * Async because Web Crypto's `crypto.subtle.digest` is async. The encode path
 * gathers fingerprints in parallel via Promise.all.
 *
 * ## Sidecar payload v1
 *
 *   { v: 1,
 *     good: "<concat 24-char fingerprints, one per clean block>",
 *     bad:  { "<fp>": { g: [...], n: [...], c: [...] } } }
 *
 * "Clean" = the block had a cached findings entry whose three tier arrays were
 * all empty. We persist clean blocks so a future load can skip re-running
 * engines on them (the engines are local but not free — particularly Harper's
 * WASM startup and compromise's lazy 210 KB chunk).
 *
 * Block findings are NOT keyed by `blockId` in the payload — block ids are
 * generated per parse (`n1`, `n2`, …) and would invalidate the cache after a
 * single block insert. Keying by html-fingerprint lets the cache survive
 * structural edits as long as the *text* of a given block is unchanged.
 *
 * ## Decode contract
 *
 *   decode(payload) → {
 *     fingerprints: Map<fp, 'good' | 'bad'>,    // every fp the sidecar covers
 *     byFingerprint: Map<fp, BlockFindings>,    // bad-keyed findings only
 *   }
 *
 * The caller (App, on import) walks the freshly-parsed blocks, computes each
 * block's fingerprint, and:
 *   - if `fingerprints.get(fp) === 'good'`: prefill an empty BlockFindings for
 *     that blockId (suppresses inline engines until the html changes).
 *   - if `fingerprints.get(fp) === 'bad'`: prefill from `byFingerprint.get(fp)`.
 *   - otherwise: no cache hit, engines run normally.
 *
 * ## Cache invalidation
 *
 * No explicit invalidation pass is needed. When a block is edited, the
 * existing debounced lint pipeline runs on the new html and overwrites the
 * `byBlock` entry. The stale fingerprint never matches again because the
 * sidecar is only consulted at hand-off (load) time, not per-keystroke.
 *
 * ## Range objects
 *
 * Live `Range` objects on findings (used by CSS.highlights) are intentionally
 * stripped during encode — they're DOM references that can't cross a save/load
 * boundary. The decoded findings carry `range: null`; the next time the block
 * is focused, the engine re-derives ranges from the violation offsets. The
 * cache still hits in the sense that the *violation list* is preserved — only
 * the lazy DOM materialization runs again.
 */

const FINGERPRINT_HEX_CHARS = 24; // 96 bits — matches WriterAgent v2
const FINGERPRINT_LEN = FINGERPRINT_HEX_CHARS;
const PAYLOAD_VERSION = 1;

/** Async SHA-256 fingerprint of `html`, truncated to 24 hex chars. */
export async function fingerprintBlock(html) {
  const text = typeof html === 'string' ? html : '';
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    // Node-less / pre-WebCrypto environment: fall back to a small synchronous
    // hash via dynamic require so this module stays browser-compatible. Tests
    // run in jsdom which exposes crypto.subtle; this branch is paranoia.
    return fallbackFingerprint(text);
  }
  const bytes = new TextEncoder().encode(text);
  const digest = await subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < view.length && out.length < FINGERPRINT_LEN; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out.slice(0, FINGERPRINT_LEN);
}

function fallbackFingerprint(text) {
  // FNV-1a 64-bit-ish, packed into 24 hex chars. Only used when Web Crypto
  // is missing (should not occur in supported targets — kept as a guard).
  let h1 = 0xcbf29ce4, h2 = 0x84222325;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = (h1 ^ c) >>> 0;
    h2 = (h2 ^ c) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  const a = h1.toString(16).padStart(8, '0');
  const b = h2.toString(16).padStart(8, '0');
  return (a + b + a).slice(0, FINGERPRINT_LEN);
}

/**
 * Strip live Range references from a violation list, so the result is
 * JSON-serializable. Preserves the violation object itself (offset, ruleId,
 * severity, match, etc.); only `f.range` is dropped.
 */
function stripFindings(findings) {
  if (!Array.isArray(findings)) return [];
  const out = [];
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    const v = f.violation;
    if (!v || typeof v !== 'object') continue;
    out.push({ violation: v });
  }
  return out;
}

/** Inverse: re-hydrate stripped findings with `range: null`. */
function rehydrateFindings(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(f => f && typeof f === 'object' && f.violation)
    .map(f => ({ range: null, violation: f.violation }));
}

function isBlockClean(bf) {
  return (
    (!bf.compliance || bf.compliance.length === 0) &&
    (!bf.nlp || bf.nlp.length === 0) &&
    (!bf.grammar || bf.grammar.length === 0)
  );
}

/**
 * Encode the linting reducer's `byBlock` map into the v1 payload.
 *
 * @param {Map<string, BlockFindings>} byBlock — keyed by blockId
 * @param {Array<{ id: string, html?: string }>} blocksOrder — current block array
 * @returns {Promise<{ v: 1, good: string, bad: Record<string, object> }>}
 *
 * Blocks not in `byBlock` are skipped entirely — the cache covers only blocks
 * we've actually linted. Empty-findings blocks land in `good`; non-empty in
 * `bad`. Block order in `good` matches blocksOrder iteration order so the
 * concatenation is deterministic for byte-stable round-trip.
 */
export async function encodeSidecar(byBlock, blocksOrder) {
  const safeMap = byBlock instanceof Map ? byBlock : new Map();
  const safeOrder = Array.isArray(blocksOrder) ? blocksOrder : [];

  // Compute fingerprints in parallel.
  const fpEntries = await Promise.all(
    safeOrder.map(async (b) => {
      if (!b || typeof b.id !== 'string') return null;
      const bf = safeMap.get(b.id);
      if (!bf) return null;
      const fp = await fingerprintBlock(b.html || '');
      return { fp, bf };
    })
  );

  const goodParts = [];
  const bad = {};
  const seen = new Set();
  for (const entry of fpEntries) {
    if (!entry) continue;
    const { fp, bf } = entry;
    if (seen.has(fp)) continue;     // dedupe — duplicate-content blocks share one entry
    seen.add(fp);
    if (isBlockClean(bf)) {
      goodParts.push(fp);
    } else {
      bad[fp] = {
        g: stripFindings(bf.grammar),
        n: stripFindings(bf.nlp),
        c: stripFindings(bf.compliance),
      };
    }
  }
  return { v: PAYLOAD_VERSION, good: goodParts.join(''), bad };
}

/**
 * Decode a v1 payload into a fingerprint → status map and a findings map.
 *
 * Tolerant of unknown future fields (forward-compat). Returns empty maps for
 * malformed input rather than throwing — load-boundary defense, mirrors
 * `cm.normalizeForLoad`.
 */
export function decodeSidecar(payload) {
  const fingerprints = new Map();
  const byFingerprint = new Map();
  if (!payload || typeof payload !== 'object') return { fingerprints, byFingerprint };
  if (payload.v !== PAYLOAD_VERSION) return { fingerprints, byFingerprint };

  const good = typeof payload.good === 'string' ? payload.good : '';
  if (good.length % FINGERPRINT_LEN === 0) {
    for (let i = 0; i < good.length; i += FINGERPRINT_LEN) {
      const fp = good.slice(i, i + FINGERPRINT_LEN);
      if (fp.length === FINGERPRINT_LEN) fingerprints.set(fp, 'good');
    }
  }

  const bad = payload.bad && typeof payload.bad === 'object' ? payload.bad : {};
  for (const [fp, entry] of Object.entries(bad)) {
    if (typeof fp !== 'string' || fp.length !== FINGERPRINT_LEN) continue;
    if (!entry || typeof entry !== 'object') continue;
    fingerprints.set(fp, 'bad');
    byFingerprint.set(fp, {
      compliance: rehydrateFindings(entry.c),
      nlp: rehydrateFindings(entry.n),
      grammar: rehydrateFindings(entry.g),
      grammarText: null,
    });
  }

  return { fingerprints, byFingerprint };
}

/**
 * Build the App-facing prefill: walk current blocks, fingerprint each, and
 * project the decoded payload into a `Map<blockId, BlockFindings>` that
 * `linting.prefillFromSidecar` can absorb.
 *
 * Returned map covers only blocks with a fingerprint hit ('good' → empty
 * BlockFindings; 'bad' → rehydrated findings). Blocks without a hit are
 * absent — the engines run normally for them.
 */
export async function projectDecoded(decoded, blocks) {
  const out = new Map();
  if (!decoded || !Array.isArray(blocks)) return out;
  const { fingerprints, byFingerprint } = decoded;
  if (!(fingerprints instanceof Map) || fingerprints.size === 0) return out;

  for (const b of blocks) {
    if (!b || typeof b.id !== 'string') continue;
    const fp = await fingerprintBlock(b.html || '');
    const status = fingerprints.get(fp);
    if (status === 'good') {
      out.set(b.id, { compliance: [], nlp: [], grammar: [], grammarText: null });
    } else if (status === 'bad') {
      const bf = byFingerprint.get(fp);
      if (bf) out.set(b.id, bf);
    }
  }
  return out;
}
