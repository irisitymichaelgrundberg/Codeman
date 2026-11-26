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
 * - The shipped schedule is three reads, at about 1.5 s, 4 s and 10 s after the turn ends.
 * - While no browser holds an SSE connection, a read that falls due is skipped and the schedule
 *   goes on, so a browser that connects later still gets the later reads. The server's
 *   `hasViewers` dependency is its count of SSE clients.
 * - The server's capture dependency passes the read's options on to `capturePaneText`, and its
 *   `publish` dependency calls `publishPromptSuggestion`.
 *
 * Port: N/A
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composerIsEmpty, composerSuggestion } from '../src/session-submit-verifier.js';
import {
  isLaunchPlaceholder,
  PROMPT_SUGGESTION_READ_DELAYS_MS,
  PromptSuggestionReader,
  readPromptSuggestionFrame,
} from '../src/web/prompt-suggestion-reader.js';
import { getCli } from '../src/config/cli-registry/registry.js';

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

  it('gives null for a typed draft followed by faint text', () => {
    // A command typed with its faint argument hint after it: the composer is not empty, so the
    // faint text is not a suggestion.
    const screen = frame('❯ /review \x1b[2m[pr-number]\x1b[0m');
    expect(composerIsEmpty(screen, GLYPH)).toBe(false);
    expect(composerSuggestion(screen, GLYPH)).toBeNull();
  });

  it('gives null for a typed draft, an empty composer, or no composer at all', () => {
    expect(composerSuggestion(frame('❯ fix the build'), GLYPH)).toBeNull();
    expect(composerSuggestion(frame('❯ \x1b[7mf\x1b[27mix'), GLYPH)).toBeNull();
    // Only the statusline below the composer is faint here.
    expect(composerSuggestion(frame('❯ '), GLYPH)).toBeNull();
    expect(composerSuggestion('$ ls\nfile.txt', GLYPH)).toBeNull();
  });

  it('removes control characters and caps the length', () => {
    const screen = frame(`❯ \x1b[2mabc\x07def${'x'.repeat(900)}\x1b[0m`);
    const text = composerSuggestion(screen, GLYPH);
    expect(text).toHaveLength(500);
    expect(text).not.toContain('\x07');
    expect(text?.startsWith('abc def')).toBe(true);
  });
});

