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
    expect(sanitizeStatusLineText('lone\u001b esc')).toBe('lone esc');
  });

  it('keeps line breaks, trims trailing space and empty trailing lines, and caps the line count', () => {
    expect(sanitizeStatusLineText('one  \r\ntwo\n\n\u001b[0m\n')).toBe('one\ntwo');
    const many = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    expect(sanitizeStatusLineText(many).split('\n')).toHaveLength(STATUSLINE_MAX_LINES);
    expect(sanitizeStatusLineText('x'.repeat(5000))).toHaveLength(STATUSLINE_MAX_LINE_CHARS);
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
