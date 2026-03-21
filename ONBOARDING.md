# SpecsIntact Modern — Developer Onboarding

## Quickstart

```bash
# 1. Install dependencies
npm install

# 2. Start the dev server
npm run dev
# Open http://localhost:5173 in Chrome

# 3. Run tests
npm test            # 345 unit tests (Vitest) — runs in ~4 seconds
npm run test:e2e    # 132 Playwright E2E tests — runs in ~90 seconds

# 4. Build for production
npm run build       # Output in dist/
```

## Key Files to Read First

1. **`CLAUDE.md`** — The most important file. Contains full architecture, conventions, critical rules, data model, test coverage, and development roadmap. Claude Code reads this automatically on every session. **Read this first.**

2. **`reference/section.ini`** — Authoritative formatting rules from USACE. Always check `[COLORS]`, `[FONTS]`, and `[MARGINS]` sections before changing any styles. This is not optional.

3. **`src/App.jsx`** — Main editor component (~1806 lines). All state management, toolbar rendering, and block operations live here.

4. **`src/styles/editor.css`** — Global stylesheet (~360 lines). Inline mark colors, revision marks, dark mode, comment highlights, unit toggles.

5. **`src/lib/sec-parser.js`** + **`src/lib/sec-serializer.js`** — The import/export pipeline. Parser reads .SEC XML into a block array; serializer writes it back. Round-trip fidelity is critical.

## Project Structure at a Glance

```
src/
  App.jsx              # State management, toolbar, sidebar, editor pane
  components/          # 16 React components (EditableBlock, FloatingToolbar, etc.)
  lib/                 # 16 utility modules + 21 test files (345 tests)
  data/                # Sample data + UMRL/UMSL reference databases
  styles/              # Single CSS file (editor.css)
reference/             # .ini formatting rules (AUTHORITATIVE), sample .SEC files
tests/e2e/             # 132 Playwright E2E tests
```

## Claude Code Configuration

The `.claude/` directory contains configuration that works with Claude Code:

- **`settings.local.json`** — Pre-configured permissions so Claude doesn't ask for approval on every file read, npm command, or git operation. Covers Bash, Read, Edit, Write, and all MCP tools.
- **`launch.json`** — Dev server configuration for the Claude Preview tool.

These files are ready to use — no setup needed beyond installing Claude Code in VS Code.

## Development Conventions

1. **Vanilla CSS only** — no Tailwind, CSS modules, or styled-components. All styles in `editor.css` or inline `style` props.
2. **Inline styles for component-specific styling** — most components use `style={{...}}` objects directly in JSX.
3. **UX standards** — Inter font, 16px body text, 32px minimum button height, warm off-white background, WCAG AA contrast. See `.claude/memory/ux-standards.md` if it exists.
4. **`.ini` files are authoritative** — never guess at colors, fonts, or margins. Always cross-reference `reference/section.ini`.
5. **contentEditable focus management** — do NOT add additional focus effects. The current ref-callback pattern was arrived at through extensive debugging. See CLAUDE.md "Critical Rules" section.

## Testing Strategy

- **Unit tests** (`npm test`): Pure logic — parsers, serializers, diff algorithms, validation, search, table operations
- **E2E tests** (`npm run test:e2e`): Full browser testing via Playwright — keyboard navigation, toolbar interactions, track changes, import/export, comments, drag-and-drop
- **Run both after every change.** A single failing test means something is broken.

## Current Status

All planned features are implemented (64 features). The application is feature-complete for single-section UFGS editing. See CLAUDE.md "Development Roadmap" section for next steps (real-world testing, interop testing, deployment).

## Reference Data

The app uses two USACE-maintained databases (parsed from legacy SpecsIntact):
- **`src/data/umrl.json`** (587KB) — 302 standards organizations, 4,973 references. Powers the Reference Wizard.
- **`src/data/umsl.json`** (1,097KB) — 13,203 submittal entries. Powers the Submittal Register.

To refresh these: re-parse from `C:\Program Files (x86)\SpecsIntact 5\UMRL\` on a machine with SpecsIntact installed.
