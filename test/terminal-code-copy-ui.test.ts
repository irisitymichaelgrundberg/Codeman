/**
 * The terminal's code-block Copy button as terminal-ui.js wires it: the
 * desktop-only opt-in gate, the block list fetched from the transcript and its
 * refetch policy, and the update that places the button and picks what it
 * copies. The settings wiring that keeps the toggle per-device is pinned too.
 *
 * Strategy: constants.js, the vendored marked and terminal-ui.js in one vm, as
 * the browser loads them, with `fetch`, `Date.now` and the DOM stubbed. The
 * matcher itself is tested in terminal-code-copy.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const fixtures = resolve(import.meta.dirname, 'fixtures');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');

const sample = readFileSync(resolve(fixtures, 'code-copy-sample.md'), 'utf8');
const screen = readFileSync(resolve(fixtures, 'code-copy-sample.screen.txt'), 'utf8').split('\n');

type FetchBody =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: string; errorCode: string };

function loadHarness() {
  const CodemanApp = function CodemanApp(this: any) {};
  const windowRef: Record<string, any> = {};
  let now = 1_000;
  let body: FetchBody = { success: true, data: { messages: [] } };
  let ok = true;
  let status: number | null = null;
  let etag: string | null = null;

  const RealDate = Date;
  const DateStub: any = function DateStub(this: any, ...args: any[]) {
    return new (RealDate as any)(...args);
  };
  DateStub.now = () => now;

  const fetch = vi.fn(async (_url: string, _init?: { cache?: string; headers?: Record<string, string> }) => {
    const code = status ?? (ok ? 200 : 502);
    return {
      ok: code >= 200 && code < 300,
      status: code,
      headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag : null) },
      json: async () => body,
    };
  });

  const documentRef: Record<string, any> = {
    body: { classList: { contains: () => false } },
    activeElement: null,
    getElementById: () => null,
    createElement: () => ({}),
    addEventListener: () => {},
    elementFromPoint: () => null,
  };

  const context = vm.createContext({
    window: windowRef,
    document: documentRef,
    CodemanApp,
    console: { warn: vi.fn(), log: vi.fn(), debug: vi.fn() },
    _crashDiag: { log: vi.fn() },
    Date: DateStub,
    fetch,
    performance: { now: () => now },
    requestAnimationFrame: (_fn: () => void) => 1,
    setTimeout: (_fn: () => void) => 1,
    clearTimeout: () => {},
    Blob: function Blob() {},
    URL: { createObjectURL: () => 'blob:yield', revokeObjectURL: () => {} },
    Worker: function Worker(this: any) {
      this.postMessage = () => {};
    },
    MobileDetection: { isTouchDevice: () => false },
    KeyboardHandler: { keyboardVisible: false },
    DEC_SYNC_STRIP_RE: /\x1b\[\?2026[hl]/g,
    OSC52_STRIP_RE: /\x1b\]52;[^\x07\x1b]*(?:\x07|\x1b\\)/g,
    TERMINAL_CHUNK_SIZE: 32 * 1024,
  });
  const ctx = context as Record<string, any>;
  ctx.globalThis = context;
  ctx.self = context;

  vm.runInContext(read('vendor/marked.min.js'), context, { filename: 'marked.min.js' });
  vm.runInContext(read('constants.js'), context, { filename: 'constants.js' });
  vm.runInContext(read('terminal-ui.js'), context, { filename: 'terminal-ui.js' });

  const app = new (CodemanApp as any)();
  app.activeSessionId = 's1';
  app._codeCopyCache = new Map();
  app._codeCopyScreenGen = 0;
  app._codeCopyPointer = null;

  return {
    app,
    windowRef,
    documentRef,
    fetch,
    lex: (text: string) => ctx.marked.lexer(text),
    setNow: (value: number) => {
      now = value;
    },
    setBody: (value: FetchBody) => {
      body = value;
    },
    setOk: (value: boolean) => {
      ok = value;
    },
    /** Answer with this HTTP status instead of the one `setOk` picks; null restores it. */
    setStatus: (value: number | null) => {
      status = value;
    },
    setEtag: (value: string | null) => {
      etag = value;
    },
    context: ctx,
  };
}

