/**
 * @fileoverview The chat view's runtime field on a Session's published state.
 *
 * Pinned: `toState()` carries the prompt suggestion once its setter stored it, and leaves it out
 * while it is empty. `toState()` is the only way the prompt suggestion reaches the page (the
 * debounced `session:updated` broadcast). Every submit clears a stored suggestion and emits
 * `promptSuggestionChanged` once, so a command that starts no turn (`/clear`) still drops it; a
 * submit with no suggestion stored emits nothing.
 *
 * Port: N/A
 */

import { describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';

describe('Session chat view state', () => {
  it('publishes the prompt suggestion through toState()', () => {
    const session = new Session({ id: 'chat-view-state', workingDir: '/tmp', mode: 'claude' });
    expect(session.toState().promptSuggestion).toBeUndefined();

    expect(session.setPromptSuggestion('run the tests again')).toBe(true);
    expect(session.toState().promptSuggestion).toBe('run the tests again');

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
});
