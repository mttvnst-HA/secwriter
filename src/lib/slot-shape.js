/**
 * slot-shape — the single duck-type discriminator for a block's html CRDT
 * slot (architecture-review candidate #3).
 *
 * A block's `html` slot can be one of two Yjs shapes:
 *   - Y.XmlFragment (post-1d default; PmEditableBlock's ySyncPlugin binds to it)
 *   - Y.Text        (legacy / migrationPartial leftover; pre-broker rooms)
 * See ADR-0006. Before this module, "which shape is this slot?" was re-derived
 * by hand-copied duck-type across six modules (block-html-store, collab,
 * pm-fragment-cache, pmdoc-html, PmEditableBlock), each spelling out
 * `typeof x.toArray === 'function' && typeof x.nodeName !== 'string'` etc.
 * inline. A y-prosemirror / Yjs API change to any of these shapes would need
 * all six edited independently. This module owns the predicate once.
 *
 * Detection is by STRUCTURAL DUCK-TYPING, deliberately NOT `instanceof
 * Y.XmlFragment`, and this module imports NOTHING — collab.js and pmdoc-html.js
 * are pulled into the CJS server bundle and must not add a second yjs import
 * path (issue #47 Q22, ADR-0001 / ADR-0006). A zero-dependency sibling is the
 * only centralization that preserves that constraint.
 *
 * The duck-type facts (from the Yjs shared-type surface):
 *   - Y.XmlFragment    : has toArray(), NO nodeName property.
 *   - YXmlElement      : has toArray() AND a string nodeName (so nodeName is
 *                        what separates a fragment slot from an element child).
 *   - Y.Text / YXmlText: has toDelta(), no toArray().
 */

/**
 * A Y.XmlFragment html slot (the post-migration v2 shape ySyncPlugin binds to).
 * @param {*} x
 * @returns {boolean}
 */
export function isXmlFragmentSlot(x) {
  return !!x && typeof x.toArray === 'function' && typeof x.nodeName !== 'string';
}

/**
 * A Y.Text / YXmlText slot-or-child (the legacy / migrationPartial shape).
 * @param {*} x
 * @returns {boolean}
 */
export function isTextSlot(x) {
  return !!x && typeof x.toDelta === 'function';
}

/**
 * Either supported html-slot shape. Excludes bare strings, null, and malformed
 * slots — the defensive fallback branches key off `!isReadableSlot(...)`.
 * @param {*} x
 * @returns {boolean}
 */
export function isReadableSlot(x) {
  return isXmlFragmentSlot(x) || isTextSlot(x);
}

/**
 * A YXmlElement node (has both toArray() and a string nodeName) — used when
 * walking a fragment's children to tell element nodes from text nodes. Not a
 * slot shape itself (a slot is never a bare element), but it shares the same
 * duck-type primitives, so it lives here too.
 * @param {*} x
 * @returns {boolean}
 */
export function isYXmlElementNode(x) {
  return !!x && typeof x.nodeName === 'string' && typeof x.toArray === 'function';
}
