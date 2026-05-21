/**
 * compliance-ai.js
 *
 * AI rewrite module for UFS 1-300-02 compliance.
 * Sends violations that can't be auto-fixed to the Anthropic API
 * for sentence-level restructuring.
 */

import { jsonrepair } from 'jsonrepair';
import rulesData from '../data/ufs-1-300-02-rules.json';

const MAX_BLOCKS_PER_CHUNK = 20;

// ── System Prompt Builder ────────────────────────────────────────────────────

/**
 * Build the system prompt dynamically from the UFS rules JSON.
 */
export function buildSystemPrompt() {
  const prohibited = rulesData.prohibitedTerms
    .map(t => `- "${t.term}": ${t.replacement}`)
    .join('\n');

  const vague = rulesData.vagueTerms
    .map(t => `- "${t}"`)
    .join('\n');

  return `You are a UFGS specification language compliance editor. Your job is to rewrite construction specification text to comply with UFS 1-300-02.

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
 * @param {Object} options - { model, abortSignal, onProgress }
 * @returns {Array} rewrites - [{ blockId, original, proposed, changes }]
 */
export async function requestAIRewrite(blocks, violations, apiKey, options = {}) {
  const {
    model = 'claude-sonnet-4-20250514',
    abortSignal = null,
    onProgress = null,
  } = options;

  const chunks = chunkViolations(blocks, violations);
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
        totalBlocks: [...new Set(violations.map(v => v.blockId))].length,
      });
    }

    const chunk = chunks[i];
    const systemPrompt = buildSystemPrompt();
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
    results.push(...parsed);
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
