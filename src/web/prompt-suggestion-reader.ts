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
 * ({@link PROMPT_SUGGESTION_READ_DELAYS_MS}) that ends at the first of these:
 * - A suggestion is on screen. It is published, and the schedule stops.
 * - Something is typed in the composer. The suggestion is cleared, since none is on screen.
 * - The session is no longer idle, or the pane cannot be read.
 * - The schedule runs out.
 *
 * A turn starting clears the suggestion at once (`onWorking`): the CLI drops it as soon as a
 * prompt goes in. Every decision lives here, and the server lends the IO (`read`, `publish`),
 * so the test drives the shipped code with fake timers.
 */

import { composerIsEmpty, composerSuggestion } from '../session-submit-verifier.js';

/** Waits between reads after a turn ends, about 40 s in all. */
export const PROMPT_SUGGESTION_READ_DELAYS_MS: readonly number[] = [1500, 2500, 4000, 8000, 12000, 12000];

export interface PromptSuggestionReaderDeps {
  /**
   * The pane as a styled frame (`capture-pane -p -e`) and the CLI's composer glyph, or null
   * when this session is not one to read (wrong CLI, no pane) or the capture failed.
   */
  read(sessionId: string): { screen: string; glyph: string } | null;
  /** Whether the session is still idle; a read for a session that is not is dropped. */
  isIdle(sessionId: string): boolean;
  /** Store the suggestion ('' for none) and tell the pages when it changed. */
  publish(sessionId: string, text: string): void;
  delaysMs?: readonly number[];
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
    if (suggestion) {
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
