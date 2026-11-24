/**
 * @fileoverview The `/` menu's sources (claude-slash-commands.ts, claude-slash-command-files.ts).
 *
 * Pinned: a later `isInitial` listing starts the list again while other rows add to it, a
 * description runs to the next listed name and never borrows a longer name's line, frontmatter
 * is read the way Claude Code writes it, a skill marked `user-invocable: false` is not offered,
 * the first source to name a command wins, and the file reader stays inside its bounds.
 *
 * Port: N/A
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanText,
  mergeSlashCommands,
  parseSkillFile,
  parseSkillListings,
  SLASH_DESCRIPTION_MAX_CHARS,
} from '../src/claude-slash-commands.js';
import { readSlashCommandFiles } from '../src/claude-slash-command-files.js';

const row = (names: string[], content: string, isInitial?: boolean) =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'skill_listing', names, content, isInitial } });

describe('parseSkillListings', () => {
  it('replays the listing rows: an initial row resets, a later row adds', () => {
    const transcript = [
      row(['old'], '- old: gone after the next initial row', true),
      '{"type":"user","message":{"content":"hi"}}',
      row(['a', 'b'], '- a: First\n- b: Second\nspans two lines', true),
      row(['c'], '- c: Third', false),
      'not json "skill_listing"',
    ].join('\n');
    expect(parseSkillListings(transcript)).toEqual([
      { name: 'a', description: 'First', kind: 'skill' },
      { name: 'b', description: 'Second spans two lines', kind: 'skill' },
      { name: 'c', description: 'Third', kind: 'skill' },
    ]);
  });

  it("never takes a longer name's line for a shorter name, and keeps a name without a description", () => {
    const transcript = row(['run', 'running', 'bare'], '- running: Long one\n- run: Short one\n- bare', true);
    const byName = new Map(parseSkillListings(transcript).map((c) => [c.name, c.description]));
    expect(byName.get('run')).toBe('Short one');
    expect(byName.get('bare')).toBe('');
  });

  it('drops names Claude Code would not accept after /', () => {
    expect(parseSkillListings(row(['ok', 'bad name', '../x'], '- ok: fine', true)).map((c) => c.name)).toEqual(['ok']);
  });
});

describe('parseSkillFile', () => {
  it('reads name and description from frontmatter, quoted or folded', () => {
    expect(parseSkillFile('---\nname: own\ndescription: "Quoted"\n---\nbody', 'folder', 'skill')).toEqual({
      name: 'own',
      description: 'Quoted',
      kind: 'skill',
    });
    expect(parseSkillFile('---\ndescription: |\n  One\n  two\n---\n', 'folder', 'skill')?.description).toBe('One two');
  });

  it('falls back to the first body line for a command, and skips user-invocable: false', () => {
    expect(parseSkillFile('# Title\n\nDo the thing\n', 'ops:deploy', 'command')).toEqual({
      name: 'ops:deploy',
      description: 'Do the thing',
      kind: 'command',
    });
    expect(parseSkillFile('---\nuser-invocable: false\n---\n', 'hidden', 'skill')).toBeNull();
  });

  it('strips control characters and caps the description', () => {
    expect(cleanText('a\u001b[31mb\u0007c')).toBe('a [31mb c');
    expect(cleanText('x'.repeat(500))).toHaveLength(SLASH_DESCRIPTION_MAX_CHARS + 1);
  });
});

describe('mergeSlashCommands', () => {
  it('keeps the first source to name a command and sorts by name', () => {
    const merged = mergeSlashCommands(
      [{ name: 'b', description: 'from transcript', kind: 'skill' }],
      [
        { name: 'b', description: 'from disk', kind: 'skill' },
        { name: 'a', description: 'disk only', kind: 'command' },
      ]
    );
    expect(merged).toEqual([
      { name: 'a', description: 'disk only', kind: 'command' },
      { name: 'b', description: 'from transcript', kind: 'skill' },
    ]);
  });
});

describe('readSlashCommandFiles', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codeman-slash-files-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads skills and nested commands, and stops three folders deep', () => {
    const write = (path: string, text: string) => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
    };
    write(join(root, 'skills', 'one', 'SKILL.md'), '---\ndescription: Skill one\n---\n');
    write(join(root, 'skills', 'no-file', 'README.md'), 'not a skill');
    write(join(root, 'commands', 'top.md'), 'Top command');
    write(join(root, 'commands', 'a', 'b', 'deep.md'), 'Two folders down');
    write(join(root, 'commands', 'a', 'b', 'c', 'too-deep.md'), 'Three folders down');
    return readSlashCommandFiles([root, join(root, 'missing')]).then((list) => {
      expect(list.map((c) => c.name).sort()).toEqual(['a:b:deep', 'one', 'top']);
    });
  });
});
