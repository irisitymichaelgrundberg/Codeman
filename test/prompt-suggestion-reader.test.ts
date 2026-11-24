/**
 * @fileoverview Claude Code's suggested next prompt, read off the pane for the chat view.
 *
 * Pinned:
 * - `composerSuggestion()` returns only the faint text of an otherwise empty composer, with the
 *   first letter in the reverse-video cursor cell joined back on, and a wrapped suggestion read
 *   as one line. A typed draft, an empty composer and faint text outside the composer (the
 *   statusline under it) give null. The frames copy the layout of a real Claude Code 2.1.331
 *   pane: the glyph is followed by a no-break space, and the rules are coloured.
 * - The reader looks after each turn ends, stops at the first suggestion, clears on a typed
 *   draft or when a turn starts, and never reads a session that is no longer idle.
 *
 * Port: N/A
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composerIsEmpty, composerSuggestion } from '../src/session-submit-verifier.js';
import { PromptSuggestionReader } from '../src/web/prompt-suggestion-reader.js';

const GLYPH = '❯';
const rule = `\x1b[38;5;244m${'─'.repeat(40)}`;
const statusline = '\x1b[39m  \x1b[36m/home/u/project\x1b[38;5;246m \x1b[2m[\x1b[0mmain\x1b[2m]\x1b[0m';
const frame = (...composer: string[]) =>
  ['● The answer.', '', '✻ Brewed for 6s', rule, ...composer, rule, statusline].join('\n');

describe('composerSuggestion', () => {
  it('reads the faint text of an empty composer', () => {
    const screen = frame('\x1b[39m❯ \x1b[2mhow is the tag build going?\x1b[0m\x1b[39m\x1b[49m');
    expect(composerIsEmpty(screen, GLYPH)).toBe(true);
    expect(composerSuggestion(screen, GLYPH)).toBe('how is the tag build going?');
  });

  it('joins the cursor cell back on, and reads a wrapped suggestion as one line', () => {
    const screen = frame(
      '❯ \x1b[7mr\x1b[27m\x1b[2mun the tests again and tell me\x1b[0m',
      '  \x1b[2mwhich ones still fail\x1b[0m'
    );
    expect(composerSuggestion(screen, GLYPH)).toBe('run the tests again and tell me which ones still fail');
  });

  it('gives null for a typed draft, an empty composer, or no composer at all', () => {
    expect(composerSuggestion(frame('❯ fix the build'), GLYPH)).toBeNull();
    expect(composerSuggestion(frame('❯ \x1b[7mf\x1b[27mix'), GLYPH)).toBeNull();
    // Only the statusline below the composer is faint here.
    expect(composerSuggestion(frame('❯ '), GLYPH)).toBeNull();
    expect(composerSuggestion('$ ls\nfile.txt', GLYPH)).toBeNull();
  });

  it('removes control characters and caps the length', () => {
    const screen = frame(`❯ \x1b[2m${'x'.repeat(900)}\x07\x1b[0m`);
    expect(composerSuggestion(screen, GLYPH)).toHaveLength(500);
  });
});

describe('PromptSuggestionReader', () => {
  let screen: string | null;
  let idle: boolean;
  let published: string[];
  let reads: number;
  let reader: PromptSuggestionReader;

  beforeEach(() => {
    vi.useFakeTimers();
    screen = null;
    idle = true;
    published = [];
    reads = 0;
    reader = new PromptSuggestionReader({
      read: () => {
        reads++;
        return screen === null ? null : { screen, glyph: GLYPH };
      },
      isIdle: () => idle,
      publish: (_id, text) => published.push(text),
      delaysMs: [100, 100, 100],
    });
  });

  afterEach(() => {
    reader.stop();
    vi.useRealTimers();
  });

  it('keeps looking until the suggestion appears, then publishes it once', () => {
    screen = frame('❯ ');
    reader.onIdle('s1');
    vi.advanceTimersByTime(100);
    expect(published).toEqual([]);
    screen = frame('❯ \x1b[2mcommit it\x1b[0m');
    vi.advanceTimersByTime(100);
    expect(published).toEqual(['commit it']);
    vi.advanceTimersByTime(1000);
    expect(reads).toBe(2);
  });

  it('clears when something is typed, and when a turn starts', () => {
    screen = frame('❯ half a thought');
    reader.onIdle('s1');
    vi.advanceTimersByTime(100);
    expect(published).toEqual(['']);
    reader.onWorking('s1');
    expect(published).toEqual(['', '']);
  });

  it('reads nothing for a session that is busy again, and stops after the schedule', () => {
    screen = frame('❯ ');
    reader.onIdle('s1');
    idle = false;
    vi.advanceTimersByTime(1000);
    expect(reads).toBe(0);

    idle = true;
    reader.onIdle('s1');
    vi.advanceTimersByTime(1000);
    expect(reads).toBe(3);
    expect(published).toEqual([]);
  });

  it('a turn starting cancels the reads still scheduled', () => {
    screen = frame('❯ \x1b[2mlater\x1b[0m');
    reader.onIdle('s1');
    reader.onWorking('s1');
    vi.advanceTimersByTime(1000);
    expect(reads).toBe(0);
    expect(published).toEqual(['']);
  });
});
