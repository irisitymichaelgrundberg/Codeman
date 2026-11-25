/**
 * @fileoverview The chat view (chat-view.js): a session's conversation as its main view.
 *
 * What is pinned, and why:
 * - The pure helpers (`CodemanChatView` in constants.js): keep-warm turns are never drawn, a
 *   growing thread appends instead of redrawing, long prompts fold, and Enter sends only where
 *   the plan says it does.
 * - Which sessions can show it comes from `window.__codemanChatViewModes` (the transcript
 *   capability), and remote and adopted sessions never do.
 * - The chat view covers the terminal without removing it, and a session remembers its view.
 * - A send goes through `POST /api/sessions/:id/input` with `useMux: true`: the WebSocket path
 *   writes raw bytes and never arms the server's Enter re-press. A retried request carries the
 *   same `clientId` and `seq`, so the server applies it once, and a refused one keeps the text.
 * - A dialog in the pane shows the "waiting in the terminal" notice, and nothing is sent while
 *   it waits: the text and the Enter would go into the dialog.
 * - Codeman's own keep-alive turn shows no status line and no Stop button.
 * - The toggle chord is swallowed by the xterm key handler, so it never types into the session.
 *
 * The real constants.js and chat-view.js run inside a JSDOM window.
 *
 * Port: none.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const read = (name: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', name), 'utf8');

type Msg = { role: string; text: string; turn?: number; keepAlive?: boolean; queued?: boolean };

interface ChatHelpers {
  visibleMessages: (m: unknown) => Msg[];
  messageKey: (m: Msg) => string;
  renderPlan: (a: string[], b: string[]) => { mode: string; from?: number };
  promptFold: (t: string) => { folded: boolean; head: string; totalLines: number };
  promptText: (t: string) => string;
  promptCount: (m: Msg[], t: string) => number;
  pendingConfirmed: (p: { text: string; baseline: number }, m: Msg[]) => boolean;
  activity: (tool?: string, detail?: string, workingDir?: string, command?: string) => string;
  elapsed: (ms: number) => string;
  statusLineSegments: (text: string) => { text: string; color: string; bold: boolean; dim: boolean }[][];
  enterSends: (ev: Record<string, unknown>, touch: boolean) => boolean;
  sendPayload: (v: string) => string | null;
  slashQuery: (value: string, caret?: number) => string | null;
  slashMatches: (commands: { name: string; description?: string }[], query: string) => { name: string }[];
  slashIntent: (value: string) => { kind: string; name: string } | null;
}

function loadHelpers(): ChatHelpers {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
  return (context.window as { CodemanChatView: ChatHelpers }).CodemanChatView;
}

describe('CodemanChatView helpers', () => {
  const h = loadHelpers();

  it('leaves out keep-warm turns and messages without text', () => {
    const shown = h.visibleMessages([
      { role: 'user', text: 'Fix it', turn: 1 },
      { role: 'assistant', text: 'Done.', turn: 1 },
      { role: 'user', text: 'nudge', turn: 2, keepAlive: true },
      { role: 'assistant', text: 'ok', turn: 2, keepAlive: true },
      { role: 'assistant', text: '   ', turn: 3 },
      null,
    ]);
    expect(shown.map((m) => m.text)).toEqual(['Fix it', 'Done.']);
    expect(h.visibleMessages(undefined)).toEqual([]);
  });

  it('appends when the thread only grew, and redraws when it changed', () => {
    expect(h.renderPlan(['a', 'b'], ['a', 'b'])).toEqual({ mode: 'none' });
    expect(h.renderPlan(['a', 'b'], ['a', 'b', 'c'])).toEqual({ mode: 'append', from: 2 });
    expect(h.renderPlan([], ['a'])).toEqual({ mode: 'append', from: 0 });
    expect(h.renderPlan(['a', 'b'], ['a', 'x', 'c'])).toEqual({ mode: 'replace' });
    expect(h.renderPlan(['a', 'b'], ['a'])).toEqual({ mode: 'replace' });
  });

  it('keys a message by role, turn and text', () => {
    const a = h.messageKey({ role: 'user', text: 'hi', turn: 1 });
    expect(h.messageKey({ role: 'user', text: 'hi', turn: 1 })).toBe(a);
    expect(h.messageKey({ role: 'user', text: 'hi', turn: 2 })).not.toBe(a);
    expect(h.messageKey({ role: 'assistant', text: 'hi', turn: 1 })).not.toBe(a);
  });

  it('folds a prompt over 12 lines to its first 6, and one enormous line too', () => {
    const short = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    expect(h.promptFold(short).folded).toBe(false);
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const fold = h.promptFold(long);
    expect(fold.folded).toBe(true);
    expect(fold.totalLines).toBe(30);
    expect(fold.head.split('\n')).toHaveLength(6);
    const wide = h.promptFold('x'.repeat(5000));
    expect(wide.folded).toBe(true);
    expect(wide.head.length).toBeLessThanOrEqual(801);
  });

  it('sends on Enter on a desktop, never during an IME composition or with Shift', () => {
    expect(h.enterSends({ key: 'Enter' }, false)).toBe(true);
    expect(h.enterSends({ key: 'Enter', shiftKey: true }, false)).toBe(false);
    expect(h.enterSends({ key: 'Enter', altKey: true }, false)).toBe(false);
    expect(h.enterSends({ key: 'Enter', isComposing: true }, false)).toBe(false);
    expect(h.enterSends({ key: 'Enter', keyCode: 229 }, false)).toBe(false);
    expect(h.enterSends({ key: 'a' }, false)).toBe(false);
  });

  it('adds a line on Enter on a touch device, where only Send or Ctrl+Enter sends', () => {
    expect(h.enterSends({ key: 'Enter' }, true)).toBe(false);
    expect(h.enterSends({ key: 'Enter', ctrlKey: true }, true)).toBe(true);
    expect(h.enterSends({ key: 'Enter', metaKey: true }, true)).toBe(true);
  });

  it("unwraps Claude Code's pasted_content tag so a pasted prompt keeps its lines", () => {
    expect(h.promptText('<pasted_content id="a9da">\nline 1\nline 2\n</pasted_content>')).toBe('line 1\nline 2');
    expect(h.promptText('before <pasted_content>x</pasted_content> after')).toBe('before x after');
    // Claude Code 2.1.331 repeats the id on the closing tag.
    expect(h.promptText('<pasted_content id="a9da">\nA\nB\n</pasted_content id="a9da">')).toBe('A\nB');
    expect(h.promptText('a <pasted_content id="1"> left open')).toBe('a <pasted_content id="1"> left open');
    expect(h.promptText('plain')).toBe('plain');
  });

  it('confirms a pending prompt only once a NEW copy of it is in the transcript', () => {
    const msgs: Msg[] = [
      { role: 'user', text: 'again', turn: 1 },
      { role: 'assistant', text: 'again', turn: 1 },
      { role: 'user', text: '<pasted_content id="1">\nline a\nline b\n</pasted_content id="1">', turn: 2 },
    ];
    expect(h.promptCount(msgs, 'again')).toBe(1);
    expect(h.promptCount(msgs, 'line a\r\nline b  ')).toBe(1);
    expect(h.pendingConfirmed({ text: 'again', baseline: 1 }, msgs)).toBe(false);
    expect(h.pendingConfirmed({ text: 'again', baseline: 0 }, msgs)).toBe(true);
    expect(h.pendingConfirmed({ text: 'missing', baseline: 0 }, msgs)).toBe(false);
  });

  it('says what the agent is doing the way the CLI does, with workspace paths made relative', () => {
    expect(h.activity(undefined, '', '/w')).toBe('Working');
    expect(h.activity('Read', '/w/src/a.ts', '/w')).toBe('Reading src/a.ts');
    expect(h.activity('Read', '/w/src/a.ts', '/w/')).toBe('Reading src/a.ts');
    expect(h.activity('Read', '/other/a.ts', '/w')).toBe('Reading /other/a.ts');
    expect(h.activity('Edit', '/w/app.js', '/w')).toBe('Editing app.js');
    expect(h.activity('Bash', 'npm test', '/w')).toBe('Running npm test');
    expect(h.activity('Grep', 'TODO in src', '/w')).toBe('Searching for TODO in src');
    expect(h.activity('Task', '', '/w')).toBe('Running agent');
    expect(h.activity('TodoWrite', '', '/w')).toBe('Updating the to-do list');
    expect(h.activity('mcp__db__query', 'select 1', '/w')).toBe('mcp__db__query: select 1');
    expect(h.activity('SomethingNew', '', '/w')).toBe('SomethingNew');
    // A described command: the description alone, as the CLI's headline.
    expect(h.activity('Bash', 'Listing changes', '/w', 'git diff')).toBe('Listing changes');
  });

  it('turns a statusline into styled segments, mapping colours to names and dropping extended ones', () => {
    const lines = h.statusLineSegments(
      '\u001b[36m/w\u001b[0m \u001b[2m5h:\u001b[0m \u001b[1;31m91%\u001b[0m\nx\u001b[38;5;208my\u001b[39mz'
    );
    expect(lines).toHaveLength(2);
    expect(lines[0].map((s) => [s.text, s.color, s.bold, s.dim])).toEqual([
      ['/w', 'cyan', false, false],
      [' ', '', false, false],
      ['5h:', '', false, true],
      [' ', '', false, false],
      ['91%', 'red', true, false],
    ]);
    expect(lines[1].map((s) => [s.text, s.color])).toEqual([
      ['x', ''],
      ['y', ''],
      ['z', ''],
    ]);
    expect(h.statusLineSegments('plain')).toEqual([[{ text: 'plain', color: '', bold: false, dim: false }]]);
  });

  it('formats the running time like the CLI', () => {
    expect(h.elapsed(0)).toBe('0s');
    expect(h.elapsed(14_900)).toBe('14s');
    expect(h.elapsed(125_000)).toBe('2m 05s');
    expect(h.elapsed(3_780_000)).toBe('1h 03m');
    expect(h.elapsed(-5)).toBe('0s');
  });

  it('builds the pane payload: newlines kept, trailing space dropped, one submitting CR', () => {
    expect(h.sendPayload('hello')).toBe('hello\r');
    expect(h.sendPayload('a\r\nb\n\n  ')).toBe('a\nb\r');
    expect(h.sendPayload('  \n ')).toBeNull();
    expect(h.sendPayload('')).toBeNull();
  });
});

describe('slash command helpers', () => {
  const h = loadHelpers();

  it('reads the word after / only while the caret is still in the first word', () => {
    expect(h.slashQuery('/', 1)).toBe('');
    expect(h.slashQuery('/rev', 4)).toBe('rev');
    expect(h.slashQuery('/review the diff', 3)).toBe('review');
    expect(h.slashQuery('/review the diff', 10)).toBeNull();
    expect(h.slashQuery('hello /rev', 10)).toBeNull();
    expect(h.slashQuery(' /rev', 4)).toBeNull();
  });

  it('ranks an exact name, then name prefixes, word prefixes, substrings and descriptions', () => {
    const commands = [
      { name: 'anthropic-skills:pdf', description: 'PDF files' },
      { name: 'code-review', description: 'Review the diff' },
      { name: 'compact', description: 'Summarize the conversation' },
      { name: 'dual-review', description: 'Two reviewers' },
      { name: 'preview', description: '' },
      { name: 'review', description: '' },
      { name: 'reviewer-notes', description: '' },
      { name: 'skills', description: 'List available skills' },
    ];
    expect(h.slashMatches(commands, 'review').map((c) => c.name)).toEqual([
      'review',
      'reviewer-notes',
      'code-review',
      'dual-review',
      'preview',
    ]);
    expect(h.slashMatches(commands, 'PDF').map((c) => c.name)).toEqual(['anthropic-skills:pdf']);
    expect(h.slashMatches(commands, 'conversation').map((c) => c.name)).toEqual(['compact']);
    // A description counts only where one of its words starts with the query.
    expect(h.slashMatches(commands, 'ers')).toEqual([]);
    expect(h.slashMatches(commands, 'two').map((c) => c.name)).toEqual(['dual-review']);
    expect(h.slashMatches(commands, 'iew').map((c) => c.name)).toEqual([
      'code-review',
      'dual-review',
      'preview',
      'review',
      'reviewer-notes',
    ]);
    expect(h.slashMatches(commands, '')).toHaveLength(commands.length);
    expect(h.slashMatches(commands, 'zzz')).toEqual([]);
  });
});

// ─── The module in a DOM ──────────────────────────────────────────────────────

type Api = ReturnType<typeof vi.fn>;

interface ChatApp {
  activeSessionId: string | null;
  sessions: Map<string, Record<string, unknown>>;
  pendingHooks: Map<string, Set<string>>;
  _api: Api;
  _apiJson: Api;
  showToast: Api;
  _sendInputAsync: Api;
  loadAppSettingsFromStorage: () => Record<string, unknown>;
  _admitPromptAttachments?: Api;
  _uploadAndInsertImages?: Api;
  _chatViewAttach: (files: File[]) => Promise<void>;
  _chatViewReload: () => void;
  onChatViewTurnEvent: (id: string, idle: boolean, keepAlive?: boolean) => void;
  chatViewEligible: (id: string) => boolean;
  chatViewModeFor: (id: string) => string;
  setChatViewMode: (id: string, mode: string) => void;
  onChatViewActiveSession: (id: string) => void;
  onChatViewHooksChanged: (id: string) => void;
  _onChatViewTranscriptUpdate: (d: { sessionId: string }) => void;
  _chatViewFetch: () => Promise<void>;
  _chatViewSend: () => Promise<void>;
  _chatViewForget: (id: string) => void;
  _chatViewSlashUpdate: () => void;
  _chatView: {
    slashMenu: HTMLElement;
    root: HTMLElement;
    toggle: HTMLElement;
    thread: HTMLElement;
    dialog: HTMLElement;
    input: HTMLTextAreaElement;
    sendBtn: HTMLButtonElement;
    stopBtn: HTMLButtonElement;
    status: HTMLElement;
    statusText: HTMLElement;
    statusTimer: unknown;
  };
}

function loadModule(opts: { messages?: Msg[][] } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body><input type="file" id="attachFileInput" accept="image/*,.pdf">
     <div class="terminal-wrap"><div id="terminalContainer"></div></div></body>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/' }
  );
  const win = dom.window as unknown as Window & { eval: (s: string) => unknown; [k: string]: unknown };
  win.__codemanChatViewModes = ['claude'];
  // The window has a Date of its own. Tie it to the test's clock, so vi.setSystemTime reaches
  // the module's elapsed times.
  (win.Date as DateConstructor).now = () => Date.now();
  win.eval('class CodemanApp {}; window.CodemanApp = CodemanApp;');
  win.eval(read('constants.js'));
  win.eval(read('chat-view.js'));
  const proto = (win.CodemanApp as { prototype: object }).prototype;

  const pages = [...(opts.messages ?? [[]])];
  const app = Object.assign(Object.create(proto), {
    activeSessionId: 's1',
    sessions: new Map<string, Record<string, unknown>>([
      ['s1', { id: 's1', mode: 'claude', status: 'idle' }],
      ['s2', { id: 's2', mode: 'claude', status: 'idle', remote: { hostId: 'h' } }],
      ['s3', { id: 's3', mode: 'claude', status: 'idle', adopt: { target: 'x' } }],
      ['s4', { id: 's4', mode: 'codex', status: 'idle' }],
      ['s5', { id: 's5', mode: 'claude', status: 'idle', docker: { caseName: 'box' } }],
    ]),
    pendingHooks: new Map<string, Set<string>>(),
    loadAppSettingsFromStorage: () => ({}),
    _getResponseViewerAgentLabel: () => 'Claude',
    _buildResponseViewerMessage: (text: string, role: string, _label: string, meta?: { continuation?: boolean }) => {
      const div = win.document.createElement('div');
      div.className = `rv-message rv-msg-${role}`;
      if (meta?.continuation) div.classList.add('rv-msg-cont');
      const body = win.document.createElement('div');
      body.className = 'rv-text';
      body.textContent = text;
      div.appendChild(body);
      return div;
    },
    _bindResponseViewerInteractions: () => {},
    _api: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true }) })),
    _apiJson: vi.fn(async () => ({ messages: pages.length > 1 ? pages.shift() : pages[0] })),
    showToast: vi.fn(),
    _sendInputAsync: vi.fn(),
    terminal: { focus: vi.fn() },
  }) as ChatApp;
  return { dom, win, app };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('chat view module', () => {
  it('is offered only for sessions whose run mode has a Claude transcript, local or Docker', () => {
    const { app } = loadModule();
    expect(app.chatViewEligible('s1')).toBe(true);
    expect(app.chatViewEligible('s5')).toBe(true); // Docker
    expect(app.chatViewEligible('s2')).toBe(false); // remote
    expect(app.chatViewEligible('s3')).toBe(false); // adopted
    expect(app.chatViewEligible('s4')).toBe(false); // not in __codemanChatViewModes
    expect(app.chatViewEligible('missing')).toBe(false);
  });

  it('is not offered on a phone, even one turned to landscape', () => {
    const { win, app } = loadModule();
    // A phone in landscape is wider than the phone breakpoint, so its width says "desktop".
    win.MobileDetection = { isHandheldDevice: () => true, getDeviceType: () => 'desktop' };
    expect(app.chatViewEligible('s1')).toBe(false);
    win.MobileDetection = { isHandheldDevice: () => false, getDeviceType: () => 'desktop' };
    expect(app.chatViewEligible('s1')).toBe(true);
  });

  it('opens in Chat when the device setting says so, unless the session remembers Terminal', () => {
    const { win, app } = loadModule();
    app.loadAppSettingsFromStorage = () => ({ chatViewDefault: true });
    expect(app.chatViewModeFor('s1')).toBe('chat');
    win.localStorage.setItem('codeman:chatViewModes', JSON.stringify({ s1: 'terminal' }));
    expect(app.chatViewModeFor('s1')).toBe('terminal');
  });

  it('marks the body while Chat shows, so the keyboard accessory bar stays hidden', () => {
    const { win, app } = loadModule();
    app.onChatViewActiveSession('s1');
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(false);
    app.setChatViewMode('s1', 'chat');
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(true);
    app.setChatViewMode('s1', 'terminal');
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(false);
  });

  it('moves a focus that lands in the hidden terminal to the message box', () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const inner = win.document.createElement('textarea');
    win.document.getElementById('terminalContainer')!.appendChild(inner);
    inner.focus();
    expect(win.document.activeElement).toBe(app._chatView.input);
  });

  it('starts in Terminal, covers the terminal once Chat is picked, and remembers the choice', async () => {
    const { win, app } = loadModule({ messages: [[{ role: 'user', text: 'Hi', turn: 1 }]] });
    app.onChatViewActiveSession('s1');
    expect(app.chatViewModeFor('s1')).toBe('terminal');
    expect(app._chatView.toggle.hidden).toBe(false);
    expect(app._chatView.root.hidden).toBe(true);

    app.setChatViewMode('s1', 'chat');
    await settle();
    expect(app._chatView.root.hidden).toBe(false);
    // The terminal stays in the DOM underneath: nothing is removed or resized.
    expect(win.document.getElementById('terminalContainer')).not.toBeNull();
    expect(win.document.querySelector('.terminal-wrap')!.classList.contains('chat-view-active')).toBe(true);
    expect(app._apiJson).toHaveBeenCalledWith('/api/sessions/s1/last-response?context=full');
    expect(JSON.parse(win.localStorage.getItem('codeman:chatViewModes')!)).toEqual({ s1: 'chat' });

    // The per-session turn and command-menu state goes with the session too.
    const state = app as unknown as Record<string, Map<string, unknown> | Set<string>>;
    state._chatViewTurnStarts = new Map([['s1', 1]]);
    state._chatViewIdleSeen = new Set(['s1']);
    state._chatViewKeepAliveTurns = new Set(['s1']);
    state._chatViewSlashCache = new Map([['s1', { commands: [] }]]);

    app._chatViewForget('s1');
    expect(win.localStorage.getItem('codeman:chatViewModes')).toBe('{}');
    for (const key of ['_chatViewTurnStarts', '_chatViewIdleSeen', '_chatViewKeepAliveTurns', '_chatViewSlashCache']) {
      expect(state[key].has('s1')).toBe(false);
    }
  });

  it('shows the Chat / Terminal switch when the device has no showChatViewSwitch setting', () => {
    const { app } = loadModule();
    app.loadAppSettingsFromStorage = () => ({});
    app.onChatViewActiveSession('s1');
    expect(app._chatView.toggle.hidden).toBe(false);
    app.loadAppSettingsFromStorage = () => ({ showChatViewSwitch: true });
    app._chatViewSync();
    expect(app._chatView.toggle.hidden).toBe(false);
  });

  it('hides the switch when the setting is off, while Alt+Shift+C still switches views', async () => {
    const { win, app } = loadModule({ messages: [[{ role: 'user', text: 'Hi', turn: 1 }]] });
    app.loadAppSettingsFromStorage = () => ({ showChatViewSwitch: false });
    app.onChatViewActiveSession('s1');
    expect(app._chatView.toggle.hidden).toBe(true);

    app.toggleChatView();
    await settle();
    expect(app.chatViewModeFor('s1')).toBe('chat');
    expect(app._chatView.root.hidden).toBe(false);
    expect(app._chatView.toggle.hidden).toBe(true);
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(true);

    app.toggleChatView();
    expect(app.chatViewModeFor('s1')).toBe('terminal');
    expect(app._chatView.root.hidden).toBe(true);

    // A settings save re-syncs: turning the setting back on shows the switch again.
    app.loadAppSettingsFromStorage = () => ({ showChatViewSwitch: true });
    app._chatViewSync();
    expect(app._chatView.toggle.hidden).toBe(false);
  });

  it('hides the toggle for a session that cannot show the chat view', () => {
    const { app } = loadModule();
    app.onChatViewActiveSession('s1');
    app.activeSessionId = 's4';
    app.onChatViewActiveSession('s4');
    expect(app._chatView.toggle.hidden).toBe(true);
    expect(app._chatView.root.hidden).toBe(true);
  });

  it('draws the conversation without keep-warm turns, folds long prompts and appends new messages', async () => {
    const long = Array.from({ length: 20 }, (_, i) => `log ${i}`).join('\n');
    const first: Msg[] = [
      { role: 'user', text: long, turn: 1 },
      { role: 'assistant', text: 'Looked at it.', turn: 1 },
      { role: 'user', text: 'keep-warm nudge', turn: 2, keepAlive: true },
      { role: 'assistant', text: 'keep-warm reply', turn: 2, keepAlive: true },
    ];
    const second: Msg[] = [...first, { role: 'user', text: 'Next', turn: 3 }];
    const { app } = loadModule({ messages: [first, second] });
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await settle();

    const nodes = Array.from(app._chatView.thread.children) as HTMLElement[];
    expect(nodes).toHaveLength(2);
    expect(nodes[0].querySelector('.chat-view-show-all')!.textContent).toBe('Show all (20 lines)');
    expect(nodes[0].textContent).not.toContain('log 10');
    expect(app._chatView.thread.textContent).not.toContain('keep-warm');

    await app._chatViewFetch();
    const after = Array.from(app._chatView.thread.children);
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(nodes[0]); // appended, not redrawn

    (nodes[0].querySelector('.chat-view-show-all') as HTMLButtonElement).click();
    expect(app._chatView.thread.children[0].textContent).toContain('log 19');
  });

  it('sends through the HTTP input route with useMux, so the server presses and verifies Enter', async () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    app._chatView.input.value = 'line one\nline two  ';
    await app._chatViewSend();
    expect(app._api).toHaveBeenCalledTimes(1);
    const [url, init] = app._api.mock.calls[0] as [string, { method: string; body: Record<string, unknown> }];
    expect(url).toBe('/api/sessions/s1/input');
    expect(init.method).toBe('POST');
    expect(init.body).toMatchObject({ input: 'line one\nline two\r', useMux: true, seq: 1 });
    expect(typeof init.body.clientId).toBe('string');
    expect(app._chatView.input.value).toBe('');
    expect(app._sendInputAsync).not.toHaveBeenCalled();
  });

  it('retries a failed request with the same clientId and seq, so the server applies it once', async () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    app._api
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });
    app._chatView.input.value = 'hello';
    await app._chatViewSend();
    expect(app._api).toHaveBeenCalledTimes(2);
    const bodies = app._api.mock.calls.map((c) => (c[1] as { body: { clientId: string; seq: number } }).body);
    expect(bodies[1].clientId).toBe(bodies[0].clientId);
    expect(bodies[1].seq).toBe(bodies[0].seq);
    expect(app._chatView.input.value).toBe('');
  });

  it('shows a sent prompt at once, below the conversation, until the transcript has it', async () => {
    const before: Msg[] = [{ role: 'user', text: 'Hi', turn: 1 }];
    const working: Msg[] = [...before, { role: 'assistant', text: 'Hello.', turn: 1 }];
    const after: Msg[] = [...working, { role: 'user', text: 'Next question', turn: 2 }];
    const { app } = loadModule({ messages: [before, working, after] });
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await settle();

    let resolvePost: (v: unknown) => void = () => {};
    app._api.mockImplementationOnce(() => new Promise((r) => (resolvePost = r)));
    app._chatView.input.value = 'Next question';
    const sending = app._chatViewSend();
    // Drawn before the request has even answered, and the box is already empty.
    const pending = app._chatView.thread.querySelector('.chat-view-msg-pending') as HTMLElement;
    // Drawn exactly as the transcript will draw it: no "sending" marker of any kind.
    expect(pending.textContent).toBe('Next question');
    expect(app._chatView.input.value).toBe('');
    resolvePost({ ok: true, status: 200, json: async () => ({ success: true }) });
    await sending;
    expect(pending.textContent).toBe('Next question');

    // An answer that lands first is drawn ABOVE the pending prompt.
    await app._chatViewFetch();
    const kids = Array.from(app._chatView.thread.children);
    expect(kids[kids.length - 1]).toBe(pending);
    expect(kids[kids.length - 2].textContent).toBe('Hello.');

    // It was sent while "Hi" had no answer yet, so it was drawn as a continuation (no badge);
    // the answer then landed first, which gives it a turn and a badge of its own.
    expect(pending.classList.contains('rv-msg-cont')).toBe(true);

    // Once the transcript has the prompt, the drawn element BECOMES the real message: the same
    // node stays where it is, and only its badge is corrected.
    await app._chatViewFetch();
    expect(pending.classList.contains('rv-msg-cont')).toBe(false);
    expect(pending.querySelector('.rv-role')!.textContent).toBe('You');
    expect(app._chatView.thread.querySelector('.chat-view-msg-pending')).toBeNull();
    const after2 = Array.from(app._chatView.thread.children);
    expect(after2[after2.length - 1]).toBe(pending);
    expect(
      after2.map((el) => el.querySelector('.rv-text')?.textContent).filter((t) => t === 'Next question')
    ).toHaveLength(1);
  });

  it('lets an unconfirmed pending prompt go after its turn ends', async () => {
    const { app } = loadModule({ messages: [[{ role: 'user', text: 'Hi', turn: 1 }]] });
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await settle();
    app._chatView.input.value = 'something Claude never records';
    await app._chatViewSend();
    const view = app._chatView as unknown as { pending: { postedAt: number }[] };
    expect(view.pending).toHaveLength(1);
    view.pending[0].postedAt -= 5000;
    (app as unknown as { onChatViewTurnEvent: (id: string, idle: boolean) => void }).onChatViewTurnEvent('s1', true);
    await app._chatViewFetch();
    expect(app._chatView.thread.querySelector('.chat-view-msg-pending')).toBeNull();
  });

  it('keeps a sent prompt that starts with / once the transcript records it as a prompt', async () => {
    vi.useFakeTimers();
    try {
      const text = '/home/me/app.log why';
      const before: Msg[] = [
        { role: 'user', text: 'Hi', turn: 1 },
        { role: 'assistant', text: 'Hello.', turn: 1 },
      ];
      const { app } = loadModule({ messages: [before, [...before, { role: 'user', text, turn: 2 }]] });
      app.setChatViewMode('s1', 'chat');
      app.onChatViewActiveSession('s1');
      await vi.advanceTimersByTimeAsync(0);
      app._chatView.input.value = text;
      await app._chatViewSend();
      // The re-read after the send finds the prompt in the transcript and keeps the drawn element.
      await vi.advanceTimersByTimeAsync(300);
      const el = app._chatView.thread.lastElementChild as HTMLElement;
      expect(el.textContent).toBe(text);
      expect(el.classList.contains('chat-view-msg-pending')).toBe(false);
      // The timer that lets an unrecorded slash command go must leave the real message alone.
      await vi.advanceTimersByTimeAsync(4000);
      expect(el.parentElement).toBe(app._chatView.thread);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a sent /compact drawn for as long as its turn runs, until the transcript records it', async () => {
    vi.useFakeTimers();
    try {
      const before: Msg[] = [
        { role: 'user', text: 'Hi', turn: 1 },
        { role: 'assistant', text: 'Hello.', turn: 1 },
      ];
      const { app } = loadModule({ messages: [before] });
      app.setChatViewMode('s1', 'chat');
      app.onChatViewActiveSession('s1');
      await vi.advanceTimersByTimeAsync(0);
      app._chatView.input.value = '/compact';
      await app._chatViewSend();
      app.sessions.get('s1')!.status = 'busy';
      await vi.advanceTimersByTimeAsync(60_000);
      const pending = app._chatView.thread.querySelector('.chat-view-msg-pending') as HTMLElement;
      expect(pending?.textContent).toBe('/compact');

      // Claude writes the command row only when the compaction ends, a minute or more later.
      const after = [...before, { role: 'user', text: '/compact', turn: 2 }];
      (app as unknown as { _apiJson: unknown })._apiJson = vi.fn(async () => ({ messages: after }));
      app.sessions.get('s1')!.status = 'idle';
      (app as unknown as { onChatViewTurnEvent: (id: string, idle: boolean) => void }).onChatViewTurnEvent('s1', true);
      await vi.advanceTimersByTimeAsync(300);
      expect(pending.parentElement).toBe(app._chatView.thread);
      expect(pending.classList.contains('chat-view-msg-pending')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a sent slash command go after a few seconds when it started no turn and was not recorded', async () => {
    vi.useFakeTimers();
    try {
      const { app } = loadModule();
      app.setChatViewMode('s1', 'chat');
      app.onChatViewActiveSession('s1');
      await vi.advanceTimersByTimeAsync(0);
      app._chatView.input.value = '/btw is the build green?';
      await app._chatViewSend();
      expect(app._chatView.thread.querySelector('.chat-view-msg-pending')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(4000);
      expect(app._chatView.thread.querySelector('.chat-view-msg-pending')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the conversation is being compacted, while Claude Code compacts it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    try {
      const { app } = loadModule();
      app.setChatViewMode('s1', 'chat');
      app.onChatViewActiveSession('s1');
      const a = app as unknown as {
        onChatViewTurnEvent: (id: string, idle: boolean) => void;
        _onChatViewToolStart: (d: Record<string, string>) => void;
        _chatView: { statusText: HTMLElement; statusSub: HTMLElement };
      };
      app.sessions.set('s1', { id: 's1', mode: 'claude', status: 'busy', workingDir: '/work' });
      a.onChatViewTurnEvent('s1', false);
      // A tool from earlier in the turn: auto-compaction can start in the middle of one.
      a._onChatViewToolStart({ sessionId: 's1', toolName: 'Bash', detail: 'Run the tests', command: 'npm test' });
      app.sessions.get('s1')!.compacting = true;
      app.onChatViewActiveSession('s1');
      expect(a._chatView.statusText.textContent).toBe('Compacting conversation · 0s');
      expect(a._chatView.statusSub.hidden).toBe(true);

      app.sessions.get('s1')!.compacting = undefined;
      app.onChatViewActiveSession('s1');
      expect(a._chatView.statusText.textContent).toBe('Run the tests · 0s');
      app.setChatViewMode('s1', 'terminal');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends nothing while a dialog waits in the pane, and keeps the text', async () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    app.pendingHooks.set('s1', new Set(['permission_prompt']));
    app.onChatViewHooksChanged('s1');
    const input = app._chatView.input;
    input.value = 'yes, do it';
    input.dispatchEvent(new win.Event('input'));
    expect(app._chatView.sendBtn.disabled).toBe(true);

    await app._chatViewSend();
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    expect(app._api).not.toHaveBeenCalled();
    expect(input.value).toBe('yes, do it');
    expect(app._chatView.thread.querySelector('.chat-view-msg-pending')).toBeNull();
    expect(app.showToast).toHaveBeenCalledWith('Claude is waiting for your answer in the terminal.', 'warning');

    // The dialog was answered: Send works again.
    app.pendingHooks.delete('s1');
    app.onChatViewHooksChanged('s1');
    expect(app._chatView.sendBtn.disabled).toBe(false);
    await app._chatViewSend();
    expect(app._api).toHaveBeenCalledWith('/api/sessions/s1/input', expect.anything());
  });

  it('keeps the text and says why when the server refuses the message', async () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    app._api.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'Input too long' }) });
    app._chatView.input.value = 'hello';
    await app._chatViewSend();
    expect(app._api).toHaveBeenCalledTimes(1);
    expect(app._chatView.input.value).toBe('hello');
    expect(app._chatView.thread.querySelector('.chat-view-msg-pending')).toBeNull();
    expect(app.showToast).toHaveBeenCalledWith('Message not sent: Input too long', 'error');
  });

  it('puts the Working line right under the last message, inside the scrolling list', () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const view = app._chatView as unknown as { status: HTMLElement; thread: HTMLElement; scroller: HTMLElement };
    expect(view.status.parentElement).toBe(view.scroller);
    expect(view.thread.nextElementSibling).toBe(view.status);
  });

  it('shows the running tool and what it works on, with the turn time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1'); // idle: this page sees the turn begin
    app.sessions.set('s1', { id: 's1', mode: 'claude', status: 'busy', workingDir: '/work' });
    const a = app as unknown as {
      onChatViewTurnEvent: (id: string, idle: boolean) => void;
      _onChatViewToolStart: (d: Record<string, string>) => void;
      _chatView: { status: HTMLElement; statusText: HTMLElement; statusSub: HTMLElement; statusTimer: unknown };
    };
    a.onChatViewTurnEvent('s1', false);
    a._onChatViewToolStart({ sessionId: 's1', toolName: 'Read', detail: '/work/src/session.ts' });
    expect(a._chatView.status.hidden).toBe(false);
    expect(a._chatView.statusText.textContent).toBe('Reading src/session.ts · 0s');
    expect(a._chatView.statusTimer).not.toBeNull();
    expect(a._chatView.statusSub.hidden).toBe(true);

    // A described command: the description is the headline and the command goes under it.
    a._onChatViewToolStart({
      sessionId: 's1',
      toolName: 'Bash',
      detail: 'Listing every changed region',
      command: 'git diff -U0 -- .docs/plans',
    });
    expect(a._chatView.statusText.textContent).toBe('Listing every changed region · 0s');
    expect(a._chatView.statusSub.hidden).toBe(false);
    expect(a._chatView.statusSub.textContent).toBe('$ git diff -U0 -- .docs/plans');

    // The clock is the test's: the running time is exactly what passed.
    vi.advanceTimersByTime(5000);
    expect(a._chatView.statusText.textContent).toBe('Listing every changed region · 5s');

    app.sessions.set('s1', { id: 's1', mode: 'claude', status: 'idle', workingDir: '/work' });
    a.onChatViewTurnEvent('s1', true);
    expect(a._chatView.status.hidden).toBe(true);
    expect(a._chatView.statusTimer).toBeNull();
    vi.useRealTimers();
  });

  it('says what still runs in the background between turns, without a running time', () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const status = app._chatView.root.querySelector('.chat-view-status') as HTMLElement;
    expect(status.hidden).toBe(true);

    app.sessions.get('s1')!.watching = '1 shell';
    app.onChatViewActiveSession('s1');
    expect(status.hidden).toBe(false);
    expect(status.classList.contains('chat-view-status--background')).toBe(true);
    expect(status.querySelector('.chat-view-status-text')!.textContent).toBe('1 shell still running');
    // The count comes from the CLI's screen, so only the words after it go through the translator.
    const w = win as unknown as { CodemanI18n?: unknown };
    w.CodemanI18n = { t: (text: string) => (text === 'still running' ? 'X' : text) };
    try {
      app.onChatViewActiveSession('s1');
      expect(status.querySelector('.chat-view-status-text')!.textContent).toBe('1 shell X');
    } finally {
      delete w.CodemanI18n;
    }

    // A new turn takes the line back; the background wording goes once the work ends.
    app.sessions.get('s1')!.status = 'busy';
    app.onChatViewActiveSession('s1');
    expect(status.classList.contains('chat-view-status--background')).toBe(false);
    app.sessions.get('s1')!.status = 'idle';
    app.sessions.get('s1')!.watching = null;
    app.onChatViewActiveSession('s1');
    expect(status.hidden).toBe(true);
  });

  it('counts a turn already running when the page loaded from the last Enter, not from the page load', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    const { app } = loadModule();
    app.sessions.set('s1', {
      id: 's1',
      mode: 'claude',
      status: 'busy',
      workingDir: '/work',
      lastSubmitAt: Date.now() - 73_000,
    });
    app.setChatViewMode('s1', 'chat');
    const a = app as unknown as {
      onChatViewTurnEvent: (id: string, idle: boolean) => void;
      _chatView: { statusText: HTMLElement };
    };
    // A working event for a session this page never saw idle says nothing about the turn's start.
    a.onChatViewTurnEvent('s1', false);
    app.onChatViewActiveSession('s1');
    expect(a._chatView.statusText.textContent).toBe('Working · 1m 13s');
    // Stop the status line's ticking before the real clock comes back.
    app.setChatViewMode('s1', 'terminal');
    vi.useRealTimers();
  });

  it("shows no status line and no Stop button during Codeman's keep-alive turn", () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const session = app.sessions.get('s1')!;
    session.status = 'busy';
    app.onChatViewTurnEvent('s1', false, true);
    expect(app._chatView.status.hidden).toBe(true);
    expect(app._chatView.stopBtn.hidden).toBe(true);

    session.status = 'idle';
    app.onChatViewTurnEvent('s1', true, true);
    // A real turn shows both again.
    session.status = 'busy';
    app.onChatViewTurnEvent('s1', false);
    expect(app._chatView.status.hidden).toBe(false);
    expect(app._chatView.stopBtn.hidden).toBe(false);
    session.status = 'idle';
    app.onChatViewTurnEvent('s1', true);
  });

  it("makes a running keep-alive turn the user's once a prompt is sent into it", async () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const session = app.sessions.get('s1')!;
    session.status = 'busy';
    app.onChatViewTurnEvent('s1', false, true);
    expect(app._chatView.stopBtn.hidden).toBe(true);

    app._chatView.input.value = 'my own prompt';
    await app._chatViewSend();
    const a = app as unknown as { _chatViewBusy: (id: string) => boolean };
    expect(a._chatViewBusy('s1')).toBe(true);
    expect(app._chatView.stopBtn.hidden).toBe(false);
    expect(app._chatView.status.hidden).toBe(false);
    session.status = 'idle';
    app.onChatViewTurnEvent('s1', true);
  });

  it('interrupts the running turn with Esc from the Stop button', () => {
    const { app } = loadModule();
    app.sessions.get('s1')!.status = 'busy';
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    expect(app._chatView.stopBtn.hidden).toBe(false);
    app._chatView.stopBtn.click();
    expect(app._sendInputAsync).toHaveBeenCalledWith('s1', '\x1b');
    app.setChatViewMode('s1', 'terminal');
  });

  /** A Chat session that is busy, on a device that is touch or not, with app.js's focus rule. */
  function loadForFocus(touch: boolean) {
    const loaded = loadModule();
    const { win, app } = loaded;
    // The rule the app applies to a tab switch (app.js), run as written.
    const appJs = read('app.js');
    const method = appJs.match(/\n {2}_shouldFocusTerminalForTabSwitch\(\) \{[\s\S]*?\n {2}\}\n/)![0];
    Object.assign(app, win.eval(`({${method}})`) as object);
    win.MobileDetection = {
      isHandheldDevice: () => false,
      getDeviceType: () => (touch ? 'tablet' : 'desktop'),
      isTouchDevice: () => touch,
    };
    win.KeyboardHandler = { keyboardVisible: false };
    app.sessions.get('s1')!.status = 'busy';
    app.setChatViewMode('s1', 'terminal');
    return loaded;
  }
  const nextFrame = (win: Window) => new Promise<void>((r) => win.requestAnimationFrame(() => r()));

  it('keeps the on-screen keyboard down on a touch device: no focus on a switch to Chat or on Stop', async () => {
    const { win, app } = loadForFocus(true);
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await nextFrame(win);
    expect(win.document.activeElement).not.toBe(app._chatView.input);
    app._chatView.stopBtn.click();
    expect(app._sendInputAsync).toHaveBeenCalledWith('s1', '\x1b');
    expect(win.document.activeElement).not.toBe(app._chatView.input);
  });

  it('focuses the message box on a desktop, on a switch to Chat and after Stop', async () => {
    const { win, app } = loadForFocus(false);
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await nextFrame(win);
    expect(win.document.activeElement).toBe(app._chatView.input);
    app._chatView.input.blur();
    app._chatView.stopBtn.click();
    expect(win.document.activeElement).toBe(app._chatView.input);
  });

  it('unfolds a long prompt with the badge it shows now, not the one it was drawn with', () => {
    const { win, app } = loadModule();
    const a = app as unknown as {
      _buildResponseViewerMessage: (t: string, r: string, l: string, m?: { continuation?: boolean }) => HTMLElement;
      _chatViewBuildMessage: (m: Msg, label: string, continuation: boolean) => HTMLElement;
      _chatViewSetUserBadge: (el: HTMLElement, badge: boolean) => void;
    };
    // As the real builder does: a prompt that is not a continuation carries its "You" badge.
    const build = a._buildResponseViewerMessage;
    a._buildResponseViewerMessage = (text, role, label, meta) => {
      const el = build(text, role, label, meta);
      if (!meta?.continuation) {
        const badge = win.document.createElement('div');
        badge.className = 'rv-role rv-role-user';
        el.prepend(badge);
      }
      return el;
    };
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const el = a._chatViewBuildMessage({ role: 'user', text: long, turn: 1 }, 'Claude', true);
    expect(el.classList.contains('rv-msg-cont')).toBe(true);
    a._chatViewSetUserBadge(el, true);
    (el.querySelector('.chat-view-show-all') as HTMLButtonElement).click();
    expect(el.querySelector(':scope > .rv-role')).not.toBeNull();
    expect(el.classList.contains('rv-msg-cont')).toBe(false);
  });

  it('uploads attached files and puts their paths in the message box, never in the pane', async () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const file = new win.File(['x'], 'a.png', { type: 'image/png' });
    app._admitPromptAttachments = vi.fn((files: File[]) => files);
    app._uploadAndInsertImages = vi.fn(async () => ['/w/.codeman-uploads/a.png']);
    app._chatView.input.value = 'look at';
    await app._chatViewAttach([file]);
    expect(app._uploadAndInsertImages).toHaveBeenCalledWith([file], { insert: false, sessionId: 's1' });
    expect(app._chatView.input.value).toBe('look at /w/.codeman-uploads/a.png ');
  });

  it('uploads a pasted screenshot like an attached file, and leaves a plain text paste to the browser', async () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const file = new win.File(['x'], 'image.png', { type: 'image/png' });
    app._admitPromptAttachments = vi.fn((files: File[]) => files);
    app._uploadAndInsertImages = vi.fn(async () => ['/w/.codeman-uploads/image.png']);
    const paste = (items: { getAsFile: () => File | null }[], text: string) => {
      const ev = new win.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { value: { items, getData: () => text } });
      app._chatView.input.dispatchEvent(ev);
      return ev;
    };

    const textOnly = paste([{ getAsFile: () => null }], 'just text');
    expect(textOnly.defaultPrevented).toBe(false);
    expect(app._uploadAndInsertImages).not.toHaveBeenCalled();

    const shot = paste([{ getAsFile: () => file }], '');
    expect(shot.defaultPrevented).toBe(true);
    expect(app._admitPromptAttachments).toHaveBeenCalledWith([file], { textPasted: false });
    await settle();
    expect(app._uploadAndInsertImages).toHaveBeenCalledWith([file], { insert: false, sessionId: 's1' });
    expect(app._chatView.input.value).toBe('/w/.codeman-uploads/image.png ');

    // A file the attach rules refuse is not uploaded, and the paste goes on as text.
    app._admitPromptAttachments = vi.fn(() => []);
    const refused = paste([{ getAsFile: () => file }], 'name.exe');
    expect(refused.defaultPrevented).toBe(false);
    expect(app._uploadAndInsertImages).toHaveBeenCalledTimes(1);
  });

  it('draws the statusline under the message box and follows its changes', () => {
    const { app } = loadModule();
    app.sessions.set('s1', { id: 's1', mode: 'claude', status: 'idle', statusLine: '\u001b[32mctx: 5%\u001b[0m' });
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const a = app as unknown as {
      _onChatViewStatusLine: (d: { sessionId: string; text: string }) => void;
      _chatView: { statusline: HTMLElement; root: HTMLElement };
    };
    const line = a._chatView.statusline;
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe('ctx: 5%');
    expect(line.querySelector('.sl-green')!.textContent).toBe('ctx: 5%');
    // Below the message box, as in the CLI.
    expect(a._chatView.root.lastElementChild).toBe(line);

    a._onChatViewStatusLine({ sessionId: 's1', text: '<b>not html</b>' });
    expect(line.textContent).toBe('<b>not html</b>');
    expect(line.querySelector('b')).toBeNull();
    a._onChatViewStatusLine({ sessionId: 's1', text: '' });
    expect(line.hidden).toBe(true);
  });

  it('shows the waiting notice while a permission prompt or question is pending', () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    expect(app._chatView.dialog.hidden).toBe(true);
    app.pendingHooks.set('s1', new Set(['elicitation_dialog']));
    app.onChatViewHooksChanged('s1');
    expect(app._chatView.dialog.hidden).toBe(false);
    app.pendingHooks.set('s1', new Set(['idle_prompt']));
    app.onChatViewHooksChanged('s1');
    expect(app._chatView.dialog.hidden).toBe(true);
    // Claude's AskUserQuestion, plan approval and permission dialogs arrive as permission_prompt.
    app.pendingHooks.set('s1', new Set(['permission_prompt']));
    app.onChatViewHooksChanged('s1');
    expect(app._chatView.dialog.hidden).toBe(false);
  });

  it('re-reads on transcript:update only for its own session and only while showing', () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const reload = vi.spyOn(app, '_chatViewReload').mockImplementation(() => {});
    app._onChatViewTranscriptUpdate({ sessionId: 's1' });
    expect(reload).toHaveBeenCalledTimes(1);
    app._onChatViewTranscriptUpdate({ sessionId: 's2' });
    expect(reload).toHaveBeenCalledTimes(1);
    app.setChatViewMode('s1', 'terminal');
    app._onChatViewTranscriptUpdate({ sessionId: 's1' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reads nothing once hidden, even for a re-read armed while Chat showed', async () => {
    vi.useFakeTimers();
    try {
      const { app } = loadModule();
      app.setChatViewMode('s1', 'chat');
      app.onChatViewActiveSession('s1');
      await vi.advanceTimersByTimeAsync(0);
      const reads = app._apiJson.mock.calls.length;
      app._onChatViewTranscriptUpdate({ sessionId: 's1' });
      app.setChatViewMode('s1', 'terminal');
      await vi.advanceTimersByTimeAsync(300);
      expect(app._apiJson.mock.calls.length).toBe(reads);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays hidden while the tile grid owns the terminal, so the keyboard bar shows for the tiles', () => {
    const { win, app } = loadModule();
    const a = app as unknown as {
      _tileGrid?: { open: boolean };
      _tilesOwnTerminal: () => boolean;
      _chatViewSync: () => void;
    };
    a._tilesOwnTerminal = () => !!a._tileGrid?.open;
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(true);

    a._tileGrid = { open: true };
    a._chatViewSync();
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(false);
    expect(app._chatView.root.hidden).toBe(true);

    a._tileGrid = { open: false };
    a._chatViewSync();
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(true);
    expect(app._chatView.root.hidden).toBe(false);
  });
});

