/**
 * compliance-ai.js
 *
 * AI rewrite module for UFS 1-300-02 compliance.
 * Sends violations that can't be auto-fixed to the Anthropic API
 * for sentence-level restructuring.
 */

import { jsonrepair } from 'jsonrepair';
import rulesData from '../data/ufs-1-300-02-rules.json';
import { computeIgnoreKey, isFindingIgnored, isNlpRuleMuted } from './linting.js';
import { fingerprintBlock } from './lint-sidecar.js';

const MAX_BLOCKS_PER_CHUNK = 20;

// ── System Prompt Builder ────────────────────────────────────────────────────

/**
 * Build the system prompt dynamically from the UFS rules JSON.
 *
 * @param {Object} [options]
 * @param {Array<{ruleId: string, match: string}>} [options.ignoredInChunk]
 *   Per-finding dismissals scoped to the current chunk's blocks (from #141).
 *   When non-empty, a "Do not propose rewrites" section is appended so the
 *   model leaves dismissed matches untouched in blocks it IS asked to rewrite
 *   (sibling-finding case). The pre-filter already strips fully-ignored
 *   violations before they reach the API — this section is defense in depth.
 */
export function buildSystemPrompt(options = {}) {
  const { ignoredInChunk = [] } = options;

  const prohibited = rulesData.prohibitedTerms
    .map(t => `- "${t.term}": ${t.replacement}`)
    .join('\n');

  const vague = rulesData.vagueTerms
    .map(t => `- "${t}"`)
    .join('\n');

  const base = `You are a UFGS specification language compliance editor. Your job is to rewrite construction specification text to comply with UFS 1-300-02.

PROHIBITED TERMS (replace or restructure):
${prohibited}

VAGUE TERMS (replace with specific, measurable language):
${vague}

Rules:
1. Convert all requirements to imperative mood (direct commands)
2. Remove prohibited terms — restructure sentences as needed
3. Remove "The Contractor" as sentence subject — use direct imperative verb
4. Convert passive voice to active: "Materials shall be placed" -> "Place materials"
5. Do NOT change technical meaning, quantities, tolerances, or standards references
6. Do NOT change bracketed items [like this] — they are tailoring choices
7. Preserve all paragraph structure and sentence boundaries
8. Do NOT add new requirements or remove existing ones
9. If a sentence is already compliant, return it unchanged

Respond as JSON:
{
  "rewrites": [
    { "blockId": "n42", "original": "...", "proposed": "...", "changes": ["description"] }
  ]
}`;

  if (ignoredInChunk.length === 0) return base;

  const dismissals = ignoredInChunk
    .map(e => `- ${e.ruleId}: "${e.match}"`)
    .join('\n');

  return `${base}

The user has dismissed these matches in the blocks below. Do not propose rewrites for them:
${dismissals}`;
}

// ── User Prompt Builder ──────────────────────────────────────────────────────

/**
 * Strip HTML to plain text for API input.
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<del\b[^>]*>.*?<\/del>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\u200B/g, '')
    .trim();
}

/**
 * Build the user prompt from blocks and their violations.
 */
function buildUserPrompt(blocks, violations) {
  const items = blocks.map(b => ({
    blockId: b.id,
    text: stripHtml(b.html),
    violations: violations
      .filter(v => v.blockId === b.id)
      .map(v => ({ ruleId: v.ruleId, match: v.match, message: v.message })),
  }));

  return JSON.stringify(items, null, 2);
}

// ── Chunking ─────────────────────────────────────────────────────────────────

/**
 * Chunk violations into groups of MAX_BLOCKS_PER_CHUNK blocks.
 */
export function chunkViolations(blocks, violations) {
  // Get unique block IDs that have violations
  const blockIds = [...new Set(violations.map(v => v.blockId))];
  const chunks = [];

  for (let i = 0; i < blockIds.length; i += MAX_BLOCKS_PER_CHUNK) {
    const chunkBlockIds = new Set(blockIds.slice(i, i + MAX_BLOCKS_PER_CHUNK));
    const chunkBlocks = blocks.filter(b => chunkBlockIds.has(b.id));
    const chunkViolations = violations.filter(v => chunkBlockIds.has(v.blockId));
    chunks.push({ blocks: chunkBlocks, violations: chunkViolations });
  }

  return chunks;
}

// ── #141: Pre-filter, prompt section, post-filter ────────────────────────────

