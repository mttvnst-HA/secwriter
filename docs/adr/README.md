# Architecture Decision Records

Load-bearing architectural decisions for SecWriter. An ADR exists when a decision would be **re-litigated** by a future architecture review, refactor proposal, or dependency-bump bot if the reasoning weren't written down.

## When to write one

Write an ADR when:

- A future explorer would need the reason to avoid re-suggesting a refactor that's already been considered and rejected.
- A constraint is non-obvious from the code (e.g., "this must stay CommonJS because of yjs single-instance," "this dependency is pinned because of an internal-API patch").
- A trade-off was made deliberately and the alternative looks superficially attractive.

Do **not** write an ADR for:

- Decisions that are obvious from the code itself.
- Style preferences without a load-bearing reason.
- Things that are merely "current state" — those go in `CLAUDE.md` or `CONTEXT.md`.

## When to update one

Update an ADR's **status** (not its body) when its reasoning shifts:

- `Accepted` — the decision is current.
- `Superseded by ADR-NNNN` — replaced by a later decision; keep the body intact for history.
- `Deprecated` — no longer applies, but no replacement.

When superseding, the new ADR references the old one in its `Context`.

## Format

Each ADR is one Markdown file: `NNNN-short-slug.md`. Use [`0000-template.md`](0000-template.md) as a starting point.

## Index

| ID | Title | Status |
|----|-------|--------|
| [0001](0001-server-uses-commonjs.md) | Server uses CommonJS, not ESM | Accepted |
| [0002](0002-pin-y-websocket-v1.md) | Pin y-websocket at v1 | Accepted |
| [0003](0003-compliance-rules-as-data.md) | Compliance rules live in JSON, not source code | Accepted |
| [0004](0004-collab-publish-snapshot-diff.md) | Collab publish path uses snapshot diff, not live Y.Text binding | Accepted (deferred refactor tracked at issue #22) |
| [0005](0005-storage-adapter-atomicity-per-backend.md) | Room storage: base class + adapters; multi-artifact atomicity stays per-backend | Accepted |
| [0006](0006-pm-substrate-migration.md) | Server-side broker migrates v1 (Y.Text) rooms to v2 (Y.XmlFragment) on first v2 connect | Accepted |
| [0007](0007-single-pm-editor.md) | Retire the legacy contentEditable path; SecWriter is a single PM-based editor | Accepted |
| [0008](0008-blocks-reducer-architecture.md) | Single blocks-reducer dispatcher owns every mutation of the blocks array | Accepted |
| [0009](0009-track-changes-per-keystroke.md) | Track Changes marks per-keystroke via PM dispatchTransaction intercept | Accepted |
| [0010](0010-comments-reducer-dual-reconcile.md) | Comments architecture — opaque reducer + dual reconcile (substrate + html-walk) | Accepted |
| [0011](0011-compliance-rule-engine.md) | Compliance checker — data-driven rule engine with two-tier (regex + AI) evaluation | Accepted |
| [0012](0012-inline-linting-css-highlights.md) | Inline linting via CSS Custom Highlight API + three engines | Accepted |
| [0013](0013-storage-backends.md) | Pluggable storage backends — local, Azure Blob, S3-compatible | Accepted |
| [0014](0014-collab-server-yjs-relay.md) | Collab server — Yjs + y-websocket relay, CJS, four non-obvious patterns | Accepted |
