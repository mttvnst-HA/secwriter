# Chat Session: Inline Linting Feature Implementation
**Date:** 2026-03-21 to 2026-03-22
**Branch:** feature/inline-linting
**Project:** SpecsIntact Modern (SIM)

---

## Session Overview

Implemented real-time inline linting across 5 sessions from the INLINE-LINTING.md plan. Three detection engines feed into a CSS Custom Highlight API orchestrator:
- **Static UFS compliance rules** (yellow highlights)
- **Harper.js grammar/spelling** (blue highlights, WASM Web Worker)
- **compromise.js NLP** (orange highlights, passive voice + indicative mood)

## Commits

1. `402b84f` - Session 1: CSS Custom Highlight API proof of concept
2. `7618756` - Sessions 2+3: Inline tooltip + Harper.js grammar checking
3. `4225f1b` - Session 4: Passive voice/indicative mood + bug fixes from user testing
4. `8ea9f4f` - Session 5: Linting toggle, de-duplication, gutter dots, panel collision
5. `66aa589` - docs: update CLAUDE.md with inline linting architecture and test counts

## Files Created
- `src/lib/inline-linter.js` - Orchestrator (~400 lines)
- `src/lib/grammar-checker.js` - Harper.js wrapper (~170 lines)
- `src/lib/nlp-rules.js` - compromise.js NLP rules (~170 lines)
- `src/components/InlineTooltip.jsx` - Floating tooltip (~290 lines)
- `src/lib/__tests__/inline-linter.test.js` - 19 tests
- `src/lib/__tests__/grammar-checker.test.js` - 10 tests
- `src/lib/__tests__/nlp-rules.test.js` - 37 tests

## Files Modified
- `src/components/EditableBlock.jsx` - Wired linting, tooltip, gutter dots
- `src/App.jsx` - Lint toggle button, compliance panel collision props
- `src/styles/editor.css` - 3 highlight CSS rules
- `package.json` - Added harper.js, compromise dependencies
- `CLAUDE.md` - Architecture docs, test counts

## Test Results
- 446 Vitest + 40 Node + 140 Playwright = 626 automated tests, all passing

---

## Conversation Log

### User Request
> Read @INLINE-LINTING.md. Implement Session 1 only.

### Side Tasks
User requested:
1. Add Git Conventions section to CLAUDE.md
2. Add browser data exfiltration prevention to development roadmap
3. Print the workplan from INLINE-LINTING.md

The workplan was printed showing 5 sessions:
- Session 1: CSS Custom Highlight API Proof of Concept - COMPLETE
- Session 2: Inline Tooltip on Hover/Click - NOT STARTED
- Session 3: Grammar Checking via Harper.js - NOT STARTED
- Session 4: Passive Voice Detection via compromise.js - NOT STARTED
- Session 5: Orchestrator Polish, De-duplication, and User Toggle - NOT STARTED

---

### Session 1 Implementation (already done in prior session)

Session 1 was already complete from a prior conversation.

---

### Session 2 and 3 Implementation

User requested: "implement session 2 only"

#### Bug: No highlights appearing
User reported that typing "shall" in a block produced no highlights. Investigation revealed the CSS progressive enhancement was replacing the visible yellow background with `transparent` and relying on `text-decoration: underline wavy` which Chrome's `::highlight()` may not render. Fixed by keeping background as primary indicator.

#### Bug: Highlights disappearing on blur
User reported highlights should persist until the issue is fixed. Changed behavior:
1. Don't clear highlights on blur
2. Re-lint when block receives focus
3. Store findings per-block so linting one block doesn't wipe another's highlights

#### Session 3: Harper.js Grammar Checking
Implemented grammar checker with:
- Web Worker wrapper with lazy WASM loading
- Custom engineering dictionary (ASTM, AASHTO, NICET, etc.)
- Stale result handling via text version tracking
- Blue wavy underline highlights

#### Test Results from User
User tested in Chrome and provided feedback:

**Test 1 (Compliance highlight + tooltip):** Passed after fixing highlight persistence

**Test 2 (Grammar highlight):** Spelling errors identified, but popup had no suggestions shown. Fixed to display suggestion text (e.g., `appels -> apples`).

**Test 3 (Both highlights coexist):** Passed

**Test 4 (Highlights persist across blur/focus):** Initially failed - highlights disappeared on first blur but persisted after re-focusing. Root cause: first blur triggers `onUpdate` -> React re-render -> DOM text nodes replaced -> Range objects invalidated. Fixed by re-linting after blur with 50ms delay.

**Test 5 (Escape dismisses tooltip):** Tooltip didn't reappear after Escape + arrow keys. Fixed by:
1. Using `Range.compareBoundaryPoints` for robust cursor hit-testing
2. Adding `keyup` listener for arrow keys as backup for `selectionchange`

#### Tooltip positioning fix
User reported tooltip going off-screen. Fixed by:
1. Measuring actual tooltip height via ref instead of hardcoded 100px estimate
2. Truncating "Found:" match text to 40 characters

#### Committed Sessions 2+3
`7618756 feat: add inline tooltip, grammar checking (Harper.js), and persistent highlights`

---

### Session 4: Passive Voice Detection

