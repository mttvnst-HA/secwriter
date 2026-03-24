# SIM Compliance and Grammar Testing Plan

## Context

**You are the software engineer. Matt is the project manager. He does not write code. Deliver complete, working, tested code - never pseudocode, skeleton code, or partial snippets.**

This plan builds test infrastructure for SIM's (SpecsIntact Modern) three text-analysis engines:
1. **Static UFS (Unified Facilities Standard) rules** - `compliance-rules.js` (~81 regex-based rules loaded from `ufs-1-300-02-rules.json`)
2. **NLP (Natural Language Processing) rules** - `nlp-rules.js` (compromise.js passive voice and indicative mood detection)
3. **Grammar checker** - `grammar-checker.js` (Harper.js WASM [WebAssembly] via Web Worker)

Refer to `CLAUDE.md` for full architecture details. When this plan references a function or file, verify the actual export signature before implementing.

## Goal

Build four test corpora to rigorously measure precision and recall of SIM's compliance checker, inline linter, and grammar engines against real UFGS (Unified Facilities Guide Specifications) specification text. Use the results to tune rules, eliminate false positives, and quantify detection rates per rule.

## Definitions

- **Calibration corpus:** Raw UFGS master text, unmodified. Known to be clean on primary rules ("shall," "should," "and/or," "etc.," symbols) but dirty on secondary rules (passive voice, "any," "suitable," pronouns, "furnish," lowercase "contract"). Used to validate that SIM's primary-rule detectors produce zero false positives and that secondary-rule detectors produce non-zero true positives.
- **Known clean corpus:** UFGS text rewritten by Opus to full UFS 1-300-02 compliance across all rule categories. Every flag SIM raises against this text is a false positive.
- **Known dirty corpus:** The clean corpus with labeled violations systematically injected back in. Every violation has a rule ID, character offset, and expected detection. Measures recall - how many injected violations does SIM actually catch?
- **Adversarial corpus:** Hand-crafted edge cases that challenge detection systems: borderline compliance, false-positive traps, NLP ambiguity, and domain-specific jargon. Measures robustness against subtle or ambiguous inputs.

## Corpus Source Material

**Selected from 690 .SEC files across 33 CSI divisions, already available in `reference/UFGS_M/`.**

### Selection criteria

The number and choice of sections is driven by three constraints, in priority order:

**1. Statistical power (minimum block count)**

The dirty corpus needs at least 10 injected violations per rule to measure recall with ±15% precision at 80% confidence. With ~25 rule categories, that's ~250 injections minimum spread across different blocks. The clean corpus needs ≥500 non-note blocks to detect a 2% false-positive rate (the success threshold) with reasonable confidence — at 500 blocks, even a single false positive per rule is measurable.

**Target: 800-1,200 testable prose blocks (after filtering out blocks <20 chars, pure citations, and all-bracket blocks).** This provides enough blocks for injection distribution across rules and enough clean blocks for precision measurement.

**2. Diversity (minimum division coverage)**

UFGS sections vary in writing style by discipline. Structural/civil specs (Div 03, 31, 32) use heavy measurement language. Mechanical/electrical specs (Div 22, 23, 26) use more procedural language. Site/utilities specs (Div 33, 35) mix both. The corpus must cover at least 5 distinct CSI divisions to prevent overfitting detection rules to one discipline's vocabulary.

**Target: ≥5 unique CSI divisions, no more than 2 sections from any single division.**

**3. Processing budget (maximum section count)**

Each section flows through: Opus rewrite (30-50 blocks/batch, ~$0.10-0.30/batch) + Opus injection + Matt's 20% validation review (~15 min per section's sample). The Opus cost scales linearly with block count, not section count. Matt's review time scales with section count (each section requires a separate stratified sample).

**Budget ceiling: Matt's review time ≤8 hours total across Phases 2-3. At ~15-20 min per section for validation, this caps at ~10-12 sections maximum.** Below that, the binding constraint is the block-count target.

### Applying the criteria

From the 690 available sections (size range: 7KB to 581KB, median 70KB):
- A large section (~250-400KB) yields ~500-700 prose blocks alone
- A medium section (~70-150KB) yields ~150-325 prose blocks
- A small section (~15-40KB) yields ~40-100 prose blocks

**The block-count target of 800-1,200 can be reached with 3-8 sections** depending on size mix. The diversity target requires ≥5 divisions. The processing budget allows ≤12 sections.

**Selection algorithm:**
1. Pick one large section (≥250KB) as the anchor — provides bulk of blocks
2. Pick sections from 4+ additional divisions, mixing medium and small sizes
3. Stop adding sections when total estimated prose blocks exceed 1,000
4. Prefer sections with heavy measurement content (ENG/MET pairs), procedural content (imperative verbs), and reference-heavy content (RID citations) — these exercise different rule categories

### Selected sections

| # | Section | Filename | Div | Est. Blocks | Selection Rationale |
|---|---------|----------|-----|:-----------:|---------------------|
| 1 | 03 30 00 - Cast-in-Place Concrete | `03 30 00.SEC` | 03 | ~700 | Anchor: largest prose density, heavy measurement + reference content |
| 2 | 22 00 00 - Plumbing, General Purpose | `22 00 00.SEC` | 22 | ~560 | Mechanical division, different writing conventions |
| 3 | 26 20 00 - Interior Distribution System | `26 20 00.SEC` | 26 | ~250* | Electrical division, recently revised (2025/2026) |
| 4 | 32 12 16.16 - Road-Mix Asphalt Paving | `32 12 16.16.SEC` | 32 | ~200 | Smaller section, heavy ENG/MET measurement content |
| 5 | 33 71 02 - Underground Electrical Dist. | `33 71 02.SEC` | 33 | ~325 | Utilities division, moderate length |

*Estimated — actual block count determined by extraction script.

**Estimated total: ~2,035 prose blocks → ~1,200-1,400 testable blocks after filtering.** This exceeds the 800-1,200 target, providing margin. If processing budget becomes a concern, sections 4 and 5 can be dropped (the first 3 sections alone provide ~1,000+ testable blocks across 3 divisions, with reduced diversity).

### Source files

All .SEC files are already present at `reference/UFGS_M/` (690 sections across 33 divisions). No download step is needed. These are U.S. Government works and are not subject to copyright. The extraction script reads directly from this directory.

