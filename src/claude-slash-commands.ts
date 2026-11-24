/**
 * @fileoverview The slash commands the chat view offers when the user types `/` in its message
 * box, for a session whose CLI writes a Claude-format transcript.
 *
 * Three sources feed the list, and the first one that names a command wins:
 *
 * 1. The transcript. Claude Code writes a `skill_listing` attachment row that lists every skill
 *    and prompt command it offers (plugin skills included), with the description it shows. The
 *    first row has `isInitial: true`; a later one without it adds the skills that appeared
 *    since. {@link parseSkillListings} replays them.
 * 2. Skill and command files on disk: `<dir>/skills/<name>/SKILL.md` and `<dir>/commands/**.md`
 *    under the Claude config folder and the session's `.claude` folder. A session that has not
 *    taken its first prompt has no transcript yet, so these cover it. {@link parseSkillFile}
 *    reads one file's frontmatter.
 * 3. {@link CLAUDE_BUILTIN_COMMANDS}, the built-in commands the CLI handles itself. The
 *    transcript never lists them.
 *
 * Pure: no IO, so the test exercises the shipped code. Every name and description is text from
 * a file somebody else wrote: {@link cleanText} strips control characters and caps the length,
 * and the browser sets both with `textContent` only.
 */

export type SlashCommandKind = 'builtin' | 'skill' | 'command';

export interface SlashCommand {
  /** Without the leading `/`; a plugin's skill carries its `plugin:` prefix. */
  name: string;
  description: string;
  kind: SlashCommandKind;
}

/** Longest description sent, in UTF-16 code units, before the ellipsis. */
export const SLASH_DESCRIPTION_MAX_CHARS = 200;
/** Most commands one answer carries, whatever the sources hold. */
export const SLASH_COMMANDS_MAX = 400;

/** A name Claude Code accepts after `/`: letters, digits, `-`, `_`, `.` and `:` separators. */
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

/**
 * The built-in commands worth offering from a message box, with the CLI's own descriptions
 * (read from Claude Code 2.1.331). Commands that only make sense inside the terminal UI
 * (`/theme`, `/vim`, `/copy`, `/exit`) are left out; typing one still sends it.
 */
export const CLAUDE_BUILTIN_COMMANDS: readonly SlashCommand[] = [
  ['add-dir', 'Add a working directory'],
  ['advisor', 'Let Claude consult a stronger model at key moments'],
  ['btw', 'Ask a side question without interrupting Claude'],
  ['clear', 'Start a new session with empty context; the old one stays in /resume'],
  ['compact', 'Free up context by summarizing the conversation so far'],
  ['config', 'Open settings'],
  ['context', 'Show what fills the context'],
  ['effort', "Set the model's effort level"],
  ['export', 'Export this session to a file or clipboard'],
  ['goal', 'Set a goal Claude checks before stopping'],
  ['help', 'Show help and available commands'],
  ['hooks', 'View hook configurations for tool events'],
  ['mcp', 'Manage MCP servers'],
  ['memory', 'Edit CLAUDE.md files and memory settings'],
  ['model', 'Set the AI model for Claude Code'],
  ['output-style', 'List output styles or switch to one'],
  ['permissions', 'Manage allow and deny tool permission rules'],
  ['plan', 'Turn on plan mode or view the plan'],
  ['plugin', 'Manage Claude Code plugins'],
  ['recap', 'Generate a one-line session recap now'],
  ['reload-skills', 'Pick up skills added or changed on disk during this session'],
  ['rename', 'Rename the current conversation'],
  ['resume', 'Resume an earlier conversation'],
  ['rewind', 'Restore earlier code, conversation, or both'],
  ['skills', 'List available skills'],
  ['status', 'Show version, account, model, MCP servers, and setup warnings'],
  ['tasks', "View and manage this session's background work"],
  ['usage', 'Show session cost, plan usage, and activity stats'],
].map(([name, description]) => ({ name, description, kind: 'builtin' as const }));

