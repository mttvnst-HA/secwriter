# Autonomous Compliance Checker Testing Prompt

## Overview

You are an autonomous testing agent. Your job is to systematically test the UFS 1-300-02 Compliance Checker in SpecsIntact Modern (SIM). The compliance checker has a history of bugs in five categories: false positives, highlighting mismatches, button failures, exclusion gaps, and scroll/interaction jank. This test suite is designed to catch regressions in all five categories.

**Project location:** `C:\github\secwriter`
**Dev server:** `npm run dev` at `http://localhost:5173`
**Key source files:**
- `src/lib/compliance-rules.js` — Static rule engine (builds ~81 rules from JSON)
- `src/lib/compliance-checker.js` — Orchestrator (scope, grouping, exclusions)
- `src/components/CompliancePanel.jsx` — UI panel (findings, highlighting, accept/reject)
- `src/data/ufs-1-300-02-rules.json` — Authoritative rule data
- `src/styles/editor.css` — `.compliance-highlight` styles

---

## PASS 1: False Positive Regression (Unit Tests)

Run these checks programmatically via the test runner. For each test, verify the rule engine does NOT flag compliant text.

### 1A. "per" in unit expressions (TERM-004)

The word "per" is prohibited EXCEPT in measurement contexts. Verify these are NOT flagged:

```
"miles per hour"
"kilometers per hour"
"pounds per cubic foot"
"pounds per square inch"
"feet per second"
"gallons per minute"
"tons per acre"
"cubic yards per hour"
"2.5 to 3.5 miles per hour"
"psi per foot"
```

Verify these ARE flagged:
```
"per the specification"
"per UFS 1-300-02"
"as per the contract"
"per ASTM D2487"
```

### 1B. "Contract" vs "Contractor" (CAP-Contract)

The rule requires capitalizing "Contract". Verify:
- `"the contract duration"` → flagged (lowercase "contract")
- `"the Contract duration"` → NOT flagged (already capitalized)
- `"the Contractor is"` → NOT flagged (different word)
- `"subcontractor"` → NOT flagged (compound word)
- `"contract" at start of sentence` → flagged

### 1C. Bracket content exclusion

No rule should flag text inside `[brackets]`. Verify:
- `"Use [any suitable material]"` → "any" and "suitable" NOT flagged (inside brackets)
- `"Use any suitable material"` → "any" and "suitable" ARE flagged (outside brackets)
- `"[[_____] inches]"` → no FMT-001 spacing violation for spaces near brackets
- `"[as directed by the Contracting Officer]"` → NOT flagged (inside brackets)

### 1D. Note block exclusion

Note blocks (type="note") must be completely skipped. Verify:
- Create a note block with text "The contractor shall provide suitable material etc."
- Run compliance check → zero violations from that block
- Same text in a txt block → multiple violations

### 1E. Hidden unit content exclusion

When unitDisplay is 'eng', metric content should be skipped, and vice versa. Verify:
- Block with `<span class="mark-met">5 kilometers per hour</span>` when unitDisplay='eng' → "per" NOT flagged in metric span
- Same block with unitDisplay='met' → "per" IS evaluated in metric span
- Block with `<span class="mark-eng">3 miles per hour</span>` when unitDisplay='met' → "per" NOT flagged in eng span

### 1F. Other known false positive patterns

