# 1i-b.1 known concerns (for 1i-b.2 attention)

## Reconcile roundtrip stability

The setBlockHtmlSilent path assumes `cm.reconcileBlocks` produces HTML
byte-stable through htmlToPmFragment + prosemirrorToYXmlFragment. If
not, a "silent" write on a PM-mounted block produces real ops, y-
prosemirror observes them, dispatches a PM tr with ySyncPluginKey
origin → enters local undo as a phantom frame.

Symptom: Ctrl+Z after a comment-status reconcile fires undoes the
reconcile rather than the user action.

Mitigation if hit: extend setBlockHtmlSilent to check `prosemirrorToYXmlFragment`'s
return value (or wrap in a try-then-no-op) when the fragment already
matches the target shape. Today no such regression has been observed
but the path isn't pinned by a test.
