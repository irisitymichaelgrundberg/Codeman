/**
 * @fileoverview Reads Claude Code's suggested next prompt off the pane, for the chat view.
 *
 * When a turn ends, Claude Code may draw a predicted next prompt, faint, in its empty composer.
 * It writes that prediction nowhere else in an interactive session (the transcript never holds
 * it), so the screen is the only source. The model generates it after the turn, so it appears
 * a few seconds after the session goes idle, or never (the user switched suggestions off, or
 * Claude Code backed off after a run of unused ones).
 *
 * So each idle transition starts a short schedule of styled captures
 * ({@link PROMPT_SUGGESTION_READ_DELAYS_MS}): three reads, at about 1.5 s, 4 s and 10 s after the
 * turn ends. The schedule ends at the first of these:
 * - A suggestion is on screen. It is published, and the schedule stops.
 * - Something is typed in the composer. The suggestion is cleared, since none is on screen.
 * - The session is no longer idle, or the pane cannot be read.
 * - No browser is connected to the server, so nobody would see a suggestion.
 * - The schedule runs out.
 *
 * Each capture is synchronous and blocks the server's event loop while tmux answers, which is
 * why the schedule is short and why it stops when no browser is connected. Moving every screen
 * read (this reader, the submit verifier, the idle probe and keep-warm) to an async capture is a
 * follow-up.
 *
 * Claude Code also draws a launch placeholder, faint, in a new session's empty composer:
 * `Try "<example>"`, picked from a fixed list of examples such as `fix lint errors` (measured on
 * 2.1.331). It is a hint, not a prediction, so {@link isLaunchPlaceholder} keeps it out: the
 * reader treats it as an empty composer and goes on with its schedule.
 *
 * A turn starting clears the suggestion at once (`onWorking`): the CLI drops it as soon as a
 * prompt goes in. Every decision lives here, and the server lends the IO (`read`, `publish`),
 * so the test drives the shipped code with fake timers.
 */

import type { CliEntry } from '../config/cli-registry/types.js';
import { composerIsEmpty, composerSuggestion } from '../session-submit-verifier.js';

/**
 * Waits between reads after a turn ends: reads at about 1.5 s, 4 s and 10 s, so a suggestion
 * the model writes later than that is missed.
 */
export const PROMPT_SUGGESTION_READ_DELAYS_MS: readonly number[] = [1500, 2500, 6000];

export interface PromptSuggestionReaderDeps {
  /**
   * The pane as a styled frame (`capture-pane -p -e`) and the CLI's composer glyph, or null
   * when this session is not one to read (wrong CLI, no pane), no browser is connected, or the
   * capture failed. A null ends the schedule.
   */
  read(sessionId: string): { screen: string; glyph: string } | null;
  /** Whether the session is still idle; a read for a session that is not is dropped. */
  isIdle(sessionId: string): boolean;
  /** Store the suggestion ('' for none) and tell the pages when it changed. */
  publish(sessionId: string, text: string): void;
  delaysMs?: readonly number[];
}

/** The parts of a session that decide whether its pane is read. */
export interface PromptSuggestionSession {
  readonly remote?: unknown;
  readonly isAdopted: boolean;
  readonly muxName: string | null;
}

/**
 * The server's `read` dependency. Only sessions the chat view can show are read: a CLI that
 * writes a Claude-format transcript and names a composer glyph, a local pane, not adopted. The
 * pane is read only while at least one browser holds an SSE connection (`sseClients`), since
 * each capture blocks the event loop. The capture is styled, because the suggestion is told
 * from a draft by its faint text.
 */
export function readPromptSuggestionFrame(
  session: PromptSuggestionSession | undefined,
  cli: CliEntry | undefined,
  capture: (muxName: string, opts: { styles: boolean }) => string | null,
  sseClients: number
): { screen: string; glyph: string } | null {
  if (sseClients <= 0) return null;
  const glyph = cli?.capabilities.workDetect?.promptGlyph;
  if (!session || cli?.capabilities.transcript !== 'claude-jsonl' || !glyph) return null;
  if (session.remote || session.isAdopted || !session.muxName) return null;
  const screen = capture(session.muxName, { styles: true });
  return screen ? { screen, glyph } : null;
}

/** Claude Code's launch placeholder (`Try "fix lint errors"`), which is not a suggested prompt. */
const LAUNCH_PLACEHOLDER = /^Try "[^"]*"$/;

export function isLaunchPlaceholder(text: string): boolean {
  return LAUNCH_PLACEHOLDER.test(text);
}

export class PromptSuggestionReader {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: PromptSuggestionReaderDeps) {}

  /** A turn ended: look for the suggestion again from the start of the schedule. */
  onIdle(sessionId: string): void {
    this.cancel(sessionId);
    this.schedule(sessionId, 0);
  }

  /** A turn started: the CLI has dropped its suggestion, so drop ours. */
  onWorking(sessionId: string): void {
    this.cancel(sessionId);
    this.deps.publish(sessionId, '');
  }

  /** The session is gone. */
  forget(sessionId: string): void {
    this.cancel(sessionId);
  }

  /** Server shutdown. */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private cancel(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  private schedule(sessionId: string, step: number): void {
    const delays = this.deps.delaysMs ?? PROMPT_SUGGESTION_READ_DELAYS_MS;
    if (step >= delays.length) return;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.check(sessionId, step);
    }, delays[step]);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  private check(sessionId: string, step: number): void {
    if (!this.deps.isIdle(sessionId)) return;
    const frame = this.deps.read(sessionId);
    if (!frame) return;
    const suggestion = composerSuggestion(frame.screen, frame.glyph);
    if (suggestion && !isLaunchPlaceholder(suggestion)) {
      this.deps.publish(sessionId, suggestion);
      return;
    }
    if (composerIsEmpty(frame.screen, frame.glyph) === false) {
      this.deps.publish(sessionId, '');
      return;
    }
    this.schedule(sessionId, step + 1);
  }
}
