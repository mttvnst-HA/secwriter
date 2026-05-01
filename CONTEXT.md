# SecWriter — domain glossary

Names for the things SecWriter manipulates. This file is the source of truth for **domain** vocabulary used in code, tests, ADRs, and architecture reviews. It does **not** describe the system's architecture (that's `CLAUDE.md` and `docs/adr/`); it just gives the system's nouns and verbs precise names.

When a new concept becomes load-bearing in the codebase, add it here. When an existing term gets sharpened during a grilling/design conversation, update the entry in place. If you find yourself reaching for "component," "service," or "thing," check whether one of the names below already covers it.

For architecture vocabulary (module, interface, depth, seam, adapter, leverage, locality), see the `improve-codebase-architecture` skill's `LANGUAGE.md`.

---

## The document

**.SEC file** — A SpecsIntact section file: SGML-based XML, `windows-1252`-encoded. The on-disk artifact this app reads and writes.

**UFGS** — Unified Facilities Guide Specifications. The U.S. military's construction specification system. SecWriter edits sections from the UFGS catalog.

**SGML / XML** — The .SEC format is XML in shape, but its tag set and conventions descend from SGML. `windows-1252` byte mapping (curly quotes, em-dash, euro, trademark, bullet) is part of the format, not optional.

**UFS 1-300-02** — The USACE specification standard that governs UFGS authoring style: required imperative mood, prohibited terms ("shall," "will," etc.), prohibited symbols, vague terms, capitalization rules. The compliance engine encodes this standard.

**section.ini** — Authoritative formatting reference (`reference/section.ini`). Defines `[MARGINS]`, `[COLORS]`, `[RULES]`, `[CODES]`, `[FONTS]`. Read this before changing any visual styling — it overrides intuition.

**UMRL** — Unified Master Reference List. 302 organizations, 4,973 entries. Source of truth for the Reference Wizard.

**UMSL** — Unified Master Submittal List. 13,203 submittal entries.

---

## Editor model

**Block** — The atomic unit of the document. A flat-array entry with `id`, `type`, `part`, `depth`, `html`, optional `revision`, and type-specific payloads. Blocks are not nested in state — nesting is implied by `part` + `depth` + `section`.

**Block type** — One of: `title`, `txt`, `note`, `oli`, `item`, `lst`, `table`, `ref`, `pagebreak`, `tbl`. Determined by SGML tag at parse time, chosen via slash menu at edit time.

**Tag** — An SGML element name (TXT, OLI, RID, SUB, etc.). Tags are categorized by `[CODES]` in section.ini as either block-level or transparent.

**Transparent tag** — An inline SGML wrapper that does not break flow: ADD, ATT, BLD, CHG, CTR, DEL, ENG, HL1–HL4, HLS, INC, ITA, MET, SBS, SPS, TAI, TST, UND, URL. Rendered as a `<span>` with a `mark-*` class in the editor.

**Mark** — The DOM representation of a transparent tag (`<span class="mark-rid">`, `<span class="mark-add">`, etc.). The editor never asks the user about tags — marks are derived from semantics or applied via toolbar.

**Tag label** — The visible `RID`, `SUB`, etc. caret-anchorable indicator that appears when tag visibility is toggled on. Real DOM nodes (`contentEditable="false"`), not CSS pseudo-elements — pseudo-elements don't create caret positions.

**Slash menu** — The block-conversion UI triggered by typing `/`. The primary interface for block-type changes.

**Block hierarchy** — `SEC > PRT > SPT > {TXT, OLG, OLI, LST, ITM, NTE, NPR, NPG, SBM, TAB, TBL, TTL, REF}`. PRT is a numbered top-level part; SPT is a section/subsection wrapper; the leaf types hold visible content.

**OLI level** — Outline list level 1–4 per UFS Figure A-1. Level 1 = `a.`, level 2 = `(1)`, level 3 = `(a)`, level 4 = `1.`. Promotion/demotion via Tab.

---

## Inline data elements

**RID** — Reference citation. Points to an entry in the REFERENCES section (which itself points to UMRL).

**SUB** — Submittal callout. Registers a submittal (drawing, sample, certification) that appears in PART 1 SUBMITTALS.

**SRF** — Section cross-reference. Points to another UFGS section by number; must be validated.

**ENG / MET** — Dual-unit pair. ENG is the U.S.-customary value, MET is metric. The editor renders one based on the user's unit-display preference.

**TAI** — Tailoring marker. Wraps content that applies only to a specific branch (Army/Navy/AF), region, or delivery type. Carries a `data-opt` attribute identifying the variant.

---

## Compliance

**Compliance rule** — One row in `src/data/ufs-1-300-02-rules.json`. Categorized as `prohibitedTerms`, `prohibitedSymbols`, `vagueTerms`, `requiredCapitalizations`, `colloquial`, `redundant`, or `requiredPractice`. Rules are data, not code.

**Finding** — A single match of one rule against one block: rule id, severity, offset, message, optional `fix()`.

