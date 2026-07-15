---
name: compliance-rule-workflow
description: Add, debug, or measure UFS 1-300-02 compliance rules and run the 4-corpus test suite (calibration/clean/dirty/adversarial). Use when adding a compliance rule to ufs-1-300-02-rules.json, debugging a false positive, measuring engine recall/precision after a change, or adding an adversarial edge case.
---

## Common task recipes

- **Add a compliance rule:** Edit `src/data/ufs-1-300-02-rules.json` (add to `prohibitedTerms`, `vagueTerms`, or `prohibitedSymbols`). The rule engine auto-generates regex via `buildRules()`. Run `npm run test:compliance` then `npm run test:corpus` to validate.
- **Debug a false positive:** `npm run corpus:test -- --corpus clean`, check `corpus/results/clean-results.json` for the rule ID, then inspect the pattern in `compliance-rules.js`.
- **Measure engine after a change:** `npm run corpus:test -- --corpus clean && npm run corpus:test -- --corpus dirty && npm run corpus:report` — compare metrics.json to previous baseline.
- **Add an adversarial edge case:** Edit `corpus/adversarial/adversarial.json`, add entry with `shouldFlag`/`ruleId`/`reason`, then re-run `npm run test:corpus:adversarial`.

## Corpus Testing Infrastructure

Three text-analysis engines measured against real UFGS text using a 4-corpus suite:

1. **Calibration** (`corpus/calibration/`) — 2,583 raw UFGS blocks from 5 sections. Validates primary rules (shall, should) produce zero hits on unmodified master text.
2. **Clean** (`corpus/clean/`) — same blocks rewritten by Claude Opus to full UFS 1-300-02 compliance. Every finding is a false positive. Measures precision.
3. **Dirty** (`corpus/dirty/`) — 644 blocks with 653 labeled injected violations. Measures recall per rule.
4. **Adversarial** (`corpus/adversarial/`) — 156 edge cases (FP traps, NLP ambiguity, domain jargon). Measures robustness.

**Regenerating results:** `node --import ./tools/json-loader.mjs tools/run-corpus-test.mjs --corpus clean` (or `dirty`, `calibration`, `adversarial`). Adversarial delegates to `tools/score-adversarial.mjs` since its shape is pass/fail per entry, not a findings list. Then `node tools/generate-report.mjs` for REPORT.md + metrics.json.

**Baseline (June 2026, harper.js 2.0 — stale, package.json now pins 2.4.0 post-#226, corpus not re-run):** Static recall 92.1%, NLP recall 67.5%, Grammar recall 65.6%. Static FP rate 0.35%. Adversarial accuracy 100% (adversarial.json v2.2.1). Full report: `corpus/results/REPORT.md`. Re-run `npm run test:corpus` against 2.4.0 before trusting these numbers.

The Grammar drop from the March 2026 baseline (78.4% → 65.6%) tracks the harper.js 1.12 → 2.0 bump in [#57](https://github.com/mttvnst-HA/secwriter/pull/57): 2.0 retired several rule categories and tightened agreement detection, trading recall for an 86% reduction in grammar FPs on the calibration corpus (2251 → 279 findings on 2,583 raw UFGS blocks) — the more impactful axis for spec text, where FPs vastly outnumber TPs. New 2.0 lint kinds (`Typo`, `Usage`) are gated in `DISABLED_LINT_KINDS` in `src/lib/grammar-checker.js`. The per-PR recall/adversarial deltas that carried the engines back to 100% (TERM-properly broadened to `proper`; TERM-as-necessary matching clause-final `as required`; the ADV-038/065/066 fixes in #165–#167; the 2026-05-22 adversarial refresh) live in `corpus/results/REPORT.md` + git history — re-run `npm run test:corpus` against 2.4.0 before trusting any of these numbers.

**Rule ID mapping:** The injection plan used semantic IDs (e.g., `COLLOQ-furnish`) that don't match sequential IDs from `buildRules()` (e.g., `TERM-034`). Mapping at `corpus/results/rule-id-mapping.json`. Any future recall analysis must use this mapping.

## Compliance Rule Development

When implementing compliance checks, always reference `reference/ufs_1_300_02.pdf` (raw text at `reference/ufs_1_300_02_text.txt`) rather than relying on general knowledge. Ask the user to provide the spec if not already available.

**Lesson (FMT-001 removal):** A "multiple spaces should be single space" rule was fabricated without UFS basis and generated 75+ false positives per spec — USACE .SEC files conventionally use double spaces after periods. **Every rule must trace to a specific UFS 1-300-02 section.**
