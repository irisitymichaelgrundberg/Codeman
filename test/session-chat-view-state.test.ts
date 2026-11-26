/**
 * @fileoverview The chat view's runtime fields on a Session's published state.
 *
 * Pinned: `toState()` carries the statusline text and the prompt suggestion once their setters
 * stored them, and leaves both out while they are empty. The statusline text is left out too
 * while the current launch carries no exporter. A restarted session starts from the
 * previous run's statusline text, sanitized again. `toState()` is the only way the prompt
 * suggestion reaches the page (the debounced `session:updated` broadcast). Every submit clears a
 * stored suggestion and emits `promptSuggestionChanged` once, so a command that starts no turn
 * (`/clear`) still drops it; a submit with no suggestion stored emits nothing.
 *
 * Port: N/A
 */

import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';

describe('Session chat view state', () => {
  it('publishes the statusline and the prompt suggestion through toState()', () => {
    const session = new Session({ id: 'chat-view-state', workingDir: '/tmp', mode: 'claude' });
    expect(session.toState().statusLine).toBeUndefined();
    expect(session.toState().promptSuggestion).toBeUndefined();

    expect(session.setStatusLine('main · 42% context')).toBe(true);
    expect(session.setStatusLine('main · 42% context')).toBe(false);
    expect(session.setPromptSuggestion('run the tests again')).toBe(true);
    const state = session.toState();
    expect(state.statusLine).toBe('main · 42% context');
    expect(state.promptSuggestion).toBe('run the tests again');

    // Setting the same text again reports no change, and clearing it drops the field.
    expect(session.setPromptSuggestion('run the tests again')).toBe(false);
    session.setPromptSuggestion('');
    expect(session.toState().promptSuggestion).toBeUndefined();
  });

  it('clears the suggestion on every submit, and says so once', () => {
    const session = new Session({ id: 'chat-view-submit', workingDir: '/tmp', mode: 'claude' });
    const changed = vi.fn();
    session.on('promptSuggestionChanged', changed);

    // A write without a suggestion stored emits nothing.
    session.write('/help\r');
    expect(changed).not.toHaveBeenCalled();

    session.setPromptSuggestion('run the tests again');
    // Typing without an Enter is not a submit.
    session.write('/cl');
    expect(session.promptSuggestion).toBe('run the tests again');
    session.write('ear\r');
    expect(session.promptSuggestion).toBe('');
    expect(session.toState().promptSuggestion).toBeUndefined();
    expect(changed).toHaveBeenCalledTimes(1);

    // A submit the CLI's own hook reports clears it too.
    session.setPromptSuggestion('commit it');
    session.markPromptSubmitted('hello');
    expect(session.promptSuggestion).toBe('');
    expect(changed).toHaveBeenCalledTimes(2);
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

  it('publishes the statusline only while the current launch carries the exporter', () => {
    const muxSession = (statusLine: string) =>
      ({ muxName: 'codeman-test', sessionId: 'test', createdAt: 1, pid: 1, statusLine }) as unknown as NonNullable<
        ConstructorParameters<typeof Session>[0]['muxSession']
      >;
    // A launch without the exporter never reports again, so its last text would go stale.
    const off = new Session({
      id: 'chat-view-off',
      workingDir: '/tmp',
      mode: 'claude',
      muxSession: muxSession('collection-off'),
    });
    off.setStatusLine('main · 42%');
    expect(off.toState().statusLine).toBeUndefined();

    const on = new Session({
      id: 'chat-view-on',
      workingDir: '/tmp',
      mode: 'claude',
      muxSession: muxSession('injected'),
    });
    on.setStatusLine('main · 42%');
    expect(on.toState().statusLine).toBe('main · 42%');
  });
});
