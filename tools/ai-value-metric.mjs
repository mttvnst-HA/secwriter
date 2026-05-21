/**
 * ai-value-metric — pure helpers for the Value (C²/$) corpus metric (#137).
 *
 *   Value (C²/$) = avg_correctness² ÷ avg_USD_per_run
 *
 * Plumbing only — no policy. Squaring punishes "cheap but unreliable" models:
 * a model with 0.5 correctness at $0.01/run scores 25× lower than one with
 * 0.95 correctness at the same cost. The framework comes from WriterAgent
 * (KeithCu/writeragent); this implementation is a small numeric helper, not
 * a model leaderboard.
 *
 * No network, no fs, no async. Trivially unit-testable.
 */

/**
 * Compute the cost of a single AI run from token counts and per-1k rates.
 * Rates are USD per 1,000 tokens. Returns USD (number).
 *
 * @param {{ inputTokens:number, outputTokens:number }} run
 * @param {{ input_per_1k:number, output_per_1k:number }} pricing
 * @returns {number} USD cost of this run (may be 0 if either field missing)
 */
export function costOfRun(run, pricing) {
  if (!run || !pricing) return 0;
  const inTok = Number(run.inputTokens) || 0;
  const outTok = Number(run.outputTokens) || 0;
  const inRate = Number(pricing.input_per_1k) || 0;
  const outRate = Number(pricing.output_per_1k) || 0;
  return (inTok / 1000) * inRate + (outTok / 1000) * outRate;
}

/**
 * Aggregate a list of AI runs into the value metric for a single model.
 *
 * Each `runs[i]` shape:
 *   {
 *     model: string,            // optional — caller should pre-filter
 *     correctness: number,      // 0..1
 *     inputTokens: number,
 *     outputTokens: number,
 *   }
 *
 * Returns `null` when the run list is empty (avoids 0/0 NaN in the caller).
 * Otherwise returns:
 *   {
 *     runs:           number,   // count
 *     avgCorrectness: number,   // 0..1
 *     avgUsdPerRun:   number,   // USD
 *     value:          number,   // (avgCorrectness² / avgUsdPerRun); +Infinity when cost is 0
 *   }
 *
 * `value = +Infinity` (not NaN) when avgUsdPerRun is 0 — a free model that's
 * also correct should sort above every priced model. Callers that print the
 * column should guard against Infinity and render a placeholder ("—").
 *
 * @param {Array} runs
 * @param {{ input_per_1k:number, output_per_1k:number }} pricing
 */
export function aggregateModel(runs, pricing) {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  let sumCorrectness = 0;
  let sumUsd = 0;
  let n = 0;
  for (const r of runs) {
    if (!r || typeof r !== 'object') continue;
    const c = Number(r.correctness);
    if (!Number.isFinite(c)) continue;
    sumCorrectness += c;
    sumUsd += costOfRun(r, pricing);
    n++;
  }
  if (n === 0) return null;
  const avgCorrectness = sumCorrectness / n;
  const avgUsdPerRun = sumUsd / n;
  const value = avgUsdPerRun === 0
    ? Number.POSITIVE_INFINITY
    : (avgCorrectness * avgCorrectness) / avgUsdPerRun;
  return { runs: n, avgCorrectness, avgUsdPerRun, value };
}

/**
 * Group runs by `run.model`, then aggregate each group. Returns a Map
 * `<modelId, aggregate>` for caller iteration (preserves insertion order).
 *
 * Runs whose model is missing from the pricing JSON still aggregate, but
 * their `avgUsdPerRun` will be 0 — surface a warning at the call site if
 * unrecognized models are present.
 *
 * @param {Array} runs
 * @param {{ models: Record<string, { input_per_1k:number, output_per_1k:number }> }} pricingDoc
 */
export function aggregateByModel(runs, pricingDoc) {
  const out = new Map();
  if (!Array.isArray(runs) || !pricingDoc || !pricingDoc.models) return out;
  const groups = new Map();
  for (const r of runs) {
    if (!r || typeof r.model !== 'string') continue;
    if (!groups.has(r.model)) groups.set(r.model, []);
    groups.get(r.model).push(r);
  }
  for (const [model, group] of groups) {
    const pricing = pricingDoc.models[model] || { input_per_1k: 0, output_per_1k: 0 };
    const agg = aggregateModel(group, pricing);
    if (agg) out.set(model, agg);
  }
  return out;
}
