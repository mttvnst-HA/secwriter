# Onboarding Guide — SpecsIntact Modern (SIM)

Welcome to SpecsIntact Modern, a web-based editor for UFGS (Unified Facilities Guide Specifications) `.SEC` files. This guide will get you from zero to running the app and contributing code.

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | 20+ | LTS recommended. Download from [nodejs.org](https://nodejs.org) |
| **npm** | 10+ | Ships with Node |
| **Git** | 2.40+ | [git-scm.com](https://git-scm.com) |
| **Browser** | Chromium-based | Chrome or Edge — required for CSS Custom Highlight API (used by inline linting) |

Optional but recommended:
- **VS Code** with the ESLint and Vite extensions
- **Git Bash** (included with Git for Windows) — the project uses Unix-style paths

## 1. Clone the Repository

```bash
git clone https://github.com/haleyaldrich/specsintact-modern.git
cd specsintact-modern
```

If you don't have access, request it from the repo admin. The repo is private.

## 2. Install Dependencies

```bash
npm install
```

This installs React, Vite, Vitest, Playwright, and all other dependencies. Takes about 30 seconds on a typical connection.

### Install Playwright Browsers (for E2E tests)

```bash
npx playwright install chromium
```

You only need to do this once. E2E tests run against Chromium only.

## 3. Run the App

```bash
npm run dev
```

Open **http://localhost:5173** in Chrome or Edge. You should see the editor with a sample UFGS specification (31 00 00 EARTHWORK) loaded.

### Quick tour of the UI

- **Left sidebar** — document outline tree (click to navigate)
- **Center** — the rich text editor (contentEditable blocks)
- **Toolbar** — formatting, track changes, comments, compliance, tag toggle, dark mode
- **Right panel** — opens for compliance checker, cross-ref validation, etc.

### Loading a different `.SEC` file

Click the folder icon in the toolbar (or use File > Open). You can find sample files in:
- `reference/31_00_00.SEC` — the default sample (EARTHWORK)
- `reference/UFGS_M/01_42_00.sec` — another sample section

## 4. Run the Tests

SIM has **654 automated tests** across three runners. Run them all before making changes.

### Unit tests (457 tests, Vitest)

```bash
npm test
```

Runs in ~10 seconds. Covers parsers, serializers, diff engine, numbering, compliance rules, and more.

### Compliance rule tests (40 tests, Node runner)

```bash
npm run test:compliance
```

These use Node's built-in test runner (not Vitest) because the regex-heavy rule engine exhausts Vitest worker memory.

### Corpus tests (17 tests, Node runner)

```bash
npm run test:corpus
```

Validates the three text-analysis engines against real UFGS text corpora (precision, recall, adversarial edge cases).

### E2E tests (140 tests, Playwright)

```bash
npm run test:e2e
```

Launches a dev server automatically and runs browser tests against it. Takes 2-3 minutes. If a test fails, Playwright generates trace files you can inspect:

```bash
npx playwright show-report
```

### Watch mode (for active development)

```bash
npm run test:watch
```

Vitest re-runs affected tests on file save.

## 5. Project Structure at a Glance

```
src/
  App.jsx               # Main editor — state, toolbar, sidebar (~1860 lines)
  components/           # UI components (EditableBlock, FloatingToolbar, etc.)
  lib/                  # Core logic (parser, serializer, diff, compliance, linting)
  lib/__tests__/        # All test files live here
  data/                 # Pre-parsed JSON data (sample spec, UMRL, UMSL, rules)
  styles/editor.css     # All styles (marks, revisions, dark mode, highlights)

reference/              # Authoritative source files
  section.ini           # SpecsIntact formatting rules — READ THIS before changing styles
  ufs_1_300_02.pdf      # UFS compliance standard (source of truth for rules)
  31_00_00.SEC          # Sample spec file

tests/e2e/              # Playwright E2E tests
corpus/                 # Test corpora for engine validation
tools/                  # CLI utilities (parser, corpus tools)
```

## 6. Development Workflow

### Branching

```bash
git checkout -b feat/your-feature    # or fix/bug-name, refactor/thing
# ... make changes ...
git add <files>
git commit -m "feat: add thing"      # conventional commits required
git push -u origin feat/your-feature
```

Branch naming: `type/short-description` (e.g., `feat/slash-commands`, `fix/parser-depth`).

Commit prefixes: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

### Before committing

Always run the full test suite:

```bash
npm test && npm run test:compliance && npm run test:corpus
```

CI runs all tests on push to `main` and on pull requests. PRs with failing tests won't be merged.

### Pull requests

Open a PR against `main`. CI will run unit tests, compliance tests, corpus tests, and E2E tests automatically (on Windows, matching the production target).

## 7. Key Concepts for Contributors

### The data model

The document is a **flat array of blocks**. Each block has a `type` (`txt`, `title`, `oli`, `table`, `ref`, etc.), a `depth` for nesting, and `html` for rich text content. There is no deeply nested tree structure — the tree sidebar is built on-the-fly from the flat array.

### `.SEC` file format

`.SEC` files are XML-based SGML with **Windows-1252 encoding**. The parser (`sec-parser.js`) reads them into blocks; the serializer (`sec-serializer.js`) writes blocks back out. Round-trip fidelity is tested.

### contentEditable editing

Each text block is a `contentEditable` div. Focus management was the hardest part of the prototype — do not add competing focus mechanisms. See the "contentEditable focus management" section in `CLAUDE.md` for the exact pattern.

### Formatting rules

**Always check `reference/section.ini`** before changing margins, colors, or fonts. The `.ini` file is the authoritative source for SpecsIntact formatting, not guesswork.

### Compliance checker

Rules live in `src/data/ufs-1-300-02-rules.json`. The rule engine in `compliance-rules.js` auto-generates regex patterns from the JSON. To add or modify a rule, edit the JSON — no code changes needed. Always validate with `npm run test:compliance` and `npm run test:corpus`.

## 8. Useful Commands Reference

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start dev server (localhost:5173) |
| `npm run build` | Production build to `dist/` |
| `npm test` | Run 457 Vitest unit tests |
| `npm run test:watch` | Vitest in watch mode |
| `npm run test:compliance` | Run 40 compliance rule tests (Node runner) |
| `npm run test:corpus` | Run 17 corpus precision/recall tests |
| `npm run test:e2e` | Run 140 Playwright E2E tests |
| `npm run parse -- input.sec output.json` | Parse a .SEC file to JSON |
| `npm run corpus:report` | Generate corpus metrics report |

## 9. Troubleshooting

**Vitest OOM errors:** If unit tests crash with out-of-memory errors, try:
```bash
NODE_OPTIONS="--max-old-space-size=4096" npm test
```

**Playwright tests fail to start:** Make sure port 5173 is free, or kill any running dev server first.

**Inline linting not working:** The CSS Custom Highlight API requires Chrome/Edge 105+. Firefox and Safari do not support it.

**`.SEC` file looks garbled:** The file likely opened as UTF-8 instead of Windows-1252. The app handles this correctly via `FileReader.readAsArrayBuffer()` — if you're viewing the file in an external editor, set encoding to Windows-1252.

## 10. Where to Learn More

- **`CLAUDE.md`** — comprehensive project documentation (architecture, design decisions, known limitations)
- **`reference/section.ini`** — authoritative formatting rules
- **`reference/ufs_1_300_02.pdf`** — UFS compliance standard
- **`corpus/results/REPORT.md`** — current compliance engine metrics
- **`tests/interop-test-procedure.md`** — manual round-trip testing scenarios
