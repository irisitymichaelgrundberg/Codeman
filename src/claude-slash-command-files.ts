/**
 * @fileoverview Reads the skill and command files Claude Code offers as slash commands, for the
 * chat view's `/` menu (claude-slash-commands.ts holds the parsing and the rules).
 *
 * Each root is a folder laid out like `~/.claude`: `skills/<name>/SKILL.md` and
 * `commands/**.md`. The caller passes only roots it has already probed with the bounded probe
 * (#516), and every read here is bounded too: at most {@link MAX_ENTRIES_PER_DIR} entries per
 * folder, {@link MAX_COMMAND_DEPTH} folders deep, and the first {@link MAX_FILE_BYTES} bytes of
 * each file. A symbolic link to a folder is not followed below `commands/`. Anything that cannot
 * be read is skipped: the menu is a convenience, and an empty list is a fine answer.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parseSkillFile, type SlashCommand } from './claude-slash-commands.js';

const MAX_ENTRIES_PER_DIR = 200;
const MAX_COMMAND_DEPTH = 3;
/** Frontmatter sits at the top; a description past this is not read. */
const MAX_FILE_BYTES = 16 * 1024;

async function readHead(path: string): Promise<string | null> {
  let handle: import('node:fs/promises').FileHandle | undefined;
  try {
    handle = await fs.open(path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function list(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).slice(0, MAX_ENTRIES_PER_DIR);
  } catch {
    return [];
  }
}

async function readSkills(root: string): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  const dir = join(root, 'skills');
  for (const entry of await list(dir)) {
    // A skill folder may be a symbolic link (a synced skills checkout); SKILL.md is read through it.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const text = await readHead(join(dir, entry.name, 'SKILL.md'));
    const command = text === null ? null : parseSkillFile(text, entry.name, 'skill');
    if (command) out.push(command);
  }
  return out;
}

async function readCommands(dir: string, prefix: string, depth: number, out: SlashCommand[]): Promise<void> {
  for (const entry of await list(dir)) {
    if (entry.isDirectory() && depth < MAX_COMMAND_DEPTH) {
      await readCommands(join(dir, entry.name), `${prefix}${entry.name}:`, depth + 1, out);
    } else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md')) {
      const text = await readHead(join(dir, entry.name));
      const command = text === null ? null : parseSkillFile(text, prefix + entry.name.slice(0, -3), 'command');
      if (command) out.push(command);
    }
  }
}

/** The skills and commands under each root, the roots in priority order. */
export async function readSlashCommandFiles(roots: string[]): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  for (const root of roots) {
    out.push(...(await readSkills(root)));
    await readCommands(join(root, 'commands'), '', 1, out);
  }
  return out;
}