describe('chat view slash menu', () => {
  const commands = [
    { name: 'clear', description: 'Start a new session', kind: 'builtin' },
    { name: 'code-review', description: 'Review the current diff', kind: 'skill' },
    { name: 'compact', description: 'Free up context', kind: 'builtin' },
  ];

  async function openMenu(value: string) {
    const loaded = loadModule();
    const { app, win } = loaded;
    app._apiJson.mockImplementation(async (url: string) =>
      url.endsWith('/slash-commands') ? { commands } : { messages: [] }
    );
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await settle();
    const input = app._chatView.input;
    input.focus();
    input.value = value;
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new win.Event('input'));
    await settle();
    await settle();
    return loaded;
  }

  const key = (win: Window, input: HTMLElement, k: string, extra: Record<string, unknown> = {}) => {
    const ev = new (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', {
      key: k,
      bubbles: true,
      cancelable: true,
      ...extra,
    });
    input.dispatchEvent(ev);
    return ev;
  };

  const rows = (app: ChatApp) =>
    Array.from(app._chatView.slashMenu.querySelectorAll('.chat-view-slash-item')).map(
      (row) => row.querySelector('.chat-view-slash-name')!.textContent
    );

  it("reads the session's commands once and lists the ones matching what follows /", async () => {
    const { app } = await openMenu('/c');
    expect(app._apiJson).toHaveBeenCalledWith('/api/sessions/s1/slash-commands');
    expect(app._chatView.slashMenu.hidden).toBe(false);
    expect(rows(app)).toEqual(['/clear', '/code-review', '/compact']);
    expect(app._chatView.input.getAttribute('aria-expanded')).toBe('true');
  });

  it('moves with the arrows and completes with Tab, keeping the rest of the message', async () => {
    const { app, win } = await openMenu('/co');
    expect(rows(app)).toEqual(['/code-review', '/compact']);
    key(win, app._chatView.input, 'ArrowDown');
    expect(app._chatView.slashMenu.querySelector('[aria-selected="true"]')!.textContent).toContain('/compact');
    const ev = key(win, app._chatView.input, 'Tab');
    expect(ev.defaultPrevented).toBe(true);
    expect(app._chatView.input.value).toBe('/compact ');
    expect(app._chatView.slashMenu.hidden).toBe(true);
  });

  it('completes on Enter instead of sending, and sends once the word is a whole command name', async () => {
    const { app, win } = await openMenu('/cle');
    key(win, app._chatView.input, 'Enter');
    expect(app._chatView.input.value).toBe('/clear ');
    expect(app._api).not.toHaveBeenCalled();

    const second = await openMenu('/clear');
    expect(rows(second.app)[0]).toBe('/clear');
    key(second.win, second.app._chatView.input, 'Enter');
    await settle();
    expect(second.app._api).toHaveBeenCalledWith('/api/sessions/s1/input', expect.anything());
  });

  it('closes on Esc, on a caret past the first word, and when nothing matches', async () => {
    const { app, win } = await openMenu('/c');
    key(win, app._chatView.input, 'Escape');
    expect(app._chatView.slashMenu.hidden).toBe(true);

    const typed = await openMenu('/zzz');
    expect(typed.app._chatView.slashMenu.hidden).toBe(true);

    const past = await openMenu('/clear now');
    expect(past.app._chatView.slashMenu.hidden).toBe(true);
  });
});