#### Implementation
- Installed compromise.js
- Created `nlp-rules.js` with:
  - Passive voice detection via `(is|are|was|were|be|been|being) #PastTense` pattern (initial `#Passive` tag was unreliable)
  - Indicative mood detection: "The Contractor provides/installs..." patterns
  - Verb-to-imperative conversion with fix functions
  - Bracket/note exclusions
- Created accuracy baseline test with 30+ real sentences from sample spec data
- Wired into orchestrator with `passive-voice` highlight group

#### Bug Fixes from User Testing

**False positive on ASTM reference numbers (D4829):**
- Harper flagged "D4829" as spelling error with suggestion "DA's"
- Added alphanumeric reference designator filter

**Incorrect fix applied (D4829 -> DA's deleted text):**
- Fix function replaced "D4829" with "DA's", corrupting "ASTM D4829" to "ASTM DA's"
- Fixed by filtering out bad suggestions

**Wrong word highlighted ("the" mid-sentence instead of after period):**
- `createRangeForMatch` found first occurrence of "the" instead of the one Harper identified
- Added offset-aware range creation: accepts `targetOffset` parameter, picks the candidate closest to the violation's character offset

**Note block exemption not working:**
- `isNoteBlock` flag wasn't being passed through to `initInlineLinting`
- Fixed by passing `{ isNoteBlock: block.type === 'note' }` options

**NLP/compliance overlap ("be tested" highlighted orange when "shall" already yellow):**
- Added overlap suppression: NLP findings that overlap with compliance findings are skipped

**Bad Harper suggestions ("taht" -> "ta ht"):**
- Initially skipped entire violation - user reported "taht" not highlighted at all
- Changed to show the error (blue highlight) but without a Fix button

**Oxford comma fix deleting words:**
- Harper's Oxford comma: problemText="obstructions", replacement="," -> fix replaced word with comma
- Fixed by detecting punctuation-only suggestions and appending instead of replacing

**Tooltip not showing fix preview for compliance rules:**
- Compliance rules had `fixFn` but no `replacement` string
- Added dynamic fix preview computation in InlineTooltip

**Tooltip blocking editing:**
- Tooltip appeared over the highlighted word, preventing user from typing
- Added `input` event listener to dismiss tooltip immediately when user starts typing

**Grammar highlights flickering on focus:**
- Stale Range objects from prior lint cycle referenced invalidated DOM nodes
- Fixed by clearing all three finding types at the start of each lint cycle

**Grammar not showing on initial focus:**
- `grammarWasReadyAtLintStart` guard was too aggressive
- Changed to always try grammar if Harper is loaded; auto-run on the focused block when Harper finishes loading

#### Committed Session 4
`4225f1b feat: add passive voice/indicative mood detection and fix multiple linting bugs`

---

### Session 5: Orchestrator Polish

#### Implementation
- **Lint toggle:** "Lint (filled circle/empty circle)" toolbar button with localStorage persistence
- **De-duplication:** Grammar findings overlapping >50% with compliance/NLP findings suppressed
- **Compliance panel collision:** Inline linting suppressed while CompliancePanel is open
- **Gutter dots:** Small colored dot (red/amber/blue) in left margin showing highest finding severity per block
- **Severity filter:** Deferred - natural severity levels already provide filtering

#### User Testing Results
- Test 1 (Lint toggle): Passed
- Test 2 (Compliance panel collision): Linting correctly suppresses when panel opens and resumes when closed. Note: existing CompliancePanel span-based highlights persist after panel close (pre-existing behavior, not inline linting related)
- Test 3 (Gutter dots): Red dot appears correctly

#### Committed Session 5
`8ea9f4f feat: add linting toggle, de-duplication, gutter dots, and panel collision handling`

---

### CLAUDE.md Update
Updated with:
- New files in architecture tree
- Inline linting architecture section with all design decisions
- Updated test counts (446 Vitest + 40 Node + 140 E2E = 626 total)
- Updated dependencies (harper.js, compromise)
- Current branch reference

`66aa589 docs: update CLAUDE.md with inline linting architecture and test counts`

---

## Key Lessons Learned

1. **CSS Custom Highlight API text-decoration is unreliable** - keep background-color as primary indicator, add wavy underline as enhancement only
2. **React re-renders invalidate Range objects** - must re-create ranges after blur triggers DOM update
3. **String-search range creation fails for common words** - offset-aware disambiguation is essential
4. **Harper.js suggestions can be nonsensical** - filter bad suggestions (spaces in single words, length doubling)
5. **Oxford comma suggestions are "add punctuation" not "replace"** - detect punctuation-only replacements and append
6. **Tooltips must not block editing** - dismiss on any input event
7. **compromise.js #Passive tag is unreliable** - use explicit (be + #PastTense) pattern matching instead
8. **linkedom lacks compareBoundaryPoints** - provide fallback for test environment

---

## User Feedback Items (Not Yet Implemented)

1. **Reference validation rules** - User requested inline detection for:
   - References in text must also be in References subsection
   - Every reference in References must appear in text
   - Every reference in text must be tagged with RID tags
   - UMRL library should be used for validation
   - These are document-scope rules, better suited for Cross-Ref Panel or Compliance Panel

2. **Domain-inappropriate word detection** - Catching words unlikely in construction specs (e.g., "eat") requires domain-specific vocabulary model beyond general grammar checking

3. **Compliance panel highlight cleanup** - Panel span-based highlights persist after panel close (pre-existing behavior, not introduced by inline linting)
