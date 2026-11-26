/**
 * @fileoverview Types of the slash commands the chat view's `/` menu offers, the answer of
 * `GET /api/sessions/:id/slash-commands`. src/claude-slash-commands.ts parses and merges them,
 * and src/claude-slash-command-files.ts reads them from skill and command files.
 */

export type SlashCommandKind = 'builtin' | 'skill' | 'command';

export interface SlashCommand {
  /** Without the leading `/`; a plugin's skill carries its `plugin:` prefix. */
  name: string;
  description: string;
  kind: SlashCommandKind;
  /**
   * A built-in that, typed with nothing after it, opens a picker or a panel inside Claude's
   * terminal interface (`/model`, `/config`), which the chat view cannot draw. The chat view
   * shows the terminal for it.
   */
  opensTerminal?: boolean;
}
