# SecWriter

A modern web-based editor for UFGS (Unified Facilities Guide Specifications) .SEC files, replacing the legacy SpecsIntact desktop application (SIEditor).

**Issue [#47](https://github.com/mttvnst-HA/secwriter/issues/47) closed by sub-PR 1i-b.2 ([#109](https://github.com/mttvnst-HA/secwriter/pull/109), merged 2026-05-19):** the y-prosemirror substrate migration is fully live, the legacy contentEditable path (EditableBlock.jsx, useBlockBinder.js, useUndoableBlocks.js, VITE_PM_EDITOR flag, FloatingToolbar legacy branches) is retired, and SecWriter is a single PM-based editor.

**Terminology:** "SecWriter" = this web app (previously called "SpecsIntact Modern" / "SIM"; renamed to comply with the legacy SpecsIntact EULA). "SpecsIntact" / "SIEditor" = the legacy Windows desktop application — that name refers only to the legacy product, never to this app.

**Independence:** SecWriter is an independent project. It is not affiliated with, endorsed by, or sponsored by the U.S. Department of Defense, USACE, NAVFAC, NASA, or any other agency or vendor associated with UFGS or SpecsIntact. UFGS and SpecsIntact are referenced by name solely to identify the file format and editing workflow this project addresses.

## Project Context

**What this is:** A rich text editor that reads and writes SpecsIntact .SEC files (XML-based SGML, windows-1252 encoding, used by the U.S. military for construction specifications). The editor feels like Google Docs or Notion while preserving the underlying SGML structure.

**Who it's for:** Engineers (especially geotechnical) who currently use MS Word as a workaround because SpecsIntact's tag-based editing is too clunky. The tool eliminates the Word-to-SpecsIntact round-trip workflow.

**Key design principle:** The engineer should never think about tags or SGML. Enter creates a paragraph. `/` opens a block type menu. Tab promotes/demotes headings. The SGML structure is inferred from context, not selected from a toolbar.

## Orientation

- `src/App.jsx` — main editor layout, state, toolbar, sidebar
- `src/components/` — block components (**PmEditableBlock**, TitleBlock, TableBlock, RefBlock), panels (CompliancePanel, CrossRefPanel, CommentPopup), tooltips, wizards, plus `useBlockLinting.js` (per-block lint lifecycle hook). `PmEditableBlock.jsx` mounts a y-prosemirror EditorView per editable block; the substrate is Y.XmlFragment per slot (with a Y.Text legacy fallback for migrationPartial rooms).
- `src/hooks/` — `useCollabSession.js` (Yjs session lifecycle + the four publish effects + coordination refs), `useBlockActions.js` (block-action surface — the dispatchBlocks/dispatchToolbar verb callbacks; architecture-review candidate #2, [#284](https://github.com/mttvnst-HA/secwriter/pull/284)), `useFileSession.js` (file-session I/O — architecture-review candidate #1, slices 1+2. **Output half:** local Save / Save As / .SEC+comments+lint sidecars / in-room server downloads — pure readers of blocks/meta/comments/lint/currentFile. **Input half (slice 2):** the file-INPUT *I/O shell* only — drag-over state, multi-file drag-drop parsing (.sec/.xml vs .lint.json companion), the two FileReaders, windows-1252 decode, lint-companion staging — hidden behind a single `onFileLoaded(text, name, lintText)` callback. It deliberately does NOT absorb `loadSECContent`: that is a whole-document reset (7 App-state setters), so it stays in `App.jsx` (wired as `onFileLoaded`) along with `extractMetadata`/`applyLintSidecarPayload` — threading those setters through the hook would be a shallow relocation. Symmetric: output reads-state→emits-files, input reads-files→emits-callback; neither owns document state. App still owns `currentFile`/`saveStatus`/`isDirty`. The `clearHistoryRef` bridge stays in App — it's a declaration-order artifact of `loadSECContent` living before `useCollabSession`, orthogonal to file I/O. Import chain pinned by `tests/e2e/file-import.spec.js`.), `useComments.js` (comment-interaction intent — architecture-review candidate #1, "review surfaces" slice. Owns comment **state + handlers only**: `commentsState`(+ref)/`openCommentId`/`commentRect`/`commentRects`/`showCommentSpans` and the 7 `handleComment*` handlers. Injected: `setBlocks` (create writes the comment's block html), the stable `dispatchComment` collabRef wrapper (single imperative collab seam), and `effectiveIdentity` (shared with lint/compliance, so it stays in App). **The 4 comment EFFECTS stay in `App.jsx` at their original declaration positions** — active-highlight (`setActiveComment`+`prevActiveViewRef`), `cm.reconcileBlocks` + `setBlockHtmlSilent` substrate mirror, span-visibility persist, all-popups rect capture — reading the hook's returned state. They are effect-DECLARATION-ORDER sensitive (Rule #12 in .claude/rules/testing.md): the hook is called EARLY (before `useFileSession`, because `loadSECContent` drives `setCommentsState` and `useFileSession` reads `comments`), so moving the effects into it reorders them ahead of App's other effects. Keeping them in App preserves the exact ordering; pinned by the #195 all-popups E2E in `editor.spec.js`. **Re-grill (independent review):** the backlog's `useReviewPanels` bundled comments+compliance+lint, but comments share ZERO state with lint/compliance (grep-verified) — they couple to the substrate/collab/PM axis (PM mark-spans, not CSS.highlights), touching lint/compliance only via the `showComments` XOR `complianceOpen` panel toggle (`showComments` stays in App). So comments extract alone; lint+compliance were re-grilled as a further split along the collab axis — see `useCompliancePanel.js`.), `useCompliancePanel.js` (compliance-panel intent — architecture-review candidate #1, slice 4a. Owns `complianceOpen` + `complianceState` (`comp.createInitial()` scan reducer, **ephemeral — NOT collab-published, NOT file-exported**) + the `compliance-active` CSS Custom Highlight + scroll effect (with its `lastComplianceScrollRef` scroll-gate). Injected: `blocks` (dep so PM-driven DOM rewrites re-anchor the Range objects). **The `complianceOpen → linting.setSuspended` effect stays in App** — it's a lint write, reading the hook's `complianceOpen`. **Re-grill vs the backlog's `useReviewPanels`:** compliance and lint are NOT one module — `lintingState` is collab-published DOCUMENT state (read OUT by `useCollabSession`'s 3 publish slices + `useFileSession` sidecar export + `useBlockLinting`'s per-keystroke raw `dispatch`; written IN by 4 peer remote-merge callbacks), so it's a custodian-hook concern (a later slice mirroring `useComments`), while `complianceState` is genuinely private. The highlight effect uses the `compliance-active` key, disjoint from linting's `compliance-error`/`grammar-error`/`passive-voice` keys, so its declaration order relative to the lint-highlight effect is immaterial — reorder verified against a production build per Rule #12. Pinned by the 8 compliance E2E in `editor.spec.js`.)
- `src/lib/` — parsers/serializers (sec-parser, sec-serializer, encoding), pure-reducer modules (`track-changes.js`, `comments.js`, `linting.js`, `compliance.js`), domain-side-effect modules (`compliance-ranges.js`), compliance engines (compliance-rules, compliance-checker, compliance-ai, inline-linter, grammar-checker, nlp-rules), revisions, table-ops, numbering, plus `block-html-store.js` (Y.Doc-as-substrate adapter for block html — Y.XmlFragment with Y.Text legacy fallback for migrationPartial rooms), `pm-schema.js` + `pmdoc-html.js` (PM schema + serializer — used by `PmEditableBlock` and by `yMapToBlock`'s Y.XmlFragment branch in collab.js), `ytext-html.js` (legacy Y.Text ↔ HTML conversion, retained for the migration partial path and load-boundary defenses), `block-registry.js` (App-scoped imperative-handle registry replacing `querySelector('[data-block-id="…"]')` in App), `pm-slash-dismiss.js` (Vitest-friendly slash-menu dismiss helpers — `closeSlashMenuPlugin` forceClose dispatcher + `isBlockJustSlashTrigger` heuristic), and `pm-plugins/` (slash-menu, tag-labels, keymap, relpos-selection — PM plugin set used by `PmEditableBlock`)
- `src/data/` — `ufs-1-300-02-rules.json` (compliance rules), `umrl.json` (reference DB), `umsl.json` (submittal DB), sample spec — see [src/CLAUDE.md](src/CLAUDE.md) for PM/Yjs substrate, blocks, dark mode, track changes, comments, and compliance/linting engine architecture
- `reference/section.ini` — **authoritative** formatting rules (MARGINS, COLORS, RULES, CODES, FONTS)
- `reference/ufs_1_300_02.pdf` — authoritative source for compliance rules
- `reference/UFGS_M/` — 689 .SEC files for parser validation
- `tests/e2e/` — Playwright suite: `editor.spec.js` + `collab.spec.js`
- `tests/*.node-test.mjs` — UFGS structural + interop tests (Node runner)
- `corpus/` — 4-corpus test suite (calibration/clean/dirty/adversarial)
- `tools/` — CLI utilities (interop-scan, corpus tooling, ui-audit/)
- `server/` — Hocuspocus collab relay + storage backends. See [server/CLAUDE.md](server/CLAUDE.md).
- `CONTEXT.md` — domain glossary (block, transparent tag, TC snapshot, publish path, etc.). Use these names; consult before introducing new terms.
- `docs/adr/` — load-bearing architectural decisions. **Read the relevant ADR before proposing a refactor in its area** (CJS server, Hocuspocus relay, rules-as-data, snapshot-diff publish path, storage atomicity-per-backend).
- `docs/architecture-review.md` — open deepening-candidates backlog from architecture reviews.

## Running

**First-time setup on a fresh checkout:** `npm install` then `npx playwright install` (E2E browsers) before running `npm run test:e2e`.

```bash
npm run dev                # Vite dev server at localhost:5173
npm run collab             # Collab WebSocket+HTTP server at 127.0.0.1:1234 (SIM_STORAGE_BACKEND=local writes to server/collab-db/)
npm test                   # Vitest unit tests
npm run test:compliance    # Compliance rule tests (Node runner — NOT Vitest; Vitest OOMs on the regex-heavy engine)
npm run test:e2e           # Playwright E2E (first run on fresh checkout: npx playwright install)
npm run test:corpus        # Corpus precision/recall/adversarial
npm run test:ufgs          # UFGS tag coverage + structural across 689 files
npm run test:interop       # Structural interop (parse/serialize/roundtrip)
npm run audit:init         # Autonomous UI audit (15 test areas; requires "Claude in Chrome" MCP server attached to Claude Code)
npm run audit:report       # Markdown report from findings.json
npm run audit:promote      # Promote findings to GitHub issues
npm run test:server        # Server tests (Node runner — node --test --test-force-exit)
```

**Environment:** Windows (Git Bash). `jq` is not available — use `node -e` for JSON processing in scripts/hooks.

**Common task recipes:** adding/debugging/measuring compliance rules — see the `compliance-rule-workflow` skill.

## Development Workflow

When fixing bugs, verify the fix doesn't introduce regressions by running the full test suite before reporting completion. Never report a fix as done until tests pass.

## Git Conventions

- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`
- Subject lines under 72 characters
- Always run tests before committing
- Feature branches named `type/short-description` (e.g., `feat/slash-commands`)
- `test-results/` and `tools/harper-candidates.*` are intentionally untracked — do not commit generated audit output or dictionary candidates

**Testing Rules:** see [.claude/rules/testing.md](.claude/rules/testing.md) (loads automatically when working with test files — `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`). Covers the `\u200B` regex-literal gotcha, CI-flake handling, PM-aware E2E injection helpers (`pm-helpers.js`), the full-suite-not-spot-check gate, and the React.StrictMode production-build caveat (rule #12, referenced from Orientation above).

## Security Scanning & Branch Protection

**CodeQL runs as GitHub default setup — there is no `codeql.yml` workflow.** Configuration lives in repo settings (read/write via `gh api repos/mttvnst-HA/secwriter/code-scanning/default-setup`), not in the tree. Current settings (2026-09-14): languages `javascript-typescript` + `actions`, query suite **`extended`**, threat model **`remote`**, weekly schedule plus every push/PR. Keep those — `extended` found the real share-route property-injection bug ([#332](https://github.com/mttvnst-HA/secwriter/pull/332)); `local` would only add env/file-read noise in `server/` config loading. Default setup cannot exclude paths; `tools/` is scanned deliberately and its findings are dismissed, not fixed (see below). Move to advanced setup with `paths-ignore` only if `tools/` keeps producing waves.

**Alert handling policy.** Fix findings in `src/`, `server/`, and the root `server.js`. Dismiss via the API with a comment (**280-char cap** on `dismissed_comment`):
- `tools/*.mjs` (maintainer-run local CLI scripts, e.g. `opus-*.mjs`, `run-ai-corpus.mjs`) → `won't fix`. Sending corpus files to the Claude API and writing responses to disk is their purpose.
- `tests/`, `**/__tests__/`, E2E helpers → `used in tests`.
- Mitigated-but-unrecognized (below) → `false positive`, comment naming the guard + test.

**CodeQL does NOT model these mitigations — a correct fix will still leave the alert open, so dismiss it after fixing:**
- `js/xml-bomb` has no sanitizer model at all. The `<!DOCTYPE|<!ENTITY` pre-parse reject in `sec-parser.js` is complete ([#318](https://github.com/mttvnst-HA/secwriter/pull/318)); alert #22 is dismissed.
- `js/xss` at `DOMParser.parseFromString` does not recognize a hand-written escaper. `escapeHtmlText` / `escapeHtmlAttr` in `sec-parser.js` are the real fix ([#321](https://github.com/mttvnst-HA/secwriter/pull/321)); alert #4 is dismissed. **Text nodes from the XML parser are decoded — always escape before they enter `block.html`**, which reaches `innerHTML` / `dangerouslySetInnerHTML` in TitleBlock, TableBlock, PreformattedBlock, and the comment/lint scratch divs.
- `js/remote-property-injection` recognizes ONLY a constant-string prefix on the key (`RemotePropertyInjectionQuery.qll`) — no validation guard, however named, clears it. The share route (merged in [#332](https://github.com/mttvnst-HA/secwriter/pull/332)) therefore builds its three ACL working copies (roles, invites-by-email, display cache) as **`Map`s** and converts back with `Object.fromEntries` at persist; `isSafeAclKey` in `auth/authorize.cjs` is the 400 gate for prototype-mutating subject keys. Keep both when touching that route.
- `js/client-side-request-forgery` clears with a validation guard on the same binding that reaches the fetch: gate on `isValidRoomId` from `collab.js` and `encodeURIComponent` the segment (pattern in `useFileSession.js`).
- `js/file-system-race`: don't probe with `access()`/`existsSync` before a read/write — read first and handle the error (`server.js`, [#341](https://github.com/mttvnst-HA/secwriter/pull/341)).

**Verifying a fix before merge:** PR-ref analyses report only NEW alerts, so `alerts?ref=refs/pull/N/head` is empty and uninformative. Query the branch ref instead — default setup also scans branch pushes: `gh api "repos/mttvnst-HA/secwriter/code-scanning/alerts?ref=refs/heads/<branch>&state=open"`. An alert whose line moved shows as `fixed` and a NEW number opens at the new line; compare by rule, not by number.

**Branch ruleset on `main`** (single ruleset, `main: PR + green CI + code scanning`, scoped to `~DEFAULT_BRANCH`; feature branches have zero rules): PR required (0 approvals), the three CI jobs (`Unit & Compliance Tests`, `Playwright E2E Tests`, `Azure Integration (Azurite)`) must pass, GitHub's built-in code-scanning rule blocks merges on new CodeQL findings at `errors` (quality) / `high_or_higher` (security), no force-push, no deletion. Repository admin has an `always` bypass — GitHub still demands an explicit confirmation per bypass, so nothing slips by accident. Adding a required check means adding it to the ruleset too (`gh api -X PUT repos/mttvnst-HA/secwriter/rulesets/<id>`), or the new job is advisory only.

**Also enabled:** secret scanning + push protection; Dependabot covers `npm` and `github-actions` (weekly, [.github/dependabot.yml](.github/dependabot.yml)).

## Always Check the .ini Files for Formatting

`reference/section.ini` is the authoritative source for:
- **[MARGINS]** — left/right indent per block type in inches, ABSOLUTE per type (not cumulative with nesting). TXT=0.16,0→15px | OLI=0.50,0→48px | ITM=0.85,0→82px | LST=0.50,0→48px | NPR=0.89,0.89→85px
- **[COLORS]** — inline data element colors (RID=magenta, SUB=blue, ENG=blue, MET=red, etc.)
- **[RULES]** — what tags can nest inside what (the grammar)
- **[CODES]** — tag names, descriptions, and whether TRANSPARENT (inline) or block-level
- **[FONTS]** — font styling per tag

**Read the .ini file before adding or modifying any formatting.** This applies to revision marks (ADD/DEL/CHG), inline data elements, and block styling. Always cross-reference `[COLORS]`, `[FONTS]`, and `[CODES]` before choosing CSS values.

## Thinking

Use extended thinking before architectural decisions, debugging failures, writing regex, choosing whether to retry vs. switch tools, and answering "why" questions. If you catch yourself in a retry loop, stop and reconsider the approach.

## Data Model

Each document is a flat array of blocks:

```json
{
  "id": "n42",
  "type": "txt",        // title | txt | note | oli | item | lst | table | ref | pagebreak | tbl
  "part": 1,            // PART number (1, 2, 3)
  "depth": 2,           // SPT nesting depth (0 = PART level)
  "section": "n41",     // ID of parent title block
  "level": 1,           // OLI only: list level 1..4 per UFS Figure A-1 (a. / (1) / (a) / 1.)
  "html": "...",         // Rich text with <span class="mark-rid"> etc.
  "table": { ... },     // table blocks: { columns, rows: [[{text, colspan}]] }
  "ref": { ... },        // ref blocks: { org: string, entries: [{ rid, rtl }] }
  "revision": "add",    // Block-level: "add" | "del" | "chg" | undefined
  "isNew": true          // Transient: newly created blocks (controls editability + focus)
}
```

## Agent skills

### Issue tracker

GitHub issues in `mttvnst-HA/secwriter` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary — `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
