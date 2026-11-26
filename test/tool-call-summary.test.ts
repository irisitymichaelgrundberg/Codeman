/**
 * @fileoverview What the chat view's status line says a tool call works on
 * (src/tool-call-summary.ts): the field the CLI itself shows, flattened to one safe line.
 *
 * Port: none.
 */
import { describe, expect, it } from 'vitest';
import {
  summarizeToolCall,
  toolCallCommand,
  toolStartPayload,
  TOOL_DETAIL_MAX_CHARS,
} from '../src/tool-call-summary.js';

describe('summarizeToolCall', () => {
  it('names the file, the command, the pattern or the page', () => {
    expect(summarizeToolCall('Read', { file_path: '/w/a.ts', limit: 20 })).toBe('/w/a.ts');
    expect(summarizeToolCall('Edit', { file_path: '/w/a.ts', old_string: 'x', new_string: 'y' })).toBe('/w/a.ts');
    // The CLI's headline for a command is its description; the command goes on the line under it.
    expect(summarizeToolCall('Bash', { command: 'npm test', description: 'Run the tests' })).toBe('Run the tests');
    expect(toolCallCommand('Bash', { command: 'npm test', description: 'Run the tests' })).toBe('npm test');
    expect(summarizeToolCall('Bash', { command: 'npm test' })).toBe('npm test');
    expect(summarizeToolCall('Grep', { pattern: 'TODO', path: 'src' })).toBe('TODO in src');
    expect(summarizeToolCall('Grep', { pattern: 'TODO' })).toBe('TODO');
    expect(summarizeToolCall('Grep', { pattern: 'TODO', glob: '*.ts' })).toBe('TODO in *.ts');
    // A path wins over a glob.
    expect(summarizeToolCall('Grep', { pattern: 'TODO', path: 'src', glob: '*.ts' })).toBe('TODO in src');
    expect(summarizeToolCall('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
    expect(summarizeToolCall('WebFetch', { url: 'https://example.com', prompt: 'x' })).toBe('https://example.com');
    expect(summarizeToolCall('Task', { description: 'Review the diff', prompt: 'long' })).toBe('Review the diff');
  });

  it('sends a separate command only for a Bash call that has a description', () => {
    expect(toolCallCommand('Bash', { command: 'npm test' })).toBeUndefined();
    expect(toolCallCommand('Read', { command: 'x', description: 'y' })).toBeUndefined();
    expect(toolCallCommand('Bash', { command: 'a\nb', description: 'two lines' })).toBe('a b');
    expect(toolCallCommand('Bash', null)).toBeUndefined();
  });

  it('falls back to a common field for a tool it does not know', () => {
    expect(summarizeToolCall('mcp__fs__read', { path: '/etc/hosts' })).toBe('/etc/hosts');
    expect(summarizeToolCall('mcp__x__y', { count: 3 })).toBeUndefined();
  });

  it('returns nothing for an input that names nothing', () => {
    expect(summarizeToolCall('TodoWrite', { todos: [] })).toBeUndefined();
    expect(summarizeToolCall('Read', undefined)).toBeUndefined();
    expect(summarizeToolCall('Read', null)).toBeUndefined();
    expect(summarizeToolCall('Read', ['x'])).toBeUndefined();
    expect(summarizeToolCall('Bash', { command: '   ' })).toBeUndefined();
  });

  it('flattens a multi-line command and strips control characters', () => {
    expect(summarizeToolCall('Bash', { command: 'cd /w &&\n  npm test\r\n' })).toBe('cd /w && npm test');
    expect(summarizeToolCall('Bash', { command: 'echo \u001b[31mred\u0007' })).toBe('echo [31mred');
  });

  it('caps a long value with an ellipsis', () => {
    const out = summarizeToolCall('Bash', { command: 'x'.repeat(1000) })!;
    expect(out).toHaveLength(TOOL_DETAIL_MAX_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('toolStartPayload', () => {
  it('carries the detail of a Read', () => {
    expect(toolStartPayload('s1', 'Read', { file_path: '/w/a.ts' }, 1000)).toEqual({
      sessionId: 's1',
      toolName: 'Read',
      detail: '/w/a.ts',
      timestamp: 1000,
    });
  });

  it('carries the description and the command of a Bash call', () => {
    expect(toolStartPayload('s1', 'Bash', { command: 'npm test', description: 'Run the tests' }, 1000)).toEqual({
      sessionId: 's1',
      toolName: 'Bash',
      detail: 'Run the tests',
      command: 'npm test',
      timestamp: 1000,
    });
  });

  it('leaves both fields out for a call with no input', () => {
    const payload = toolStartPayload('s1', 'TodoWrite', undefined, 1000);
    expect(payload).toEqual({ sessionId: 's1', toolName: 'TodoWrite', timestamp: 1000 });
    expect('detail' in payload).toBe(false);
    expect('command' in payload).toBe(false);
  });
});