/** Let the fetch chain in `_codeBlockCopyBlocks` settle. */
const flush = () => new Promise((r) => setImmediate(r));

describe('_codeBlockCopyEnabled', () => {
  it('is off until the user turns it on', () => {
    const { app, windowRef } = loadHarness();
    windowRef.matchMedia = vi.fn(() => ({ matches: true }));
    app.loadAppSettingsFromStorage = () => ({});
    expect(app._codeBlockCopyEnabled()).toBe(false);
  });

  it('is on when turned on and the device has a hovering, fine pointer', () => {
    const { app, windowRef } = loadHarness();
    windowRef.matchMedia = vi.fn(() => ({ matches: true }));
    app.loadAppSettingsFromStorage = () => ({ terminalCodeCopy: true });
    expect(app._codeBlockCopyEnabled()).toBe(true);
    expect(windowRef.matchMedia).toHaveBeenCalledWith('(hover: hover) and (pointer: fine)');
  });

  it('stays off on a device without a hovering pointer, even when turned on', () => {
    const { app, windowRef } = loadHarness();
    windowRef.matchMedia = vi.fn(() => ({ matches: false }));
    app.loadAppSettingsFromStorage = () => ({ terminalCodeCopy: true });
    expect(app._codeBlockCopyEnabled()).toBe(false);
    expect(windowRef.matchMedia).toHaveBeenCalledWith('(hover: hover) and (pointer: fine)');
  });
});

