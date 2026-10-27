/**
 * Locating the transcript's code blocks on the terminal screen
 * (`CodemanCodeBlockCopy` in constants.js), which puts a Copy button on them.
 *
 * The fixture pair is real: `code-copy-sample.md` is what Claude Code 2.1.309
 * was asked to answer with, and `code-copy-sample.screen.txt` is the pane it
 * drew at 100 columns (`tmux capture-pane -p`). The render is what the matcher
 * has to cope with: a 2-column gutter, a long line word-wrapped with no
 * continuation marker and the space at the break dropped, tabs expanded, and
 * fenced blocks nested in a list.
 *
 * Strategy: constants.js and the vendored marked in one vm, as the browser
 * loads them. No DOM, no xterm.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const fixtures = resolve(import.meta.dirname, 'fixtures');

function load() {
  const context = vm.createContext({ window: {}, console });
  (context as Record<string, unknown>).globalThis = context;
  (context as Record<string, unknown>).self = context;
  vm.runInContext(readFileSync(resolve(publicDir, 'vendor/marked.min.js'), 'utf8'), context);
  vm.runInContext(readFileSync(resolve(publicDir, 'constants.js'), 'utf8'), context);
  const ctx = context as Record<string, any>;
  const api = ctx.window.CodemanCodeBlockCopy;
  const lex = (text: string) => ctx.marked.lexer(text);
  return { api, lex };
}

const { api, lex } = load();
const sample = readFileSync(resolve(fixtures, 'code-copy-sample.md'), 'utf8');
const screen = readFileSync(resolve(fixtures, 'code-copy-sample.screen.txt'), 'utf8').split('\n');
const blocks: { text: string }[] = api.extract([{ text: sample }], lex);

/** The rows a block occupies in the fixture render, found by its first line. */
const rowOf = (needle: string) => screen.findIndex((row) => row.includes(needle));

