/**
 * @fileoverview How server.ts wires the chat view's server-side pieces.
 *
 * Pinned:
 * - The session listener deps hand a turn's end and start to the prompt-suggestion reader
 *   (`promptSuggestionIdle` reaches `onIdle`, `promptSuggestionWorking` reaches `onWorking`).
 * - `publishPromptSuggestion()` stores the suggestion and broadcasts the session state only
 *   when the stored text changed.
 * - `broadcastToolStart()` sends `transcript:tool_start` with the call's `detail` and, for a
 *   described Bash call, its `command`.
 * - The transcript watcher's `transcript:tool_start` listener passes the call's input on to
 *   `broadcastToolStart()` (a source scan of server.ts).
 *
 * Uses a bare `WebServer.prototype` object with just the fields these paths touch, like
 * agent-inbox-server-wiring.test.ts.
 *
 * Port: N/A
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { SseEvent } from '../src/web/sse-events.js';

type WiringServer = {
  buildSessionListenerDeps(): {
    promptSuggestionIdle(id: string): void;
    promptSuggestionWorking(id: string): void;
  };
  publishPromptSuggestion(id: string, text: string): void;
  broadcastToolStart(sessionId: string, toolName: string, input: unknown): void;
  [key: string]: unknown;
};

function bareServer(fields: Record<string, unknown>): WiringServer {
  const server = Object.create(WebServer.prototype) as WiringServer;
  Object.assign(server, fields);
  return server;
}

describe('prompt suggestion server wiring', () => {
  it("hands a turn's end and start to the prompt-suggestion reader", () => {
    const onIdle = vi.fn();
    const onWorking = vi.fn();
    const server = bareServer({ promptSuggestionReader: { onIdle, onWorking } });

    const deps = server.buildSessionListenerDeps();
    deps.promptSuggestionIdle('s1');
    deps.promptSuggestionWorking('s1');

    expect(onIdle).toHaveBeenCalledWith('s1');
    expect(onWorking).toHaveBeenCalledWith('s1');
  });

  it('broadcasts the session state only when the stored suggestion changed', () => {
    const setPromptSuggestion = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const broadcastSessionStateDebounced = vi.fn();
    const server = bareServer({
      sessions: new Map([['s1', { setPromptSuggestion }]]),
      sse: { broadcastSessionStateDebounced },
    });

    server.publishPromptSuggestion('s1', 'commit it');
    server.publishPromptSuggestion('s1', 'commit it');

    expect(setPromptSuggestion).toHaveBeenCalledTimes(2);
    expect(setPromptSuggestion).toHaveBeenCalledWith('commit it');
    expect(broadcastSessionStateDebounced).toHaveBeenCalledTimes(1);
    expect(broadcastSessionStateDebounced).toHaveBeenCalledWith('s1');
  });

  it('sends transcript:tool_start with the detail and command of a described Bash call', () => {
    const broadcast = vi.fn();
    const server = bareServer({ broadcast });

    server.broadcastToolStart('s1', 'Bash', { command: 'npm test', description: 'Run tests' });

    expect(broadcast).toHaveBeenCalledTimes(1);
    const [event, payload] = broadcast.mock.calls[0];
    expect(event).toBe(SseEvent.TranscriptToolStart);
    expect(payload).toMatchObject({ sessionId: 's1', toolName: 'Bash', detail: 'Run tests', command: 'npm test' });
  });

  it("passes the watcher's tool input on to broadcastToolStart", () => {
    const server = readFileSync(resolve(import.meta.dirname, '../src/web/server.ts'), 'utf8');
    const start = server.indexOf("watcher.on('transcript:tool_start', (toolName: string, input?: unknown) => {");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = server.slice(start, server.indexOf('});', start));
    expect(block).toContain('this.broadcastToolStart(sessionId, toolName, input);');
  });
});
