/**
 * @fileoverview Reads the skill and command files Claude Code offers as slash commands, for the
 * chat view's `/` menu (claude-slash-commands.ts holds the parsing and the rules).
 *
 * Each root is a folder laid out like `~/.claude`: `skills/<name>/SKILL.md` and
 * `commands/**.md`. The caller passes only roots it has already probed with the bounded probe
 * (#516), and every read here is bounded too:
 *
 * - at most {@link MAX_ENTRIES_PER_DIR} entries per folder, and {@link MAX_COMMAND_DEPTH} folders
 *   deep;
 * - at most {@link MAX_TOTAL_ENTRIES} folder entries and {@link MAX_TOTAL_FILES} opened files in
 *   one call, across every root;
 * - the first {@link MAX_FILE_BYTES} bytes of each file.
 *
 * A file opens non-blocking, so a FIFO named like a skill file fails its regular-file check
 * at once and never holds a threadpool worker. A symbolic link to a folder is not followed
 * below `commands/`. A root may name a folder it must stay inside (`confineTo`, the workspace):
 * a file under it is read only when its real path lies inside that folder and the file that was
 * opened is the one at that real path (same device and inode), so a link out of the workspace's
 * `.claude` is skipped, even one rewritten between the open and the check. Anything that cannot
 * be read is skipped: the menu is a convenience, and an empty list is a fine answer.
 */

import { constants as fsConstants, promises as fs } from 'node:fs';
import { join, sep } from 'node:path';
import { parseSkillFile, type SlashCommand } from './claude-slash-commands.js';

const MAX_ENTRIES_PER_DIR = 200;
const MAX_COMMAND_DEPTH = 3;
/** Folder entries one call may look at, across every root. */
export const MAX_TOTAL_ENTRIES = 2000;
/** Files one call may open, across every root. */
export const MAX_TOTAL_FILES = 400;
/** Frontmatter sits at the top; a description past this is not read. */
const MAX_FILE_BYTES = 16 * 1024;

/** A folder laid out like `~/.claude`, and the folder its files must resolve inside, if any. */
export interface SlashCommandRoot {
  dir: string;
  /**
   * The folder every file under `dir` must resolve inside. It must be an absolute path that is
   * already resolved (`fs.realpath`), because each file's real path is compared with it as
   * given. An unresolved path makes every file under the root fail that check, so the root
   * lists nothing.
   */
  confineTo?: string;
}

/** What is left of one call's budget; every root draws on the same one. */
interface ScanBudget {
  entries: number;
  files: number;
}

async function readHead(path: string, root: SlashCommandRoot, budget: ScanBudget): Promise<string | null> {
  if (budget.files <= 0) return null;
  budget.files--;
  let handle: import('node:fs/promises').FileHandle | undefined;
  try {
    // Open first, then judge the file that was opened: a link rewritten between a realpath
    // check and the open would otherwise be followed to wherever it points by then.
    handle = await fs.open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    if (root.confineTo !== undefined) {
      const real = await fs.realpath(path);
      if (real !== root.confineTo && !real.startsWith(root.confineTo + sep)) return null;
      const named = await fs.stat(real);
      if (named.dev !== stat.dev || named.ino !== stat.ino) return null;
    }
    const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES, stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function list(dir: string, budget: ScanBudget): Promise<import('node:fs').Dirent[]> {
  const take = Math.min(MAX_ENTRIES_PER_DIR, budget.entries);
  if (take <= 0) return [];
  try {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).slice(0, take);
    budget.entries -= entries.length;
    return entries;
  } catch {
    return [];
  }
}

async function readSkills(root: SlashCommandRoot, budget: ScanBudget): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  const dir = join(root.dir, 'skills');
  for (const entry of await list(dir, budget)) {
    if (budget.files <= 0) break;
    // A skill folder may be a symbolic link (a synced skills checkout); SKILL.md is read through it.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const text = await readHead(join(dir, entry.name, 'SKILL.md'), root, budget);
    const command = text === null ? null : parseSkillFile(text, entry.name, 'skill');
    if (command) out.push(command);
  }
  return out;
}

async function readCommands(
  root: SlashCommandRoot,
  dir: string,
  prefix: string,
  depth: number,
  budget: ScanBudget,
  out: SlashCommand[]
): Promise<void> {
  for (const entry of await list(dir, budget)) {
    if (budget.files <= 0) break;
    if (entry.isDirectory() && depth < MAX_COMMAND_DEPTH) {
      await readCommands(root, join(dir, entry.name), `${prefix}${entry.name}:`, depth + 1, budget, out);
    } else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.md')) {
      const text = await readHead(join(dir, entry.name), root, budget);
      const command = text === null ? null : parseSkillFile(text, prefix + entry.name.slice(0, -3), 'command');
      if (command) out.push(command);
    }
  }
}

/**
 * The skills and commands under each root, the roots in priority order. A root's `confineTo`
 * must already be a resolved real path (`fs.realpath`): an unresolved one lists nothing.
 */
export async function readSlashCommandFiles(roots: SlashCommandRoot[]): Promise<SlashCommand[]> {
  const out: SlashCommand[] = [];
  const budget: ScanBudget = { entries: MAX_TOTAL_ENTRIES, files: MAX_TOTAL_FILES };
  for (const root of roots) {
    out.push(...(await readSkills(root, budget)));
    await readCommands(root, join(root.dir, 'commands'), '', 1, budget, out);
  }
  return out;
}