/** One line of text, control characters removed, capped at {@link SLASH_DESCRIPTION_MAX_CHARS}. */
export function cleanText(value: string): string {
  const flat = String(value ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > SLASH_DESCRIPTION_MAX_CHARS ? `${flat.slice(0, SLASH_DESCRIPTION_MAX_CHARS)}…` : flat;
}

export function isCommandName(name: string): boolean {
  return COMMAND_NAME.test(name);
}

/**
 * The descriptions in one listing's `content`, which reads `- <name>: <description>` per skill,
 * in the order of `names`. A description runs until the next listed name's line.
 */
function listingDescriptions(content: string, names: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const starts: Array<{ name: string; at: number; body: number }> = [];
  let from = 0;
  for (const name of names) {
    const marker = `- ${name}`;
    let at = content.indexOf(marker, from);
    // The marker must open a line and end at `:` or the line's end, or `- foo` matches `- foobar`.
    while (at !== -1) {
      const after = content[at + marker.length];
      const lineStart = at === 0 || content[at - 1] === '\n';
      if (lineStart && (after === undefined || after === ':' || after === '\n')) break;
      at = content.indexOf(marker, at + 1);
    }
    if (at === -1) continue;
    const body = content[at + marker.length] === ':' ? at + marker.length + 1 : at + marker.length;
    starts.push({ name, at, body });
    from = body;
  }
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].at : content.length;
    out.set(start.name, cleanText(content.slice(start.body, end)));
  });
  return out;
}

/**
 * The skills the transcript's `skill_listing` rows name, in listing order. An `isInitial` row
 * starts the list again; any other row adds to it. Lines that do not hold a listing are skipped
 * before they are parsed.
 */
export function parseSkillListings(transcript: string): SlashCommand[] {
  let skills = new Map<string, SlashCommand>();
  for (const line of transcript.split('\n')) {
    if (!line.includes('"skill_listing"')) continue;
    let attachment: { type?: unknown; names?: unknown; content?: unknown; isInitial?: unknown } | undefined;
    try {
      attachment = (JSON.parse(line) as { attachment?: typeof attachment }).attachment;
    } catch {
      continue;
    }
    if (!attachment || attachment.type !== 'skill_listing' || !Array.isArray(attachment.names)) continue;
    const names = attachment.names.filter((n): n is string => typeof n === 'string' && isCommandName(n));
    const descriptions = listingDescriptions(typeof attachment.content === 'string' ? attachment.content : '', names);
    if (attachment.isInitial === true) skills = new Map();
    for (const name of names) skills.set(name, { name, description: descriptions.get(name) ?? '', kind: 'skill' });
  }
  return [...skills.values()];
}

/** The YAML frontmatter's top-level scalar values, folded and block values joined to one line. */
function frontmatter(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return out;
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value === '' || /^[>|][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        block.push(lines[++i].trim());
      }
      value = block.join(' ');
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    out.set(kv[1], value);
  }
  return out;
}

/**
 * One skill or command file read as a slash command, or null when it is not one a user can
 * type: a bad name, or a skill marked `user-invocable: false`. `name` is the skill's folder
 * name or the command's path below `commands/` with `:` for each folder.
 */
export function parseSkillFile(text: string, name: string, kind: 'skill' | 'command'): SlashCommand | null {
  const meta = frontmatter(text);
  if (meta.get('user-invocable') === 'false') return null;
  const ownName = kind === 'skill' ? meta.get('name') : undefined;
  const finalName = ownName && isCommandName(ownName) ? ownName : name;
  if (!isCommandName(finalName)) return null;
  let description = meta.get('description') ?? '';
  if (!description) {
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    description = body.split(/\r?\n/).find((line) => line.trim() !== '' && !line.startsWith('#')) ?? '';
  }
  return { name: finalName, description: cleanText(description), kind };
}

/** One list from the sources in priority order: the first source to name a command wins. */
export function mergeSlashCommands(...sources: SlashCommand[][]): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const source of sources) {
    for (const command of source) {
      if (!byName.has(command.name)) byName.set(command.name, command);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, SLASH_COMMANDS_MAX);
}
