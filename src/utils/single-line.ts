/**
 * @fileoverview Collapse text onto one line: a prompt an unattended sender writes
 * ({@link toSingleLine}), or untrusted text a status or menu shows as one line ({@link oneLineText}).
 *
 * @module utils/single-line
 */

/**
 * A prompt as one line: each line is trimmed, blank lines are dropped, and the rest
 * are joined with a single space; a prompt without a line break is returned as is.
 *
 * For the senders that run unattended through `writeViaMux` (respawn's update and
 * kickstart steps, auto-compact). The mux pastes a multi-line prompt as one block,
 * and the check that re-presses a stranded Enter cannot reliably recognise a
 * multi-line paste in the composer, so nobody would notice a prompt left unsubmitted.
 * Cron rejects multi-line prompts for the same reason; these senders join them
 * instead, so a saved multi-line setting is still sent rather than refused.
 *
 * Split and trim, which is linear, rather than one regex replace that folds the
 * whitespace around each break: that regex backtracks quadratically over a long
 * whitespace run (50,000 spaces took over a second).
 */
export function toSingleLine(prompt: string): string {
  if (!/[\r\n]/.test(prompt)) return prompt;
  return prompt
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
}

/** Control characters, line breaks included. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

/**
 * Untrusted text as one short line: C0 control characters and DEL become spaces, runs of
 * whitespace collapse to one space, the ends are trimmed, and the result is cut at `max`
 * UTF-16 code units. A cut line ends in `…` unless `ellipsis` is false.
 */
export function oneLineText(value: string, max: number, ellipsis = true): string {
  const flat = value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return ellipsis ? `${flat.slice(0, max)}…` : flat.slice(0, max);
}
