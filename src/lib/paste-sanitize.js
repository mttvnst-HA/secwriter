/**
 * Sanitize pasted text: collapse newlines to single space, strip zero-width
 * spaces, trim trailing whitespace.
 *
 * Shared by EditableBlock (legacy contentEditable onPaste) and PmEditableBlock
 * (PM EditorView handlePaste). Both paste pipelines deliberately discard the
 * `text/html` clipboard variant in favor of `text/plain` so that engineers
 * pasting from Word or web sources don't carry rich formatting into the
 * spec — SpecsIntact's data model has no concept of arbitrary inline
 * formatting beyond the schema's recognized marks.
 */
export function sanitizePasteText(text) {
  return text.replace(/[\r\n]+/g, ' ').replace(/​/g, '').trimEnd();
}
