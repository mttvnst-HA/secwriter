# ADR-0003: Compliance rules live in JSON, not source code

**Status:** Accepted
**Date:** 2026-05-01

## Context

SecWriter's compliance engine enforces UFS 1-300-02 — the USACE specification authoring standard. UFS defines prohibited terms ("shall," "will," etc.), prohibited symbols, vague terms, required capitalizations, colloquial words, redundant phrases, and required practices.

There were two ways to encode these rules:

1. **Hard-code each rule as a JavaScript regex literal in `compliance-rules.js`**, with the message and UFS reference as adjacent strings.
2. **Store the rules as data in `src/data/ufs-1-300-02-rules.json`**, derived from `reference/ufs_1_300_02.pdf`, and have `buildRules()` synthesize regex from the categorized JSON at startup.

USACE updates UFS 1-300-02 periodically. Each update changes prohibited-term lists, vague-term lists, and required-capitalization lists. Hard-coding makes this a code change every revision; data-driven makes it a JSON refresh.

A historical lesson reinforces this: the now-removed `FMT-001` "multiple spaces should be single space" rule was once fabricated without UFS basis and generated 75+ false positives per spec. Every rule must trace to a specific UFS 1-300-02 section, and that traceability is easier to audit when the rules are data with cited references rather than scattered regex.

## Decision

Compliance rules are **data**. They live in `src/data/ufs-1-300-02-rules.json`, organized by category (`prohibitedTerms`, `prohibitedSymbols`, `vagueTerms`, `requiredCapitalizations`, `colloquial`, `redundant`, `requiredPractice`). `buildRules()` in `src/lib/compliance-rules.js` reads the JSON at startup and generates ~81 rule objects, including regex.

When USACE publishes a new edition, the workflow is:

1. Re-extract the rule data from the new PDF (raw text in `reference/ufs_1_300_02_text.txt`).
2. Update `src/data/ufs-1-300-02-rules.json`.
3. Run `npm run test:compliance` and `npm run test:corpus` to validate.
4. No source-code changes.

## Consequences

- **Positive:** Editorial updates are data updates. UFS-traceability is enforced by the JSON's structure (each rule cites a UFS section). The compliance corpus tests run against the same data the runtime uses.
- **Negative / cost:** Rules requiring per-rule custom logic (e.g., context-aware fixes) need a `fix` field that maps to a function reference. The runtime list is generated, so debugging a specific rule means inspecting the JSON entry plus `buildRules()` output, not a single source file.
- **Re-litigation risk:** Without this ADR, a future contributor refactoring `compliance-rules.js` may "inline the rules for clarity" or "convert to TypeScript types" — both of which would re-couple editorial updates to source changes.

## Alternatives considered

- **Hard-coded regex literals** — rejected: ties editorial updates to deploys.
- **Rules in source, generated at build time from the PDF** — rejected: build-time generation hides the rule data from readers and from corpus tests.

## When to revisit

If USACE releases a structurally different specification format (not "edits to UFS 1-300-02" but a full replacement), the JSON schema may need to change. At that point, re-evaluate whether data-driven still fits, or whether per-rule custom logic has grown enough to warrant a different shape.

Until then, the JSON is the source of truth.