describe('chat view slash commands that do more than send', () => {
  const h = loadHelpers();

  it('tells /quit, /exit, /clear and other bare commands apart, and leaves commands with arguments alone', () => {
    expect(h.slashIntent(' /quit ')).toEqual({ kind: 'close', name: 'quit' });
    expect(h.slashIntent('/exit')).toEqual({ kind: 'close', name: 'exit' });
    expect(h.slashIntent('/clear')).toEqual({ kind: 'clear', name: 'clear' });
    expect(h.slashIntent('/model')).toEqual({ kind: 'bare', name: 'model' });
    expect(h.slashIntent('/model opus')).toBeNull();
    expect(h.slashIntent('quit')).toBeNull();
    expect(h.slashIntent('/quit now')).toBeNull();
  });

  it('closes the session at once for /quit, the way the close button does, and sends nothing', async () => {
    const { app } = loadModule();
    const close = vi.fn(async () => true);
    (app as unknown as { closeSession: typeof close }).closeSession = close;
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    app._chatView.input.value = '/quit';
    await app._chatViewSend();
    expect(close).toHaveBeenCalledWith('s1', true);
    expect(app._api).not.toHaveBeenCalled();
    expect(app._chatView.input.value).toBe('');
  });

  it('empties the thread on /clear and keeps the old conversation out until the server moves on', async () => {
    const old: Msg[] = [
      { role: 'user', text: 'old prompt', turn: 1, timestamp: '2026-11-25T08:00:00Z' } as Msg,
      { role: 'assistant', text: 'old answer', turn: 1, timestamp: '2026-11-25T08:00:05Z' } as Msg,
    ];
    const fresh: Msg[] = [{ role: 'user', text: 'new prompt', turn: 1, timestamp: '2026-11-25T08:01:00Z' } as Msg];
    const { app } = loadModule({ messages: [old, old, fresh] });
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await settle();
    expect(app._chatView.thread.textContent).toContain('old answer');

    app._chatView.input.value = '/clear';
    await app._chatViewSend();
    expect(app._api).toHaveBeenCalledWith('/api/sessions/s1/input', expect.anything());
    expect(app._chatView.thread.textContent).toBe('');

    // The server still reads the old conversation: nothing of it comes back.
    await app._chatViewFetch();
    expect(app._chatView.thread.textContent).toBe('');
    // The next prompt is the new conversation's, and it shows.
    await app._chatViewFetch();
    expect(app._chatView.thread.textContent).toContain('new prompt');
  });

  it('shows the terminal for a bare picker command without changing the remembered choice', async () => {
    const { app, win } = loadModule();
    app._apiJson.mockImplementation(async (url: string) =>
      url.endsWith('/slash-commands')
        ? {
            commands: [
              { name: 'model', description: '', kind: 'builtin', opensTerminal: true },
              { name: 'recap', description: '', kind: 'builtin' },
            ],
          }
        : { messages: [] }
    );
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await settle();

    app._chatView.input.value = '/recap';
    await app._chatViewSend();
    await settle();
    expect(app.chatViewModeFor('s1')).toBe('chat');

    app._chatView.input.value = '/model';
    await app._chatViewSend();
    await settle();
    expect(app.chatViewModeFor('s1')).toBe('terminal');
    expect(app._chatView.root.hidden).toBe(true);
    expect(JSON.parse(win.localStorage.getItem('codeman:chatViewModes')!)).toEqual({ s1: 'chat' });
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('/model opens in the terminal'), 'info');

    // Switching back ends it.
    app.setChatViewMode('s1', 'chat');
    expect(app.chatViewModeFor('s1')).toBe('chat');
  });

  it('re-reads at once when the server reports the new conversation after /clear', () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const reload = vi.fn();
    (app as unknown as { _chatViewReload: typeof reload })._chatViewReload = reload;
    const handler = (app as unknown as { _onChatViewConversationCleared: (d: unknown) => void })
      ._onChatViewConversationCleared;
    handler.call(app, { sessionId: 's2' });
    expect(reload).not.toHaveBeenCalled();
    handler.call(app, { sessionId: 's1' });
    expect(reload).toHaveBeenCalledWith({ immediate: true });
  });

  it('subscribes to hook:conversation_cleared', () => {
    expect(read('app.js')).toContain("[SSE_EVENTS.HOOK_CONVERSATION_CLEARED, '_onChatViewConversationCleared']");
  });
});

