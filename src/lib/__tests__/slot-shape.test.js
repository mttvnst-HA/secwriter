// slot-shape — architecture-review candidate #3.
//
// The one duck-type discriminator for a block's html CRDT slot, previously
// hand-copied across six modules. These assertions run the predicates against
// REAL Yjs shapes (not hand-mocked objects), so a future yjs / y-prosemirror
// release that reshapes Y.XmlFragment / Y.Text / YXmlElement trips exactly one
// test here instead of silently breaking read+write paths in six files.

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import {
  isXmlFragmentSlot,
  isTextSlot,
  isReadableSlot,
  isYXmlElementNode,
} from '../slot-shape.js';

// Build the four real Yjs shapes a slot / fragment-child can take.
function shapes() {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('html'); // Y.XmlFragment (v2 slot)
  const element = new Y.XmlElement('paragraph'); // YXmlElement (fragment child)
  const xmlText = new Y.XmlText('hi'); // YXmlText (inline child)
  fragment.insert(0, [element]);
  element.insert(0, [xmlText]);
  const text = doc.getText('legacy'); // Y.Text (v1 / migrationPartial slot)
  return { fragment, element, xmlText, text };
}

describe('slot-shape discriminators (real Yjs shapes)', () => {
  const { fragment, element, xmlText, text } = shapes();

  it('isXmlFragmentSlot: true only for a Y.XmlFragment', () => {
    expect(isXmlFragmentSlot(fragment)).toBe(true);
    expect(isXmlFragmentSlot(text)).toBe(false); // Y.Text
    expect(isXmlFragmentSlot(element)).toBe(false); // has a string nodeName
    expect(isXmlFragmentSlot(xmlText)).toBe(false); // no toArray
  });

  it('isTextSlot: true for Y.Text and YXmlText (both expose toDelta)', () => {
    expect(isTextSlot(text)).toBe(true);
    expect(isTextSlot(xmlText)).toBe(true);
    expect(isTextSlot(fragment)).toBe(false);
    expect(isTextSlot(element)).toBe(false);
  });

  it('isYXmlElementNode: true only for a YXmlElement (nodeName + toArray)', () => {
    expect(isYXmlElementNode(element)).toBe(true);
    expect(isYXmlElementNode(fragment)).toBe(false); // no string nodeName
    expect(isYXmlElementNode(text)).toBe(false);
    expect(isYXmlElementNode(xmlText)).toBe(false);
  });

  it('isReadableSlot: true for either supported slot shape', () => {
    expect(isReadableSlot(fragment)).toBe(true); // v2
    expect(isReadableSlot(text)).toBe(true); // v1 / migrationPartial
  });

  it('rejects non-slot inputs (string, null, undefined, plain object)', () => {
    for (const bad of ['<p>x</p>', '', null, undefined, {}, 42]) {
      expect(isXmlFragmentSlot(bad)).toBe(false);
      expect(isTextSlot(bad)).toBe(false);
      expect(isReadableSlot(bad)).toBe(false);
      expect(isYXmlElementNode(bad)).toBe(false);
    }
  });
});