### Processing guidance

**Process one section at a time through the LLM rewrite and injection phases.** Sending all five sections simultaneously will cause context-window exhaustion and degrade output quality. The extraction and validation scripts can process all sections in batch.

---

## Phase 1: Build the Calibration Corpus

### Step 1.1: Parse .SEC files to JSON blocks

**Use the existing Node.js parser, not Python.** The project already has `src/lib/sec-parser.js` (tested with 36 Vitest tests). Note: there is no CLI wrapper — the extraction script must import the parser directly as an ES module.

Write a Node.js script (`tools/extract-corpus.js`) that:

1. For each .SEC file in `reference/UFGS_M/`, reads the file and parses it using the `parse()` function from `src/lib/sec-parser.js`
2. Handles windows-1252 encoding: read the file as a `Buffer` and decode with Node's `TextDecoder('windows-1252')` — the same decoding approach used by SIM's browser-side file import (see CLAUDE.md: "Windows-1252 encoding" section). Note: Node.js has built-in `TextDecoder` support for windows-1252.
3. Extracts text content from all prose-bearing block types: `txt`, `note`, `oli`, `item`, `lst`, `npr`, `sbm` (submittals contain prose too)
4. Resolves ENG/MET (English/Metric) dual-unit display: choose ENG (imperial) as the default visible unit system. Strip `<MET>...</MET>` content from extracted text, keep `<ENG>...</ENG>` content (unwrapped). This matches the default unit display in SIM.
5. Resolves TAI (Tailoring) options: include ALL TAI content regardless of `OPT` attribute. Calibration corpus should test against the broadest possible text.
6. Strips all remaining SGML/XML markup tags but preserves bracket content `[like this]` and inline mark content (RID, SUB, SRF references as plain text)
7. Tags each block with metadata: source section number, part (1/2/3), parent heading text, block type, block index
8. Outputs a JSON file per section: `corpus/calibration/03_30_00.json`

**Important: operate at block granularity, not sentence granularity.** Spec text is full of abbreviations that break sentence tokenizers ("ASTM C150/C150M.", "No. 4 aggregate", "24 in. minimum", "U.S. Army Corps of Engineers"). SIM's engines operate on block text, so the test corpora should too. Each test unit is one block's text.

**ESM import note:** `sec-parser.js` uses ES module syntax (`export function parse`). The extraction script must use `.mjs` extension or set `"type": "module"` handling. Since the project's `package.json` may not have `"type": "module"`, use `.mjs` extension for the script.

Output format per block:

```json
{
  "id": "03_30_00-P2-B142",
  "section": "03 30 00",
  "part": 2,
  "heading": "2.3.1 Portland Cement",
  "blockType": "txt",
  "isNote": false,
  "text": "Provide portland cement conforming to ASTM C150/C150M, Type I or Type II.",
  "charCount": 73
}
```

The `isNote` flag is critical: note blocks are exempted from compliance and NLP rules in SIM's engines (notes use advisory language by design). The test harness must replicate this exemption.

### Step 1.2: Filter to testable blocks

Not all blocks are suitable for compliance testing. Remove:
- Blocks under 20 characters (headers, labels, "Not used.", short list items)
- Blocks that are purely reference citations (e.g., "ASTM C150/C150M")
- Table cell content (extracted separately if `blockType === 'table'` - not prose)
- Blocks whose text is entirely bracketed `[...]` (tailoring placeholders)

Do NOT remove note blocks - keep them tagged with `isNote: true` so the harness can test that engines correctly skip them.

Target: **800-1,200 testable blocks** across the selected sections (see Selection Criteria above). The large anchor section will contribute far more blocks than smaller sections - this imbalance is expected and useful (tests engine performance on large sections).

### Step 1.3: Build the Node.js test harness

Write a Node.js test harness (`tools/run-corpus-test.mjs`) that:

1. Loads the calibration JSON files
2. For each block, runs:
   - `runStaticRules(text, blockId, rules, { isNote })` from `compliance-rules.js` — note: the `options` object supports `isNote` which controls note-block exemption at the rule engine level
   - `detectNlpIssues(text, blockId, isNote)` from `nlp-rules.js` — note: the third parameter `isNoteBlock` (default `false`) controls note-block exemption. Pass `block.isNote` for correct behavior. Alternatively, `detectNlpIssuesSync(text, blockId, isNote)` is available and avoids async overhead for batch processing.
   - Harper.js grammar check — **see the WASM-in-Node section below**
3. Records every finding: `{ blockId, ruleId, match, index, severity, engine, category }`
4. Outputs results as JSON: `corpus/results/calibration-results.json`

This harness runs in Node.js (not the browser) so it can process the full corpus in batch. It imports the same rule engines SIM uses - no reimplementation.

**Memory considerations:** The compliance rule engine creates ~81 regex objects. If the harness hits OOM errors, use `--max-old-space-size=4096`. If that's insufficient, process sections sequentially and write results incrementally rather than holding all results in memory.

#### Harper.js WASM-in-Node adaptation

Harper.js uses `WorkerLinter` which creates a Web Worker (browser-only API). The `grammar-checker.js` module wraps `WorkerLinter` and **cannot run in Node.js** — it requires browser Web Worker and DOM APIs. For Node.js batch processing, you have three options:

**Option A (preferred): Use Harper's direct API.** Harper.js may expose a `Linter` class (not just `WorkerLinter`) that runs synchronously without a Web Worker. Check Harper.js npm package exports and docs for a non-Worker entry point. This is simpler for batch processing.

**Option B: Use `worker_threads`.** If Harper.js only exposes `WorkerLinter`, create a thin adapter that maps Web Worker messages to Node.js `worker_threads`. This is more complex but preserves the exact production code path.

**Option C: Skip Harper in the batch harness.** Run only static rules and NLP in the harness. Test Harper separately via Playwright E2E (End-to-End) tests against the browser. This is the simplest approach but sacrifices grammar recall measurement in the batch harness.

Document which option was chosen and why in a comment at the top of `run-corpus-test.mjs`.

### Step 1.4: Validate calibration results

**Expected results for primary rules (should be zero or near-zero hits):**