describe('PromptSuggestionReader', () => {
  let screen: string | null;
  let idle: boolean;
  let viewers: boolean;
  let published: string[];
  let reads: number;
  let reader: PromptSuggestionReader;

  beforeEach(() => {
    vi.useFakeTimers();
    screen = null;
    idle = true;
    viewers = true;
    published = [];
    reads = 0;
    reader = new PromptSuggestionReader({
      read: () => {
        reads++;
        return screen === null ? null : { screen, glyph: GLYPH };
      },
      isIdle: () => idle,
      hasViewers: () => viewers,
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

  it("never publishes Claude Code's launch placeholder, and keeps looking past it", () => {
    // The shape the CLI draws in a new session's empty composer (2.1.331), faint like a suggestion.
    screen = frame('❯\u00a0\x1b[2mTry "edit <filepath> to…"\x1b[0m');
    reader.onIdle('s1');
    vi.advanceTimersByTime(100);
    expect(published).toEqual([]);
    screen = frame('❯\u00a0\x1b[2mtry the build again\x1b[0m');
    vi.advanceTimersByTime(100);
    expect(published).toEqual(['try the build again']);
    expect(isLaunchPlaceholder('Try "fix lint errors"')).toBe(true);
    expect(isLaunchPlaceholder('Try the build again')).toBe(false);
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

  it('ships a schedule of three reads, at about 1.5 s, 4 s and 10 s', () => {
    expect(PROMPT_SUGGESTION_READ_DELAYS_MS).toEqual([1500, 2500, 6000]);
    const times: number[] = [];
    const start = Date.now();
    const shipped = new PromptSuggestionReader({
      read: () => {
        times.push(Date.now() - start);
        return { screen: frame('❯ '), glyph: GLYPH };
      },
      isIdle: () => true,
      hasViewers: () => true,
      publish: () => {},
    });
    shipped.onIdle('s1');
    vi.advanceTimersByTime(60_000);
    shipped.stop();
    expect(times).toEqual([1500, 4000, 10000]);
  });

  it('skips a read while no browser is connected, and goes on with the schedule', () => {
    screen = frame('❯ \x1b[2mcommit it\x1b[0m');
    viewers = false;
    reader.onIdle('s1');
    vi.advanceTimersByTime(100);
    expect(reads).toBe(0);
    expect(published).toEqual([]);

    // A browser connects before the second read.
    viewers = true;
    vi.advanceTimersByTime(100);
    expect(reads).toBe(1);
    expect(published).toEqual(['commit it']);
  });

  it('reads nothing at all while no browser is connected', () => {
    screen = frame('❯ \x1b[2mcommit it\x1b[0m');
    viewers = false;
    reader.onIdle('s1');
    vi.advanceTimersByTime(1000);
    expect(reads).toBe(0);
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

describe('readPromptSuggestionFrame', () => {
  const claude = getCli('claude');
  const local = { remote: undefined, isAdopted: false, muxName: 'codeman-abc' };

  function captureSpy(result: string | null = 'frame') {
    const calls: Array<{ muxName: string; opts: { styles: boolean } }> = [];
    const capture = (muxName: string, opts: { styles: boolean }) => {
      calls.push({ muxName, opts });
      return result;
    };
    return { calls, capture };
  }

  it('reads a local Claude pane with a styled capture', () => {
    const { calls, capture } = captureSpy();
    const glyph = claude?.capabilities.workDetect?.promptGlyph;
    expect(glyph).toBeTruthy();
    expect(readPromptSuggestionFrame(local, claude, capture)).toEqual({ screen: 'frame', glyph });
    expect(calls).toEqual([{ muxName: 'codeman-abc', opts: { styles: true } }]);
  });

  it.each([
    ['no session', undefined, claude],
    ['no CLI entry', local, undefined],
    ['a CLI without a Claude-format transcript', local, getCli('codex')],
    ['a remote session', { ...local, remote: { hostId: 'h1' } }, claude],
    ['an adopted session', { ...local, isAdopted: true }, claude],
    ['a session without a pane', { ...local, muxName: null }, claude],
  ] as const)('reads nothing for %s', (_label, session, cli) => {
    const { calls, capture } = captureSpy();
    expect(readPromptSuggestionFrame(session, cli, capture)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('reads nothing for a CLI that names no composer glyph', () => {
    const { calls, capture } = captureSpy();
    const noGlyph = claude && {
      ...claude,
      capabilities: {
        ...claude.capabilities,
        workDetect: { ...claude.capabilities.workDetect, promptGlyph: undefined },
      },
    };
    expect(readPromptSuggestionFrame(local, noGlyph as typeof claude, capture)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('gives null when the capture fails', () => {
    const { capture } = captureSpy(null);
    expect(readPromptSuggestionFrame(local, claude, capture)).toBeNull();
  });

  it("pins the server's reader dependencies", () => {
    const server = readFileSync(resolve(import.meta.dirname, '../src/web/server.ts'), 'utf8');
    const start = server.indexOf('new PromptSuggestionReader({');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = server.slice(start, server.indexOf('});', start));
    expect(block).toContain('readPromptSuggestionFrame(');
    // Without `opts` the capture is a plain frame, in which no suggestion is ever faint.
    expect(block).toContain('(muxName, opts) => this.mux.capturePaneText?.(muxName, undefined, opts)');
    expect(block).toContain('hasViewers: () => this.sse.clientCount > 0');
    expect(block).toContain('publish: (id, text) => this.publishPromptSuggestion(id, text)');
  });
});