Verify these compliant phrases are NOT flagged:
- `"Contracting Officer"` → NOT flagged by CAP-Contract (it's "Contracting Officer", not "contract")
- `"in accordance with"` → NOT flagged (this is the correct replacement for "per")
- `"Government-furnished"` → NOT flagged by CAP-Government (already capitalized)
- `"subcontract"` → NOT flagged by CAP-Contract (compound word)

**Test method:** Run `npm test -- --grep "compliance"` and verify all pass. If any fail, read the test, identify whether the rule or the test is wrong, and fix.

---

## PASS 2: Highlighting Accuracy (Browser Tests)

Use Chrome browser automation to verify that clicking a compliance finding highlights the correct text in the editor — and ONLY the correct text.

### 2A. Word boundary highlighting

1. Open the app, click Compliance, Run Check on Entire Document
2. Find the CAP-Contract group (if present)
3. Click the group card
4. Verify: only standalone "contract" (lowercase) is highlighted with `.compliance-highlight`
5. Verify: "Contractor", "Contracting", "subcontract" do NOT have highlights
6. Use `javascript_tool` to inspect:
```javascript
document.querySelectorAll('.compliance-highlight').forEach(el => {
  console.log('HIGHLIGHTED:', JSON.stringify(el.textContent));
});
```
7. Every highlighted text should exactly match the violation's `match` value — no substrings, no superstrings

### 2B. Multi-instance highlighting

1. Find a group with 3+ instances (e.g., TERM-004 "per" or TERM-025 "suitable")
2. Click the group card
3. Verify ALL instances are highlighted (count `.compliance-highlight` elements matches group count)
4. Scroll through the document to confirm highlights are visible in the correct blocks

### 2C. Highlight cleanup

1. Click a group to highlight it
2. Click a different group
3. Verify: old highlights are removed, new highlights appear
4. Click the same group again (deselect)
5. Verify: ALL highlights are removed

### 2D. Highlight persistence across scroll

1. Click a group that spans multiple sections (e.g., a TERM rule with 10+ instances)
2. Scroll through the document
3. Verify highlights remain visible and correctly positioned (not shifted or missing)

---

## PASS 3: Accept/Reject Functionality (Browser Tests)

### 3A. Individual Accept button

1. Run Check, find a group with a fix (green "Accept" button on an instance)
2. Click Accept on one instance
3. Verify: the violation text in the editor block is replaced with the fix
4. Verify: the instance disappears from the panel
5. Verify: the group count decreases by 1
6. Verify: the block's HTML is updated (inspect via `javascript_tool`)

### 3B. Individual Reject button

1. Click Reject on an instance
2. Verify: the instance disappears from the panel
3. Verify: the editor text is NOT changed
4. Verify: the group count decreases by 1

### 3C. Accept All (group-level) button

**This was previously broken.** Test thoroughly:

1. Find a group with 3+ instances that have fixes (e.g., CAP-Contract or TERM-007)
2. Note the current text of each affected block (read via `javascript_tool`)
3. Click "Accept All N"
4. Verify: ALL instances in the group are resolved
5. Verify: each affected block's HTML contains the fix text, not the original
6. Verify: the group card disappears from the panel
7. Verify: the total violation count decreases by N

### 3D. Reject All (group-level) button

1. Find a group with instances
2. Click "Reject All"
3. Verify: group disappears
4. Verify: editor text is unchanged

### 3E. Accept All does not corrupt inline marks

1. Find a block that has both a compliance violation AND inline marks (e.g., `<span class="mark-rid">ASTM D2487</span>`)
2. Accept the violation fix
3. Verify: the inline mark span is still present and correctly wrapping the RID text
4. This was a known bug — fix functions were stripping HTML tags

---

## PASS 4: Exclusion Logic (Browser Tests)

### 4A. Notes are excluded

1. Toggle Notes ON (make note blocks visible)
2. Run Check on Entire Document
3. Inspect the results — find any violation where `blockId` matches a note block
4. There should be ZERO violations from note blocks
5. Use `javascript_tool`:
```javascript
(() => {
  const noteBlocks = document.querySelectorAll('[data-block-id]');
  const noteIds = [];
  noteBlocks.forEach(el => {
    if (el.closest('[style*="amber"]') || el.closest('.note-block')) noteIds.push(el.dataset.blockId);
  });
  return noteIds;
})()
```
Then verify none of those IDs appear in violation results.

### 4B. Hidden units are excluded

1. Toggle to "ENG" only (click ENG+MET button until it shows "ENG")
2. Run Check
3. Verify: no violations from text inside `<span class="mark-met">` elements
4. Toggle to "MET" only
5. Run Check
6. Verify: no violations from text inside `<span class="mark-eng">` elements

### 4C. Bracket content is excluded

1. Find a block with `[bracketed text]` containing words like "any", "suitable", "as directed"
2. Run Check
3. Verify: those words inside brackets are NOT flagged
4. The same words outside brackets in other blocks SHOULD be flagged

---

## PASS 5: Scroll and Interaction (Browser Tests)

### 5A. No scroll jank on group click

1. Click a group card in the panel
2. The editor should scroll to the first instance — ONCE
3. Click the same group card again
4. The editor should NOT scroll to a different location
5. Repeat 5 times — the scroll position should be stable

### 5B. Clicking instance sub-cards scrolls correctly

1. Expand a group (click "View All N")
2. Click instance #1 — editor scrolls to that block
3. Click instance #3 — editor scrolls to THAT block (not instance #1's block)
4. Verify each instance scrolls to the correct block

### 5C. Panel and editor don't fight for scroll

1. Scroll the compliance panel (right side) up and down
2. Verify the editor (left side) does NOT scroll
3. Scroll the editor up and down
4. Verify the compliance panel does NOT scroll

---

## PASS 6: Auto-fix Formatting (Browser Tests)

### 6A. Auto-fix button applies FMT rules

1. Run Check — if FMT violations exist, the "Auto-fix N formatting items" button should appear
2. Click the button
3. Verify: all FMT violations are resolved (double spaces → single, trailing spaces removed)
4. Verify: the FMT group disappears from the panel
5. Verify: the affected blocks' HTML is updated
6. Verify: no inline marks were corrupted

---

## PASS 7: Rule Data Integrity (Unit Tests)

### 7A. Every rule has required fields

Run a unit test that loads `buildRules()` and verifies each rule has:
- `id` (non-empty string)
- `category` (one of: terminology, formatting, capitalization, symbol, vague, colloquial, redundant)
- `severity` (one of: high, medium, low)
- `pattern` (RegExp instance)
- `message` (non-empty string)
- `ufsRef` (non-empty string starting with "UFS")

### 7B. No two rules share the same ID

Verify `buildRules()` returns unique IDs.

### 7C. Every rule with a fix function produces different output

For each rule that has `fix !== null`, verify that `fix(testString)` !== `testString` when given a string that matches the rule's pattern.

### 7D. JSON data matches expected counts

Verify `ufs-1-300-02-rules.json` has:
- `prohibitedTerms.length >= 30`
- `prohibitedSymbols.length >= 10`
- `vagueTerms.length >= 15`
- `requiredCapitalization.length >= 4`
- `colloquialTerms.length >= 2`
- `redundantWording.length >= 2`

---

## Execution Strategy

1. **Start each pass fresh** — reload the page between passes
2. **Take screenshots** at key verification points
3. **Use `javascript_tool`** to inspect DOM state programmatically
4. **Log results** — for each test, report PASS or FAIL with details
5. **On failure:**
   a. Take a screenshot
   b. Inspect DOM state
   c. Read the relevant source file(s)
   d. Fix the code
   e. Wait for hot-reload
   f. Re-run the failed test
6. **After all passes**, run `npm test` and `npm run test:e2e` to ensure no regressions
7. **Report final summary** with pass/fail counts

## Success Criteria

All 7 passes must complete with 0 failures. Any code fixes must not break existing unit tests (412) or E2E tests (140).