describe('extract', () => {
  it('finds every fenced block, including the ones nested in a list', () => {
    expect(blocks.map((b) => b.text.split('\n')[0])).toEqual([
      'def resolve(path, *, strict=False):',
      'npm run build && systemctl --user restart codeman-web',
      '{',
      '┌────────┐     ┌────────┐',
      'npm install',
      'npm run build && systemctl --user restart codeman-web',
      'func main() {',
    ]);
  });

  it('skips messages with no code and survives a lexer that throws', () => {
    expect(api.extract([{ text: 'plain prose' }, { text: '```\nx = 1\n```' }], lex)).toHaveLength(1);
    const boom = () => {
      throw new Error('bad markdown');
    };
    expect(api.extract([{ text: '```\nx\n```' }], boom)).toEqual([]);
    expect(api.extract(null, lex)).toEqual([]);
  });

  it('never lexes a message with no code', () => {
    const spy = vi.fn(lex);
    expect(api.extract([{ text: 'plain prose' }], spy)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('finds tilde-fenced and indented code blocks', () => {
    const found = api.extract([{ text: '~~~\ny = 2\n~~~' }, { text: 'Intro:\n\n    z = 3' }], lex);
    expect(found.map((b: { text: string }) => b.text)).toEqual(['y = 2', 'z = 3']);
  });
});

describe('match on a full render', () => {
  const matches = api.match(screen, blocks);

  it('places every block, complete, on the rows Claude drew it', () => {
    expect(matches).toHaveLength(blocks.length);
    expect(matches.every((m: { partial: boolean }) => !m.partial)).toBe(true);
  });

  it('spans a word-wrapped line across both rows', () => {
    const py = matches.find((m: { block: number }) => m.block === 0);
    expect(py.startRow).toBe(rowOf('def resolve('));
    expect(py.endRow).toBe(rowOf('return path'));
    expect(screen[rowOf('exceeds one hundred')]).toMatch(/^ {2}exceeds/);
  });

  it('matches tab-indented code drawn with spaces, blank line included', () => {
    const go = matches.find((m: { block: number }) => m.block === 6);
    expect(go.startRow).toBe(rowOf('func main()'));
    expect(go.endRow - go.startRow).toBe(4);
  });

  it('never puts a button on prose', () => {
    const covered = new Set<number>();
    for (const m of matches) for (let r = m.startRow; r <= m.endRow; r++) covered.add(r);
    for (const prose of [
      'Here is a Python helper',
      'Run it with',
      'A diagram',
      'First install',
      'Then run the same command',
      'Done.',
    ]) {
      expect(rowOf(prose)).toBeGreaterThanOrEqual(0);
      expect(covered.has(rowOf(prose))).toBe(false);
    }
  });
});

describe('match on a screen that cuts a block off', () => {
  it('matches a block whose top is above the screen, starting mid-line', () => {
    const from = rowOf('return os.path.realpath');
    const rows = [screen[from].slice(30), ...screen.slice(from + 1, from + 6)];
    const [m] = api.match(rows, blocks);
    expect(m).toMatchObject({ block: 0, startRow: 0, partial: true });
  });

  it('matches a block cut off by the fullscreen frame, past the "Jump to bottom" row', () => {
    const from = rowOf('def resolve(');
    const rows = [
      ...screen.slice(from - 2, from + 3),
      '  ❯ next                               Jump to bottom (ctrl+End) ↓',
      '─'.repeat(100),
      '❯ ',
    ];
    const [m] = api.match(rows, blocks);
    expect(m).toMatchObject({ block: 0, startRow: 2, endRow: 4, partial: true });
  });

  it("matches a block's last line alone below the top edge", () => {
    // "return path" is a whole line of block 0, and ten characters long.
    const rows = ['  return path', '', '  Run it with:'];
    expect(api.match(rows, blocks)).toEqual([{ block: 0, startRow: 0, endRow: 0, partial: true }]);
  });

  it("matches a block's first line alone above the bottom edge", () => {
    const rows = ['  Then:', '', '  npm run build'];
    expect(api.match(rows, [{ text: 'npm run build\nnpm test' }])).toEqual([
      { block: 0, startRow: 2, endRow: 2, partial: true },
    ]);
  });

  it('needs eight characters before it trusts a sliver of whole lines', () => {
    // "Claude:" is a whole line of the block, but a short line like it ends
    // up on screen as prose too.
    const rows = ['  Claude:', '', '  More prose here.'];
    expect(api.match(rows, [{ text: 'Speakers:\nClaude:' }])).toEqual([]);
  });

  it('needs twelve characters before it trusts a sliver that starts partway through a line', () => {
    // The row is the end of the block's only line, and could as well end a
    // sentence of prose.
    const rows = ['  still open."', '', '  Next paragraph.'];
    expect(api.match(rows, [{ text: 'printf "%s\\n" "the thread is still open."' }])).toEqual([]);
  });

  it('needs twelve characters before it trusts a sliver that ends partway through a line', () => {
    // The row is the start of a line that wraps onto rows below the screen.
    const rows = ['  Then:', '', '  npm run build'];
    expect(api.match(rows, [{ text: 'npm run build && npm test' }])).toEqual([]);
  });

  it('gives no button to a sliver that several different blocks share', () => {
    const rows = ['  Two drafts:', '', '  echo shared-prefix-line'];
    const drafts = [{ text: 'echo shared-prefix-line\necho one' }, { text: 'echo shared-prefix-line\necho two' }];
    expect(api.match(rows, drafts)).toEqual([]);
  });

  it('does not treat a block below a blank row near the top as cut off', () => {
    const rows = ['● Then run:', '', '  npm run build', '  npm run lint', '', '  done'];
    expect(api.match(rows, [{ text: 'cd ~/proj\nnpm run build\nnpm run lint' }])).toEqual([]);
  });

  it('still matches a block scrolled to just below one of its own blank lines', () => {
    const rows = ['', '  def g():', '      return 2', '', '  prose'];
    const block = { text: 'def f():\n    return 1\n\ndef g():\n    return 2' };
    expect(api.match(rows, [block])).toEqual([{ block: 0, startRow: 1, endRow: 2, partial: true }]);
  });

  it('gives no button to rows that may be the top of a longer block cut off at the bottom', () => {
    const rows = ['  prose', '', '  Shared body line that is long enough'];
    const list = [
      { text: 'Shared body line that is long enough' },
      { text: 'Shared body line that is long enough\nnpm test' },
    ];
    expect(api.match(rows, list)).toEqual([]);
  });

  it('matches the short block when a blank row shows the longer one is not cut off', () => {
    const rows = ['  prose', '', '  Shared body line that is long enough', '', '  more prose'];
    const list = [
      { text: 'Shared body line that is long enough' },
      { text: 'Shared body line that is long enough\nnpm test' },
    ];
    expect(api.match(rows, list)).toEqual([{ block: 0, startRow: 2, endRow: 2, partial: false }]);
  });

  it('prefers a longer block cut off at the top over a shorter block it ends with', () => {
    const longer = { text: 'alpha one\nalpha two\n\nshared line one here\nshared line two here' };
    const shorter = { text: 'shared line one here\nshared line two here' };
    const rows = ['alpha two', '', 'shared line one here', 'shared line two here', '', 'prose after'];
    expect(api.match(rows, [longer, shorter])).toEqual([{ block: 0, startRow: 0, endRow: 3, partial: true }]);
  });

  it('gives no button when other blocks explain the rows a block cut off at the bottom adds', () => {
    const shared = 'shared line one here\nshared line two here';
    const omega = 'omega first line long\nomega second line';
    const longer = shared + '\n\n' + omega;
    const rows = ['p1', 'p2', 'p3', '', 'shared line one here', 'shared line two here', '', 'omega first line long'];
    const matches = api.match(rows, [{ text: longer }, { text: shared }, { text: omega }]);
    expect(matches.filter((m: { startRow: number; endRow: number }) => m.endRow >= 4 && m.startRow <= 7)).toEqual([]);
  });

  it('gives the same answer when every block appears several times', () => {
    const shared = 'shared line one here\nshared line two here';
    const omega = 'omega first line long\nomega second line';
    const longer = shared + '\n\n' + omega;
    const rows = ['p1', 'p2', 'p3', '', 'shared line one here', 'shared line two here', '', 'omega first line long'];
    const list = [{ text: longer }, { text: shared }, { text: omega }];
    expect(api.match(rows, [...list, ...list, ...list])).toEqual(api.match(rows, list));

    const top = [{ text: 'alpha one\nalpha two\n\nshared line one here\nshared line two here' }, { text: shared }];
    const topRows = ['alpha two', '', 'shared line one here', 'shared line two here', '', 'prose after'];
    const once = api.match(topRows, top);
    expect(once).toEqual([{ block: 0, startRow: 0, endRow: 3, partial: true }]);
    expect(api.match(topRows, [...top, ...top, ...top])).toEqual(once);
  });

  it('treats a block right under a rule as cut off at the top', () => {
    const block = { text: 'first line\nsecond line of the block\nthird line here' };
    const rows = [
      '  p1',
      '  p2',
      '  p3',
      '─'.repeat(100),
      '  second line of the block',
      '  third line here',
      '',
      '  prose',
    ];
    expect(api.match(rows, [block])).toEqual([{ block: 0, startRow: 4, endRow: 5, partial: true }]);
  });

  it('gives no button when other blocks explain the rows a block cut off at the top adds', () => {
    const shared = 'shared line one here\nshared line two here';
    const other = 'first line\nalpha two is longer';
    const longer = 'alpha one\nalpha two is longer\n\n' + shared;
    const rows = ['alpha two is longer', '', 'shared line one here', 'shared line two here', '', 'prose'];
    const matches = api.match(rows, [{ text: longer }, { text: shared }, { text: other }]);
    expect(matches.filter((m: { startRow: number; endRow: number }) => m.endRow >= 0 && m.startRow <= 3)).toEqual([]);
  });

  it('lets a block cut off at the top start below a prompt pinned to the first row', () => {
    const draftA = 'fix: one\n\nShared body line that is long enough\nCo-Authored-By: A';
    const rows = ['❯ my prompt', '  Shared body line that is long enough', '  Co-Authored-By: A', '', '  prose'];
    expect(api.match(rows, [{ text: draftA }])).toEqual([{ block: 0, startRow: 1, endRow: 2, partial: true }]);
  });

  it('does not treat a block that ends above the composer rule as cut off', () => {
    const rows = [
      '● Try this:',
      '',
      '  cd ~/proj',
      '  npm run build',
      '  npm run lint',
      '',
      '─'.repeat(100),
      '❯ ',
      '─'.repeat(100),
    ];
    expect(api.match(rows, [{ text: 'cd ~/proj\nnpm run build\nnpm test' }])).toEqual([]);
  });
});

describe('match on rows the message bullet shares', () => {
  it('matches a code block that opens a message on the bullet row', () => {
    const cmd = 'npm run build && systemctl --user restart codeman-web';
    const rows = [`● ${cmd}`, '', '  prose'];
    expect(api.match(rows, [{ text: cmd }])).toEqual([{ block: 0, startRow: 0, endRow: 0, partial: false }]);
  });

  it("matches a code block that opens a message on Codex's bullet row", () => {
    const cmd = 'npm run build && systemctl --user restart codeman-web';
    const rows = [`• ${cmd}`, '', '  prose'];
    expect(api.match(rows, [{ text: cmd }])).toEqual([{ block: 0, startRow: 0, endRow: 0, partial: false }]);
  });
});

describe('blocks that differ only in whitespace', () => {
  it('copies the block whose spacing the screen shows', () => {
    const rows = ['● Run:', '', '  rm -rf /tmp/build', '', '  done'];
    expect(api.match(rows, [{ text: 'rm -rf / tmp/build' }, { text: 'rm -rf /tmp/build' }])).toEqual([
      { block: 1, startRow: 2, endRow: 2, partial: false },
    ]);
  });

  it('gives no button when the only block has a space the screen lacks', () => {
    const rows = ['● Run:', '', '  rm -rf /tmp/build', '', '  done'];
    expect(api.match(rows, [{ text: 'rm -rf / tmp/build' }])).toEqual([]);
  });

  it('gives no button when the screen has a space the only block lacks', () => {
    const rows = ['● Run:', '', '  rm -rf / tmp/build', '', '  done'];
    expect(api.match(rows, [{ text: 'rm -rf /tmp/build' }])).toEqual([]);
  });

  it('gives no button when the screen has as many spaces as the only block, in other places', () => {
    const rows = ['  rm -rf /tmp/build'];
    expect(api.match(rows, [{ text: 'rm -rf/ tmp/build' }])).toEqual([]);
  });

  it('gives no button when drafts differ only in indentation', () => {
    const rows = ['● Here is the fixed config:', '', '  server:', '    port: 80', '    host: x', '', '  done'];
    const yaml = [{ text: 'server:\nport: 80\nhost: x' }, { text: 'server:\n  port: 80\n  host: x' }];
    expect(api.match(rows, yaml)).toEqual([]);
  });

  it('still matches blocks with identical text, as the first of them', () => {
    const rows = ['  x = compute(1)', '', '  done'];
    const same = [{ text: 'x = compute(1)' }, { text: 'x = compute(1)' }];
    expect(api.match(rows, same)).toEqual([{ block: 0, startRow: 0, endRow: 0, partial: false }]);
  });
});

describe('revised drafts of one block', () => {
  const draftA = 'fix: one\n\nShared body line that is long enough\nCo-Authored-By: A';
  const draftB = 'fix: two\n\nShared body line that is long enough\nCo-Authored-By: A';
  const after = 'echo after-the-drafts';
  const drafts = [{ text: draftA }, { text: draftB }, { text: after }];

  it('skips the rows when nothing on screen says which draft they are', () => {
    const rows = ['  Shared body line that is long enough', '  Co-Authored-By: A', '', '  prose'];
    expect(api.match(rows, drafts)).toEqual([]);
  });

  it('picks the latest draft before the next complete block', () => {
    const rows = ['  Shared body line that is long enough', '  Co-Authored-By: A', '', '  prose', '', `  ${after}`];
    const found = api.match(rows, drafts);
    expect(found.map((m: { block: number }) => m.block)).toEqual([1, 2]);
  });

  it('picks the earliest draft after the nearest complete block above a cut at the bottom', () => {
    // These drafts share their FIRST line, so a bottom cut inside it fits
    // both. The bottom row holds the first half of that word-wrapped line.
    const before = 'echo before-the-drafts';
    const draftC = 'Shared body line that is long enough\nfix: one';
    const draftD = 'Shared body line that is long enough\nfix: two';
    const list = [{ text: draftD }, { text: before }, { text: draftC }, { text: draftD }];
    const rows = [`  ${before}`, '', '  prose', '', '  Shared body line that is'];
    const found = api.match(rows, list);
    expect(found.map((m: { block: number }) => m.block)).toEqual([1, 2]);
    expect(found[1]).toMatchObject({ startRow: 4, endRow: 4, partial: true });
  });
});