**Three-tier linting** — (1) Static UFS rules (synchronous, <5ms). (2) Harper.js grammar (async, Web Worker, WASM). (3) `compromise.js` NLP (synchronous, lazy-loaded). Each tier emits findings with distinct highlight colors.

**Violation budget** — `MAX_VIOLATIONS = 2000` cap on findings per scan. Returns `truncated: true` when capped.

**AI tier** — The Claude-API rewrite path used for fixes the static engine can't compute (`fix === null`). Chunked at 20 blocks per call.

**Compliance scope** — `whole-doc | part | section | block`. Limits which blocks are scanned.

**Rule ID mapping** — `corpus/results/rule-id-mapping.json`. Translates the corpus's semantic injection IDs (`COLLOQ-furnish`) to runtime sequential IDs (`TERM-034`).

---

## Track changes

**Revision** — A pending mutation to a block: `add`, `del`, or `chg` (block-level), or inline `<add>` / `<del>` marks (within HTML).

**TC snapshot** — The plain text of a block at the moment Track Changes was enabled. Stored in `tcSnapshots: Map<blockId, plainText>`. Diffed against current text on blur to synthesize revision marks.

**Diff pipeline** — `diffWords()` → `refineWordDiff()` → `diffChars()`. Refinement applies character-level sub-diff to consecutive del→add pairs sharing ≥50% common characters.

**Accept / Reject** — User actions that resolve a revision. Accept All / Reject All operate on every revision in scope. Inline accept/reject operates on one mark.

---

## Comments

**Comment** — Metadata in the `comments: Map<commentId, ...>` store: id, blockId, status, highlightText, entries (thread).

**Comment span** — `<span class="mark-comment" data-comment-id="...">text</span>` in the DOM. Persisted in `block.html` for editable blocks; injected into render-only DOM for ref/table blocks.

**Comment status** — `open` | `resolved`. Reflected on the comment metadata AND on the span's class (drift between the two is a known pathology).

**Orphan span** — A `mark-comment` span whose `data-comment-id` has no metadata entry (typically appears after a remote collab sync). Cleaned up by `stripOrphanCommentSpans`.

---

## Collaboration

**Room** — A collaborative editing session, identified by a room id. Backed by one Y.Doc on the server and persisted as three artifacts.

**Identity** — The user's display name + color, stored in localStorage. The collab session is gated on `inRoom && identity` — without an identity, the WebSocketProvider is never instantiated.

**Y.Doc / Y.Text** — Yjs CRDT primitives. SecWriter uses one Y.Doc per room with shared types `yOrder`, `yStore`, `yMeta`, `yTc`, `yComments`.

**Publish path** — The pipeline that gets block content into the Y.Doc: `EditableBlock.onUpdate` (debounced 400ms or on blur) → `App.handleBlockUpdate` → publish effect → `applyBlocksToYDoc` → `applyHtmlToYText`. String-diff at publish time, not a live Y.Text↔DOM binding. See ADR-0004.

**Snapshot diff (collab)** — The publish-path strategy of diffing new HTML against existing Y.Text inside `applyHtmlToYText`. Distinct from the **TC snapshot** (plain-text baseline for revision diffs) — same word, different concept.

**Awareness** — Yjs cursor/presence broadcast. Carries identity, color, and selection range.

**Eviction guard** — The `server/collab-server.cjs` patch around `setupWSConnection` that re-installs the preloaded Y.Doc into y-websocket's `docs` Map after the preload `await`. Prevents y-websocket v1's `closeConn` from evicting our doc by name during a stale-close race. See ADR-0002.

---

## Storage

**Backend** — One of `local`, `azure`, `s3`. Selected via `SIM_STORAGE_BACKEND`. Implements `writeRoom`, `readRoom`, `listRooms`, `deleteRoom`.

**Room artifacts** — The three files persisted per room: `.ydoc` (CRDT state), `.SEC` (serialized section), `.comments.json` (sidecar metadata). Written atomically (stage → rename → rollback).

---

## Reference data and corpora

**Calibration corpus** — 2,583 raw UFGS blocks from 5 sections. Validates that primary rules produce zero false positives on unmodified master text.

**Clean corpus** — Same blocks, rewritten to full UFS 1-300-02 compliance by Claude Opus. Every finding here is a false positive. Measures precision.

**Dirty corpus** — 644 blocks with 1,438 labeled injected violations. Measures recall.

**Adversarial corpus** — 150 hand-crafted edge cases: false-positive traps, NLP ambiguity, domain jargon. Measures robustness.

---

## Anti-glossary (don't say)

- "Component" — too vague. Say "block," "block component" if it's a React render-layer thing, or "module" for an architectural unit.
- "Boundary" — overloaded. Use "seam" (architecture) or name the actual transition (publish path, parser, serializer).
- "Service" — not a SecWriter concept. Say "module" or name the verb.
- "Element" — ambiguous between SGML element and DOM element. Say "tag" or "DOM node."
- "Annotation" — too vague. Say "mark," "comment span," "revision mark," or "tag label" depending on which is meant.
