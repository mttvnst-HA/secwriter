import { describe, it, expect } from 'vitest';

// The paste handler logic: extract plain text, strip all formatting
// We test the sanitization function that will be used by onPaste
import { sanitizePasteText } from '../../components/EditableBlock.jsx';

describe('sanitizePasteText', () => {
  it.each([
    ['plain text passes through', 'hello world', 'hello world'],
    ['trims trailing whitespace but preserves internal', 'hello  world  ', 'hello  world'],
    ['collapses newlines to spaces', 'line1\nline2', 'line1 line2'],
    ['collapses CRLF to spaces', 'line1\r\nline2', 'line1 line2'],
    ['collapses multiple newlines to single space', 'line1\n\n\nline2', 'line1 line2'],
    ['strips zero-width spaces', 'hello\u200Bworld', 'helloworld'],
  ])('%s', (_label, input, expected) => {
    expect(sanitizePasteText(input)).toBe(expected);
  });
});
