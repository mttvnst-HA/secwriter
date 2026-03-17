import { describe, it, expect } from 'vitest';
import { encodeWindows1252 } from '../encoding.js';

describe('encodeWindows1252', () => {
  it('encodes ASCII characters unchanged', () => {
    const result = encodeWindows1252('Hello World 123');
    expect(result).toEqual(new Uint8Array([72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100, 32, 49, 50, 51]));
  });

  it('encodes Latin-1 supplement characters (0xA0-0xFF)', () => {
    // © = U+00A9, ° = U+00B0, ñ = U+00F1
    const result = encodeWindows1252('©°ñ');
    expect(result[0]).toBe(0xA9);
    expect(result[1]).toBe(0xB0);
    expect(result[2]).toBe(0xF1);
  });

  it('encodes curly quotes (windows-1252 0x91-0x94)', () => {
    // Left single quote U+2018 → 0x91
    // Right single quote U+2019 → 0x92
    // Left double quote U+201C → 0x93
    // Right double quote U+201D → 0x94
    const result = encodeWindows1252('\u2018\u2019\u201C\u201D');
    expect(result[0]).toBe(0x91);
    expect(result[1]).toBe(0x92);
    expect(result[2]).toBe(0x93);
    expect(result[3]).toBe(0x94);
  });

  it('encodes em-dash and en-dash', () => {
    // Em-dash U+2014 → 0x97, En-dash U+2013 → 0x96
    const result = encodeWindows1252('\u2014\u2013');
    expect(result[0]).toBe(0x97);
    expect(result[1]).toBe(0x96);
  });

  it('encodes euro sign (U+20AC → 0x80)', () => {
    const result = encodeWindows1252('\u20AC');
    expect(result[0]).toBe(0x80);
  });

  it('encodes trademark (U+2122 → 0x99)', () => {
    const result = encodeWindows1252('\u2122');
    expect(result[0]).toBe(0x99);
  });

  it('encodes bullet (U+2022 → 0x95)', () => {
    const result = encodeWindows1252('\u2022');
    expect(result[0]).toBe(0x95);
  });

  it('encodes ellipsis (U+2026 → 0x85)', () => {
    const result = encodeWindows1252('\u2026');
    expect(result[0]).toBe(0x85);
  });

  it('replaces unmappable characters with ?', () => {
    // Chinese character — not in windows-1252
    const result = encodeWindows1252('\u4e2d');
    expect(result[0]).toBe(0x3F); // '?'
  });

  it('handles empty string', () => {
    const result = encodeWindows1252('');
    expect(result).toEqual(new Uint8Array(0));
  });

  it('handles mixed ASCII and special characters', () => {
    const result = encodeWindows1252('Test\u2014value');
    // T=0x54, e=0x65, s=0x73, t=0x74, —=0x97, v=0x76, a=0x61, l=0x6C, u=0x75, e=0x65
    expect(result[0]).toBe(0x54); // T
    expect(result[4]).toBe(0x97); // em-dash
    expect(result[5]).toBe(0x76); // v
  });
});
