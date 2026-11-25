/**
 * @fileoverview One short line saying what a tool call works on, for the chat view's status line.
 *
 * The transcript watcher reports each `tool_use` block it reads (`transcript:tool_start`). The
 * name alone ("Read", "Bash") says little; the CLI shows the file, the command or the pattern
 * beside it. This module picks that one value out of the call's input and makes it safe to
 * broadcast and show: control characters and line breaks become spaces, runs of whitespace
 * collapse, and the result is capped at {@link TOOL_DETAIL_MAX_CHARS}.
 *
 * Pure: no IO, so the test exercises the shipped code. The value is still untrusted text (the
 * agent wrote it), and the browser sets it with `textContent` only.
 */

import { oneLineText } from './utils/index.js';

/** Longest detail sent, in UTF-16 code units, before the ellipsis. */
export const TOOL_DETAIL_MAX_CHARS = 160;

/** Which input field names the thing a tool works on, by tool name. First present field wins. */
const DETAIL_FIELDS: Record<string, readonly string[]> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  NotebookRead: ['notebook_path'],
  // The description is the CLI's headline for a command, with the command under it
  // (toolCallCommand); a call without a description shows the command.
  Bash: ['description', 'command'],
  Glob: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Task: ['description'],
  Agent: ['description'],
  Skill: ['skill', 'command'],
};

/** Fields tried, in order, for a tool this module has no entry for (MCP tools, newer tools). */
const FALLBACK_FIELDS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description'] as const;

/** Control characters and line breaks have no place in a one-line status. */
function clean(value: string): string {
  return oneLineText(value, TOOL_DETAIL_MAX_CHARS);
}

function field(input: Record<string, unknown>, name: string): string | undefined {
  const value = input[name];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * The command of a Bash call that also has a description, for the second line the CLI shows
 * under the description; undefined otherwise (the command is then the detail itself).
 */
export function toolCallCommand(name: string, input: unknown): string | undefined {
  if (name !== 'Bash' || !input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const command = field(record, 'command');
  return command && field(record, 'description') ? clean(command) : undefined;
}

/**
 * The one line that says what `name` called with `input` works on, or undefined when the input
 * names nothing worth showing.
 */
export function summarizeToolCall(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  if (name === 'Grep') {
    const pattern = field(record, 'pattern');
    if (!pattern) return undefined;
    const where = field(record, 'path') ?? field(record, 'glob');
    return clean(where ? `${pattern} in ${where}` : pattern);
  }
  for (const key of DETAIL_FIELDS[name] ?? FALLBACK_FIELDS) {
    const value = field(record, key);
    if (value) return clean(value);
  }
  return undefined;
}

/** The `transcript:tool_start` broadcast's payload, `detail` and `command` only when present. */
export interface ToolStartPayload {
  sessionId: string;
  toolName: string;
  detail?: string;
  command?: string;
  timestamp: number;
}

/**
 * The payload broadcast when the transcript watcher reports a tool call. `detail` names what the
 * call works on (the file, the command), for the chat view's status line. A Bash call with a
 * description also carries its `command`, which the chat view shows under it as the CLI does.
 */
export function toolStartPayload(sessionId: string, toolName: string, input: unknown, now: number): ToolStartPayload {
  const detail = summarizeToolCall(toolName, input);
  const command = toolCallCommand(toolName, input);
  return {
    sessionId,
    toolName,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    timestamp: now,
  };
}
