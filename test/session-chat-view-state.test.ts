/**
 * @fileoverview The chat view's runtime fields on a Session's published state.
 *
 * Pinned: `toState()` carries the statusline text and the prompt suggestion once their setters
 * stored them, and leaves both out while they are empty. A restarted session starts from the
 * previous run's statusline text, sanitized again. `toState()` is the only way the prompt
 * suggestion reaches the page (the debounced `session:updated` broadcast). `compacting` is
 * published while set, and the session going idle clears it, because a compaction cancelled
 * with Esc sends no PostCompact hook.
 *
 * Port: N/A
 */

import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';

describe('Session chat view state', () => {
  it('publishes the statusline and the prompt suggestion through toState()', () => {
    const session = new Session({ id: 'chat-view-state', workingDir: '/tmp', mode: 'claude' });
    expect(session.toState().statusLine).toBeUndefined();
    expect(session.toState().promptSuggestion).toBeUndefined();

    expect(session.setStatusLine('main · 42% context')).toBe(true);
    expect(session.setPromptSuggestion('run the tests again')).toBe(true);
    const state = session.toState();
    expect(state.statusLine).toBe('main · 42% context');
    expect(state.promptSuggestion).toBe('run the tests again');

    // Setting the same text again reports no change, and clearing it drops the field.
    expect(session.setPromptSuggestion('run the tests again')).toBe(false);
    session.setPromptSuggestion('');
    expect(session.toState().promptSuggestion).toBeUndefined();
  });

  it("restores the previous run's statusline text, sanitized again", () => {
    // An idle claude session runs its statusline command again only on its next turn, so the
    // restored text is what the chat view shows until then. state.json can be edited by hand,
    // so a cursor move or a title-setting escape in it is stripped while colour stays.
    const saved = '\x1b[32mmain\x1b[0m · 42%\x1b[2J\x1b]0;title\x07';
    const session = new Session({ id: 'chat-view-restore', workingDir: '/tmp', mode: 'claude', statusLine: saved });
    expect(session.statusLine).toBe('\x1b[32mmain\x1b[0m · 42%');
    expect(session.toState().statusLine).toBe('\x1b[32mmain\x1b[0m · 42%');
    // The next report replaces it.
    expect(session.setStatusLine('dev · 3%')).toBe(true);
    expect(session.toState().statusLine).toBe('dev · 3%');
    // Nothing saved leaves it empty.
    expect(new Session({ id: 'chat-view-none', workingDir: '/tmp', mode: 'claude' }).statusLine).toBe('');
  });

  it('publishes a running compaction, and drops it when the session goes idle', () => {
    const session = new Session({ id: 'chat-view-compacting', workingDir: '/tmp', mode: 'claude' });
    expect(session.toState().compacting).toBeUndefined();
    expect(session.setCompacting(true)).toBe(true);
    expect(session.setCompacting(true)).toBe(false);
    expect(session.toState().compacting).toBe(true);

    (session as unknown as { _concludeIdle: (turnEnded: boolean) => void })._concludeIdle(true);
    expect(session.compacting).toBe(false);
    expect(session.toState().compacting).toBeUndefined();
  });
});