describe('chat view suggested prompt', () => {
  it('shows the suggestion as the placeholder, fills it on Tab, and never sends it on its own', async () => {
    const { app, win } = loadModule();
    app.sessions.get('s1')!.promptSuggestion = 'commit and push it';
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const input = app._chatView.input;
    expect(input.placeholder).toBe('commit and push it');

    const key = (k: string) => {
      const ev = new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
      input.dispatchEvent(ev);
      return ev;
    };
    key('Enter');
    await settle();
    expect(app._api).not.toHaveBeenCalled();

    expect(key('Tab').defaultPrevented).toBe(true);
    expect(input.value).toBe('commit and push it');

    // With text in the box, Tab is left to the browser.
    expect(key('Tab').defaultPrevented).toBe(false);

    key('Enter');
    await settle();
    expect(app._api).toHaveBeenCalledWith(
      '/api/sessions/s1/input',
      expect.objectContaining({ body: expect.objectContaining({ input: 'commit and push it\r' }) })
    );
    // Sent: the suggestion is gone from the box at once.
    expect(input.placeholder).toBe('Message Claude (Enter to send, Shift+Enter for a new line)');
  });
});

describe('chat view wiring', () => {
  it('swallows the toggle chord in the xterm key handler', () => {
    const terminalUi = read('terminal-ui.js');
    expect(terminalUi).toMatch(/shouldToggleChatViewFromShortcut\?\.\(ev\)\)\s*\{\s*return false;/);
  });

  it('binds Alt+Shift+C to the toggle in the shortcut registry', () => {
    const app = read('app.js');
    expect(app).toMatch(
      /id: 'toggle-chat-view',[\s\S]*?modifiers: \['alt', 'shift'\], key: 'C', code: 'KeyC'[\s\S]*?action: 'toggleChatView'/
    );
    expect(app).toContain('toggleChatView: () => this.toggleChatView?.()');
  });

  it('keeps chatViewDefault per device and out of the server PUT', () => {
    const settings = read('settings-ui.js');
    expect(settings).toMatch(/'showEditHistory', 'chatViewDefault',/);
    expect(settings).toContain('chatViewDefault: _cvd,');
    const schemas = readFileSync(resolve(import.meta.dirname, '../src/web/schemas.ts'), 'utf8');
    expect(schemas).not.toContain('chatViewDefault');
  });

  it('keeps showChatViewSwitch per device, out of the server PUT, and on when absent', () => {
    const settings = read('settings-ui.js');
    expect(settings).toMatch(/'showEditHistory', 'chatViewDefault', 'showChatViewSwitch',/);
    expect(settings).toContain('showChatViewSwitch: _scvs,');
    expect(settings).toContain(
      "document.getElementById('appSettingsShowChatViewSwitch').checked = settings.showChatViewSwitch !== false;"
    );
    const schemas = readFileSync(resolve(import.meta.dirname, '../src/web/schemas.ts'), 'utf8');
    expect(schemas).not.toContain('showChatViewSwitch');
    // A settings save re-syncs the chat view, so the switch follows the new value at once.
    expect(settings).toMatch(/this\._chatViewSync\?\.\(\);/);
    const html = read('index.html');
    expect(html).toContain('id="appSettingsShowChatViewSwitch"');
  });

  it("lets Escape in the message box close only the / menu, ahead of the global handler's closes", () => {
    const app = read('app.js');
    const escape = app.slice(app.indexOf("if (e.key === 'Escape') {"), app.indexOf('this.closeAllPanels();'));
    expect(escape).toMatch(
      /if \(e\.target\?\.classList\?\.contains\('chat-view-input'\) && this\._chatView\?\.slash\) \{\s*this\._chatViewSlashClose\(\);\s*return;/
    );
  });

  it('passes the keep-alive flag of session:working and session:idle to the chat view', () => {
    const app = read('app.js');
    expect(app).toContain('this.onChatViewTurnEvent?.(data.id, true, data.keepAlive);');
    expect(app).toContain('this.onChatViewTurnEvent?.(data.id, false, data.keepAlive);');
  });

  it("starts the chat layer and its switch below Pane A's split header", () => {
    const css = read('styles.css');
    expect(css).toMatch(/\.terminal-pane-a-header ~ \.chat-view \{\s*top: 28px;\s*\}/);
    expect(css).toMatch(/\.terminal-pane-a-header ~ \.chat-view-toggle \{\s*top: 36px;\s*\}/);
  });

  it('centres the empty notice over the Response Viewer paragraph margin', () => {
    // The notice is a <p> directly inside .response-viewer-body, whose `> p` margin rule
    // outranks `.chat-view-empty` alone and left it against the window's left edge.
    const css = read('styles.css');
    expect(css).toMatch(/\.chat-view-scroll > \.chat-view-empty \{\s*margin-left: auto;\s*margin-right: auto;\s*\}/);
  });

  it('loads chat-view.js after local-model-ui.js', () => {
    const html = read('index.html');
    expect(html.indexOf('src="chat-view.js"')).toBeGreaterThan(html.indexOf('src="local-model-ui.js"'));
  });
});
