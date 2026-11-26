/**
 * @fileoverview oneLineText (src/utils/single-line.ts): untrusted text as one short line, the
 * sanitizer behind the tool-call detail, the slash-command descriptions and the prompt suggestion.
 *
 * Port: N/A
 */

import { describe, expect, it } from 'vitest';
import { oneLineText } from '../src/utils/index.js';

describe('oneLineText', () => {
  it('turns control characters and line breaks into single spaces and trims the ends', () => {
    expect(oneLineText('  a\tb\r\n\nc\x07d\x7fe\x1b[0m  ', 100)).toBe('a b c d e [0m');
  });

  it('returns text within the cap unchanged', () => {
    expect(oneLineText('short text', 10)).toBe('short text');
  });

  it('cuts at the cap and adds an ellipsis', () => {
    expect(oneLineText('abcdefghij', 4)).toBe('abcd…');
  });

  it('cuts without an ellipsis when asked', () => {
    expect(oneLineText('abcdefghij', 4, false)).toBe('abcd');
  });

  it('cuts after collapsing, so whitespace does not use up the cap', () => {
    expect(oneLineText('a     b     c', 5)).toBe('a b c');
  });
});