/**
 * Drop violations the user has already dismissed before they reach the API.
 *
 * Two sources of suppression — both checked against `lintingState.ignored`:
 *   1. Per-finding ignore: `(ruleId, blockHash, match)` → ignoreKey via
 *      `computeIgnoreKey`, dismissed if present non-tombstoned in
 *      `state.ignored.findings`.
 *   2. Rule-wide mute: `ruleId` present non-tombstoned in
 *      `state.ignored.mutedRules`. The mute check short-circuits the hash
 *      lookup, so muted-rule violations cost zero hashing.
 *
 * Returns `{ kept, droppedByBlock }` where `droppedByBlock` is a
 * `Map<blockId, dropCount>` for the post-filter step (rewrites for any block
 * with ALL violations dropped should not be accepted from the model).
 *
 * No match-string normalization — the pre-filter compares exactly as
 * `useBlockLinting.js` populates `ignoredFindings`. A curly-quote variant of
 * a previously-dismissed ASCII match is treated as a distinct finding by
 * design (user must dismiss each variant they encounter).
 */
export async function filterViolationsForAI(violations, blocks, lintingState, abortSignal = null) {
  const empty = { kept: violations, droppedByBlock: new Map() };
  if (!lintingState?.ignored) return empty;

  // #170-review-15: tolerate partial sidecar shapes where one inner map is
  // missing or non-Map. The selectors below call .get() on the maps directly
  // and would TypeError on a non-Map shape mid-loop. Normalize once up front.
  const ignored = lintingState.ignored;
  const findings = ignored.findings instanceof Map ? ignored.findings : null;
  const mutedRules = ignored.mutedRules instanceof Map ? ignored.mutedRules : null;
  if ((!findings || findings.size === 0) && (!mutedRules || mutedRules.size === 0)) {
    return empty;
  }
  const safeState = {
    ...lintingState,
    ignored: { findings: findings || new Map(), mutedRules: mutedRules || new Map() },
  };

  // #170-review-1: honor cancellation BEFORE the expensive hashing pass.
  if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // #170-review-8: skip per-block hashing when only mutedRules is populated —
  // the mute branch short-circuits before any hash is consulted.
  const needsHashing = !!(findings && findings.size > 0);

  const blockById = new Map(blocks.map(b => [b.id, b]));
  const blockIds = [...new Set(violations.map(v => v.blockId))];
  const hashByBlockId = needsHashing
    ? new Map(await Promise.all(blockIds.map(async id => {
        const block = blockById.get(id);
        if (!block) return [id, null];
        try { return [id, await fingerprintBlock(block.html || '')]; }
        catch { return [id, null]; }
      })))
    : new Map();

  if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

  // #170-review-5: parallel ignoreKey computation. The pre-PR loop awaited
  // computeIgnoreKey sequentially per violation, blocking the main thread for
  // 2-6s on documents near the MAX_VIOLATIONS cap. Promise.all collapses that
  // to ~max(N) parallel SHA-256 digests.
  const ignoreKeys = needsHashing
    ? await Promise.all(violations.map(v => {
        const blockHash = hashByBlockId.get(v.blockId);
        return blockHash ? computeIgnoreKey(v.ruleId, blockHash, v.match) : Promise.resolve(null);
      }))
    : new Array(violations.length).fill(null);

  if (abortSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const kept = [];
  const droppedByBlock = new Map();
  const drop = (v) => {
    droppedByBlock.set(v.blockId, (droppedByBlock.get(v.blockId) || 0) + 1);
  };

  for (let i = 0; i < violations.length; i++) {
    const v = violations[i];
    // Rule-wide mute — cheap, short-circuits the hash lookup.
    if (isNlpRuleMuted(safeState, v.ruleId)) { drop(v); continue; }

    const ignoreKey = ignoreKeys[i];
    if (!ignoreKey) { kept.push(v); continue; }  // no findings, or can't hash → keep
    if (isFindingIgnored(safeState, ignoreKey)) { drop(v); continue; }

    kept.push(v);
  }

  return { kept, droppedByBlock };
}

/**
 * For each block in `chunkBlocks`, look up any non-tombstoned ignored entries
 * whose `blockHash` matches the block's current hash, and return a flat
 * `Array<{ruleId, match}>` for embedding into the system prompt's
 * "Do not propose rewrites" section.
 *
 * Bounded to the chunk's blocks (NOT the whole document) — keeps the
 * prompt-size growth linear in chunk size, not in project-wide ignored count.
 */
export async function ignoredEntriesForChunk(chunkBlocks, lintingState) {
  if (!lintingState?.ignored?.findings) return [];
  const findings = lintingState.ignored.findings;
  if (findings.size === 0) return [];

  // Build chunk's blockHash set in parallel.
  const hashes = await Promise.all(chunkBlocks.map(async b => {
    try { return await fingerprintBlock(b.html || ''); }
    catch { return null; }
  }));
  const chunkHashes = new Set(hashes.filter(Boolean));
  if (chunkHashes.size === 0) return [];

  const out = [];
  for (const entry of findings.values()) {
    if (!entry || entry.tombstone === true) continue;
    if (!chunkHashes.has(entry.blockHash)) continue;
    out.push({ ruleId: entry.ruleId, match: entry.match });
  }
  return out;
}

/**
 * Drop rewrites whose `blockId` is not in `survivingBlockIds`. In the current
 * wiring this can only fire when the model returns a rewrite for a blockId
 * that wasn't in the chunk we sent (model hallucination — `chunkViolations`
 * already excludes blocks whose violations were all pre-filtered, so the
 * "block we deliberately didn't ask about" case never reaches the model).
 * Defense in depth: catches malformed model output before it lands in the
 * panel as an accepted rewrite.
 *
 * Caller convention:
 *   - `null` / non-Set → passthrough (no pre-filtering ran).
 *   - empty Set → passthrough (#170-review-4: the model wasn't sent any
 *     blocks, so dropping all rewrites would be the wrong default if the
 *     chunker ever produces an empty chunk).
 *   - non-empty Set → drop rewrites whose blockId is missing, with a warn.
 */
export function postFilterRewrites(rewrites, survivingBlockIds) {
  if (!survivingBlockIds || !(survivingBlockIds instanceof Set)) return rewrites;
  if (survivingBlockIds.size === 0) return rewrites;
  const kept = [];
  for (const r of rewrites) {
    if (survivingBlockIds.has(r.blockId)) {
      kept.push(r);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[compliance-ai] dropped rewrite for block ${r.blockId} — blockId not in the chunk sent to the model`);
    }
  }
  return kept;
}

// ── Token Estimation ─────────────────────────────────────────────────────────

/**
 * Estimate token count for a set of blocks and violations.
 * ~4 characters per token is a rough estimate for English text.
 */
export function estimateTokens(blocks, violations) {
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(blocks, violations);
  const totalChars = systemPrompt.length + userPrompt.length;
  return Math.ceil(totalChars / 4);
}

/**
 * Estimate cost for a given token count.
 * Claude Sonnet pricing: $3/M input, $15/M output (approximate).
 */
export function estimateCost(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1_000_000) * 3;
  const outputCost = (outputTokens || inputTokens * 0.5) / 1_000_000 * 15;
  return inputCost + outputCost;
}

// ── API Error ────────────────────────────────────────────────────────────────

export class ComplianceAPIError extends Error {
  constructor(status, body) {
    super(`Compliance API error (${status}): ${body}`);
    this.status = status;
    this.body = body;
  }
}

// ── API Call ──────────────────────────────────────────────────────────────────

/**
 * Request AI rewrites for violations that can't be auto-fixed.
 *
 * @param {Array} blocks - Block objects with HTML content
 * @param {Array} violations - Violations where fix is null
 * @param {string} apiKey - Anthropic API key
 * @param {Object} options - { model, abortSignal, onProgress, lintingState }
 *   `lintingState` enables the #141 three-layer ignored-finding suppression:
 *   input pre-filter (drop dismissed/muted violations before chunking),
 *   chunk-scoped negative-constraint section in the system prompt, and
 *   output post-filter (drop rewrites for blocks whose violations were all
 *   pre-filtered). Pass `null` or omit to disable suppression entirely.
 * @returns {Promise<{ rewrites: Array<{ blockId, original, proposed, changes }>,
 *                    tokensUsed: number, inputTokens: number, outputTokens: number }>}
 *   `tokensUsed` is `inputTokens + outputTokens`, preserved for callers that
 *   read a single token total (e.g. CompliancePanel). `inputTokens` /
 *   `outputTokens` are surfaced separately for the #137 C²/$ corpus metric
 *   (different per-1k rates for input vs output).
 */
export async function requestAIRewrite(blocks, violations, apiKey, options = {}) {
  const {
    model = 'claude-sonnet-4-20250514',
    abortSignal = null,
    onProgress = null,
    lintingState = null,
  } = options;

  // #141 layer 1 — input pre-filter. Drops dismissed/muted violations so the
  // API never sees them. `kept` replaces `violations` for chunking; the
  // surviving blockId set drives layer 3 (post-filter). abortSignal is honored
  // inside the filter so Cancel is responsive before the first API call.
  const { kept: filteredViolations } = await filterViolationsForAI(
    violations, blocks, lintingState, abortSignal);

  const chunks = chunkViolations(blocks, filteredViolations);
  const results = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let i = 0; i < chunks.length; i++) {
    if (abortSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    if (onProgress) {
      onProgress({
        chunk: i + 1,
        totalChunks: chunks.length,
        blocksProcessed: results.length,
        totalBlocks: [...new Set(filteredViolations.map(v => v.blockId))].length,
      });
    }

    const chunk = chunks[i];

    // #141 layer 2 — chunk-scoped negative-constraint section. Catches the
    // sibling case where a block has one ignored + one non-ignored finding:
    // the non-ignored survives pre-filter, the model is asked to rewrite the
    // block, and the prompt tells it not to touch the dismissed span.
    const ignoredInChunk = await ignoredEntriesForChunk(chunk.blocks, lintingState);
    const systemPrompt = buildSystemPrompt({ ignoredInChunk });
    const userPrompt = buildUserPrompt(chunk.blocks, chunk.violations);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: abortSignal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ComplianceAPIError(response.status, body);
    }

    const data = await response.json();
    totalInputTokens += data.usage?.input_tokens || 0;
    totalOutputTokens += data.usage?.output_tokens || 0;

    const parsed = parseAIResponse(data);

    // #141 layer 3 — output post-filter. Drops rewrites whose blockId is
    // missing from the chunk (model hallucination — the chunker already
    // excludes blocks whose violations were all pre-filtered). Active
    // whenever lintingState was supplied; harmless no-op when the model
    // behaves and only emits rewrites for chunk blocks.
    const survivingBlockIds = lintingState?.ignored
      ? new Set(chunk.violations.map(v => v.blockId))
      : null;
    const filteredRewrites = postFilterRewrites(parsed, survivingBlockIds);

    results.push(...filteredRewrites);
  }

  // #137: return input/output token counts separately for the C²/$ corpus
  // metric (different per-1k rates for input vs output). `tokensUsed` is
  // preserved for backwards compatibility — App's CompliancePanel reads it.
  return {
    rewrites: results,
    tokensUsed: totalInputTokens + totalOutputTokens,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  };
}

/**
 * Parse the AI response to extract rewrites.
 *
 * Primary path: JSON.parse on the matched JSON object.
 * Fallback path: when JSON.parse throws (trailing commas, Python literals,
 * unterminated strings, etc.), run the matched text through `jsonrepair`
 * and try again. Logs a console.warn with the original error message so
 * the frequency of malformed-but-recoverable responses is visible in dev
 * consoles; intentionally does NOT log the full response (could contain
 * spec text). If repair also throws, return [] (original behavior).
 */
export function parseAIResponse(data) {
  // The response content is in data.content[0].text
  const text = data?.content?.[0]?.text || '';

  // Prefer the matched {...} substring; fall back to the full text (covers
  // unterminated-object cases where the regex can't find a closing brace).
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch ? jsonMatch[0] : text;
  if (!candidate || candidate.indexOf('{') === -1) return [];

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (parseErr) {
    try {
      // jsonrepair can salvage trailing commas, Python True/None/false-y
      // literals, single quotes, missing/extra brackets, and unterminated
      // strings — see https://github.com/josdejong/jsonrepair.
      const repaired = jsonrepair(candidate);
      parsed = JSON.parse(repaired);
      // eslint-disable-next-line no-console
      console.warn(
        `[compliance-ai] JSON.parse failed, jsonrepair salvaged response: ${parseErr.message}`,
      );
    } catch {
      return [];
    }
  }

  if (!parsed || !parsed.rewrites || !Array.isArray(parsed.rewrites)) return [];
  return parsed.rewrites.filter(r => r.blockId && r.proposed && r.proposed !== r.original);
}

// ── Test Connection ──────────────────────────────────────────────────────────

/**
 * Test if an API key is valid by making a minimal API call.
 */
export async function testConnection(apiKey) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Reply with "ok"' }],
      }),
    });

    if (response.ok) return { success: true };
    const body = await response.text();
    return { success: false, error: `API returned ${response.status}: ${body}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── API Key Storage ──────────────────────────────────────────────────────────

const STORAGE_KEY = 'sim-anthropic-api-key';

export function getApiKey() {
  return localStorage.getItem(STORAGE_KEY);
}

export function setApiKey(key) {
  localStorage.setItem(STORAGE_KEY, key);
}

export function clearApiKey() {
  localStorage.removeItem(STORAGE_KEY);
}
