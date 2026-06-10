/**
 * Windows-1252 encoding utilities for SEC file I/O.
 *
 * SEC files declare encoding="windows-1252" in their XML header.
 * The browser's TextDecoder supports windows-1252 for reading,
 * but there's no built-in TextEncoder for it — only UTF-8.
 *
 * This module provides a windows-1252 encoder for export.
 */

// Windows-1252 characters in the 0x80-0x9F range that differ from ISO-8859-1
const WIN1252_EXTRAS = {
  0x20AC: 0x80, // €
  0x201A: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201E: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x02C6: 0x88, // ˆ
  0x2030: 0x89, // ‰
  0x0160: 0x8A, // Š
  0x2039: 0x8B, // ‹
  0x0152: 0x8C, // Œ
  0x017D: 0x8E, // Ž
  0x2018: 0x91, // '
  0x2019: 0x92, // '
  0x201C: 0x93, // "
  0x201D: 0x94, // "
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02DC: 0x98, // ˜
  0x2122: 0x99, // ™
  0x0161: 0x9A, // š
  0x203A: 0x9B, // ›
  0x0153: 0x9C, // œ
  0x017E: 0x9E, // ž
  0x0178: 0x9F, // Ÿ
};

/**
 * Encode a JavaScript string to a windows-1252 Uint8Array.
 * Characters that don't exist in windows-1252 are replaced with '?'.
 */
export function encodeWindows1252(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 0x7F) {
      // ASCII — same in all encodings
      bytes[i] = code;
    } else if (code >= 0xA0 && code <= 0xFF) {
      // Latin-1 supplement — same as windows-1252
      bytes[i] = code;
    } else if (WIN1252_EXTRAS[code] !== undefined) {
      // Special windows-1252 characters in the 0x80-0x9F gap
      bytes[i] = WIN1252_EXTRAS[code];
    } else {
      // Character not representable in windows-1252
      bytes[i] = 0x3F; // '?'
    }
  }
  return bytes;
}

// Inverse of WIN1252_EXTRAS: byte (0x80-0x9F) -> Unicode codepoint.
const WIN1252_EXTRAS_DECODE = Object.fromEntries(
  Object.entries(WIN1252_EXTRAS).map(([cp, byte]) => [byte, Number(cp)]),
);

/**
 * Decode a windows-1252 byte sequence to a JavaScript string.
 *
 * Pure-JS so it does NOT depend on Node's ICU build. `TextDecoder('windows-1252')`
 * is reliable in browsers but on a small-ICU Node build (e.g. the Node 20 CI runner)
 * it silently decodes the 0x80-0x9F band like latin1 (byte 0x97 -> U+0097 instead of
 * U+2014), which then re-encodes to '?'. This is the exact inverse of
 * encodeWindows1252, so upload->export round-trips byte-for-byte (issue #212).
 */
export function decodeWindows1252(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b >= 0x80 && b <= 0x9F) {
      // windows-1252 punctuation gap (0x81/0x8D/0x8F/0x90/0x9D are undefined —
      // pass them through as their C1 codepoint, matching the WHATWG decoder).
      out += String.fromCodePoint(WIN1252_EXTRAS_DECODE[b] ?? b);
    } else {
      // ASCII (0x00-0x7F) and Latin-1 supplement (0xA0-0xFF) are identity-mapped.
      out += String.fromCodePoint(b);
    }
  }
  return out;
}