describe('_codeBlockCopyBlocks', () => {
  const message = { text: '```\nx = 1\n```' };

  it('offers no blocks from a response segmented from the pane', async () => {
    const { app, setBody } = loadHarness();
    setBody({ success: true, data: { source: 'pane', messages: [message] } });
    expect(app._codeBlockCopyBlocks()).toBeNull();
    await flush();
    expect(app._codeCopyCache.get('s1').blocks).toEqual([]);
  });

  it('never refetches a session that answered from the pane', async () => {
    const { app, fetch, setBody, setNow } = loadHarness();
    setBody({ success: true, data: { source: 'pane', messages: [message] } });
    app._codeBlockCopyBlocks(true);
    await flush();

    app._codeCopyCache.get('s1').stale = true;
    setNow(10_000);
    app._codeBlockCopyBlocks(true);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('offers no blocks and fetches nothing for a remote session', async () => {
    const { app, fetch, setBody } = loadHarness();
    setBody({ success: true, data: { messages: [message] } });
    app.sessions = new Map([['s1', { id: 's1', remote: { host: 'example.test' } }]]);

    expect(app._codeBlockCopyBlocks(true)).toEqual([]);
    await flush();

    expect(fetch).not.toHaveBeenCalled();
    expect(app._codeCopyCache.has('s1')).toBe(false);
  });

  it('fetches for a local session that has a session record', async () => {
    const { app, fetch, setBody } = loadHarness();
    setBody({ success: true, data: { messages: [message] } });
    app.sessions = new Map([['s1', { id: 's1' }]]);

    app._codeBlockCopyBlocks();
    await flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(app._codeCopyCache.get('s1').blocks).toEqual([{ text: 'x = 1', lang: '' }]);
  });

  it('offers the blocks of a transcript-backed response', async () => {
    const { app, setBody } = loadHarness();
    setBody({ success: true, data: { messages: [message] } });
    app._codeBlockCopyBlocks();
    await flush();
    expect(app._codeCopyCache.get('s1').blocks).toEqual([{ text: 'x = 1', lang: '' }]);
  });

  it("offers the blocks of the agent's messages, not the user's prompts", async () => {
    const { app, setBody } = loadHarness();
    setBody({
      success: true,
      data: {
        messages: [
          { role: 'user', text: '```\nmine = 1\n```' },
          { role: 'assistant', text: '```\nx = 1\n```' },
        ],
      },
    });
    app._codeBlockCopyBlocks();
    await flush();
    expect(app._codeCopyCache.get('s1').blocks).toEqual([{ text: 'x = 1', lang: '' }]);
  });

  it('updates the button under a resting pointer once the list arrives', async () => {
    const { app } = loadHarness();
    app._codeCopyPointer = { x: 1, y: 1, buttons: 0 };
    app._updateCodeBlockCopy = vi.fn();
    const gen = app._codeCopyScreenGen;

    app._codeBlockCopyBlocks();
    await flush();

    expect(app._updateCodeBlockCopy).toHaveBeenCalledTimes(1);
    expect(app._codeCopyScreenGen).toBe(gen + 1);
  });

  it('leaves the button alone when the list arrives after a tab switch', async () => {
    const { app } = loadHarness();
    app._codeCopyPointer = { x: 1, y: 1, buttons: 0 };
    app._updateCodeBlockCopy = vi.fn();

    app._codeBlockCopyBlocks();
    app.activeSessionId = 's2';
    await flush();

    expect(app._updateCodeBlockCopy).not.toHaveBeenCalled();
  });

  it('refetches a stale list only after pointer movement, at most once every three seconds', async () => {
    const { app, fetch, setNow } = loadHarness();
    setNow(1_000);
    app._codeBlockCopyBlocks(true);
    await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    const entry = app._codeCopyCache.get('s1');

    entry.stale = true;
    setNow(2_000);
    app._codeBlockCopyBlocks(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    setNow(4_500);
    app._codeBlockCopyBlocks(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    app._codeBlockCopyBlocks(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    await flush();
  });

  it('does not refetch a list no repaint has marked stale', async () => {
    const { app, fetch, setNow } = loadHarness();
    app._codeBlockCopyBlocks(true);
    await flush();
    expect(app._codeCopyCache.get('s1').stale).toBe(false);

    setNow(10_000);
    app._codeBlockCopyBlocks(true);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the last good list when a refetch gets an HTTP error', async () => {
    const { app, setBody, setNow, setOk } = loadHarness();
    setBody({ success: true, data: { messages: [message] } });
    app._codeBlockCopyBlocks(true);
    await flush();
    const entry = app._codeCopyCache.get('s1');
    expect(entry.blocks).toEqual([{ text: 'x = 1', lang: '' }]);

    entry.stale = true;
    setNow(5_000);
    setOk(false);
    // The server's error envelope has no messages, so reading it would empty the list.
    setBody({ success: false, error: 'Bad gateway', errorCode: 'INTERNAL_ERROR' });
    app._codeBlockCopyBlocks(true);
    await flush();
    expect(entry.blocks).toEqual([{ text: 'x = 1', lang: '' }]);
  });

  it('marks the list stale after a failed fetch, so pointer movement retries it', async () => {
    const { app, fetch, setNow, setOk } = loadHarness();
    setOk(false);
    app._codeBlockCopyBlocks(false);
    await flush();
    const entry = app._codeCopyCache.get('s1');
    expect(entry.blocks).toEqual([]);
    expect(entry.stale).toBe(true);

    setOk(true);
    setNow(5_000);
    app._codeBlockCopyBlocks(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    await flush();
  });

  it('sends the stored ETag back and keeps the list on a 304', async () => {
    const { app, fetch, setBody, setEtag, setNow, setStatus } = loadHarness();
    setBody({ success: true, data: { messages: [message] } });
    setEtag('"v1"');
    app._codeBlockCopyBlocks(true);
    await flush();
    const entry = app._codeCopyCache.get('s1');
    const blocks = entry.blocks;
    expect(blocks).toEqual([{ text: 'x = 1', lang: '' }]);
    // The first fetch has no list to keep, so it sends no validator.
    expect(fetch.mock.calls[0][1]).toEqual({ cache: 'no-store', headers: {} });

    entry.stale = true;
    setNow(5_000);
    setStatus(304);
    app._codeBlockCopyBlocks(true);
    expect(fetch.mock.calls[1][1]).toEqual({ cache: 'no-store', headers: { 'If-None-Match': '"v1"' } });
    await flush();

    // The same array, so the matcher's cache of the prepared list still applies.
    expect(entry.blocks).toBe(blocks);
    expect(entry.stale).toBe(false);
    expect(entry.fetchedAt).toBe(5_000);
  });

  it('sends no ETag while it holds no list', async () => {
    const { app, fetch, setNow } = loadHarness();
    app._codeCopyCache.set('s1', { blocks: null, etag: '"v1"', fetchedAt: 0, loading: false, stale: true });
    setNow(5_000);

    app._codeBlockCopyBlocks(true);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toEqual({ cache: 'no-store', headers: {} });
    await flush();
  });

  it('lexes only the messages that are new since the last fetch', async () => {
    const { app, context, setBody, setNow } = loadHarness();
    const first = [{ text: '```\nx = 1\n```' }, { text: '```\ny = 2\n```' }];
    setBody({ success: true, data: { messages: first } });
    app._codeBlockCopyBlocks(true);
    await flush();
    const entry = app._codeCopyCache.get('s1');
    const before = entry.blocks;

    const lexer = vi.spyOn(context.marked, 'lexer');
    setBody({ success: true, data: { messages: [...first, { text: '```\nz = 3\n```' }] } });
    entry.stale = true;
    setNow(5_000);
    app._codeBlockCopyBlocks(true);
    await flush();

    expect(lexer).toHaveBeenCalledTimes(1);
    expect(entry.blocks).not.toBe(before);
    expect(entry.blocks.map((b: { text: string }) => b.text)).toEqual(['x = 1', 'y = 2', 'z = 3']);
  });

  it('runs the first fetch for a session from any caller', () => {
    const { app, fetch } = loadHarness();
    app._codeBlockCopyBlocks(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps block lists for at most eight sessions', async () => {
    const { app } = loadHarness();
    for (let i = 0; i < 9; i++) {
      app.activeSessionId = `s${i}`;
      app._codeBlockCopyBlocks(false);
    }
    await flush();
    expect(app._codeCopyCache.size).toBeLessThanOrEqual(8);
  });
});

type StubCell = { getChars: () => string; getWidth: () => number };

/** A buffer line whose cells are `cells`, padded to 100 columns with cells never written to. */
function stubLine(text: string, cells: StubCell[]) {
  const padded = [...cells];
  while (padded.length < 100) padded.push({ getChars: () => '', getWidth: () => 1 });
  return { length: padded.length, translateToString: () => text, getCell: (x: number) => padded[x] };
}

/** One cell of width 1 per character, as a screen of narrow characters fills them. */
const narrowLine = (text: string) =>
  stubLine(
    text,
    [...text].map((ch) => ({ getChars: () => ch, getWidth: () => 1 }))
  );

/**
 * The fixture screen in a 24-row terminal with 8x16 cells, a cached block list
 * for it, the gate open and the pointer over the first row of the Python block.
 */
function arrangeUpdate() {
  const harness = loadHarness();
  const { app, windowRef, lex } = harness;
  const blocks = windowRef.CodemanCodeBlockCopy.extract([{ text: sample }], lex);
  app._codeCopyCache.set('s1', { blocks, fetchedAt: 1_000, loading: false, stale: false });

  const screenRect = { left: 0, top: 0, right: 800, bottom: 384 };
  const hostRect = { left: 0, top: 0, right: 800, bottom: 384 };
  const host: Record<string, any> = { getBoundingClientRect: () => hostRect, scrollLeft: 0, scrollTop: 0 };
  const btn = {
    hidden: true,
    style: {} as Record<string, string>,
    classList: { remove: vi.fn() },
    setAttribute: vi.fn(),
    title: 'Copy code block',
    parentElement: host,
    contains: () => false,
    offsetWidth: 28,
    _codeText: null as string | null,
  };
  app._codeCopyBtn = btn;
  app.terminal = {
    rows: 24,
    buffer: { active: { viewportY: 0, getLine: (y: number) => narrowLine(screen[y] ?? '') } },
    element: {
      querySelector: (sel: string) => (sel === '.xterm-screen' ? { getBoundingClientRect: () => screenRect } : null),
    },
    _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
  };
  const startRow = screen.findIndex((row) => row.includes('def resolve('));
  const endRow = screen.findIndex((row) => row.includes('return path'));
  app._codeBlockCopyEnabled = () => true;
  app._clientPointToCell = () => ({ col: 5, row: startRow + 2 });
  app._codeCopyPointer = { x: 40, y: (startRow + 1) * 16 + 8, buttons: 0 };
  return { ...harness, blocks, btn, host, screenRect, startRow, endRow };
}

describe('_updateCodeBlockCopy', () => {
  it('shows the button on a hovered block and copies the transcript text, not the screen rows', () => {
    const { app, blocks, btn, startRow, endRow } = arrangeUpdate();

    app._updateCodeBlockCopy();

    expect(btn.hidden).toBe(false);
    expect(btn._codeText).toBe(blocks[0].text);
    expect(btn.style.top).toBe(`${startRow * 16}px`);
    // The screen has the gutter and the word-wrap break; the clipboard must not.
    const onScreen = screen.slice(startRow, endRow + 1).join('\n');
    expect(btn._codeText).not.toBe(onScreen);
    expect(btn._codeText).toContain('# this comment is deliberately very long so that the line exceeds one hundred');
  });

  it('copies the block under the pointer, not the first block on screen', () => {
    const { app, blocks, btn } = arrangeUpdate();
    const npmRow = screen.findIndex((row) => row.includes('npm run build && systemctl'));
    app._clientPointToCell = () => ({ col: 5, row: npmRow + 1 });

    app._updateCodeBlockCopy();

    expect(btn.hidden).toBe(false);
    expect(btn._codeText).toBe(blocks[1].text);
    expect(btn.style.top).toBe(`${npmRow * 16}px`);
  });

  it('keeps the button on its block when the container is scrolled sideways', () => {
    const { app, btn, host, screenRect } = arrangeUpdate();
    app._updateCodeBlockCopy();
    const { left, top } = btn.style;

    host.scrollLeft = 200;
    host.clientWidth = 800;
    screenRect.left = -200;
    screenRect.right = 600;
    app._updateCodeBlockCopy();

    expect(btn.style.left).toBe(left);
    expect(btn.style.top).toBe(top);
  });

  it("keeps the button inside the container's visible part", () => {
    const { app, btn, host } = arrangeUpdate();
    host.clientWidth = 100;

    app._updateCodeBlockCopy();

    expect(btn.hidden).toBe(false);
    expect(parseInt(btn.style.left, 10)).toBeLessThanOrEqual(100 - 28 - 4);
  });

  it('keeps the button inside the left edge when the container is scrolled past the block', () => {
    const { app, btn, host, screenRect } = arrangeUpdate();
    host.scrollLeft = 1500;
    host.clientWidth = 800;
    screenRect.left = -1500;
    screenRect.right = 1000;

    app._updateCodeBlockCopy();

    expect(btn.hidden).toBe(false);
    expect(btn.style.left).toBe(`${4 + 1500}px`);
  });

  it('measures a row of wide characters in cells, not characters', () => {
    const { app, btn } = arrangeUpdate();
    const comment = '# 中文注释';
    const wide = (ch: string): StubCell[] => [
      { getChars: () => ch, getWidth: () => 2 },
      { getChars: () => '', getWidth: () => 0 },
    ];
    const commentCells = [
      { getChars: () => '#', getWidth: () => 1 },
      { getChars: () => ' ', getWidth: () => 1 },
      ...[...'中文注释'].flatMap(wide),
    ];
    const rows = ['', 'x = 1', comment, '', 'after'];
    app.terminal.buffer.active.getLine = (y: number) =>
      y === 2 ? stubLine(comment, commentCells) : narrowLine(rows[y] ?? '');
    app._codeCopyCache.set('s1', {
      blocks: [{ text: `x = 1\n${comment}` }],
      fetchedAt: 1_000,
      loading: false,
      stale: false,
    });
    app._clientPointToCell = () => ({ col: 1, row: 2 });

    app._updateCodeBlockCopy();

    expect(btn.hidden).toBe(false);
    expect(btn._codeText).toBe(`x = 1\n${comment}`);
    // 2 narrow cells and 4 wide characters of 2 cells each: 10 cells.
    expect(btn.style.left).toBe(`${(10 + 1) * 8}px`);
  });

  it('hides the button under a resting pointer once the session changes', () => {
    const { app, btn } = arrangeUpdate();
    app._updateCodeBlockCopy();
    expect(btn.hidden).toBe(false);

    btn.contains = () => true;
    app.activeSessionId = 's2';
    app._codeCopyCache.set('s2', { blocks: [], fetchedAt: 1_000, loading: false, stale: false });
    app._updateCodeBlockCopy();

    expect(btn.hidden).toBe(true);
    expect(btn._codeText).toBeNull();
  });

  it('shows nothing and fetches nothing while the setting is off', () => {
    const { app, btn, fetch } = arrangeUpdate();
    app._codeBlockCopyEnabled = () => false;
    app._codeCopyCache = new Map();

    app._updateCodeBlockCopy();

    expect(btn.hidden).toBe(true);
    expect(btn._codeText).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refetches a stale list only when the pointer moved', async () => {
    const { app, blocks, fetch, setNow } = arrangeUpdate();
    app._codeCopyCache.set('s1', { blocks, fetchedAt: 1_000, loading: false, stale: true });
    setNow(10_000);

    app._codeCopyPointerMoved = false;
    app._updateCodeBlockCopy();
    expect(fetch).not.toHaveBeenCalled();

    app._codeCopyPointerMoved = true;
    app._updateCodeBlockCopy();
    expect(fetch).toHaveBeenCalledTimes(1);

    // The update clears the flag it read, so one movement allows one refetch.
    await flush();
    app._codeCopyCache.get('s1').stale = true;
    setNow(60_000);
    app._updateCodeBlockCopy();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(app._codeCopyPointerMoved).toBe(false);
  });

  it('translates the label when it shows the button', () => {
    const { app, btn, windowRef } = arrangeUpdate();
    windowRef.codemanT = (text: string) => `zh:${text}`;

    app._updateCodeBlockCopy();

    expect(btn.hidden).toBe(false);
    expect(btn.title).toBe('zh:Copy code block');
    expect(btn.setAttribute).toHaveBeenCalledWith('aria-label', 'zh:Copy code block');
  });

  it('drops the copied or failed mark when the button moves to a different block', () => {
    const { app, btn } = arrangeUpdate();
    app._updateCodeBlockCopy();
    btn.classList.remove.mockClear();

    app._updateCodeBlockCopy();
    expect(btn.classList.remove).not.toHaveBeenCalled();

    const npmRow = screen.findIndex((row) => row.includes('npm run build && systemctl'));
    app._clientPointToCell = () => ({ col: 5, row: npmRow + 1 });
    app._updateCodeBlockCopy();
    expect(btn.classList.remove).toHaveBeenCalledWith('rv-copied', 'rv-copy-failed');
  });

  it('stays hidden while a mouse button is held', () => {
    const { app, btn } = arrangeUpdate();
    app._codeCopyPointer.buttons = 1;

    app._updateCodeBlockCopy();

    expect(btn.hidden).toBe(true);
    expect(btn._codeText).toBeNull();
  });
});

describe('_installCodeBlockCopy', () => {
  function install() {
    const harness = loadHarness();
    const { app, documentRef } = harness;
    const listeners = (target: Record<string, any>) => {
      target.on = {} as Record<string, (ev: unknown) => unknown>;
      target.addEventListener = (type: string, fn: (ev: unknown) => unknown) => {
        target.on[type] = fn;
      };
      return target;
    };
    const container = listeners({ appendChild: () => {} });
    const btn = listeners({ setAttribute: vi.fn(), classList: { remove: vi.fn() }, hidden: false });
    documentRef.getElementById = (id: string) => (id === 'terminalContainer' ? container : null);
    documentRef.createElement = () => btn;
    const term: Record<string, any> = {};
    term.onWriteParsed = (fn: () => void) => {
      term.writeParsed = fn;
    };
    term.onScroll = () => {};
    term.onResize = () => {};
    app.terminal = term;
    app._installCodeBlockCopy();
    return { ...harness, btn, container, term };
  }

  it('records pointer movement, held buttons included, and wheel scrolling', () => {
    const { app, container } = install();

    container.on.mousemove({ clientX: 12, clientY: 34, buttons: 1 });
    expect(app._codeCopyPointerMoved).toBe(true);
    expect(app._codeCopyPointer).toEqual({ x: 12, y: 34, buttons: 1 });

    app._codeCopyPointerMoved = false;
    container.on.wheel({});
    expect(app._codeCopyPointerMoved).toBe(true);
  });

  it('forgets the pointer when it leaves the terminal', () => {
    const { app, container } = install();
    app._codeCopyPointer = { x: 12, y: 34, buttons: 0 };

    container.on.mouseleave();

    expect(app._codeCopyPointer).toBeNull();
  });

  it('marks the block list stale on every repaint', () => {
    const { app, term } = install();
    app._codeCopyCache.set('s1', { blocks: [], fetchedAt: 1_000, loading: false, stale: false });

    term.writeParsed();

    expect(app._codeCopyCache.get('s1').stale).toBe(true);
  });

  it('updates the button under a resting pointer after output, at most once per throttle window', () => {
    const { app, context, term } = install();
    const timers: { fn: () => void; ms: number }[] = [];
    const frames: (() => void)[] = [];
    context.setTimeout = (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length;
    };
    context.requestAnimationFrame = (fn: () => void) => {
      frames.push(fn);
      return frames.length;
    };
    app._codeCopyPointer = { x: 1, y: 1, buttons: 0 };
    app._updateCodeBlockCopy = vi.fn();

    term.writeParsed();
    term.writeParsed();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(150);

    timers[0].fn();
    expect(frames).toHaveLength(1);
    frames[0]();
    expect(app._updateCodeBlockCopy).toHaveBeenCalledTimes(1);
  });

  it('schedules no update after output while no pointer is over the terminal', () => {
    const { app, context, term } = install();
    const timers: unknown[] = [];
    context.setTimeout = (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    };
    app._codeCopyPointer = null;

    term.writeParsed();

    expect(timers).toHaveLength(0);
  });

  it('recomputes the matches after a repaint that keeps the viewport where it was', () => {
    const { app, btn, term } = install();
    const blockOne = 'alpha = 1\nbeta = 2';
    const blockTwo = 'gamma = 3\ndelta = 4';
    app._codeCopyCache.set('s1', {
      blocks: [{ text: blockOne }, { text: blockTwo }],
      fetchedAt: 1_000,
      loading: false,
      stale: false,
    });
    let rows = ['', 'alpha = 1', 'beta = 2', '', 'prose'];
    const rect = { left: 0, top: 0, right: 800, bottom: 384 };
    const host = { getBoundingClientRect: () => rect, scrollLeft: 0 };
    Object.assign(btn, { style: {}, parentElement: host, contains: () => false, offsetWidth: 28 });
    Object.assign(term, {
      rows: 24,
      buffer: { active: { viewportY: 0, getLine: (y: number) => narrowLine(rows[y] ?? '') } },
      element: {
        querySelector: (sel: string) => (sel === '.xterm-screen' ? { getBoundingClientRect: () => rect } : null),
      },
      _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } },
    });
    app._codeBlockCopyEnabled = () => true;
    app._clientPointToCell = () => ({ col: 3, row: 2 });
    app._codeCopyPointer = { x: 24, y: 24, buttons: 0 };

    app._updateCodeBlockCopy();
    expect(btn._codeText).toBe(blockOne);

    // The same rows now show block two, and the viewport has not moved.
    rows = ['', 'gamma = 3', 'delta = 4', '', 'prose'];
    term.writeParsed();
    app._updateCodeBlockCopy();

    expect(btn._codeText).toBe(blockTwo);
  });

  it("copies the button's code text on click", async () => {
    const { app, btn } = install();
    app._copyText = vi.fn(async () => true);
    app._flashCopyResult = vi.fn();
    btn._codeText = 'x = 1';

    await btn.on.click({ preventDefault() {}, stopPropagation() {} });

    expect(app._copyText).toHaveBeenCalledWith('x = 1');
    expect(app._flashCopyResult).toHaveBeenCalledWith(btn, true);
  });

  it('gives focus back after a copy that moved it', async () => {
    const { app, btn, documentRef } = install();
    const focused = { isConnected: true, focus: vi.fn() };
    documentRef.activeElement = focused;
    // The execCommand fallback focuses a temporary textarea and removes it.
    app._copyText = vi.fn(async () => {
      documentRef.activeElement = { isConnected: false };
      return true;
    });
    app._flashCopyResult = vi.fn();
    btn._codeText = 'x = 1';

    await btn.on.click({ preventDefault() {}, stopPropagation() {} });

    expect(focused.focus).toHaveBeenCalledTimes(1);
  });

  it('flashes failure when the copy fails', async () => {
    const { app, btn } = install();
    app._copyText = vi.fn(async () => false);
    app._flashCopyResult = vi.fn();
    btn._codeText = 'x = 1';

    await btn.on.click({ preventDefault() {}, stopPropagation() {} });

    expect(app._flashCopyResult).toHaveBeenCalledWith(btn, false);
  });

  it('flashes failure without copying when the button has no code text', async () => {
    const { app, btn } = install();
    app._copyText = vi.fn(async () => true);
    app._flashCopyResult = vi.fn();
    btn._codeText = null;

    await btn.on.click({ preventDefault() {}, stopPropagation() {} });

    expect(app._copyText).not.toHaveBeenCalled();
    expect(app._flashCopyResult).toHaveBeenCalledWith(btn, false);
  });
});

describe('code-block copy settings wiring', () => {
  const settingsUi = read('settings-ui.js');
  const html = read('index.html');
  const schemas = readFileSync(resolve(import.meta.dirname, '../src/web/schemas.ts'), 'utf8');

  it('keeps the toggle per-device: display key, stripped from the PUT, absent from the schema', () => {
    const displayKeys = settingsUi.slice(
      settingsUi.indexOf('const displayKeys = new Set(['),
      settingsUi.indexOf('])', settingsUi.indexOf('const displayKeys = new Set(['))
    );
    expect(displayKeys).toContain("'terminalCodeCopy'");
    // SettingsUpdateSchema is .strict(), so a key it does not declare 400s the
    // whole settings PUT if the client sends it.
    expect(settingsUi).toContain('terminalCodeCopy: _tcc,');
    expect(schemas).not.toContain('terminalCodeCopy');
  });

  it('keeps the control loadable and savable by id', () => {
    expect(html).toContain('id="appSettingsTerminalCodeCopy"');
    expect(settingsUi).toContain(
      "document.getElementById('appSettingsTerminalCodeCopy').checked = settings.terminalCodeCopy === true;"
    );
    expect(settingsUi).toContain("terminalCodeCopy: document.getElementById('appSettingsTerminalCodeCopy').checked,");
  });
});