| Rule Category | Expected Hits | If >0 |
|---|:---:|---|
| "shall" (TERM-001) | 0 | Investigate - likely a parser artifact or text inside brackets |
| "should" | 0 | Same |
| "and/or" | 0 | Same |
| "etc." | 0 | Same |
| "per" in non-unit context (TERM-004) | 0-2 | May be legitimate false positives - document and add to `false-positives.json` |
| Symbol violations (%, #, &) | 0 | Same |

**Expected results for secondary rules (should be non-zero):**

| Rule Category | Expected Hits (across all 5 sections) | If 0 |
|---|:---:|---|
| Passive voice (NLP-PASSIVE-001) | 150-300+ | NLP detection is broken - check compromise.js loading |
| "any" (TERM-006) | 10-50 | Rule regex pattern too narrow |
| "suitable" (VAGUE-*) | 5-20 | Same |
| "furnish" (COLLOQ-furnish) | 5-15 | Same |
| Lowercase "contract" (CAP-Contract) | 5-30 | Capitalization regex too narrow |
| Indicative mood (NLP-INDICATIVE-001) | 0-25 | May be genuinely rare in UFGS master text |
| Grammar errors (GRAMMAR-*) | 25-100 | Harper dictionary may need engineering terms added |

**Critical regression check:** Verify that rule FMT-001 (double spaces) does NOT exist in the rule set. Per CLAUDE.md, this rule was removed because USACE (U.S. Army Corps of Engineers) .SEC files conventionally use double spaces after periods. The rule was fabricated without UFS basis and produced 75+ false positives per spec. If FMT-001 appears in results, the rule set has regressed.

Any primary-rule hit is a potential false positive to investigate. Any secondary-rule zero is a potential detection gap to investigate. Note-block hits from compliance/NLP rules are engine exemption failures.

**Record the calibration baseline:** Total findings by rule, by section, by engine, by block type (note vs. non-note). This becomes the reference point for all subsequent tuning.

---

## Phase 2: Build the Known Clean Corpus

### Step 2.1: Prepare Opus rewrite prompts

**Execution method (manual copy-paste):** No API key available. Use `tools/generate-rewrite-prompts.mjs` to create numbered prompt files (50 blocks per batch). Matt copies each prompt into Claude chat (Opus), saves the JSON response to `corpus/clean/responses/`, then runs `tools/ingest-rewrite-output.mjs` to assemble the clean corpus.

For each of the 5 sections, the prompt files contain extracted blocks (in batches of 50) with instructions to fix all UFS 1-300-02 violations while preserving technical meaning.

**Exclude note blocks from rewriting.** Notes use advisory language ("should," passive voice) by design per UFS 1-300-02. They are not subject to the same compliance rules as specification text. Copy note blocks unchanged from calibration to clean corpus with `isNote: true`.

**Strip inline HTML marks before sending to Opus.** Send plain text only (no `<span class="mark-rid">` etc.). The clean corpus is tested against plain-text engines. Store the original HTML separately if needed for future HTML-aware testing.

Prompt template:

```
You are a UFGS specification editor. Rewrite each block of text below to comply
with UFS 1-300-02. Fix ALL of the following:

1. Convert passive voice to imperative mood ("Materials are placed" -> "Place materials")
2. Remove vague terms: replace "any" with specific language, replace "suitable"
   with measurable criteria, replace "properly" with specific method
3. Replace "furnish" with "provide"
4. Capitalize "Contract" when referring to the construction contract
5. Capitalize "Contractor," "Contracting Officer," and "Government" per UFS 1-300-02 Section 2-4.7
6. Remove pronouns ("it," "which," "this," "they") - restructure to name the subject explicitly
7. Convert indicative mood to imperative ("The Contractor provides" -> "Provide")
8. If "must" can be replaced with imperative mood, do so ("must be tested" -> "Test")
9. Replace em-dashes and en-dashes with hyphens
10. Replace smart/curly quotes with straight quotes

Rules:
- Do NOT change technical meaning, quantities, tolerances, or reference citations
- Do NOT change content inside [brackets] - these are tailoring choices
- Do NOT add requirements that do not exist in the original
- If a block is already compliant, return it unchanged
- Preserve block boundaries (one input block = one output block)
- Do NOT attempt to fix grammar or spelling - only fix UFS 1-300-02 compliance issues

Return JSON array:
[{
  "id": "03_30_00-P2-B142",
  "original": "...",
  "rewritten": "...",
  "changes": ["description of each change"]
}]

If no changes are needed for a block, set "rewritten" to the same as "original"
and "changes" to [].
```

### Step 2.2: Execute Opus rewrites (Matt's manual workflow)

1. Run `node tools/generate-rewrite-prompts.mjs --section 03_30_00` (already done for all sections)
2. Open each `corpus/prompts/rewrite/{section}/batch-XX.txt` file
3. Copy the entire contents into a new Claude chat (use Opus for best quality)
4. Save Claude's JSON response to `corpus/clean/responses/{section}_batch-XX_response.json`
5. After all batches are done: `node tools/ingest-rewrite-output.mjs --section 03_30_00`

**Process one section at a time.** Start with 32_12_16_16 (smallest — 4 batches) as a trial run.

The ingest script merges all response files, adds note blocks (passthrough), and writes `corpus/clean/{section}_clean.json`.

### Step 2.3: Human validation of Opus rewrites

This is the critical quality gate. **Matt must review a sample of the Opus output.**

Review procedure:
1. For each section, randomly sample 20% of the rewritten blocks (non-note blocks only), stratified by change type (passive voice rewrites, prohibited term removals, capitalization fixes, etc.) to ensure coverage across rule categories
2. For each sampled block, verify:
   - Technical meaning is preserved (no requirements added or removed)
   - The rewrite is actually compliant (no remaining violations)
   - The rewrite reads naturally as specification language (not awkward or AI-sounding)
   - Bracketed content is untouched
   - Reference citations (ASTM, AASHTO, etc.) are unchanged
3. Record the validation rate: what percentage of Opus rewrites are acceptable?

**Acceptance threshold:** If >90% of sampled rewrites are acceptable, proceed. If <90%, refine the prompt and re-run the failed batches.

### Step 2.4: Run SIM's engines against clean corpus

Using the same test harness from Phase 1, run all three engines against the clean corpus.

**Every finding on a non-note block is a potential false positive.** For each:
1. Is the finding correct (Opus missed a violation)? Fix the block in the clean corpus.
2. Is the finding a false positive (the block is compliant but the rule fires anyway)? Add the block to `corpus/results/false-positives.json` with the rule ID and the triggering text. This becomes a regression test - the rule must be fixed so this block no longer triggers it.

**For note blocks:** Findings from compliance and NLP engines are engine exemption failures (the harness should have skipped these). Grammar findings from Harper are expected and acceptable on note blocks.

Target: **Zero compliance/NLP findings on non-note clean blocks** after tuning. Grammar findings should be near-zero (Opus was not asked to fix grammar, so some may remain - these are acceptable if they are true grammar issues in the original UFGS text).

---

## Phase 3: Build the Known Dirty Corpus

### Step 3.1: Define violation injection plan

For each rule in SIM's engine, define how to inject that specific violation into clean text.

| Rule ID | Injection Method | Target Count |
|---|---|:---:|
| TERM-001 ("shall") | Insert "shall" before imperative verbs: "Provide" -> "shall provide" or "The Contractor shall provide" | 30 |
| TERM-004 ("per") | Replace "in accordance with" with "per" | 15 |
| TERM-006 ("any") | Insert "any" before nouns: "materials" -> "any materials" | 15 |
| VAGUE-* ("suitable," "adequate," "proper") | Insert vague terms before nouns: "materials" -> "suitable materials" | 10 each |
| TERM-028 ("etc.") | Append "etc." to list items | 10 |
| COLLOQ-furnish | Replace "provide" with "furnish" | 10 |
| CAP-Contract | Lowercase "Contract" to "contract" (mid-sentence, after a period+space) | 15 |
| CAP-Contractor | Lowercase "Contractor" to "contractor" | 15 |
| CAP-Government | Lowercase "Government" to "government" | 10 |
| FMT-002 (em-dash) | Replace hyphens with em-dashes (U+2014) | 10 |
| FMT-003 (smart quotes) | Replace straight quotes with curly quotes (U+201C/U+201D) | 10 |
| NLP-PASSIVE-001 | Convert imperative to passive: "Place materials" -> "Materials are placed" or "Materials shall be placed" | 30 |
| NLP-INDICATIVE-001 | Convert imperative to indicative: "Provide" -> "The Contractor provides" | 15 |
| GRAMMAR-* (spelling) | Introduce typos: swap adjacent letters, double letters, drop letters | 20 |
| GRAMMAR-* (agreement) | Change verb number: "Materials require" -> "Materials requires" | 10 |
| SYM-* (%, #, &) | Replace spelled-out forms with symbols: "percent" -> "%" | 10 each |

**Spread injections across all 5 sections and across different block positions** (beginning, middle, end of block text) to avoid position-biased detection.

### Step 3.2: Execute injection via Opus

**Execution method (manual copy-paste):** Same workflow as Phase 2. Run `tools/generate-inject-prompts.mjs` to create prompt files, paste into Claude, save responses to `corpus/dirty/responses/`, then run `tools/ingest-inject-output.mjs`. **Process one section at a time.**

Prompt Claude to inject violations into the clean corpus blocks, with explicit labeling.

```
You are a test data generator for a specification compliance checker. For each
clean block below, introduce EXACTLY the specified violation type. Return the
corrupted block plus a label identifying the violation.

Rules:
- Introduce ONLY the specified violation type - do not add other errors
- The corrupted block must still be syntactically valid English (not gibberish)
- The violation must be detectable by a regex or NLP tool
- Preserve the rest of the block text exactly (character-for-character)
- Do NOT compute character offsets - just return the match text. Offsets
  will be computed programmatically after injection.

For each block, return:
{
  "id": "03_30_00-P2-B142",
  "clean": "...",
  "dirty": "...",
  "violations": [
    {
      "ruleId": "TERM-001",
      "match": "shall provide",
      "description": "Inserted 'shall' before imperative verb"
    }
  ]
}
```

**Use `temperature: 0` for reproducibility.**

**Target distribution:** At least 10 injected violations per rule, spread across different sections and block structures. For high-frequency rules (passive voice, "shall"), aim for 30+.

### Step 3.3: Compute offsets and validate injections programmatically

Write a Node.js script (`tools/validate-injections.mjs`) that for each injected block:

1. Diffs the clean and dirty text to identify exact changes (use word-level diff or a simple string comparison)
2. Locates each `violations[].match` string in the dirty text and records its `charOffset` - do NOT rely on Opus to compute offsets
3. Verifies:
   - The violation match text is actually present in the dirty text at the computed offset
   - The rest of the block is unchanged from the clean version (character-for-character diff outside the violation region)
   - The violation type is consistent with the rule ID (e.g., TERM-001 violation actually contains "shall")
   - Only one violation was introduced (no collateral damage)
4. Writes the validated dirty corpus with computed offsets to `corpus/dirty/03_30_00_dirty.json`

Blocks that fail validation are logged to `corpus/results/injection-failures.json` for manual review.

### Step 3.4: Run SIM's engines against dirty corpus

Run the test harness. For each injected violation, check:
- **True positive:** SIM detected the violation with the correct rule ID. Match text overlaps with the injected violation.
- **False negative:** SIM missed the violation entirely.
- **Wrong rule:** SIM detected something at the violation location but assigned the wrong rule ID.

**Do NOT test character-offset precision.** Different engines compute offsets differently (regex `index` vs. NLP token positions vs. Harper character offsets). Testing exact offset match would produce false failures. Instead, test that the rule ID and match text overlap with the injected violation.

Calculate per-rule recall:

```
Recall(TERM-001) = true positives for TERM-001 / total injected TERM-001 violations
```

**Targets:**
- >95% recall for static rules (regex-based, should be near-perfect)
- >85% recall for NLP rules (passive voice, indicative mood)
- >70% recall for grammar rules (Harper may miss some spec-specific patterns)

---

## Phase 3.5: Build the Adversarial Corpus

### Purpose

The adversarial corpus targets detection gaps that clean/dirty corpora miss: borderline compliance, false-positive traps, and NLP ambiguity. These are hand-crafted or LLM-generated edge cases where the correct answer is non-obvious.

### Step 3.5.1: Define adversarial categories

| Category | Description | Example |
|---|---|---|
| Borderline compliance | Technically valid but suspicious | "Provide materials suitable for the intended application as defined in Section 2.3." ("suitable" has a specific referent) |
| False-positive trap | Looks like a violation but is correct | "The contract documents include..." (lowercase "contract" modifying "documents" - not the Contract) |
| NLP ambiguity | Passive vs. adjective ambiguity | "The reinforcing steel is galvanized." (adjective, not passive voice) |
| Domain jargon | Engineering terms that resemble violations | "per ASTM C150" ("per" in standards-reference context is acceptable) |
| Capitalization edge | Context-dependent capitalization | "government-furnished equipment" (compound modifier - "government" may or may not require capitalization) |

### Step 3.5.2: Generate adversarial entries

Use the Opus rewrite script (adapted) to generate 50-100 adversarial entries across the categories above. Each entry must include:

```json
{
  "id": "ADV-001",
  "text": "The contract documents specify the required concrete strength.",
  "expected": {
    "shouldFlag": false,
    "ruleId": "CAP-Contract",
    "reason": "Lowercase 'contract' modifies 'documents' - this is a common noun usage, not a reference to the Contract"
  },
  "difficulty": "trap",
  "category": "false-positive-trap"
}
```

### Step 3.5.3: Integrate into test suite

Add adversarial entries to `src/lib/__tests__/corpus-adversarial.test.js`. For `shouldFlag: true` entries, verify detection. For `shouldFlag: false` entries, verify no detection. This directly measures false-positive and false-negative rates on hard cases.

---

## Phase 4: Integrate into SIM's Test Suite

### Step 4.1: Choose test runner

**Use Node's built-in test runner (`node --test`), not Vitest, for corpus tests.** Rationale: the compliance rule engine creates ~81 regex objects. Running these against 600-1,000 blocks will likely exhaust Vitest's worker memory — the same OOM pattern that forced compliance-rules.node-test.mjs to use Node's built-in runner. This is documented in CLAUDE.md: "Compliance rule tests use Node's built-in test runner (node --test), not Vitest."

Create test files with `.node-test.mjs` extension (matching the existing convention) to clearly distinguish them from Vitest tests.

### Step 4.2: Create test files

**Important: per CLAUDE.md, test files must have no more than 30 `it()` blocks.** Use `it.each()` for data-driven tests and batch assertions within a single `it()`.

Create `src/lib/__tests__/corpus-precision.node-test.mjs`:

```javascript
// For each clean corpus block, verify zero compliance/NLP findings
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRules, runStaticRules } from '../compliance-rules.js';
import { readFileSync } from 'node:fs';

const rules = getRules();
const cleanCorpus = JSON.parse(
  readFileSync(new URL('../../../corpus/clean/all_clean.json', import.meta.url), 'utf-8')
).filter(b => !b.isNote);

describe('Precision: zero false positives on clean corpus', () => {
  it('static rules produce no findings on any clean non-note block', () => {
    const failures = [];
    for (const block of cleanCorpus) {
      const violations = runStaticRules(block.text, block.id, rules, { isNote: false });
      if (violations.length > 0) {
        failures.push({ id: block.id, violations: violations.map(v => v.ruleId) });
      }
    }
    assert.equal(failures.length, 0,
      `${failures.length} blocks triggered false positives:\n${JSON.stringify(failures.slice(0, 10), null, 2)}`);
  });

  it('NLP rules produce no findings on clean non-note blocks', async () => {
    const { detectNlpIssues } = await import('../nlp-rules.js');
    const failures = [];
    for (const block of cleanCorpus) {
      const violations = await detectNlpIssues(block.text, block.id, false);
      if (violations.length > 0) {
        failures.push({ id: block.id, violations: violations.map(v => v.ruleId) });
      }
    }
    assert.equal(failures.length, 0,
      `${failures.length} blocks triggered NLP false positives:\n${JSON.stringify(failures.slice(0, 10), null, 2)}`);
  });
});
```

Create `src/lib/__tests__/corpus-recall.node-test.mjs`:

```javascript
// For each dirty corpus violation, verify detection
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRules, runStaticRules } from '../compliance-rules.js';
import { readFileSync } from 'node:fs';

const rules = getRules();
const dirtyCorpus = JSON.parse(
  readFileSync(new URL('../../../corpus/dirty/all_dirty.json', import.meta.url), 'utf-8')
);

describe('Recall: detect injected violations', () => {
  it('static rules detect all injected TERM/SYM/CAP/FMT/COLLOQ violations', () => {
    const staticBlocks = dirtyCorpus.filter(b =>
      b.violations.some(v => !v.ruleId.startsWith('NLP-') && !v.ruleId.startsWith('GRAMMAR-'))
    );
    let detected = 0;
    const missed = [];
    for (const block of staticBlocks) {
      const results = runStaticRules(block.dirty, block.id, rules, { isNote: false });
      for (const expected of block.violations) {
        if (expected.ruleId.startsWith('NLP-') || expected.ruleId.startsWith('GRAMMAR-')) continue;
        const found = results.some(v => v.ruleId === expected.ruleId);
        if (found) detected++;
        else missed.push({ blockId: block.id, expected: expected.ruleId });
      }
    }
    const total = staticBlocks.flatMap(b => b.violations)
      .filter(v => !v.ruleId.startsWith('NLP-') && !v.ruleId.startsWith('GRAMMAR-')).length;
    const recall = detected / total;
    console.log(`Static rule recall: ${detected}/${total} = ${(recall * 100).toFixed(1)}%`);
    if (missed.length > 0) console.log('Missed:', JSON.stringify(missed, null, 2));
    assert.ok(recall >= 0.95, `Static rule recall ${(recall * 100).toFixed(1)}% is below 95% threshold`);
  });

  it('NLP rules detect injected passive voice and indicative mood', async () => {
    const { detectNlpIssues } = await import('../nlp-rules.js');
    const nlpBlocks = dirtyCorpus.filter(b =>
      b.violations.some(v => v.ruleId.startsWith('NLP-'))
    );
    let detected = 0;
    const missed = [];
    for (const block of nlpBlocks) {
      const results = await detectNlpIssues(block.dirty, block.id, false);
      for (const v of block.violations.filter(v => v.ruleId.startsWith('NLP-'))) {
        const found = results.some(r => r.ruleId === v.ruleId);
        if (found) detected++;
        else missed.push({ blockId: block.id, expected: v.ruleId });
      }
    }
    const total = nlpBlocks.flatMap(b => b.violations).filter(v => v.ruleId.startsWith('NLP-')).length;
    const recall = detected / total;
    console.log(`NLP recall: ${detected}/${total} = ${(recall * 100).toFixed(1)}%`);
    assert.ok(recall >= 0.85, `NLP recall ${(recall * 100).toFixed(1)}% is below 85% threshold`);
  });
});
```

Create `src/lib/__tests__/corpus-calibration.node-test.mjs`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getRules, runStaticRules } from '../compliance-rules.js';
import { readFileSync } from 'node:fs';

const rules = getRules();
const calibrationCorpus = JSON.parse(
  readFileSync(new URL('../../../corpus/calibration/all_calibration.json', import.meta.url), 'utf-8')
);

describe('Calibration: rule behavior on raw UFGS master text', () => {
  it('primary prohibited terms produce zero hits on raw UFGS non-note blocks', () => {
    const primaryIds = ['TERM-001', 'TERM-002', 'TERM-003'];
    const nonNoteBlocks = calibrationCorpus.filter(b => !b.isNote);
    const hits = [];
    for (const block of nonNoteBlocks) {
      const violations = runStaticRules(block.text, block.id, rules, { isNote: false });
      const primary = violations.filter(v => primaryIds.includes(v.ruleId));
      if (primary.length > 0) hits.push({ id: block.id, violations: primary.map(v => v.ruleId) });
    }
    assert.equal(hits.length, 0,
      `Primary rules fired on ${hits.length} blocks:\n${JSON.stringify(hits.slice(0, 10), null, 2)}`);
  });

  it('passive voice detection finds instances in raw UFGS text', async () => {
    const { detectNlpIssues } = await import('../nlp-rules.js');
    const nonNoteBlocks = calibrationCorpus.filter(b => !b.isNote);
    let totalHits = 0;
    for (const block of nonNoteBlocks) {
      const violations = await detectNlpIssues(block.text, block.id, false);
      totalHits += violations.filter(v => v.ruleId === 'NLP-PASSIVE-001').length;
    }
    console.log(`Passive voice hits in raw UFGS: ${totalHits}`);
    assert.ok(totalHits > 0, 'Expected passive voice detections in raw UFGS text but found none');
  });

  it('FMT-001 (double spaces) rule does NOT exist in the rule set', () => {
    const fmt001 = rules.find(r => r.id === 'FMT-001');
    assert.equal(fmt001, undefined, 'FMT-001 rule exists — this is a regression (see CLAUDE.md)');
  });
});
```

Create `src/lib/__tests__/corpus-adversarial.node-test.mjs` with similar structure, using batch assertions.

### Step 4.3: Add npm scripts

In `package.json`:
```json
{
  "scripts": {
    "test:corpus": "node --test src/lib/__tests__/corpus-*.node-test.mjs",
    "test:corpus:calibration": "node --test src/lib/__tests__/corpus-calibration.node-test.mjs",
    "test:corpus:precision": "node --test src/lib/__tests__/corpus-precision.node-test.mjs",
    "test:corpus:recall": "node --test src/lib/__tests__/corpus-recall.node-test.mjs"
  }
}
```

This runs separately from `npm test` since corpus tests are slower (600+ blocks per corpus, plus async NLP loading).

---

## Phase 5: Reporting and Metrics

### Precision report (from clean corpus)

Per-rule precision: `Precision(rule) = 1 - (FP / blocks_tested)` where FP = false positives for that rule on the clean corpus.

| Rule ID | Blocks Tested | False Positives | Precision |
|---|:---:|:---:|:---:|
| TERM-001 | 800 | 0 | 100% |
| TERM-004 | 800 | 2 | 99.75% |
| NLP-PASSIVE-001 | 800 | 12 | 98.5% |
| ... | | | |

### Recall report (from dirty corpus)

Per-rule recall: `Recall(rule) = TP / injected` where TP = true positives, injected = total injected violations for that rule.

| Rule ID | Injected | Detected | Recall |
|---|:---:|:---:|:---:|
| TERM-001 | 30 | 30 | 100% |
| NLP-PASSIVE-001 | 30 | 26 | 86.7% |
| GRAMMAR-Spelling | 20 | 16 | 80% |
| ... | | | |

### Calibration report (from raw UFGS)

| Rule ID | Expected Behavior | Actual Hits | Status |
|---|:---:|:---:|:---:|
| TERM-001 | 0 hits on non-note blocks | 0 | PASS |
| NLP-PASSIVE-001 | >0 hits on non-note blocks | 187 | PASS |
| FMT-001 | Rule does not exist | N/A | PASS |
| ... | | | |

### Adversarial report

| Category | Total Cases | Correct Engine Behavior | Accuracy |
|---|:---:|:---:|:---:|
| False-positive traps | 25 | 22 | 88% |
| Borderline compliance | 15 | 11 | 73% |
| NLP ambiguity | 10 | 7 | 70% |
| ... | | | |

### Report generation

Write `tools/generate-report.mjs` that reads all results JSON files and outputs:
1. A Markdown summary: `corpus/results/REPORT.md`
2. A JSON metrics file: `corpus/results/metrics.json` (machine-readable for CI checks)

---

## Execution Timeline

| Phase | Task | Estimated Effort | Who |
|---|---|:---:|---|
| 1.1 | Write .SEC extraction script (reads from `reference/UFGS_M/`) | 1 Claude Code session | Claude Code |
| 1.2 | Filter to testable blocks | Part of 1.1 | Claude Code |
| 1.3 | Write test harness (Node.js, handle Harper WASM) | 1 Claude Code session | Claude Code |
| 1.4 | Run calibration and analyze results | 1-2 hours | Matt reviews output |
| 2.1-2.2 | Paste rewrite prompts into Claude chat, save responses, run ingest script | 42 batches total (~2-3 hours) | **Matt** (copy-paste into Claude chat) |
| 2.3 | Validate 20% sample (~150-200 blocks, stratified) | 3-4 hours | **Matt reviews** |
| 2.4 | Run SIM against clean corpus, triage findings | 1 hour | Claude Code + Matt spot-check |
| 3.1-3.2 | Paste injection prompts into Claude chat, save responses, run ingest + validate | ~15 batches total (~1 hour) | **Matt** (copy-paste into Claude chat) |
| 3.3 | Validate injections programmatically + Matt spot-check | 30 min automated + 30 min review | Claude Code + **Matt** |
| 3.4 | Run SIM against dirty corpus, compute recall | 30 minutes | Claude Code |
| 3.5 | Generate and validate adversarial corpus | 1 Claude Code session + 1 hr Matt review | Claude Code + **Matt** |
| 4.1-4.3 | Integrate into Node test runner (4 test files) | 1 Claude Code session | Claude Code |
| 5 | Generate reports | 1 Claude Code session | Claude Code |

**Total estimated effort:** 6-8 Claude Code sessions, 6-9 hours of Matt's review time. Spread over 2-3 weeks.

---

## File Structure

```
corpus/                           # ADD TO .gitignore (large generated data)
  calibration/
    03_30_00.json                 # Raw extracted blocks
    22_00_00.json
    26_20_00.json
    32_12_16_16.json
    33_71_02.json
    all_calibration.json          # Combined for test suite
  clean/
    03_30_00_clean.json           # Opus-rewritten, human-validated
    22_00_00_clean.json
    ...
    all_clean.json                # Combined for test suite
  dirty/
    03_30_00_dirty.json           # Violations injected, validated, offsets computed
    22_00_00_dirty.json
    ...
    all_dirty.json                # Combined for test suite
  adversarial/
    adversarial.json              # Edge cases with expected results
  results/
    calibration-results.json
    precision-results.json
    recall-results.json
    adversarial-results.json
    false-positives.json          # Blocks that trigger false positives (regression tests)
    injection-failures.json       # Blocks where Opus injection failed validation
    metrics.json                  # Machine-readable metrics for CI
    REPORT.md                     # Human-readable summary

tools/
  extract-corpus.mjs              # .SEC -> calibration JSON (imports sec-parser.js directly)
  run-corpus-test.mjs             # Node.js test harness for batch processing all 3 engines
  json-loader.mjs                 # Custom module loader for bare JSON imports in Node
  json-loader-hooks.mjs           # Loader hooks (used by json-loader.mjs)
  generate-rewrite-prompts.mjs    # Creates copy-paste prompt files for clean corpus (Phase 2)
  ingest-rewrite-output.mjs       # Assembles clean corpus from Claude chat responses
  generate-inject-prompts.mjs     # Creates copy-paste prompt files for dirty corpus (Phase 3)
  ingest-inject-output.mjs        # Assembles dirty corpus from Claude chat responses
  validate-injections.mjs         # Diff-based injection validation + offset computation
  generate-report.mjs             # Results -> Markdown + JSON reports
  opus-rewrite.mjs                # (Alternative) Anthropic API script — requires API key
  opus-inject.mjs                 # (Alternative) Anthropic API script — requires API key

src/lib/__tests__/
  corpus-precision.node-test.mjs    # Zero false positives on clean corpus
  corpus-recall.node-test.mjs       # Detect all injected violations
  corpus-calibration.node-test.mjs  # Primary rules clean, secondary rules detect, FMT-001 absent
  corpus-adversarial.node-test.mjs  # Edge cases behave as expected
```

### .gitignore additions

```
# Corpus test data (large, generated)
corpus/
```

### JSON schema for key files

**`false-positives.json`:**
```json
[
  {
    "blockId": "03_30_00-P2-B142",
    "ruleId": "TERM-004",
    "match": "per ASTM C150",
    "text": "Test concrete per ASTM C150/C150M requirements.",
    "reason": "False positive - 'per' is used in a standards reference context",
    "status": "open"
  }
]
```

**`metrics.json`:**
```json
{
  "generated": "2026-03-22T12:00:00Z",
  "corpusSize": {
    "calibration": 943,
    "clean": 943,
    "dirty": 943,
    "adversarial": 75
  },
  "precision": {
    "TERM-001": { "tested": 800, "falsePositives": 0, "precision": 1.0 }
  },
  "recall": {
    "TERM-001": { "injected": 30, "detected": 30, "recall": 1.0 }
  },
  "calibration": {
    "TERM-001": { "expected": "zero", "actual": 0, "status": "PASS" }
  },
  "adversarial": {
    "false-positive-trap": { "total": 25, "correct": 22, "accuracy": 0.88 }
  }
}
```

---

## Success Criteria

The testing plan is complete when:

1. **Calibration:** Primary rules produce 0 hits on raw UFGS non-note blocks. Secondary rules produce >0 hits. FMT-001 is absent.
2. **Precision:** <2% false positive rate across all rules on the clean corpus.
3. **Recall:** >95% detection rate for static rules, >85% for NLP rules, >70% for grammar rules.
4. **Adversarial:** >80% correct engine behavior on adversarial edge cases.
5. **Regression:** All four corpus test files pass in `npm run test:corpus` and are added to CI (Continuous Integration).
6. **Documentation:** Precision/recall/adversarial metrics documented in `corpus/results/REPORT.md` and referenced from `CLAUDE.md`.
7. **Note block exemption:** Compliance and NLP engines produce zero findings on note blocks in all corpora.

---

## Codebase Reference

Key functions and their locations for implementers. **Verify these against the actual codebase before implementing - line numbers may have shifted.**

| Function | File | Signature | Notes |
|---|---|---|---|
| `runStaticRules` | `compliance-rules.js` | `(plainText, blockId, rules, options = {})` | Main static rule executor. `options.isNote` controls note exemption. |
| `getRules` | `compliance-rules.js` | `() => Array<rule>` | Returns cached built rules |
| `buildRules` | `compliance-rules.js` | `() => Array<rule>` | Builds rule objects from JSON (called once, cached by `getRules`) |
| `detectNlpIssues` | `nlp-rules.js` | `(plainText, blockId, isNoteBlock = false)` | Async. Lazy-loads compromise.js. Third param controls note exemption. |
| `detectNlpIssuesSync` | `nlp-rules.js` | `(plainText, blockId, isNoteBlock = false)` | Sync variant (requires `preloadNlp()` first) |
| `preloadNlp` | `nlp-rules.js` | `() => Promise<void>` | Pre-import compromise.js for sync usage |
| `isNlpReady` | `nlp-rules.js` | `() => boolean` | Check if compromise.js is loaded |
| `checkGrammar` | `grammar-checker.js` | `(plainText, blockId) => Promise<Array<violation>>` | **Browser-only** — requires `initGrammarChecker()` and Web Worker API |
| `initGrammarChecker` | `grammar-checker.js` | `() => Promise<void>` | **Browser-only** — creates Web Worker for Harper.js WASM |
| `isGrammarReady` | `grammar-checker.js` | `() => boolean` | Check if WASM loaded |
| `checkCompliance` | `compliance-checker.js` | `(blocks, scopeType, anchorBlockId, options = {})` | High-level orchestrator (not needed for corpus tests — use `runStaticRules` directly) |
| `stripHtml` | `compliance-checker.js` | `(html, unitDisplay)` | Strip HTML for plain text. **DO NOT USE** for corpus extraction — extract from parsed blocks instead. |
| `getBlocksInScope` | `compliance-checker.js` | `(blocks, scopeType, anchorBlockId)` | Scope filtering (not needed for corpus tests) |
| `MAX_VIOLATIONS` | `compliance-checker.js` | `2000` | Violation budget constant |
| `replaceAtOffset` | `fix-utils.js` | `(html, match, replacement, targetOffset)` | Offset-aware replacement for duplicate violations |
| `parse` | `sec-parser.js` | `(xmlString) => Array<block>` | Existing .SEC parser — accepts decoded XML string |

**Critical: `tools/parse-sec.js` does NOT exist.** The parser is only available as an ES module at `src/lib/sec-parser.js`. Import it directly in extraction scripts.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Harper.js WASM does not run in Node.js | High | Low (grammar recall only) | Option C: skip Harper in batch harness, test via Playwright E2E instead. Grammar-checker.js confirmed browser-only. |
| Opus rewrites alter technical meaning | Medium | High (corrupts clean corpus) | 20% human validation with stratified sampling. >90% acceptance threshold. |
| Opus injection introduces collateral changes | Medium | Medium (corrupts dirty corpus) | Programmatic diff validation in Step 3.3 catches all unintended changes. |
| Corpus too small for statistically meaningful recall | Low | Medium (unreliable metrics) | 600-1,000 blocks across 5 sections. 10-30 injections per rule. |
| sec-parser.js fails on untested .SEC files | Medium | High (blocks Phase 1) | Parser has 36 tests but was validated on limited files. Run parser on all 5 sections first and log any parse errors before proceeding. |
| compromise.js false positive rate >20% | Medium | Medium (inflated precision failures) | Already addressed in nlp-rules.test.js baseline. Tighten patterns or lower severity if needed. |
| Adversarial edge cases are too subjective | Medium | Low (disputed results) | Matt validates all adversarial expected values before integration. |
| Vitest OOM on corpus tests | High | Medium (test runner crash) | Use Node's built-in test runner (`node --test`) instead of Vitest for all corpus tests. Matches existing `compliance-rules.node-test.mjs` convention. |
| Manual copy-paste fatigue (42+ batches for rewrite) | Medium | Medium (incomplete corpus) | Start with smallest section (32_12_16_16, 4 batches) as trial. Can reduce scope to 3 sections if needed. |

---

## Test Plan

### Test Case 1: Easy - Single block, static rule injection

**Input:** One clean block: `"Provide portland cement conforming to ASTM C150/C150M, Type I or Type II."`

**Injection instruction:** TERM-001 ("shall")

**Expected good output:**
- `dirty`: `"The Contractor shall provide portland cement conforming to ASTM C150/C150M, Type I or Type II."`
- `violations[0].ruleId`: `"TERM-001"`
- `violations[0].match`: `"shall provide"`
- No other text changes outside the injection
- Technical meaning preserved (same cement, same standard, same types)

### Test Case 2: Typical - Batch of 30 blocks, mixed rewrite

**Input:** 30 calibration blocks from Section 03 30 00, including 2 note blocks and 3 blocks already compliant.

**Expected good output:**
- Note blocks returned unchanged with `changes: []`
- Already-compliant blocks returned unchanged with `changes: []`
- Passive voice blocks rewritten to imperative mood
- No added requirements
- No altered quantities or reference citations
- JSON array with exactly 30 entries, each with `id`, `original`, `rewritten`, `changes`

### Test Case 3: Hard - Adversarial edge case generation

**Input:** Request to generate 10 false-positive traps for CAP-Contract rule.

**Expected good output:**
- 10 entries where lowercase "contract" is correct (e.g., "contract documents," "subcontract," "contract" as a verb)
- Each entry has `shouldFlag: false` with a clear `reason` explaining why the lowercase is correct
- No entries where "Contract" (the construction contract) is incorrectly lowercased
- `difficulty` field is `"trap"` for all entries
- All entries are plausible specification language, not contrived

### Evaluation Checklist for Final Prompt Outputs

Use this checklist to evaluate any output generated by the synthesized prompt:

- [ ] JSON is valid and parseable (no trailing commas, no commentary outside JSON)
- [ ] All rule IDs reference real rules from `ufs-1-300-02-rules.json`
- [ ] Block IDs follow the `{section}-P{part}-B{index}` pattern
- [ ] Clean text triggers zero SIM compliance/NLP findings on non-note blocks
- [ ] Each dirty block has exactly one injected violation (diff confirms no collateral)
- [ ] `charOffset` in dirty corpus was computed programmatically (not by the LLM)
- [ ] Note blocks are excluded from rewriting and tagged with `isNote: true`
- [ ] Bracketed content `[like this]` is unchanged between original and rewritten
- [ ] Reference citations (ASTM, AASHTO, etc.) are unchanged between original and rewritten
- [ ] Technical meaning is preserved (no requirements added or removed)
- [ ] Adversarial entries include plausible specification language with clear reasoning
- [ ] Output file paths match the file structure defined in the plan
