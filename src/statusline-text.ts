/**
 * @fileoverview The statusline text the chat view shows under its message box.
 *
 * Claude Code runs a statusline command on every render and draws its stdout under the composer.
 * Codeman wraps that command (the exporter script, hooks-config.ts). When the user has a
 * statusline of their own, the exporter prints that command's output unchanged and posts a
 * base64 copy of it (`rendered`) to `/api/status-telemetry`. This module turns that copy into
 * text safe to store, broadcast and draw.
 *
 * What survives: printable text, line breaks, and SGR colour sequences (`ESC [ … m`), which the
 * browser maps to the skin's own colours. Every other escape sequence (cursor moves, OSC
 * hyperlinks and titles) and every other control character goes. The result is capped at
 * {@link STATUSLINE_MAX_LINES} lines of {@link STATUSLINE_MAX_LINE_CHARS} characters.
 *
 * Pure: no IO, so the test exercises the shipped code. The text is still the user's command's
 * output, and the browser sets it with `textContent` only.
 */

import { ANSI_ESCAPE_PATTERN_FULL } from './utils/regex-patterns.js';

export const STATUSLINE_MAX_LINES = 4;
/** Per line, counting the SGR sequences too, so a line cannot carry unbounded escapes. */
export const STATUSLINE_MAX_LINE_CHARS = 600;
/** The decoded copy is cut here before anything else, whatever it holds. */
const STATUSLINE_MAX_DECODED_CHARS = 4096;

// eslint-disable-next-line no-control-regex
const SGR = /^\x1b\[[0-9;]*m$/;
// eslint-disable-next-line no-control-regex
const ALL_SGR = /\x1b\[[0-9;]*m/g;
// eslint-disable-next-line no-control-regex
const LONE_ESC = /\x1b(?!\[[0-9;]*m)/g;
// eslint-disable-next-line no-control-regex
const OTHER_CONTROLS = /[\u0000-\u0009\u000b-\u001a\u001c-\u001f\u007f]/g;

/** Keep text, line breaks and colour; drop every other escape and control character. */
export function sanitizeStatusLineText(raw: string): string {
  const text = String(raw ?? '')
    .slice(0, STATUSLINE_MAX_DECODED_CHARS)
    .replace(/\r\n?/g, '\n')
    .replace(new RegExp(ANSI_ESCAPE_PATTERN_FULL.source, 'g'), (seq) => (SGR.test(seq) ? seq : ''))
    .replace(LONE_ESC, '')
    .replace(OTHER_CONTROLS, '');
  const lines = text.split('\n').map((line) => line.trimEnd().slice(0, STATUSLINE_MAX_LINE_CHARS));
  while (lines.length > 0 && lines[lines.length - 1].replace(ALL_SGR, '').trim() === '') lines.pop();
  return lines.slice(0, STATUSLINE_MAX_LINES).join('\n');
}

/** The exporter's base64 copy of the user's statusline, decoded and sanitized; '' when unusable. */
export function decodeRenderedStatusLine(rendered: string): string {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(rendered)) return '';
  return sanitizeStatusLineText(Buffer.from(rendered, 'base64').toString('utf8'));
}
