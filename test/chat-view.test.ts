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

type Msg = { role: string; text: string; turn?: number; keepAlive?: boolean; queued?: boolean; kind?: string };

interface ChatHelpers {
  visibleMessages: (m: unknown) => Msg[];
  messageKey: (m: Msg) => string;
  renderPlan: (a: string[], b: string[]) => { mode: string; from?: number };
  promptFold: (t: string) => { folded: boolean; head: string; totalLines: number };
  promptText: (t: string) => string;
  promptCount: (m: Msg[], t: string) => number;
  pendingConfirmed: (p: { text: string; baseline: number }, m: Msg[]) => boolean;
  elapsed: (ms: number) => string;
  enterSends: (ev: Record<string, unknown>, touch: boolean) => boolean;
  sendPayload: (v: string) => string | null;
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

  it('strips bracketed-paste markers, so a pasted end marker cannot end the paste early', () => {
    expect(h.sendPayload('a\x1b[201~b')).toBe('ab\r');
    expect(h.sendPayload('a\x1b[200~b')).toBe('ab\r');
    // One pass over this leaves an end marker behind: the strip repeats until none is left.
    expect(h.sendPayload('x\x1b[20\x1b[201~1~y')).toBe('xy\r');
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
  _chatViewPruneModes: (ids: Set<string>) => void;
  _chatViewHide: () => void;
  _chatViewRenderStatus: () => void;
  shouldToggleChatViewFromShortcut: (e: Partial<KeyboardEvent>) => boolean;
  _chatView: {
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
     <div class="terminal-wrap"><div id="terminalContainer"></div><textarea id="cjkInput"></textarea></div></body>`,
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

  it('moves a focus that lands on the CJK input field to the message box', () => {
    // With CJK input on, terminal.focus() lands on #cjkInput, outside #terminalContainer.
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    (win.document.getElementById('cjkInput') as HTMLTextAreaElement).focus();
    expect(win.document.activeElement).toBe(app._chatView.input);
  });

  it('keeps a file dropped on the Chat / Terminal switch from opening in the browser', () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    // The switch is a sibling of the chat view root, whose own drop handler attaches the files.
    for (const type of ['dragover', 'drop']) {
      const ev = new win.Event(type, { bubbles: true, cancelable: true });
      app._chatView.toggle.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
  });

  it('takes a file dropped on the conversation as an attachment, never letting the browser open it', () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const attach = vi.spyOn(app, '_chatViewAttach').mockResolvedValue(undefined);
    const file = new win.File(['x'], 'a.png', { type: 'image/png' });
    for (const type of ['dragover', 'drop']) {
      const ev = new win.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], files: [file] } });
      app._chatView.root.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    expect(attach).toHaveBeenCalledWith([file]);
  });

  it('hides the chat view, its switch and the body mark when the home screen shows', () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    expect(app._chatView.root.hidden).toBe(false);
    app._chatViewHide();
    expect(app._chatView.root.hidden).toBe(true);
    expect(app._chatView.toggle.hidden).toBe(true);
    expect(win.document.body.classList.contains('chat-view-showing')).toBe(false);
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

    // The per-session turn state goes with the session too.
    const state = app as unknown as Record<string, Map<string, unknown> | Set<string>>;
    state._chatViewTurnStarts = new Map([['s1', 1]]);
    state._chatViewIdleSeen = new Set(['s1']);
    state._chatViewKeepAliveTurns = new Set(['s1']);

    // A detach sends the same event as a delete, so the view choice outlives it.
    app._chatViewForget('s1');
    expect(JSON.parse(win.localStorage.getItem('codeman:chatViewModes')!)).toEqual({ s1: 'chat' });
    for (const key of ['_chatViewTurnStarts', '_chatViewIdleSeen', '_chatViewKeepAliveTurns']) {
      expect(state[key].has('s1')).toBe(false);
    }
  });

  it("drops the view choices of sessions that are not in the init's session list", () => {
    const { app, win } = loadModule();
    win.localStorage.setItem('codeman:chatViewModes', JSON.stringify({ s1: 'chat', gone: 'terminal' }));
    app.setChatViewMode('s1', 'chat');
    app.setChatViewMode('gone', 'terminal');
    app._chatViewPruneModes(new Set(['s1', 's2']));
    expect(JSON.parse(win.localStorage.getItem('codeman:chatViewModes')!)).toEqual({ s1: 'chat' });
    win.localStorage.clear();
    expect(app.chatViewModeFor('gone')).toBe('terminal');
    expect(app.chatViewModeFor('s1')).toBe('chat');
  });

  it('prunes the view choices from handleInit in app.js', () => {
    const appJs = read('app.js');
    const start = appJs.indexOf('  handleInit(data) {');
    const init = appJs.slice(start, appJs.indexOf('\n  }\n', start));
    expect(init).toContain('this._chatViewPruneModes?.(new Set(data.sessions.map((s) => s.id)));');
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
      { role: 'assistant', text: 'Checked the tests too.', turn: 1 },
      { role: 'user', text: 'keep-warm nudge', turn: 2, keepAlive: true },
      { role: 'assistant', text: 'keep-warm reply', turn: 2, keepAlive: true },
    ];
    const second: Msg[] = [...first, { role: 'user', text: 'Next', turn: 3 }];
    const { app } = loadModule({ messages: [first, second] });
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await settle();

    const nodes = Array.from(app._chatView.thread.children) as HTMLElement[];
    expect(nodes).toHaveLength(3);
    expect(nodes[0].querySelector('.chat-view-show-all')!.textContent).toBe('Show all (20 lines)');
    expect(nodes[0].textContent).not.toContain('log 10');
    expect(app._chatView.thread.textContent).not.toContain('keep-warm');
    // One badge per speaker per turn: Claude's second message in the turn continues the first.
    expect(nodes[1].classList.contains('rv-msg-cont')).toBe(false);
    expect(nodes[2].classList.contains('rv-msg-cont')).toBe(true);

    await app._chatViewFetch();
    const after = Array.from(app._chatView.thread.children);
    expect(after).toHaveLength(4);
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
    vi.useFakeTimers();
    try {
      const { app } = loadModule();
      app.setChatViewMode('s1', 'chat');
      app.onChatViewActiveSession('s1');
      app._api
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });
      app._chatView.input.value = 'hello';
      const sending = app._chatViewSend();
      // The backoff before the second attempt.
      await vi.advanceTimersByTimeAsync(600);
      await sending;
      expect(app._api).toHaveBeenCalledTimes(2);
      const bodies = app._api.mock.calls.map((c) => (c[1] as { body: { clientId: string; seq: number } }).body);
      expect(bodies[1].clientId).toBe(bodies[0].clientId);
      expect(bodies[1].seq).toBe(bodies[0].seq);
      expect(app._chatView.input.value).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives each new prompt a new seq under the same clientId', async () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    app._chatView.input.value = 'first';
    await app._chatViewSend();
    app._chatView.input.value = 'second';
    await app._chatViewSend();
    const bodies = app._api.mock.calls.map((c) => (c[1] as { body: { clientId: string; seq: number } }).body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].seq).toBe(1);
    expect(bodies[1].seq).toBe(2);
    expect(bodies[1].clientId).toBe(bodies[0].clientId);
  });

  it('sends on a bare Enter in the message box on a desktop', async () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    app._chatView.input.value = 'from the keyboard';
    const ev = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    app._chatView.input.dispatchEvent(ev);
    await settle();
    expect(ev.defaultPrevented).toBe(true);
    expect(app._api).toHaveBeenCalledTimes(1);
    expect(app._api).toHaveBeenCalledWith('/api/sessions/s1/input', expect.anything());
  });

  it('adds a line at the caret on Alt+Enter in the message box', async () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const input = app._chatView.input;
    input.value = 'ab';
    input.setSelectionRange(1, 1);
    const ev = new win.KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    await settle();
    expect(ev.defaultPrevented).toBe(true);
    expect(input.value).toBe('a\nb');
    const drafts = (app as unknown as { _chatViewDrafts: () => Map<string, string> })._chatViewDrafts();
    expect(drafts.get('s1')).toBe('a\nb');
    expect(app._api).not.toHaveBeenCalled();
  });

  it('lets the primary pointer decide what a bare Enter does, not a touchscreen alone', async () => {
    const { win, app } = loadModule();
    // A touchscreen laptop: it has touch points, but its main pointer is fine.
    win.MobileDetection = {
      isHandheldDevice: () => false,
      getDeviceType: () => 'desktop',
      isTouchDevice: () => true,
    };
    let coarse = false;
    win.matchMedia = ((query: string) => ({ matches: coarse && query === '(pointer: coarse)' })) as never;
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    expect(app._chatView.input.placeholder).toBe('Message Claude (Enter to send, Shift+Enter for a new line)');
    app._chatView.input.value = 'from the laptop';
    const enter = () => {
      const ev = new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      app._chatView.input.dispatchEvent(ev);
      return ev;
    };
    expect(enter().defaultPrevented).toBe(true);
    await settle();
    expect(app._api).toHaveBeenCalledTimes(1);

    // A tablet: the main pointer is touch, so a bare Enter adds a line.
    coarse = true;
    (app as unknown as { _chatViewSync: () => void })._chatViewSync();
    expect(app._chatView.input.placeholder).toBe('Message Claude');
    app._chatView.input.value = 'from the tablet';
    expect(enter().defaultPrevented).toBe(false);
    await settle();
    expect(app._api).toHaveBeenCalledTimes(1);
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

  it('puts the text back and says to check the connection when every attempt fails', async () => {
    vi.useFakeTimers();
    try {
      const { app } = loadModule();
      app.setChatViewMode('s1', 'chat');
      app.onChatViewActiveSession('s1');
      app._api.mockResolvedValue(null);
      app._chatView.input.value = 'hello';
      const sending = app._chatViewSend();
      expect(app._chatView.thread.querySelector('.chat-view-msg-pending')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(2000);
      await sending;
      expect(app._api).toHaveBeenCalledTimes(3);
      expect(app._chatView.thread.querySelector('.chat-view-msg-pending')).toBeNull();
      expect(app._chatView.input.value).toBe('hello');
      expect(app.showToast).toHaveBeenCalledWith('Message not sent. Check the connection and try again.', 'error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps both a failed message and what was typed while it was being sent', async () => {
    vi.useFakeTimers();
    try {
      const { app } = loadModule();
      app.setChatViewMode('s1', 'chat');
      app.onChatViewActiveSession('s1');
      app._api.mockResolvedValue(null);
      app._chatView.input.value = 'the failed one';
      const sending = app._chatViewSend();
      app._chatView.input.value = 'next';
      await vi.advanceTimersByTimeAsync(2000);
      await sending;
      expect(app._chatView.input.value).toBe('the failed one\n\nnext');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a failed message across a view switch that bypasses the session change (the tile grid)', async () => {
    vi.useFakeTimers();
    try {
      const { app } = loadModule();
      const sync = (app as unknown as { _chatViewSync: () => void })._chatViewSync.bind(app);
      app.setChatViewMode('s1', 'chat');
      app.setChatViewMode('s5', 'chat');
      app.onChatViewActiveSession('s1');
      app._api.mockResolvedValue(null);
      app._chatView.input.value = 'hello';
      const sending = app._chatViewSend();
      await vi.advanceTimersByTimeAsync(2000);
      await sending;
      expect(app._chatView.input.value).toBe('hello');

      // tile-grid.js syncs the chat view directly, without onChatViewActiveSession.
      app.activeSessionId = 's5';
      sync();
      expect(app._chatView.input.value).toBe('');
      app.activeSessionId = 's1';
      sync();
      expect(app._chatView.input.value).toBe('hello');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a send attempt that never answers, so the message box never stays locked', async () => {
    vi.useFakeTimers();
    try {
      const { app } = loadModule();
      app.setChatViewMode('s1', 'chat');
      app.onChatViewActiveSession('s1');
      // A request that settles only when its signal aborts, as fetch does.
      app._api.mockImplementation(
        (_path: string, opts: { signal: AbortSignal }) =>
          new Promise((resolve) => opts.signal.addEventListener('abort', () => resolve(null)))
      );
      app._chatView.input.value = 'hello';
      const sending = app._chatViewSend();
      // Three attempts of 15 s each, with 0.6 s and 1.2 s of backoff between them.
      await vi.advanceTimersByTimeAsync(3 * 15_000 + 600 + 1200);
      await sending;
      expect(app._api).toHaveBeenCalledTimes(3);
      expect((app._chatView as unknown as { sending: boolean }).sending).toBe(false);
      expect(app._chatView.input.value).toBe('hello');
      expect(app.showToast).toHaveBeenCalledWith('Message not sent. Check the connection and try again.', 'error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a message over the input frame limit, and keeps it', async () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const limit = (win as unknown as { CodemanInputLimit: { FRAME_MAX_CHARS: number } }).CodemanInputLimit
      .FRAME_MAX_CHARS;
    const long = 'x'.repeat(limit + 1);
    app._chatView.input.value = long;
    await app._chatViewSend();
    expect(app._api).not.toHaveBeenCalled();
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('Message too long to send'), 'error');
    expect(app._chatView.input.value).toBe(long);
    expect(app._chatView.thread.querySelector('.chat-view-msg-pending')).toBeNull();
  });

  it('keeps each of two identical prompts drawn until the transcript has a copy for each', async () => {
    vi.useFakeTimers();
    try {
      const before: Msg[] = [
        { role: 'user', text: 'Hi', turn: 1 },
        { role: 'assistant', text: 'Hello.', turn: 1 },
      ];
      const one: Msg[] = [...before, { role: 'user', text: 'same', turn: 2 }];
      const two: Msg[] = [...one, { role: 'user', text: 'same', turn: 2 }];
      const { app } = loadModule({ messages: [before, one, two] });
      app.setChatViewMode('s1', 'chat');
      app.onChatViewActiveSession('s1');
      await vi.advanceTimersByTimeAsync(0);
      app._chatView.input.value = 'same';
      await app._chatViewSend();
      app._chatView.input.value = 'same';
      await app._chatViewSend();
      const [first, second] = Array.from(app._chatView.thread.querySelectorAll('.chat-view-msg-pending'));
      expect(second).toBeDefined();

      // The transcript holds one copy: it is the first prompt's, and the second stays pending.
      await vi.advanceTimersByTimeAsync(300);
      expect(first.classList.contains('chat-view-msg-pending')).toBe(false);
      expect(second.classList.contains('chat-view-msg-pending')).toBe(true);
      expect(second.parentElement).toBe(app._chatView.thread);

      // Then two copies: the second is adopted too.
      await app._chatViewFetch();
      expect(second.classList.contains('chat-view-msg-pending')).toBe(false);
      expect(second.parentElement).toBe(app._chatView.thread);
      const texts = Array.from(app._chatView.thread.querySelectorAll('.rv-text')).map((el) => el.textContent);
      expect(texts.filter((t) => t === 'same')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives an adopted prompt the transcript row's queued marker", async () => {
    const before: Msg[] = [{ role: 'user', text: 'Hi', turn: 1 }];
    const after: Msg[] = [...before, { role: 'user', text: 'and this too', turn: 1, queued: true }];
    const { app } = loadModule({ messages: [before, after] });
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await settle();
    app._chatView.input.value = 'and this too';
    await app._chatViewSend();
    const pending = app._chatView.thread.querySelector('.chat-view-msg-pending') as HTMLElement;
    expect(pending.dataset.queued).toBeUndefined();
    await app._chatViewFetch();
    expect(pending.classList.contains('chat-view-msg-pending')).toBe(false);
    expect(pending.dataset.queued).toBe('1');
  });

  it("gives an adopted prompt the transcript row's kind", async () => {
    const before: Msg[] = [{ role: 'user', text: 'Hi', turn: 1 }];
    const after: Msg[] = [...before, { role: 'user', text: 'what next', turn: 2, kind: 'prompt' }];
    const { app } = loadModule({ messages: [before, after] });
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await settle();
    app._chatView.input.value = 'what next';
    await app._chatViewSend();
    const pending = app._chatView.thread.querySelector('.chat-view-msg-pending') as HTMLElement;
    expect(pending.dataset.kind).toBeUndefined();
    await app._chatViewFetch();
    expect(pending.classList.contains('chat-view-msg-pending')).toBe(false);
    expect(pending.dataset.kind).toBe('prompt');
  });

  it('shows the text it sends in the pending prompt, without paste markers, CRs or trailing space', async () => {
    const before: Msg[] = [{ role: 'user', text: 'Hi', turn: 1 }];
    const after: Msg[] = [...before, { role: 'user', text: 'line one\nline two', turn: 2 }];
    const { app } = loadModule({ messages: [before, after] });
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await settle();
    app._chatView.input.value = 'line one\r\nline\x1b[201~ two  ';
    await app._chatViewSend();
    const pending = app._chatView.thread.querySelector('.chat-view-msg-pending') as HTMLElement;
    expect(pending.querySelector('.rv-text')?.textContent).toBe('line one\nline two');
    const posts = app._api.mock.calls as unknown as [string, { body?: { input?: string } }][];
    const post = posts.find(([url]) => url.endsWith('/input'));
    expect(post?.[1].body?.input).toBe('line one\nline two\r');
    // The transcript records the same text, so the pending copy is adopted as the real message.
    await app._chatViewFetch();
    expect(pending.classList.contains('chat-view-msg-pending')).toBe(false);
    expect(pending.parentElement).toBe(app._chatView.thread);
  });

  it('keeps a pending prompt through an idle event that came during its send or just after it', async () => {
    const { app } = loadModule({ messages: [[{ role: 'user', text: 'Hi', turn: 1 }]] });
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await settle();

    // An idle event just after the send, well inside CHAT_VIEW_IDLE_GRACE_MS.
    app._chatView.input.value = 'just sent';
    await app._chatViewSend();
    app.onChatViewTurnEvent('s1', true);
    await app._chatViewFetch();
    expect(app._chatView.thread.querySelector('.chat-view-msg-pending')?.textContent).toBe('just sent');

    // An idle event while the request is still in flight (postedAt 0).
    let resolvePost: (v: unknown) => void = () => {};
    app._api.mockImplementationOnce(() => new Promise((r) => (resolvePost = r)));
    app._chatView.input.value = 'in flight';
    const sending = app._chatViewSend();
    app.onChatViewTurnEvent('s1', true);
    resolvePost({ ok: true, status: 200, json: async () => ({ success: true }) });
    await sending;
    await app._chatViewFetch();
    const texts = Array.from(app._chatView.thread.querySelectorAll('.chat-view-msg-pending')).map(
      (el) => el.textContent
    );
    expect(texts).toContain('in flight');
  });

  it('lets an idle event drop a pending prompt only once CHAT_VIEW_IDLE_GRACE_MS has passed since its send', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    try {
      const { app } = loadModule({ messages: [[{ role: 'user', text: 'Hi', turn: 1 }]] });
      app.setChatViewMode('s1', 'chat');
      app.onChatViewActiveSession('s1');
      await vi.advanceTimersByTimeAsync(0);
      const pendingTexts = () =>
        Array.from(app._chatView.thread.querySelectorAll('.chat-view-msg-pending')).map((el) => el.textContent);

      // 1999 ms after the send, the prompt may still be on its way into the transcript.
      app._chatView.input.value = 'kept';
      await app._chatViewSend();
      vi.setSystemTime(Date.now() + 1999);
      app.onChatViewTurnEvent('s1', true);
      await app._chatViewFetch();
      expect(pendingTexts()).toContain('kept');

      // 2000 ms after the send, a finished turn that did not record it lets it go.
      app._chatView.input.value = 'expired';
      await app._chatViewSend();
      vi.setSystemTime(Date.now() + 2000);
      app.onChatViewTurnEvent('s1', true);
      await app._chatViewFetch();
      expect(pendingTexts()).not.toContain('expired');
      // Stop the status line's ticking before the real clock comes back.
      app.setChatViewMode('s1', 'terminal');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps an unsent draft per session, and forgets it with the session', () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.setChatViewMode('s5', 'chat');
    app.onChatViewActiveSession('s1');
    const input = app._chatView.input;
    input.value = 'draft A';
    input.dispatchEvent(new input.ownerDocument.defaultView!.Event('input'));

    app.activeSessionId = 's5';
    app.onChatViewActiveSession('s5');
    expect(input.value).toBe('');
    app.activeSessionId = 's1';
    app.onChatViewActiveSession('s1');
    expect(input.value).toBe('draft A');

    app._chatViewForget('s1');
    const drafts = (app as unknown as { _chatViewDrafts: () => Map<string, string> })._chatViewDrafts();
    expect(drafts.has('s1')).toBe(false);
  });

  it('adds dictated text to the message box, after a space', () => {
    const { win, app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const a = app as unknown as {
      _chatViewInsertText: (t: string) => void;
      _chatViewDrafts: () => Map<string, string>;
    };
    // An empty box has nothing to send, and the box does not hold the focus yet.
    app._chatView.input.blur();
    expect(win.document.activeElement).not.toBe(app._chatView.input);
    expect(app._chatView.sendBtn.disabled).toBe(true);
    a._chatViewInsertText('hello');
    expect(app._chatView.input.value).toBe('hello');
    // A value set by script fires no input event, so the insert itself turns Send on and
    // focuses the box.
    expect(app._chatView.sendBtn.disabled).toBe(false);
    expect(win.document.activeElement).toBe(app._chatView.input);
    a._chatViewInsertText('world');
    expect(app._chatView.input.value).toBe('hello world');
    expect(a._chatViewDrafts().get('s1')).toBe('hello world');
    expect(app._api).not.toHaveBeenCalled();
    expect(app._sendInputAsync).not.toHaveBeenCalled();
  });

  it('puts the Working line right under the last message, inside the scrolling list', () => {
    const { app } = loadModule();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    const view = app._chatView as unknown as { status: HTMLElement; thread: HTMLElement; scroller: HTMLElement };
    expect(view.status.parentElement).toBe(view.scroller);
    expect(view.thread.nextElementSibling).toBe(view.status);
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

  it('counts a turn this page saw start from its session:working event', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    try {
      const { app } = loadModule();
      app.setChatViewMode('s1', 'chat');
      app.onChatViewActiveSession('s1');
      app.onChatViewTurnEvent('s1', true);
      vi.setSystemTime(Date.now() + 30_000);
      const session = app.sessions.get('s1')!;
      session.status = 'busy';
      // An older Enter, which must not be the start of the turn the page saw begin.
      session.lastSubmitAt = Date.now() - 60_000;
      app.onChatViewTurnEvent('s1', false);
      vi.setSystemTime(Date.now() + 5_000);
      app._chatViewRenderStatus();
      expect(app._chatView.statusText.textContent).toBe('Working · 5s');
      app.setChatViewMode('s1', 'terminal');
    } finally {
      vi.useRealTimers();
    }
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
    // The message box reads the primary pointer; a tablet's is coarse.
    win.matchMedia = ((query: string) => ({ matches: touch && query === '(pointer: coarse)' })) as never;
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

  it('moves a focus left in the terminal to the conversation on a switch to Chat, on a touch device', async () => {
    const { win, app } = loadForFocus(true);
    const inner = win.document.createElement('textarea');
    win.document.getElementById('terminalContainer')!.appendChild(inner);
    inner.focus();
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await nextFrame(win);
    expect(win.document.activeElement).toBe(app._chatView.scroller);
  });

  it('moves a focus left on the CJK input field to the conversation on a switch to Chat, on a touch device', async () => {
    const { win, app } = loadForFocus(true);
    (win.document.getElementById('cjkInput') as HTMLTextAreaElement).focus();
    expect(win.document.activeElement?.id).toBe('cjkInput');
    app.setChatViewMode('s1', 'chat');
    app.onChatViewActiveSession('s1');
    await nextFrame(win);
    expect(win.document.activeElement).toBe(app._chatView.scroller);
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

    // A continuation prompt drawn without a badge stays without one once unfolded.
    const cont = a._chatViewBuildMessage({ role: 'user', text: long, turn: 1 }, 'Claude', true);
    (cont.querySelector('.chat-view-show-all') as HTMLButtonElement).click();
    expect(cont.classList.contains('rv-msg-cont')).toBe(true);
    expect(cont.querySelector(':scope > .rv-role')).toBeNull();
    expect(cont.textContent).toContain('line 29');
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

  /** A read of the conversation that stays pending until the test resolves it. */
  function deferredRead() {
    let resolve!: (v: { messages: Msg[] }) => void;
    const promise = new Promise<{ messages: Msg[] }>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('reads once more when an update arrived while a read was in flight', async () => {
    vi.useFakeTimers();
    try {
      const { app } = loadModule();
      const first = deferredRead();
      app._apiJson.mockImplementationOnce(() => first.promise);
      app.setChatViewMode('s1', 'chat');
      expect(app._apiJson).toHaveBeenCalledTimes(1);

      // The update's debounced read finds the first one still in flight.
      app._onChatViewTranscriptUpdate({ sessionId: 's1' });
      await vi.advanceTimersByTimeAsync(300);
      expect(app._apiJson).toHaveBeenCalledTimes(1);

      first.resolve({ messages: [{ role: 'user', text: 'Hi', turn: 1 }] });
      await vi.advanceTimersByTimeAsync(300);
      expect(app._apiJson).toHaveBeenCalledTimes(2);
      app.setChatViewMode('s1', 'terminal');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a read that finishes after the user switched to another session', async () => {
    vi.useFakeTimers();
    try {
      const { app } = loadModule();
      const s1Read = deferredRead();
      app._apiJson.mockImplementationOnce(() => s1Read.promise);
      app.setChatViewMode('s1', 'chat');
      app.setChatViewMode('s5', 'chat');
      app.activeSessionId = 's5';
      app.onChatViewActiveSession('s5');

      s1Read.resolve({ messages: [{ role: 'assistant', text: 'Answer for s1 only', turn: 1 }] });
      // Checked before the debounced read for s5 runs, which would redraw the thread anyway.
      await vi.advanceTimersByTimeAsync(0);
      expect(app._chatView.thread.textContent).not.toContain('Answer for s1 only');
      await vi.advanceTimersByTimeAsync(300);
      expect(app._chatView.thread.textContent).not.toContain('Answer for s1 only');
      app.setChatViewMode('s5', 'terminal');
    } finally {
      vi.useRealTimers();
    }
  });

  describe('the Alt+Shift+C chord', () => {
    const chord = { altKey: true, shiftKey: true, key: 'C', code: 'KeyC' };

    /** The module with app.js's shortcut matcher, run as written, and a registry holding the chord. */
    function loadForChord(disabled = false) {
      const loaded = loadModule();
      const { win, app } = loaded;
      const method = read('app.js').match(/\n {2}matchesShortcutEvent\(e, shortcut\) \{[\s\S]*?\n {2}\}\n/)![0];
      Object.assign(app, win.eval(`({${method}})`) as object, {
        getShortcutRegistry: () => [
          { id: 'toggle-chat-view', bindings: [{ modifiers: ['alt', 'shift'], key: 'C', code: 'KeyC' }], disabled },
        ],
      });
      return loaded;
    }

    it('applies to an active session that can show the chat view', () => {
      const { app } = loadForChord();
      expect(app.shouldToggleChatViewFromShortcut(chord)).toBe(true);
    });

    it('reaches the terminal in a session that cannot show the chat view', () => {
      const { app } = loadForChord();
      app.sessions.set('s6', { id: 's6', mode: 'shell', status: 'idle' });
      app.activeSessionId = 's6';
      expect(app.shouldToggleChatViewFromShortcut(chord)).toBe(false);
    });

    it('reaches the tiles while the tile grid owns the terminal', () => {
      const { app } = loadForChord();
      (app as unknown as { _tilesOwnTerminal: () => boolean })._tilesOwnTerminal = () => true;
      expect(app.shouldToggleChatViewFromShortcut(chord)).toBe(false);
    });

    it('needs a modifier', () => {
      const { app } = loadForChord();
      expect(app.shouldToggleChatViewFromShortcut({ key: 'C', code: 'KeyC' })).toBe(false);
    });

    it('does nothing when the user disabled the shortcut', () => {
      const { app } = loadForChord(true);
      expect(app.shouldToggleChatViewFromShortcut(chord)).toBe(false);
    });
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

describe('chat view wiring', () => {
  it("swallows the toggle chord in the xterm key handler and in Pane B's", () => {
    const terminalUi = read('terminal-ui.js');
    expect(terminalUi).toMatch(/shouldToggleChatViewFromShortcut\?\.\(ev\)\)\s*\{\s*return false;/);
    const tile = read('terminal-tile.js');
    expect(tile).toContain(
      "if (ev.type === 'keydown' && global.app?.shouldToggleChatViewFromShortcut?.(ev)) return false;"
    );
  });

  it('re-reads the conversation after an SSE reconnect onto the session on screen', () => {
    const app = read('app.js');
    expect(app).toMatch(
      /void this\._onSessionNeedsRefresh\(\{ id: restoreId \}\);[\s\S]{0,300}?this\._chatViewReload\?\.\(\{ immediate: true \}\);/
    );
  });

  it('hides the chat view when the home screen shows', () => {
    const terminalUi = read('terminal-ui.js');
    expect(terminalUi).toMatch(/\n {2}showWelcome\(\) \{\n {4}this\._chatViewHide\?\.\(\);/);
  });

  it('keeps the chat view layers under the narrow-width sidebar drawer', () => {
    // The drawer (z-index 12, mobile.css) is a sibling of .terminal-wrap: the chat view's 20 and 21
    // must stay inside the terminal area's own stacking context.
    const css = read('styles.css');
    expect(css).toMatch(/\n\.terminal-wrap \{[^}]*isolation: isolate;[^}]*\}/);
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

  it('passes the keep-alive flag of session:working and session:idle to the chat view', () => {
    const app = read('app.js');
    expect(app).toContain('this.onChatViewTurnEvent?.(data.id, true, data.keepAlive);');
    expect(app).toContain('this.onChatViewTurnEvent?.(data.id, false, data.keepAlive);');
  });

  it('hides the CJK input field on a touch device while Chat shows', () => {
    // The field is fixed over the bottom of the chat view there, and its text goes into the pane.
    const css = read('styles.css');
    expect(css).toMatch(
      /\nbody\.chat-view-showing\.touch-device #cjkInput\.cjk-input-visible \{\s*display: none !important;\s*\}/
    );
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
