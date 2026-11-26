/**
 * @fileoverview The statusline text the chat view draws (src/statusline-text.ts): text, line
 * breaks and colour survive; every other escape and control character goes; it is bounded.
 *
 * Port: none.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeRenderedStatusLine,
  sanitizeStatusLineText,
  STATUSLINE_MAX_LINES,
  STATUSLINE_MAX_LINE_CHARS,
} from '../src/statusline-text.js';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('sanitizeStatusLineText', () => {
  it('keeps text and SGR colour sequences', () => {
    const line = '\u001b[36m/work\u001b[0m \u001b[2m5h:\u001b[0m \u001b[32m27%\u001b[0m';
    expect(sanitizeStatusLineText(line)).toBe(line);
  });

  it('drops cursor moves, OSC hyperlinks and titles, and stray control characters', () => {
    expect(sanitizeStatusLineText('a\u001b[2Kb\u001b]8;;https://x\u0007link\u001b]8;;\u0007\u0007c\u0000d')).toBe(
      'ablinkcd'
    );
    // An ESC that starts no sequence (the next character is outside the escape range) goes alone.
    expect(sanitizeStatusLineText('lone\u001b\u00b7 esc')).toBe('lone\u00b7 esc');
    expect(sanitizeStatusLineText('trailing\u001b')).toBe('trailing');
  });

  it('drops whole escape sequences the ANSI pattern does not match, not just their ESC byte', () => {
    // A charset switch (nF escape), cursor save/restore (two-byte escapes) and a colon-form SGR.
    expect(sanitizeStatusLineText('\u001b[32mok\u001b(B\u001b[m rest')).toBe('\u001b[32mok\u001b[m rest');
    expect(sanitizeStatusLineText('\u001b7x\u001b8')).toBe('x');
    expect(sanitizeStatusLineText('a\u001b[38:2::255:0:0mb')).toBe('ab');
    // ESC SP e is an nF escape too, so the space and the final byte go with it.
    expect(sanitizeStatusLineText('lone\u001b esc')).toBe('lonesc');
  });

  it('keeps line breaks, trims trailing space and empty trailing lines, and caps the line count', () => {
    expect(sanitizeStatusLineText('one  \r\ntwo\n\n\u001b[0m\n')).toBe('one\ntwo');
    const many = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    expect(sanitizeStatusLineText(many).split('\n')).toHaveLength(STATUSLINE_MAX_LINES);
    expect(sanitizeStatusLineText('x'.repeat(5000))).toHaveLength(STATUSLINE_MAX_LINE_CHARS);
    expect(sanitizeStatusLineText('a\rb')).toBe('a\nb');
    // The whole text is cut to 4096 characters before the line caps, so the second line loses its last letter.
    expect(sanitizeStatusLineText(`${'x'.repeat(4090)}\nsecond`)).toBe(
      `${'x'.repeat(STATUSLINE_MAX_LINE_CHARS)}\nsecon`
    );
  });

  it('drops an SGR sequence the line cap cut in half', () => {
    const cutInSgr = sanitizeStatusLineText(`${'a'.repeat(595)}\u001b[38;5;208mX`);
    expect(cutInSgr).not.toContain('\u001b');
    expect(cutInSgr).not.toContain('[38;5');
    expect(cutInSgr).toBe('a'.repeat(595));

    const cutAfterEsc = sanitizeStatusLineText(`${'a'.repeat(STATUSLINE_MAX_LINE_CHARS - 1)}\u001b[0mX`);
    expect(cutAfterEsc).not.toContain('\u001b');
    expect(cutAfterEsc).toBe('a'.repeat(STATUSLINE_MAX_LINE_CHARS - 1));
  });
});

describe('decodeRenderedStatusLine', () => {
  it('decodes the exporter copy and sanitizes it', () => {
    expect(decodeRenderedStatusLine(b64('\u001b[35mOpus\u001b[0m \u001b[1A'))).toBe('\u001b[35mOpus\u001b[0m');
  });

  it('refuses something that is not base64', () => {
    expect(decodeRenderedStatusLine('not base64!')).toBe('');
    expect(decodeRenderedStatusLine('')).toBe('');
  });
});
