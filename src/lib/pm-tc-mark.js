/**
 * pm-tc-mark.js — sub-PR 1h (#47) Q33 marking pipeline.
 *
 * `rewriteForTrackChanges(oldState, originalTr, identity)` takes a user-
 * driven PM transaction and returns a replacement transaction that applies
 * the user's intent as TC-marked operations rather than literal text edits:
 *
 *   - text the user inserted is wrapped in a `revisionAdd` mark
 *   - text the user deleted gains a `revisionDel` mark INSTEAD of being
 *     removed (it stays visible until accepted)
 *   - the self-cancel case (deleting one's OWN un-accepted revisionAdd)
 *     is the ergonomic exception — the text actually disappears
 *
 * The function is pure (no DOM, no Yjs, no network). The PM substrate write
 * happens later when the host dispatches the returned transaction.
 *
 * Returns null when the transaction does not change the doc text (selection-
 * only updates, attr-only steps, etc.) so the caller can short-circuit and
 * dispatch the original tr.
 */

import { ReplaceStep } from 'prosemirror-transform';

/**
 * @param {import('prosemirror-state').EditorState} oldState
 * @param {import('prosemirror-state').Transaction} originalTr
 * @param {{ id: string, color?: string|null }} identity
 * @returns {import('prosemirror-state').Transaction|null}
 */
export function rewriteForTrackChanges(oldState, originalTr, identity) {
  if (!originalTr.docChanged) return null;
  const authorId = identity && identity.id ? String(identity.id) : null;
  const authorColor = identity && identity.color ? String(identity.color) : null;
  const addType = oldState.schema.marks.revisionAdd;
  const delType = oldState.schema.marks.revisionDel;
  const addMark = addType.create({ authorId, authorColor });
  const delMark = delType.create({ authorId, authorColor });

  const newTr = oldState.tr;

  for (const step of originalTr.steps) {
    if (step instanceof ReplaceStep) {
      const { from, to, slice } = step;
      // Map through any earlier steps that newTr has already applied (none
      // on the first iteration, but the helper composes correctly with
      // multi-step transactions).
      const mFrom = newTr.mapping.map(from);
      const mTo = newTr.mapping.map(to);
      const isInsert = slice.content.size > 0;
      const isDelete = from < to;

      if (isDelete) {
        // Walk the OLD doc range char-by-char and classify each character:
        //   'cancel' — own-author revisionAdd: actually delete (self-cancel)
        //   'mark'   — everything else: addMark(revisionDel) instead of delete
        //
        // Phase A: addMark over 'mark' segments using ORIGINAL positions
        //          (addMark doesn't shift positions). PM's mapping will
        //          re-resolve these against later deletes correctly.
        // Phase B: delete 'cancel' segments in DESCENDING position order
        //          so each delete doesn't shift the next.
        const segments = collectDeleteSegments(oldState.doc, from, to, authorId);
        for (const seg of segments) {
          if (seg.type === 'mark') {
            const sMapped = newTr.mapping.map(seg.from);
            const eMapped = newTr.mapping.map(seg.to);
            if (eMapped > sMapped) newTr.addMark(sMapped, eMapped, delMark);
          }
        }
        for (let i = segments.length - 1; i >= 0; i--) {
          const seg = segments[i];
          if (seg.type === 'cancel') {
            const sMapped = newTr.mapping.map(seg.from);
            const eMapped = newTr.mapping.map(seg.to);
            if (eMapped > sMapped) newTr.delete(sMapped, eMapped);
          }
        }
      }

      if (isInsert) {
        // Insert at the (possibly shifted) end of the original range so
        // the new content appears AFTER any addMark/delete from the
        // deletion phase. For pure inserts (from === to), insertPos === mFrom.
        const insertPos = newTr.mapping.map(to);
        newTr.replace(insertPos, insertPos, slice);
        const insertedEnd = insertPos + slice.content.size;
        newTr.addMark(insertPos, insertedEnd, addMark);
      }

      continue;
    }

    // Non-ReplaceStep — pass through unchanged (AddMarkStep, AttrStep, etc.).
    newTr.step(step);
  }

  return newTr;
}

/**
 * Walk `doc` and return true if any text node carries a revisionAdd or
 * revisionDel mark. revisionChg is excluded — the inline-revisions gutter
 * button accepts/rejects add/del only.
 *
 * Post-1g.6 (#87) schema-aware replacement for the stale
 * `m.type.name === 'revision' && m.attrs.kind === 'add'|'del'` check that
 * shipped in the legacy PmEditableBlock helper and silently always
 * returned false against the new revisionAdd / revisionDel / revisionChg
 * mark names.
 *
 * @param {import('prosemirror-model').Node} doc
 * @returns {boolean}
 */
export function docHasInlineRevisions(doc) {
  let found = false;
  doc.descendants((node) => {
    if (found) return false;
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type.name === 'revisionAdd' || m.type.name === 'revisionDel') {
        found = true;
        return false;
      }
    }
    return true;
  });
  return found;
}

/**
 * Walk the text content of `doc` in [from, to) and group adjacent
 * characters by whether they're self-cancel candidates: text nodes
 * carrying revisionAdd from `authorId` collapse to type 'cancel'; all
 * others to type 'mark'. Adjacent same-type runs merge.
 *
 * @param {import('prosemirror-model').Node} doc
 * @param {number} from
 * @param {number} to
 * @param {string|null} authorId
 * @returns {Array<{type:'cancel'|'mark', from:number, to:number}>}
 */
function collectDeleteSegments(doc, from, to, authorId) {
  const segments = [];
  let curType = null;
  let curStart = from;
  let lastEnd = from;

  doc.nodesBetween(from, to, (node, nodeStart) => {
    if (!node.isText) return true;
    const nodeEnd = nodeStart + node.nodeSize;
    const localFrom = Math.max(from, nodeStart);
    const localTo = Math.min(to, nodeEnd);
    if (localTo <= localFrom) return false;
    // Text-node marks are uniform across the node, so one classification
    // per intersected node is enough.
    const hasOwnAdd = node.marks.some(
      (m) => m.type.name === 'revisionAdd' && m.attrs.authorId === authorId,
    );
    const type = hasOwnAdd ? 'cancel' : 'mark';
    if (curType === null) {
      curType = type;
      curStart = localFrom;
    } else if (curType !== type) {
      segments.push({ type: curType, from: curStart, to: localFrom });
      curType = type;
      curStart = localFrom;
    }
    lastEnd = localTo;
    return false;
  });

  if (curType !== null) {
    segments.push({ type: curType, from: curStart, to: lastEnd });
  }
  return segments;
}
