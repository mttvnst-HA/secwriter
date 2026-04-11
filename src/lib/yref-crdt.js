/**
 * yref-crdt.js — REF block CRDT converter
 *
 * Converts between plain RefData objects and a Yjs Y.Map structure with
 * fine-grained Y.Text fields so concurrent REF edits can merge via CRDT
 * instead of last-write-wins.
 *
 * RefData shape: { org: string, entries: Array<{ rid: string, rtl: string }> }
 *
 * Y.Map structure:
 *   Y.Map
 *   ├── org: Y.Text
 *   └── entries: Y.Array
 *       ├── [0]: Y.Map { rid: Y.Text, rtl: Y.Text }
 *       └── [1]: Y.Map { rid: Y.Text, rtl: Y.Text }
 */

import * as Y from 'yjs';
import { applyHtmlToYText, yTextToHtml } from './ytext-html.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Seed a detached or attached Y.Text with plain text content.
 * REF fields (org, rid, rtl) are plain text with no formatting attributes,
 * so we insert the whole string in one call.
 *
 * @param {Y.Text} yText
 * @param {string} text
 */
function seedYTextFromPlain(yText, text) {
  if (text) {
    yText.insert(0, text);
  }
}

/**
 * Build a Y.Map for a single REF entry { rid, rtl }.
 * Called inside a transaction by refToYStructure.
 *
 * @param {{ rid: string, rtl: string }} entry
 * @returns {Y.Map}
 */
function entryToYMap(entry) {
  const yMap = new Y.Map();
  const ridText = new Y.Text();
  const rtlText = new Y.Text();
  seedYTextFromPlain(ridText, entry.rid || '');
  seedYTextFromPlain(rtlText, entry.rtl || '');
  yMap.set('rid', ridText);
  yMap.set('rtl', rtlText);
  return yMap;
}

/**
 * Read a Y.Text field as a plain string.
 * Uses yTextToHtml for consistency — since ref text has no formatting the
 * result will be a plain string without any HTML tags.
 *
 * @param {Y.Text} yText
 * @returns {string}
 */
function readYTextField(yText) {
  if (!(yText instanceof Y.Text)) return String(yText || '');
  return yTextToHtml(yText);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create Y.Text + Y.Array structure inside yMap from plain RefData.
 * Must be called inside a Y.Doc transaction.
 * Clears any existing content before writing.
 *
 * @param {Y.Map} yMap   — target map (already inside a Y.Doc)
 * @param {{ org: string, entries: Array<{rid: string, rtl: string}> }} refData
 */
export function refToYStructure(yMap, refData) {
  // Clear existing fields
  yMap.delete('org');
  yMap.delete('entries');

  // org: Y.Text
  const orgText = new Y.Text();
  seedYTextFromPlain(orgText, refData.org || '');
  yMap.set('org', orgText);

  // entries: Y.Array of Y.Map
  const yEntries = new Y.Array();
  const entryMaps = (refData.entries || []).map(e => entryToYMap(e));
  if (entryMaps.length > 0) {
    yEntries.push(entryMaps);
  }
  yMap.set('entries', yEntries);
}

/**
 * Read Yjs ref structure back into a plain RefData object.
 *
 * @param {Y.Map} yMap
 * @returns {{ org: string, entries: Array<{rid: string, rtl: string}> }}
 */
export function yStructureToRef(yMap) {
  const org = readYTextField(yMap.get('org'));

  const yEntries = yMap.get('entries');
  const entries = [];
  if (yEntries instanceof Y.Array) {
    for (const entryMap of yEntries) {
      if (entryMap instanceof Y.Map) {
        entries.push({
          rid: readYTextField(entryMap.get('rid')),
          rtl: readYTextField(entryMap.get('rtl')),
        });
      }
    }
  }

  return { org, entries };
}

/**
 * Diff prevRef → nextRef and apply minimal CRDT operations to yMap.
 *
 * - org change: applyHtmlToYText on the org Y.Text
 * - entry updates: applyHtmlToYText on rid/rtl Y.Text fields
 * - entry appends: push new Y.Map entries onto the Y.Array
 * - entry removals: delete from the Y.Array by index
 *
 * All mutations run inside a single doc.transact() call.
 *
 * @param {Y.Map} yMap
 * @param {{ org: string, entries: Array<{rid: string, rtl: string}> }} prevRef
 * @param {{ org: string, entries: Array<{rid: string, rtl: string}> }} nextRef
 */
export function applyRefEdits(yMap, prevRef, nextRef) {
  const doc = yMap.doc;
  if (!doc) return;

  doc.transact(() => {
    // ── org ──────────────────────────────────────────────────────────────────
    if (prevRef.org !== nextRef.org) {
      const orgText = yMap.get('org');
      if (orgText instanceof Y.Text) {
        applyHtmlToYText(orgText, nextRef.org || '');
      }
    }

    // ── entries ──────────────────────────────────────────────────────────────
    const yEntries = yMap.get('entries');
    if (!(yEntries instanceof Y.Array)) return;

    const prevEntries = prevRef.entries || [];
    const nextEntries = nextRef.entries || [];
    const prevLen = prevEntries.length;
    const nextLen = nextEntries.length;

    // Update/create entries in-place up to min(prevLen, nextLen)
    const sharedLen = Math.min(prevLen, nextLen);
    for (let i = 0; i < sharedLen; i++) {
      const entryMap = yEntries.get(i);
      if (!(entryMap instanceof Y.Map)) continue;

      const prevEntry = prevEntries[i];
      const nextEntry = nextEntries[i];

      if (prevEntry.rid !== nextEntry.rid) {
        const ridText = entryMap.get('rid');
        if (ridText instanceof Y.Text) {
          applyHtmlToYText(ridText, nextEntry.rid || '');
        }
      }
      if (prevEntry.rtl !== nextEntry.rtl) {
        const rtlText = entryMap.get('rtl');
        if (rtlText instanceof Y.Text) {
          applyHtmlToYText(rtlText, nextEntry.rtl || '');
        }
      }
    }

    if (nextLen > prevLen) {
      // Append new entries
      const newMaps = nextEntries.slice(prevLen).map(e => entryToYMap(e));
      yEntries.push(newMaps);
    } else if (nextLen < prevLen) {
      // Remove trailing entries (delete from the end to preserve indices)
      const deleteCount = prevLen - nextLen;
      yEntries.delete(nextLen, deleteCount);
    }
  }, 'local-ref-edits');
}
