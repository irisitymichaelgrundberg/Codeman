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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_BUILTIN_COMMANDS,
  cleanText,
  mergeSlashCommands,
  parseSkillFile,
  parseSkillListings,
  SLASH_DESCRIPTION_MAX_CHARS,
  shellCommandOutput,
  typedShellCommand,
  typedSlashCommand,
} from '../src/claude-slash-commands.js';
import { MAX_TOTAL_ENTRIES, MAX_TOTAL_FILES, readSlashCommandFiles } from '../src/claude-slash-command-files.js';

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
    return readSlashCommandFiles([{ dir: root }, { dir: join(root, 'missing') }]).then((list) => {
      expect(list.map((c) => c.name).sort()).toEqual(['a:b:deep', 'one', 'top']);
    });
  });

  const write = (path: string, text: string) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  };

  it('follows a link out of a confined workspace to nothing, and a link inside it as usual', async () => {
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    write(join(outside, 'secret.md'), 'The first line of a private file');
    write(join(outside, 'skill', 'SKILL.md'), '---\ndescription: Outside skill\n---\n');
    write(join(workspace, 'notes', 'inside.md'), 'Inside command');
    mkdirSync(join(workspace, '.claude', 'commands'), { recursive: true });
    mkdirSync(join(workspace, '.claude', 'skills'), { recursive: true });
    symlinkSync(join(outside, 'secret.md'), join(workspace, '.claude', 'commands', 'k.md'));
    symlinkSync(join(outside, 'skill'), join(workspace, '.claude', 'skills', 'x'));
    symlinkSync(join(workspace, 'notes', 'inside.md'), join(workspace, '.claude', 'commands', 'in.md'));

    const list = await readSlashCommandFiles([{ dir: join(workspace, '.claude'), confineTo: realpathSync(workspace) }]);
    expect(list.map((c) => c.name)).toEqual(['in']);
  });

  it('reads nothing when the link points elsewhere by the time the file opens', async () => {
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    write(join(outside, 'secret.md'), 'SECRET-LINE of a private file');
    write(join(workspace, 'notes', 'inside.md'), 'Inside command');
    mkdirSync(join(workspace, '.claude', 'commands'), { recursive: true });
    const link = join(workspace, '.claude', 'commands', 'k.md');
    symlinkSync(join(outside, 'secret.md'), link);

    // A rewritten link is hard to time, so the realpath check is made to see the link pointing
    // inside the workspace while the open follows it out.
    const realpath = fsPromises.realpath;
    const spy = vi
      .spyOn(fsPromises, 'realpath')
      .mockImplementation((async (p: string) =>
        p === link ? realpathSync(join(workspace, 'notes', 'inside.md')) : realpath(p)) as typeof realpath);
    try {
      const list = await readSlashCommandFiles([
        { dir: join(workspace, '.claude'), confineTo: realpathSync(workspace) },
      ]);
      expect(spy).toHaveBeenCalledWith(link);
      expect(list.map((c) => c.name)).not.toContain('k');
      expect(list.some((c) => (c.description ?? '').includes('SECRET-LINE'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('skips a FIFO named like a skill or command file without blocking', async () => {
    mkdirSync(join(root, 'skills', 'x'), { recursive: true });
    mkdirSync(join(root, 'commands'), { recursive: true });
    // BSD mkfifo has no --help, so the first real call is the probe for a machine without one.
    try {
      execFileSync('mkfifo', [join(root, 'skills', 'x', 'SKILL.md')], { stdio: 'ignore' });
    } catch {
      return; // no mkfifo on this machine
    }
    execFileSync('mkfifo', [join(root, 'commands', 'f.md')]);
    write(join(root, 'commands', 'ok.md'), 'A real command');

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the scan blocked on a FIFO')), 2000);
    });
    try {
      const list = await Promise.race([readSlashCommandFiles([{ dir: root }]), timeout]);
      expect(list.map((c) => c.name)).toEqual(['ok']);
    } finally {
      clearTimeout(timer);
    }
  });

  it('reads at most 200 entries of one folder', async () => {
    for (let i = 0; i < 250; i++) write(join(root, 'commands', `a${i}.md`), `Command ${i}`);
    const list = await readSlashCommandFiles([{ dir: root }]);
    expect(list).toHaveLength(200);
  });

  it('stops opening files once the call has opened its budget of them', async () => {
    for (const folder of ['a', 'b', 'c']) {
      for (let i = 0; i < 200; i++) write(join(root, 'commands', folder, `c${i}.md`), `Command ${i}`);
    }
    const list = await readSlashCommandFiles([{ dir: root }, { dir: root }]);
    expect(list).toHaveLength(MAX_TOTAL_FILES);
  });

  it('stops listing folders once the call has looked at its budget of entries', async () => {
    // Twelve folders of 200 entries each, one command per folder: more entries than the budget.
    const folders = 12;
    for (let f = 0; f < folders; f++) {
      const dir = join(root, 'commands', `d${f}`);
      for (let i = 0; i < 199; i++) write(join(dir, `x${i}.txt`), '');
      write(join(dir, 'z.md'), `Command in folder ${f}`);
    }
    expect(folders * 200).toBeGreaterThan(MAX_TOTAL_ENTRIES);
    const list = await readSlashCommandFiles([{ dir: root }]);
    // The budget covers the folder list and nine whole folders, and part of a tenth at most.
    expect(list.length).toBeGreaterThanOrEqual(9);
    expect(list.length).toBeLessThanOrEqual(10);
  });
});

describe('typedSlashCommand', () => {
  it('reads a typed command from its transcript tags, in either order, with its arguments', () => {
    expect(
      typedSlashCommand('<command-message>dual-review</command-message>\n<command-name>/dual-review</command-name>')
    ).toBe('/dual-review');
    expect(
      typedSlashCommand(
        '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'
      )
    ).toBe('/model opus');
    expect(typedSlashCommand('<command-name>/clear</command-name><command-args></command-args>')).toBe('/clear');
  });

  it('gives null for anything else', () => {
    expect(typedSlashCommand('please run <command-name>/x</command-name>')).toBeNull();
    expect(typedSlashCommand('<local-command-stdout>done</local-command-stdout>')).toBeNull();
    expect(typedSlashCommand('<command-name>/bad name</command-name>')).toBeNull();
    expect(typedSlashCommand('<command-name>/-x</command-name>')).toBeNull();
    expect(typedSlashCommand(`<command-name>/${'a'.repeat(101)}</command-name>`)).toBeNull();
  });
});

describe('typedShellCommand', () => {
  it('reads a `!` command from its transcript tags, with the `!` the user typed', () => {
    expect(typedShellCommand('<bash-input>git status</bash-input>')).toBe('!git status');
    expect(typedShellCommand('<bash-input>  ls -la  </bash-input>\n')).toBe('!ls -la');
  });

  it('gives null for anything else', () => {
    expect(typedShellCommand('<bash-input></bash-input>')).toBeNull();
    expect(typedShellCommand('run <bash-input>ls</bash-input>')).toBeNull();
    expect(typedShellCommand('<bash-stdout>x</bash-stdout><bash-stderr></bash-stderr>')).toBeNull();
  });
});

describe('shellCommandOutput', () => {
  it('fences standard output, then standard error, without terminal colours', () => {
    expect(
      shellCommandOutput('<bash-stdout>\u001b[32mok\u001b[0m\n</bash-stdout><bash-stderr>warn\n</bash-stderr>')
    ).toBe('```\nok\nwarn\n```');
  });

  it('gives an empty string for a command that printed nothing', () => {
    expect(shellCommandOutput('<bash-stdout></bash-stdout><bash-stderr></bash-stderr>')).toBe('');
  });

  it('makes the fence longer than any backtick run in the output', () => {
    expect(shellCommandOutput('<bash-stdout>a ```` b</bash-stdout><bash-stderr></bash-stderr>')).toBe(
      '`````\na ```` b\n`````'
    );
  });

  it('gives null for anything else', () => {
    expect(shellCommandOutput('<bash-input>ls</bash-input>')).toBeNull();
    expect(shellCommandOutput('the output was <bash-stdout>x</bash-stdout>')).toBeNull();
  });
});

describe('CLAUDE_BUILTIN_COMMANDS', () => {
  it('marks the built-ins whose bare form opens a picker in the terminal, and not the others', () => {
    const opens = new Set(CLAUDE_BUILTIN_COMMANDS.filter((c) => c.opensTerminal).map((c) => c.name));
    for (const name of ['model', 'config', 'resume', 'mcp', 'permissions']) expect(opens.has(name)).toBe(true);
    for (const name of ['clear', 'compact', 'recap', 'rename']) expect(opens.has(name)).toBe(false);
  });
});
