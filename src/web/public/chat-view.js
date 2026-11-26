/**
 * @fileoverview Chat view: a session's conversation, rendered like the Response Viewer, as the
 * session's main view, with a message box under it (docs/chat-view-plan.md, phase 1).
 *
 * The agent keeps running in its tmux pane. The chat view is a second way to look at that pane:
 * it covers the terminal (which stays mounted, attached and sized, so the PTY is never resized
 * by a view switch) and draws the conversation from the session's transcript.
 *
 * - Which sessions can have it: those whose run mode Codeman reads from a Claude-format
 *   transcript (`window.__codemanChatViewModes`, published from the `transcript` capability,
 *   never an id list here), local or Docker, not remote and not adopted, and not on a phone.
 * - Which view a session shows: the per-device choice remembered for that session
 *   (`codeman:chatViewModes` in localStorage), else the per-device setting `chatViewDefault`
 *   (default off, so a session opens in Terminal until the user picks Chat).
 * - The Chat / Terminal switch: shown on an eligible session unless the per-device setting
 *   `showChatViewSwitch` is false (an absent key means shown). Hiding it changes nothing else:
 *   the session keeps its view, and Alt+Shift+C still switches.
 * - Live updates: the conversation is re-read (debounced) on the session's `transcript:update`,
 *   `session:working` and `session:idle`. `transcript:tool_start` names the running tool in the
 *   status line. Nothing is read while the chat view is hidden.
 * - Sending: `POST /api/sessions/:id/input` with `useMux: true`, so the server pastes the text,
 *   presses Enter and re-presses it while the prompt still sits in Claude's composer. The
 *   browser's WebSocket path writes raw bytes and arms no such check. A `clientId` of this page
 *   load and a sequence number make a retried request apply once.
 * - A dialog in the pane (permission, question, plan approval) shows as a notice with a button
 *   that switches to the terminal, where it is answered.
 *
 * Messages are model and user text: they go through the Response Viewer's sanitising markdown
 * pipeline (`_buildResponseViewerMessage`), and everything else is set with `textContent`.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (this.activeSessionId, this.sessions, this.pendingHooks, _buildResponseViewerMessage,
 *   _bindResponseViewerInteractions, _getResponseViewerAgentLabel, _sendInputAsync, showToast)
 * @dependency constants.js (CodemanChatView)
 * @dependency api-client.js at runtime (this._api, this._apiJson)
 * @dependency image-input.js at runtime (_admitPromptAttachments, _uploadAndInsertImages)
 * @loadorder 12.595 of 16, after local-model-ui.js, before entrance-animations.js
 */

const CHAT_VIEW_MODES_KEY = 'codeman:chatViewModes';
/** Wait after an update before re-reading, so a burst of events costs one read. */
const CHAT_VIEW_RELOAD_DEBOUNCE_MS = 250;
/** Attempts for one send when the request itself fails (network, 5xx). */
const CHAT_VIEW_SEND_ATTEMPTS = 3;
/**
 * How long one send attempt may take before it is aborted and retried. A request that never
 * answers would otherwise keep the message box locked for good. The retry carries the same
 * `clientId` and `seq`, so the server applies the message once even if the aborted request
 * reached it.
 */
const CHAT_VIEW_SEND_TIMEOUT_MS = 15000;
/** The wait before retry n of a send is n times this. */
const CHAT_VIEW_SEND_BACKOFF_MS = 600;
/**
 * A prompt posted less than this long before an idle event may belong to the next turn, so that
 * idle event does not expire it: Claude may not have recorded it yet.
 */
const CHAT_VIEW_IDLE_GRACE_MS = 2000;
/**
 * How long a sent slash command stays drawn as pending when it started no turn. Claude writes
 * some commands to the transcript (the reader draws them as typed, which confirms the pending
 * copy), others never; a command that started a turn stays drawn until the turn ends.
 */
const CHAT_VIEW_SLASH_PENDING_MS = 4000;
/** How long the `/` menu reuses a session's command list before it reads it again. */
const CHAT_VIEW_SLASH_TTL_MS = 30000;

Object.assign(CodemanApp.prototype, {
  // ─── Eligibility and choice ──────────────────────────────────

  /** Whether `sessionId` can show the chat view on this device. */
  chatViewEligible(sessionId) {
    const session = sessionId ? this.sessions?.get(sessionId) : null;
    if (!session) return false;
    const modes = Array.isArray(window.__codemanChatViewModes) ? window.__codemanChatViewModes : [];
    if (!session.mode || !modes.includes(session.mode)) return false;
    // A remote session's transcript lives on its host, and an adopted one has none Codeman can name.
    if (session.remote || session.adopt) return false;
    // Phones keep the terminal and its keyboard bars (phase 3 lays the chat view out for them),
    // whatever their orientation or fold: a phone turned to landscape is still a phone.
    if (typeof MobileDetection !== 'undefined') {
      const phone = MobileDetection.isHandheldDevice?.() ?? MobileDetection.getDeviceType?.() === 'mobile';
      if (phone) return false;
    }
    return true;
  },

  /** The per-device choice for each session, `{ [sessionId]: 'chat' | 'terminal' }`. */
  _chatViewStoredModes() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CHAT_VIEW_MODES_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  },

  _chatViewStoreModes(modes) {
    try {
      localStorage.setItem(CHAT_VIEW_MODES_KEY, JSON.stringify(modes));
    } catch {
      // Storage blocked: the choice lasts for this page load only.
    }
  },

  /** 'chat' or 'terminal' for `sessionId`. */
  chatViewModeFor(sessionId) {
    // A picker command shows the terminal until the user switches back (_chatViewOpenPicker).
    if (this._chatViewPickerSessions?.has(sessionId)) return 'terminal';
    const stored = this._chatViewStoredModes()[sessionId];
    if (stored === 'chat' || stored === 'terminal') return stored;
    if (this._chatViewMemoryModes?.has(sessionId)) return this._chatViewMemoryModes.get(sessionId);
    return this.loadAppSettingsFromStorage?.().chatViewDefault === true ? 'chat' : 'terminal';
  },

  setChatViewMode(sessionId, mode) {
    if (!sessionId || (mode !== 'chat' && mode !== 'terminal')) return;
    // A choice the user makes ends a picker's temporary Terminal (_chatViewOpenPicker).
    this._chatViewPickerSessions?.delete(sessionId);
    if (!this._chatViewMemoryModes) this._chatViewMemoryModes = new Map();
    this._chatViewMemoryModes.set(sessionId, mode);
    const modes = this._chatViewStoredModes();
    modes[sessionId] = mode;
    this._chatViewStoreModes(modes);
    if (sessionId === this.activeSessionId) this._chatViewSync({ focus: true });
  },

  /**
   * Called after each init (app.js) with the server's session list: drop the view choice of every
   * session not in it. A session deleted while no page was open sends this page no event.
   */
  _chatViewPruneModes(liveIds) {
    for (const id of [...(this._chatViewMemoryModes?.keys() ?? [])]) {
      if (!liveIds.has(id)) this._chatViewMemoryModes.delete(id);
    }
    const modes = this._chatViewStoredModes();
    const kept = Object.fromEntries(Object.entries(modes).filter(([id]) => liveIds.has(id)));
    if (Object.keys(kept).length !== Object.keys(modes).length) this._chatViewStoreModes(kept);
  },

  /** Whether this device shows the Chat / Terminal switch. An absent setting means it does. */
  _chatViewSwitchShown() {
    return this.loadAppSettingsFromStorage?.().showChatViewSwitch !== false;
  },

  /** The Alt+Shift+C action: flip the active session between Chat and Terminal. */
  toggleChatView() {
    const id = this.activeSessionId;
    if (!this.chatViewEligible(id) || this._tilesOwnTerminal?.()) return;
    this.setChatViewMode(id, this.chatViewModeFor(id) === 'chat' ? 'terminal' : 'chat');
  },

  /**
   * True when `e` is the chat view toggle chord and it applies here, so the xterm key handler
   * swallows it. Outside a session that can show the chat view, the chord reaches the terminal.
   */
  shouldToggleChatViewFromShortcut(e) {
    if (!e || (!e.ctrlKey && !e.metaKey && !e.altKey)) return false;
    if (!this.chatViewEligible(this.activeSessionId) || this._tilesOwnTerminal?.()) return false;
    if (typeof this.getShortcutRegistry !== 'function' || typeof this.matchesShortcutEvent !== 'function') return false;
    const shortcut = this.getShortcutRegistry().find((s) => s.id === 'toggle-chat-view');
    if (!shortcut || shortcut.disabled) return false;
    return this.matchesShortcutEvent(e, shortcut);
  },

  // ─── DOM ─────────────────────────────────────────────────────

  /**
   * `text` in the page's language. i18n.js translates the DOM as it changes, but it skips every
   * <textarea> and the `data-i18n-skip` conversation, so the strings drawn there are looked up here.
   */
  _chatViewT(text, vars) {
    return window.CodemanI18n?.t?.(text, vars) ?? text;
  },

  _chatViewEnsureDom() {
    if (this._chatView) return this._chatView;
    const wrap = document.querySelector('.terminal-wrap');
    if (!wrap) return null;

    const toggle = document.createElement('div');
    toggle.className = 'chat-view-toggle';
    toggle.setAttribute('role', 'group');
    toggle.setAttribute('aria-label', 'Session view');
    toggle.hidden = true;
    const chatBtn = document.createElement('button');
    chatBtn.type = 'button';
    chatBtn.className = 'chat-view-toggle-btn';
    chatBtn.dataset.mode = 'chat';
    chatBtn.textContent = 'Chat';
    chatBtn.title = 'Show the conversation (Alt+Shift+C)';
    const termBtn = document.createElement('button');
    termBtn.type = 'button';
    termBtn.className = 'chat-view-toggle-btn';
    termBtn.dataset.mode = 'terminal';
    termBtn.textContent = 'Terminal';
    termBtn.title = 'Show the terminal (Alt+Shift+C)';
    toggle.append(chatBtn, termBtn);
    toggle.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.chat-view-toggle-btn');
      if (btn && this.activeSessionId) this.setChatViewMode(this.activeSessionId, btn.dataset.mode);
    });

    const root = document.createElement('section');
    root.className = 'chat-view';
    root.setAttribute('aria-label', 'Conversation');
    root.hidden = true;

    // The Response Viewer's body class: the chat view renders exactly as the viewer does.
    const scroller = document.createElement('div');
    scroller.className = 'chat-view-scroll response-viewer-body';
    scroller.setAttribute('data-i18n-skip', '');
    // Focusable, so a focus taken from the hidden terminal has somewhere to go without a keyboard.
    scroller.tabIndex = -1;
    const thread = document.createElement('div');
    thread.className = 'chat-view-thread';
    const empty = document.createElement('p');
    empty.className = 'chat-view-empty';
    empty.hidden = true;
    scroller.append(thread, empty);

    const dialog = document.createElement('div');
    dialog.className = 'chat-view-dialog';
    dialog.setAttribute('role', 'status');
    dialog.hidden = true;
    const dialogText = document.createElement('span');
    dialogText.className = 'chat-view-dialog-text';
    dialogText.textContent = 'Claude is waiting for your answer in the terminal.';
    const dialogBtn = document.createElement('button');
    dialogBtn.type = 'button';
    dialogBtn.className = 'chat-view-btn chat-view-btn-primary';
    dialogBtn.textContent = 'Open terminal';
    dialogBtn.addEventListener('click', () => {
      const id = this.activeSessionId;
      if (!id) return;
      this.setChatViewMode(id, 'terminal');
      this.terminal?.focus?.();
    });
    dialog.append(dialogText, dialogBtn);

    const status = document.createElement('div');
    status.className = 'chat-view-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    const statusDot = document.createElement('span');
    statusDot.className = 'chat-view-status-dot';
    statusDot.setAttribute('aria-hidden', 'true');
    const statusBody = document.createElement('div');
    statusBody.className = 'chat-view-status-body';
    const statusText = document.createElement('div');
    statusText.className = 'chat-view-status-text';
    // This line shows the command under a described Bash call, as the CLI draws it.
    const statusSub = document.createElement('div');
    statusSub.className = 'chat-view-status-sub';
    statusSub.hidden = true;
    statusBody.append(statusText, statusSub);
    status.append(statusDot, statusBody);

    const composer = document.createElement('form');
    composer.className = 'chat-view-composer';
    const input = document.createElement('textarea');
    input.className = 'chat-view-input';
    input.rows = 1;
    input.setAttribute('dir', 'auto');
    input.setAttribute('aria-label', this._chatViewT('Message'));
    input.setAttribute('autocomplete', 'off');
    const actions = document.createElement('div');
    actions.className = 'chat-view-actions';
    const attachBtn = document.createElement('button');
    attachBtn.type = 'button';
    attachBtn.className = 'chat-view-btn chat-view-btn-icon';
    attachBtn.title = 'Attach files';
    attachBtn.setAttribute('aria-label', 'Attach files');
    attachBtn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.hidden = true;
    fileInput.tabIndex = -1;
    // One list of accepted types: the toolbar Attach picker's.
    const toolbarPicker = document.getElementById('attachFileInput');
    if (toolbarPicker?.accept) fileInput.accept = toolbarPicker.accept;
    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'chat-view-btn';
    stopBtn.textContent = 'Stop';
    stopBtn.title = 'Interrupt the current turn (sends Esc)';
    stopBtn.hidden = true;
    const sendBtn = document.createElement('button');
    sendBtn.type = 'submit';
    sendBtn.className = 'chat-view-btn chat-view-btn-primary';
    sendBtn.textContent = 'Send';
    actions.append(attachBtn, fileInput, stopBtn, sendBtn);
    // The `/` menu: skills and commands that match what follows the `/`, drawn above the box.
    const slashMenu = document.createElement('div');
    slashMenu.className = 'chat-view-slash';
    slashMenu.id = 'chatViewSlashMenu';
    slashMenu.setAttribute('role', 'listbox');
    slashMenu.setAttribute('aria-label', this._chatViewT('Commands'));
    slashMenu.setAttribute('data-i18n-skip', '');
    slashMenu.hidden = true;
    input.setAttribute('aria-controls', slashMenu.id);
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    composer.append(slashMenu, input, actions);

    // The status line follows the last message, inside the scrolling area, so an eye watching
    // the newest output finds it there and not at the bottom of the window.
    scroller.insertBefore(status, empty);
    // The CLI's statusline, under the message box where the CLI draws it.
    const statusline = document.createElement('div');
    statusline.className = 'chat-view-statusline';
    statusline.setAttribute('data-i18n-skip', '');
    statusline.hidden = true;
    root.append(scroller, dialog, composer, statusline);
    wrap.append(root, toggle);

    input.addEventListener('keydown', (ev) => {
      if (this._chatViewSlashKey(ev)) return;
      if (this._chatViewUseSuggestion(ev)) return;
      // Firefox and Chromium insert nothing for Alt+Enter in a textarea, so the box adds the
      // line itself. The preventDefault also stops a second line where the browser does add one
      // (Option+Return on macOS), and the input event autosizes the box and saves the draft.
      if (
        ev.key === 'Enter' &&
        ev.altKey &&
        !ev.shiftKey &&
        !ev.ctrlKey &&
        !ev.metaKey &&
        !ev.isComposing &&
        ev.keyCode !== 229
      ) {
        ev.preventDefault();
        input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input'));
        return;
      }
      if (window.CodemanChatView?.enterSends(ev, this._chatViewTouchPrimary())) {
        ev.preventDefault();
        this._chatViewSend();
      }
    });
    input.addEventListener('input', () => {
      this._chatViewAutosize();
      this._chatViewSyncComposer();
      if (this._chatView?.sessionId) this._chatViewDrafts().set(this._chatView.sessionId, input.value);
      if (this._chatView) this._chatView.slashDismissed = false;
      this._chatViewSlashUpdate();
    });
    // A caret moved by a click or an arrow key can leave or enter the first word.
    input.addEventListener('click', () => this._chatViewSlashUpdate());
    input.addEventListener('keyup', (ev) => {
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End') {
        this._chatViewSlashUpdate();
      }
    });
    input.addEventListener('blur', () => this._chatViewSlashClose());
    // A pasted screenshot or file goes the way of the paperclip button; pasted text with no file
    // the attach rules admit lands in the box natively, as in the phone's Compose box.
    input.addEventListener('paste', (ev) => {
      const items = ev.clipboardData?.items;
      if (!items || typeof this._admitPromptAttachments !== 'function') return;
      const files = Array.from(items)
        .map((item) => item.getAsFile?.())
        .filter(Boolean);
      if (files.length === 0) return;
      const media = this._admitPromptAttachments(files, { textPasted: !!ev.clipboardData.getData('text/plain') });
      if (media.length === 0) return;
      ev.preventDefault();
      this._chatViewUpload(media);
    });
    // A press on a row must not take focus from the box, or the blur closes the menu first.
    slashMenu.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      const row = ev.target.closest?.('.chat-view-slash-item');
      if (row) this._chatViewSlashAccept(Number(row.dataset.index));
    });
    composer.addEventListener('submit', (ev) => {
      ev.preventDefault();
      this._chatViewSend();
    });
    stopBtn.addEventListener('click', () => this._chatViewStop());
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      this._chatViewAttach(files);
    });
    root.addEventListener('dragover', (ev) => {
      if (ev.dataTransfer?.types?.includes('Files')) ev.preventDefault();
    });
    root.addEventListener('drop', (ev) => {
      if (!ev.dataTransfer?.files?.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      this._chatViewAttach(Array.from(ev.dataTransfer.files));
    });

    // Keys must never reach the hidden terminal: a focus that lands there (a click-through, a
    // code path that refocuses the terminal after a load) moves to the message box. That covers
    // #terminalContainer and #cjkInput, which takes terminal.focus() while CJK input is on and
    // sits outside the container, under the chat layer.
    const redirectFocus = () => {
      if (this._chatViewShowing()) this._chatView?.input.focus({ preventScroll: true });
    };
    document.getElementById('terminalContainer')?.addEventListener('focusin', redirectFocus);
    document.getElementById('cjkInput')?.addEventListener('focusin', redirectFocus);

    // A file dropped on the Chat / Terminal switch must not make the browser open it and leave
    // Codeman. The conversation itself takes dropped files as attachments (above).
    toggle.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'none';
    });
    toggle.addEventListener('drop', (ev) => ev.preventDefault());

    this._chatView = {
      root,
      toggle,
      chatBtn,
      termBtn,
      scroller,
      thread,
      empty,
      dialog,
      status,
      statusText,
      statusSub,
      statusline,
      input,
      sendBtn,
      stopBtn,
      slashMenu,
      // The open menu's rows and the highlighted one: { query, items, index } or null.
      slash: null,
      // Esc closed the menu: a command list that lands later does not reopen it. The dismissal
      // lasts until the next input event, the menu opening again, or a switch to another session.
      slashDismissed: false,
      sessionId: null,
      keys: [],
      // The visible messages of the last draw, for matching pending prompts against.
      lastMessages: [],
      // Prompts drawn the moment they are sent, until the transcript has them:
      // { sessionId, text, baseline, el, postedAt, expireOnRender }.
      pending: [],
      reloadTimer: null,
      statusTimer: null,
      loading: false,
      reloadAgain: false,
      sending: false,
    };
    return this._chatView;
  },

  _chatViewDrafts() {
    if (!this._chatViewDraftMap) this._chatViewDraftMap = new Map();
    return this._chatViewDraftMap;
  },

  /**
   * Whether the device's main pointer is touch, where a bare Enter adds a line. The primary
   * pointer decides, never MobileDetection.isTouchDevice(), which is true on a touchscreen laptop
   * too (the rule settings-ui.js states for the tile grid default).
   */
  _chatViewTouchPrimary() {
    return window.matchMedia?.('(pointer: coarse)')?.matches === true;
  },

  /** Whether the chat view is what the main area shows right now. */
  _chatViewShowing() {
    return !!this._chatView && !this._chatView.root.hidden;
  },

  /** Whether keyboard focus sits in the terminal: inside #terminalContainer, or on #cjkInput. */
  _chatViewFocusInTerminal() {
    const active = document.activeElement;
    if (!active) return false;
    if (active.id === 'cjkInput') return true;
    return !!document.getElementById('terminalContainer')?.contains(active);
  },

  // ─── Sync with the active session ────────────────────────────

  /** app.js selectSession(): the active session changed. */
  onChatViewActiveSession(sessionId) {
    const view = this._chatView;
    if (view && view.sessionId && view.sessionId !== sessionId) {
      this._chatViewDrafts().set(view.sessionId, view.input.value);
    }
    this._chatViewSync({ focus: true });
  },

  /**
   * Show or hide the toggle and the chat view for the active session, and (re)load the
   * conversation when the chat view starts showing a session.
   */
  _chatViewSync(opts = {}) {
    const id = this.activeSessionId;
    const eligible = this.chatViewEligible(id);
    if (!eligible && !this._chatView) return;
    const view = this._chatViewEnsureDom();
    if (!view) return;
    // On a touch device with its keyboard down, a focus call would pop the keyboard up over the
    // conversation, so focus follows the app's tab-switch rule.
    const focus = !!opts.focus && (this._shouldFocusTerminalForTabSwitch?.() ?? true);
    const mode = eligible ? this.chatViewModeFor(id) : 'terminal';
    // The tile grid owns the terminal area while it is open, and its tiles are terminals: the
    // chat view stays hidden, whatever the active session's choice (tile-grid.js syncs it).
    const showChat = eligible && mode === 'chat' && !this._tilesOwnTerminal?.();

    // The setting hides only the switch: the session keeps its view, and Alt+Shift+C still works.
    view.toggle.hidden = !eligible || !this._chatViewSwitchShown();
    view.chatBtn.setAttribute('aria-pressed', String(showChat));
    view.termBtn.setAttribute('aria-pressed', String(!showChat));
    view.toggle.classList.toggle('chat-view-toggle--over-chat', showChat);

    const wasShowing = !view.root.hidden;
    const previousId = view.sessionId;
    if (previousId !== id || !showChat) this._chatViewSlashClose();
    view.root.hidden = !showChat;
    document.querySelector('.terminal-wrap')?.classList.toggle('chat-view-active', showChat);
    // styles.css hides the keyboard accessory bar while this is set: its keys write into the pane.
    document.body.classList.toggle('chat-view-showing', showChat);
    if (!showChat) {
      if (view.statusTimer) {
        clearInterval(view.statusTimer);
        view.statusTimer = null;
      }
      if (wasShowing && focus && eligible) this.terminal?.focus?.();
      return;
    }

    if (previousId !== id) {
      view.sessionId = id;
      view.slashDismissed = false;
      view.keys = [];
      view.lastMessages = [];
      view.thread.replaceChildren(...this._chatViewPendingEls(id));
      view.empty.hidden = true;
      view.input.value = this._chatViewDrafts().get(id) || '';
      this._chatViewAutosize();
    }
    const agent = this._getResponseViewerAgentLabel?.() || 'Claude';
    // The CLI's suggested next prompt takes the placeholder, as it takes the CLI's empty composer;
    // Tab fills it in (_chatViewUseSuggestion). It is never sent without the user.
    const suggestion = this._chatViewSuggestion(id);
    view.input.placeholder = suggestion
      ? suggestion
      : this._chatViewTouchPrimary()
        ? this._chatViewT(`Message ${agent}`)
        : this._chatViewT(`Message ${agent} (Enter to send, Shift+Enter for a new line)`);
    view.root.querySelector('.chat-view-dialog-text').textContent =
      `${agent} is waiting for your answer in the terminal.`;
    this._chatViewSyncDialog(id);
    this._chatViewRenderStatusLine();
    this._chatViewRenderStatus();
    this._chatViewSyncComposer();
    if (previousId !== id || !wasShowing) this._chatViewReload({ immediate: true });
    // A terminal that already has focus fires no new focusin, so hardware-keyboard input would
    // keep reaching the pane behind the chat view. Move that focus to the conversation now,
    // whatever the tab-switch rule says: focusing the conversation opens no soft keyboard.
    if (this._chatViewFocusInTerminal()) view.scroller.focus({ preventScroll: true });
    if (focus) requestAnimationFrame(() => view.input.focus({ preventScroll: true }));
  },

  /** Hide everything (home screen, session gone). */
  _chatViewHide() {
    if (!this._chatView) return;
    if (this._chatView.statusTimer) {
      clearInterval(this._chatView.statusTimer);
      this._chatView.statusTimer = null;
    }
    this._chatViewSlashClose();
    this._chatView.root.hidden = true;
    this._chatView.toggle.hidden = true;
    document.querySelector('.terminal-wrap')?.classList.remove('chat-view-active');
    document.body.classList.remove('chat-view-showing');
  },

  /**
   * Called when a session is deleted (app.js): forget its turn state, draft and pending prompts.
   * The view choice stays, because a detach sends the same event and the session can be attached
   * again; `_chatViewPruneModes` drops the choices of sessions that are gone.
   */
  _chatViewForget(sessionId) {
    this._chatViewDrafts().delete(sessionId);
    this._chatViewPickerSessions?.delete(sessionId);
    this._chatViewClearedAfter?.delete(sessionId);
    this._chatViewTools?.delete(sessionId);
    this._chatViewTurnStarts?.delete(sessionId);
    this._chatViewIdleSeen?.delete(sessionId);
    this._chatViewKeepAliveTurns?.delete(sessionId);
    this._chatViewSlashCache?.delete(sessionId);
    if (this._chatView) this._chatView.pending = this._chatView.pending.filter((p) => p.sessionId !== sessionId);
    if (this._chatView?.sessionId === sessionId) {
      this._chatView.sessionId = null;
      this._chatView.keys = [];
      this._chatView.lastMessages = [];
      this._chatView.thread.replaceChildren();
    }
  },

  // ─── Events ──────────────────────────────────────────────────

  /** SSE `transcript:update`: new transcript lines for `data.sessionId`. */
  _onChatViewTranscriptUpdate(data) {
    if (data?.sessionId && data.sessionId === this._chatView?.sessionId && this._chatViewShowing()) {
      this._chatViewReload();
    }
  },

  /** SSE `transcript:tool_start`: say in the status line what the running tool works on. */
  _onChatViewToolStart(data) {
    if (!data?.sessionId || typeof data.toolName !== 'string') return;
    if (!this._chatViewTools) this._chatViewTools = new Map();
    this._chatViewTools.set(data.sessionId, {
      name: data.toolName,
      detail: typeof data.detail === 'string' ? data.detail : '',
      command: typeof data.command === 'string' ? data.command : '',
    });
    if (data.sessionId === this._chatView?.sessionId) this._chatViewRenderStatus();
  },

  /**
   * SSE `transcript:tool_end`, through app.js `_onTranscriptToolEnd`: the tool finished, so the
   * status line stops naming it and says "Working" until the next tool starts.
   */
  _onChatViewToolEnd(data) {
    if (!data?.sessionId) return;
    this._chatViewTools?.delete(data.sessionId);
    if (data.sessionId === this._chatView?.sessionId) this._chatViewRenderStatus();
  },

  /**
   * app.js `_onSessionIdle` / `_onSessionWorking`: a turn started or ended. `keepAlive` marks
   * Codeman's own keep-warm turn, which the conversation hides: the status line and Stop button
   * stay hidden for it, so Stop never sends Esc into that turn.
   */
  onChatViewTurnEvent(sessionId, idle, keepAlive) {
    if (!this._chatViewTurnStarts) this._chatViewTurnStarts = new Map();
    if (!this._chatViewIdleSeen) this._chatViewIdleSeen = new Set();
    if (!this._chatViewKeepAliveTurns) this._chatViewKeepAliveTurns = new Set();
    if (!idle && keepAlive) this._chatViewKeepAliveTurns.add(sessionId);
    else this._chatViewKeepAliveTurns.delete(sessionId);
    // A turn's start is "now" only when this page saw the session idle first. A working event
    // for a session already busy when the page loaded (or the server restarted) says nothing
    // about when its turn began, so the status line falls back to the last Enter.
    if (!idle && this._chatViewIdleSeen.has(sessionId)) {
      this._chatViewIdleSeen.delete(sessionId);
      this._chatViewTurnStarts.set(sessionId, Date.now());
    }
    if (idle) {
      this._chatViewIdleSeen.add(sessionId);
      this._chatViewTurnStarts.delete(sessionId);
      this._chatViewTools?.delete(sessionId);
      // A prompt submitted before this turn ended is in the transcript by now, unless Claude
      // turned it into something it does not record as a prompt: the next draw lets it go.
      const now = Date.now();
      for (const p of this._chatView?.pending || []) {
        if (p.sessionId === sessionId && p.postedAt && now - p.postedAt >= CHAT_VIEW_IDLE_GRACE_MS) {
          p.expireOnRender = true;
        }
      }
    }
    if (sessionId !== this._chatView?.sessionId || !this._chatViewShowing()) return;
    this._chatViewRenderStatus();
    this._chatViewSyncComposer();
    this._chatViewReload();
  },

  /** SSE `session:statusLine`: the session's statusline text changed. */
  _onChatViewStatusLine(data) {
    if (!data?.sessionId || typeof data.text !== 'string') return;
    const session = this.sessions?.get(data.sessionId);
    if (session) session.statusLine = data.text;
    if (data.sessionId === this._chatView?.sessionId) this._chatViewRenderStatusLine();
  },

  /**
   * Draw the session's statusline under the message box: one row per line, colours mapped to
   * the skin's own (`CodemanChatView.statusLineSegments`). The text is the user's statusline
   * command's output, so it goes in through `textContent` only. Redrawn only when it changed.
   */
  _chatViewRenderStatusLine() {
    const view = this._chatView;
    if (!view) return;
    const text = this.sessions?.get(view.sessionId)?.statusLine || '';
    if (view.statuslineText === text) return;
    view.statuslineText = text;
    view.statusline.hidden = !text;
    const rows = window.CodemanChatView.statusLineSegments(text).map((segments) => {
      const row = document.createElement('div');
      row.className = 'chat-view-statusline-row';
      for (const seg of segments) {
        const span = document.createElement('span');
        span.textContent = seg.text;
        if (seg.color) span.classList.add(`sl-${seg.color}`);
        if (seg.bold) span.classList.add('sl-bold');
        if (seg.dim) span.classList.add('sl-dim');
        row.appendChild(span);
      }
      return row;
    });
    view.statusline.replaceChildren(...rows);
  },

  /** app.js updateTabAlertFromHooks(): a dialog appeared or was answered. */
  onChatViewHooksChanged(sessionId) {
    if (sessionId !== this._chatView?.sessionId || !this._chatViewShowing()) return;
    this._chatViewSyncDialog(sessionId);
    // Send follows the dialog: it stays off while the pane waits for an answer.
    this._chatViewSyncComposer();
  },

  /**
   * Whether the pane shows a dialog (permission, question, plan approval). Text and Enter sent
   * then would go into the dialog, and the Enter could pick its highlighted option.
   */
  _chatViewDialogPending(sessionId) {
    const hooks = this.pendingHooks?.get(sessionId);
    return !!hooks && (hooks.has('permission_prompt') || hooks.has('elicitation_dialog'));
  },

  _chatViewSyncDialog(sessionId) {
    const view = this._chatView;
    if (!view) return;
    view.dialog.hidden = !this._chatViewDialogPending(sessionId);
  },

  /** Whether `sessionId` runs a turn the chat view shows: busy, and not Codeman's keep-alive turn. */
  _chatViewBusy(sessionId) {
    if (this._chatViewKeepAliveTurns?.has(sessionId)) return false;
    return this.sessions?.get(sessionId)?.status === 'busy';
  },

  _chatViewRenderStatus() {
    const view = this._chatView;
    if (!view) return;
    const session = this.sessions?.get(view.sessionId);
    const busy = this._chatViewBusy(view.sessionId);
    // Between turns the agent can still have work running: a background shell, a monitor, a
    // workflow. The server reads that off the CLI's screen (`watching`, e.g. "1 shell"), and the
    // line says so the way the CLI's own turn-end line does.
    const background = !busy && typeof session?.watching === 'string' && session.watching !== '';
    // Keep the view pinned to the bottom when the status line appears or grows under the last
    // message, if the reader was already there.
    const scroller = view.scroller;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    view.status.hidden = !busy && !background;
    view.status.classList.toggle('chat-view-status--background', background);
    if (background) {
      view.statusText.textContent = `${session.watching} ${this._chatViewT('still running')}`;
      view.statusSub.hidden = true;
      view.statusSub.textContent = '';
    }
    if (!busy && view.sessionId) {
      if (!this._chatViewIdleSeen) this._chatViewIdleSeen = new Set();
      this._chatViewIdleSeen.add(view.sessionId);
    }
    if (busy) {
      const helpers = window.CodemanChatView;
      // A compaction runs no tools, and the last tool seen belongs to the turn before it.
      const compacting = this._chatViewCompacting();
      const tool = compacting ? undefined : this._chatViewTools?.get(view.sessionId);
      const activity = compacting
        ? this._chatViewT('Compacting conversation')
        : helpers.activity(tool?.name, tool?.detail, session?.workingDir, tool?.command, (text) =>
            // `{what}` maps to itself, so the template keeps its slot through interpolation.
            this._chatViewT(text, { what: '{what}' })
          );
      // The turn's start: seen live (session:working after idle), else the last Enter (a page
      // loaded mid-turn), else unknown and left out.
      const startedAt = this._chatViewTurnStarts?.get(view.sessionId) || session?.lastSubmitAt || 0;
      view.statusText.textContent = startedAt ? `${activity} · ${helpers.elapsed(Date.now() - startedAt)}` : activity;
      view.statusSub.hidden = !tool?.command;
      view.statusSub.textContent = tool?.command ? `$ ${tool.command}` : '';
    }
    // The running time ticks once a second, only while the status line is on screen.
    const ticking = busy && this._chatViewShowing();
    if (ticking && !view.statusTimer) view.statusTimer = setInterval(() => this._chatViewRenderStatus(), 1000);
    if (!ticking && view.statusTimer) {
      clearInterval(view.statusTimer);
      view.statusTimer = null;
    }
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  },

  /**
   * Whether Claude's working line says it is compacting (CodemanChatView.compacting). The main
   * terminal stays attached under the chat view and shows the active session, which is the one
   * the chat view draws, so its buffer holds the screen Claude draws. Read on each status tick.
   */
  _chatViewCompacting() {
    const buffer = this.terminal?.buffer?.active;
    if (!buffer || typeof buffer.getLine !== 'function') return false;
    // The window ends at the last row with text: on a tall terminal whose content does not fill
    // the screen, Claude's working line sits far above the buffer's blank bottom rows.
    let end = buffer.length - 1;
    while (end > 0 && (buffer.getLine(end)?.translateToString(true) ?? '').trim() === '') end--;
    const rows = [];
    for (let y = Math.max(0, end - 39); y <= end; y++) {
      rows.push(buffer.getLine(y)?.translateToString(true) ?? '');
    }
    return window.CodemanChatView.compacting(rows);
  },

  _chatViewSyncComposer() {
    const view = this._chatView;
    if (!view) return;
    view.stopBtn.hidden = !this._chatViewBusy(view.sessionId);
    const payload = window.CodemanChatView?.sendPayload(view.input.value);
    view.sendBtn.disabled = view.sending || !payload || this._chatViewDialogPending(view.sessionId);
  },

  _chatViewAutosize() {
    const input = this._chatView?.input;
    if (!input) return;
    input.style.height = 'auto';
    const max = Math.max(120, Math.round(window.innerHeight * 0.4));
    input.style.height = `${Math.min(input.scrollHeight, max)}px`;
  },

  // ─── Reading and drawing the conversation ────────────────────

  /** Re-read the conversation, debounced unless `immediate`. One read at a time. */
  _chatViewReload(opts = {}) {
    const view = this._chatView;
    if (!view || !view.sessionId) return;
    clearTimeout(view.reloadTimer);
    if (opts.immediate) {
      this._chatViewFetch();
      return;
    }
    view.reloadTimer = setTimeout(() => this._chatViewFetch(), CHAT_VIEW_RELOAD_DEBOUNCE_MS);
  },

  async _chatViewFetch() {
    const view = this._chatView;
    if (!view || !view.sessionId || !this._chatViewShowing()) return;
    if (view.loading) {
      view.reloadAgain = true;
      return;
    }
    const sessionId = view.sessionId;
    view.loading = true;
    try {
      const data = await this._apiJson(`/api/sessions/${encodeURIComponent(sessionId)}/last-response?context=full`);
      // A read that finished after the user moved on is dropped.
      if (view.sessionId !== sessionId || !this._chatViewShowing()) return;
      if (data && Array.isArray(data.messages))
        this._chatViewRender(this._chatViewAfterClear(sessionId, data.messages));
    } finally {
      view.loading = false;
      if (view.reloadAgain) {
        view.reloadAgain = false;
        this._chatViewReload();
      }
    }
  },

  _chatViewRender(rawMessages) {
    const view = this._chatView;
    const helpers = window.CodemanChatView;
    if (!view || !helpers) return;
    const messages = helpers.visibleMessages(rawMessages);
    const keys = messages.map(helpers.messageKey);
    const plan = helpers.renderPlan(view.keys, keys);
    view.lastMessages = messages;
    view.empty.hidden = messages.length > 0 || this._chatViewPendingEls(view.sessionId).length > 0;
    if (messages.length === 0) view.empty.textContent = this._chatViewT('No messages yet. Send a prompt to start.');
    if (plan.mode === 'none') {
      this._chatViewSettlePending();
      return;
    }

    const scroller = view.scroller;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
    const firstDraw = view.keys.length === 0;
    const from = plan.mode === 'append' ? plan.from : 0;
    if (plan.mode === 'replace') view.thread.replaceChildren(...this._chatViewPendingEls(view.sessionId));

    const agentLabel = this._getResponseViewerAgentLabel?.() || 'Claude';
    const fragment = document.createDocumentFragment();
    for (let i = from; i < messages.length; i++) {
      const msg = messages[i];
      const previous = i > 0 ? messages[i - 1] : null;
      // Same rule as the Response Viewer's full view: one badge per speaker per turn. A `!`
      // command's output and a compaction divider carry no badge, so a reply after either
      // still shows Claude's.
      const continuation =
        !!previous &&
        !previous.shellOutput &&
        !previous.compaction &&
        previous.role === msg.role &&
        typeof msg.turn === 'number' &&
        previous.turn === msg.turn;
      const adopted = msg.role === 'user' ? this._chatViewAdoptPending(messages, i, continuation) : null;
      fragment.appendChild(adopted || this._chatViewBuildMessage(msg, agentLabel, continuation));
    }
    // Pending prompts stay below the conversation: new messages go in above the first of them.
    const firstPending = this._chatViewPendingEls(view.sessionId).find((el) => el.parentNode === view.thread);
    view.thread.insertBefore(fragment, firstPending || null);
    view.keys = keys;
    this._chatViewSettlePending();
    this._bindResponseViewerInteractions?.(view.thread);
    if (firstDraw || atBottom) scroller.scrollTop = scroller.scrollHeight;
  },

  /** One drawn message. A long prompt folds to its first lines. */
  _chatViewBuildMessage(msg, agentLabel, continuation) {
    // A compaction is a line across the thread with Claude Code's own notice on it.
    if (msg.compaction) {
      const divider = document.createElement('div');
      divider.className = 'chat-view-divider';
      divider.setAttribute('role', 'separator');
      const label = document.createElement('span');
      label.textContent = msg.text;
      divider.appendChild(label);
      return divider;
    }
    const meta = { ...msg, continuation };
    // The output of a `!` command belongs to the command above it: Claude wrote none of it, so
    // it gets no badge of Claude's.
    if (msg.shellOutput) {
      return this._buildResponseViewerMessage(msg.text, 'assistant', agentLabel, { ...meta, continuation: true });
    }
    if (msg.role !== 'user') return this._buildResponseViewerMessage(msg.text, 'assistant', agentLabel, meta);
    const text = window.CodemanChatView.promptText(msg.text);
    const fold = window.CodemanChatView.promptFold(text);
    const el = this._buildResponseViewerMessage(fold.head, 'user', agentLabel, meta);
    if (!fold.folded) return el;
    el.classList.add('chat-view-msg-folded');
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'chat-view-show-all';
    more.textContent = this._chatViewT(`Show all (${fold.totalLines} ${fold.totalLines === 1 ? 'line' : 'lines'})`);
    // Unfold in place: the element stays the same node, which a pending prompt relies on. The
    // badge is the one the element shows now: _chatViewSetUserBadge keeps rv-msg-cont in step.
    more.addEventListener('click', () => {
      const full = this._buildResponseViewerMessage(text, 'user', agentLabel, {
        ...meta,
        continuation: el.classList.contains('rv-msg-cont'),
      });
      el.replaceChildren(...full.childNodes);
      el.classList.remove('chat-view-msg-folded');
    });
    el.appendChild(more);
    return el;
  },

  // ─── Pending prompts ─────────────────────────────────────────

  /** The drawn pending prompts of `sessionId`, oldest first. */
  _chatViewPendingEls(sessionId) {
    return (this._chatView?.pending || []).filter((p) => p.sessionId === sessionId).map((p) => p.el);
  },

  /**
   * Draw a prompt the moment it is sent, below the conversation, exactly as the transcript will
   * draw it: same badge rule, same folding, no marker. When the transcript has it, the draw keeps
   * this element as the real message (`_chatViewRender`), so nothing on screen changes.
   */
  _chatViewAddPending(sessionId, text) {
    const view = this._chatView;
    const helpers = window.CodemanChatView;
    const own = view.sessionId === sessionId;
    // Copies already in the transcript, plus copies sent before this one that it does not hold
    // yet: each pending copy waits for a recorded copy of its own.
    const earlierSame = view.pending
      .filter((p) => p.sessionId === sessionId)
      .map((p) => ({ role: 'user', text: p.text }));
    const baseline = (own ? helpers.promptCount(view.lastMessages, text) : 0) + helpers.promptCount(earlierSame, text);
    // The transcript puts a prompt that follows an unanswered prompt in the same turn, with no
    // second badge.
    const earlier = view.pending.some((p) => p.sessionId === sessionId);
    const continuation = earlier || (own && view.lastMessages.at(-1)?.role === 'user');
    const agentLabel = this._getResponseViewerAgentLabel?.() || 'Claude';
    const el = this._chatViewBuildMessage({ role: 'user', text }, agentLabel, continuation);
    el.classList.add('chat-view-msg-pending');
    const pending = { sessionId, text, baseline, el, continuation, postedAt: 0, expireOnRender: false };
    view.pending.push(pending);
    if (view.sessionId === sessionId) {
      view.empty.hidden = true;
      view.thread.appendChild(el);
      view.scroller.scrollTop = view.scroller.scrollHeight;
    }
    return pending;
  },

  /**
   * The element of a pending prompt that `messages[i]` is the recorded copy of, taken out of the
   * pending list so the draw keeps it as the real message, or null when there is none. When the
   * guessed badge was wrong (the answer to an earlier prompt landed after this one was sent),
   * the badge is corrected on the same element.
   */
  _chatViewAdoptPending(messages, i, continuation) {
    const view = this._chatView;
    const helpers = window.CodemanChatView;
    const msg = messages[i];
    for (const p of view.pending) {
      if (p.sessionId !== view.sessionId) continue;
      if (helpers.promptCount([msg], p.text) !== 1) continue;
      if (helpers.promptCount(messages.slice(0, i + 1), p.text) <= p.baseline) continue;
      view.pending = view.pending.filter((other) => other !== p);
      if (p.continuation !== continuation) this._chatViewSetUserBadge(p.el, !continuation);
      // The row's markers, as _buildResponseViewerMessage sets them: a prompt typed while Claude
      // worked is recorded as queued, which the pending copy could not know.
      if (msg.queued) p.el.dataset.queued = '1';
      else delete p.el.dataset.queued;
      if (msg.kind) p.el.dataset.kind = msg.kind;
      else delete p.el.dataset.kind;
      p.el.classList.remove('chat-view-msg-pending');
      return p.el;
    }
    return null;
  },

  /** Give a drawn prompt its "You" badge, or take it away, as `_buildResponseViewerMessage` would. */
  _chatViewSetUserBadge(el, badge) {
    el.classList.toggle('rv-msg-cont', !badge);
    const existing = el.querySelector(':scope > .rv-role');
    if (!badge) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const role = document.createElement('div');
    role.className = 'rv-role rv-role-user';
    role.textContent = 'You';
    el.prepend(role);
  },

  _chatViewDropPending(pending) {
    const view = this._chatView;
    if (!view) return;
    // Gone already: dropped, or taken by a draw as the real message (_chatViewAdoptPending),
    // which a slash command's timer must leave in place.
    if (!view.pending.includes(pending)) return;
    view.pending = view.pending.filter((p) => p !== pending);
    pending.el.remove();
    if (
      view.sessionId === pending.sessionId &&
      view.keys.length === 0 &&
      !this._chatViewPendingEls(view.sessionId).length
    ) {
      view.empty.hidden = false;
    }
  },

  /**
   * Let go of the active session's pending prompts that the transcript now holds, and of those
   * a finished turn left unconfirmed (`expireOnRender`).
   */
  _chatViewSettlePending() {
    const view = this._chatView;
    const helpers = window.CodemanChatView;
    if (!view || !helpers) return;
    for (const p of [...view.pending]) {
      if (p.sessionId !== view.sessionId) continue;
      if (helpers.pendingConfirmed(p, view.lastMessages) || p.expireOnRender) this._chatViewDropPending(p);
    }
  },

  // ─── The suggested next prompt ───────────────────────────────

  /** The CLI's suggested next prompt for `sessionId` (SessionState.promptSuggestion), or ''. */
  _chatViewSuggestion(sessionId) {
    const text = this.sessions?.get(sessionId)?.promptSuggestion;
    return typeof text === 'string' ? text.trim() : '';
  },

  /**
   * Tab in an empty message box puts the suggested next prompt in it, for the user to send or
   * change. True when the key was used. Enter never sends a suggestion on its own.
   */
  _chatViewUseSuggestion(ev) {
    const view = this._chatView;
    if (!view || ev.key !== 'Tab' || ev.shiftKey || ev.altKey || ev.ctrlKey || ev.metaKey) return false;
    if (view.input.value !== '') return false;
    const suggestion = this._chatViewSuggestion(view.sessionId);
    if (!suggestion) return false;
    ev.preventDefault();
    view.input.value = suggestion;
    view.input.setSelectionRange(suggestion.length, suggestion.length);
    view.input.dispatchEvent(new Event('input'));
    return true;
  },

  // ─── Sending ─────────────────────────────────────────────────

  // ─── The `/` menu ──────────────────────────────────────────────

  /**
   * The session's slash commands (GET /api/sessions/:id/slash-commands), cached for
   * CHAT_VIEW_SLASH_TTL_MS. Returns what is cached now and starts a read when it is missing or
   * old; the menu redraws when that read lands. The entry keeps the read in flight as `promise`,
   * so a caller that needs the list now can await it. Only a read that returned a list counts as
   * fresh: after a failed one, the next call reads again.
   */
  _chatViewSlashCommands(sessionId) {
    if (!this._chatViewSlashCache) this._chatViewSlashCache = new Map();
    const entry = this._chatViewSlashCache.get(sessionId);
    const fresh = entry && Date.now() - entry.at < CHAT_VIEW_SLASH_TTL_MS;
    if (!fresh && !entry?.loading) {
      const next = { commands: entry?.commands ?? null, at: entry?.at ?? 0, loading: true };
      this._chatViewSlashCache.set(sessionId, next);
      next.promise = this._apiJson(`/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`)
        .then((data) => {
          const commands = data?.commands;
          // A failed read (_apiJson answers null) leaves `at` alone, so the next call retries it.
          // It also draws nothing: a redraw would start that next read at once, and loop on a
          // server that keeps failing.
          if (!Array.isArray(commands)) return;
          next.commands = commands;
          next.at = Date.now();
          // A menu the user closed with Esc stays closed until they type again.
          if (this._chatView?.sessionId === sessionId && !this._chatView.slashDismissed) this._chatViewSlashUpdate();
        })
        .catch(() => {})
        .finally(() => {
          next.loading = false;
        });
    }
    return this._chatViewSlashCache.get(sessionId)?.commands ?? null;
  },

  /** Open, redraw or close the menu for the message box's current text and caret. */
  _chatViewSlashUpdate() {
    const view = this._chatView;
    if (!view || !view.sessionId || !this._chatViewShowing() || document.activeElement !== view.input) {
      this._chatViewSlashClose();
      return;
    }
    const helpers = window.CodemanChatView;
    const query = helpers?.slashQuery(view.input.value, view.input.selectionStart);
    if (query === null || query === undefined) {
      this._chatViewSlashClose();
      return;
    }
    const commands = this._chatViewSlashCommands(view.sessionId);
    const items = commands ? helpers.slashMatches(commands, query) : [];
    if (items.length === 0) {
      this._chatViewSlashClose();
      return;
    }
    const keep = view.slash && view.slash.query === query ? view.slash.index : 0;
    // The menu opens again (a click or a caret key), so the Esc dismissal is over.
    view.slashDismissed = false;
    view.slash = { query, items, index: Math.min(keep, items.length - 1) };
    this._chatViewSlashRender();
  },

  _chatViewSlashRender() {
    const view = this._chatView;
    const slash = view?.slash;
    if (!slash) return;
    const rows = slash.items.map((command, index) => {
      const row = document.createElement('div');
      row.className = 'chat-view-slash-item';
      row.id = `chatViewSlashItem${index}`;
      row.setAttribute('role', 'option');
      row.dataset.index = String(index);
      const selected = index === slash.index;
      row.setAttribute('aria-selected', String(selected));
      if (selected) row.classList.add('chat-view-slash-item--active');
      const name = document.createElement('span');
      name.className = 'chat-view-slash-name';
      name.textContent = `/${command.name}`;
      const description = document.createElement('span');
      description.className = 'chat-view-slash-desc';
      // A built-in's description is Codeman's own text, so it reads in the page's language; a
      // skill's comes from the user's file and stays as written.
      description.textContent =
        command.kind === 'builtin' ? this._chatViewT(command.description || '') : command.description || '';
      row.append(name, description);
      return row;
    });
    view.slashMenu.replaceChildren(...rows);
    view.slashMenu.hidden = false;
    view.input.setAttribute('aria-expanded', 'true');
    view.input.setAttribute('aria-activedescendant', `chatViewSlashItem${slash.index}`);
    rows[slash.index]?.scrollIntoView?.({ block: 'nearest' });
  },

  _chatViewSlashClose() {
    const view = this._chatView;
    if (!view || (!view.slash && view.slashMenu.hidden)) return;
    view.slash = null;
    view.slashMenu.hidden = true;
    view.slashMenu.replaceChildren();
    view.input.setAttribute('aria-expanded', 'false');
    view.input.removeAttribute('aria-activedescendant');
  },

  /** Put `/<name> ` in place of the first word, keep the rest of the text, and close. */
  _chatViewSlashAccept(index) {
    const view = this._chatView;
    const command = view?.slash?.items[index];
    if (!command) return;
    const value = view.input.value;
    const end = value.search(/\s/);
    const rest = end === -1 ? '' : value.slice(end).replace(/^[ \t]+/, '');
    const head = `/${command.name} `;
    view.input.value = head + rest;
    view.input.setSelectionRange(head.length, head.length);
    this._chatViewSlashClose();
    view.input.dispatchEvent(new Event('input'));
  },

  /**
   * The menu's keys, while it is open: arrows move, Tab completes, Enter completes and Esc closes.
   * Once the word is the highlighted command's whole name, Enter closes the menu and is left to
   * the composer, which sends on a desktop and adds a line on a touch device (chatViewEnterSends).
   * True when the key was the menu's.
   */
  _chatViewSlashKey(ev) {
    const view = this._chatView;
    const slash = view?.slash;
    if (!slash || ev.isComposing || ev.keyCode === 229) return false;
    const count = slash.items.length;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      slash.index = (slash.index + (ev.key === 'ArrowDown' ? 1 : count - 1)) % count;
      this._chatViewSlashRender();
      return true;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      view.slashDismissed = true;
      this._chatViewSlashClose();
      return true;
    }
    if (ev.key === 'Tab' && !ev.shiftKey) {
      ev.preventDefault();
      this._chatViewSlashAccept(slash.index);
      return true;
    }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
      if (slash.items[slash.index]?.name.toLowerCase() === slash.query.toLowerCase()) {
        this._chatViewSlashClose();
        return false;
      }
      ev.preventDefault();
      this._chatViewSlashAccept(slash.index);
      return true;
    }
    return false;
  },

  async _chatViewSend() {
    const view = this._chatView;
    const sessionId = view?.sessionId;
    if (!view || !sessionId || view.sending) return;
    const value = view.input.value;
    const payload = window.CodemanChatView?.sendPayload(value);
    if (!payload) return;
    const intent = window.CodemanChatView?.slashIntent(value) ?? null;
    // `/quit` and `/exit` close the session the way the tab's close button does, at once,
    // rather than waiting for the agent to exit and the server to notice the pane is gone.
    if (intent?.kind === 'close' && typeof this.closeSession === 'function') {
      view.input.value = '';
      this._chatViewSlashClose();
      this._chatViewDrafts().delete(sessionId);
      this._chatViewAutosize();
      this._chatViewSyncComposer();
      void this.closeSession(sessionId, true);
      return;
    }
    // A dialog in the pane would take the text and the Enter. The box keeps the message.
    if (this._chatViewDialogPending(sessionId)) {
      const agent = this._getResponseViewerAgentLabel?.() || 'Claude';
      this.showToast?.(`${agent} is waiting for your answer in the terminal.`, 'warning');
      return;
    }
    const limit = window.CodemanInputLimit?.FRAME_MAX_CHARS;
    if (limit && payload.length > limit) {
      this.showToast?.(`Message too long to send (maximum ${limit.toLocaleString()} characters)`, 'error');
      return;
    }
    if (!this._chatViewClientId) {
      this._chatViewClientId = `chat-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
      this._chatViewSeq = 0;
    }
    const seq = ++this._chatViewSeq;
    view.sending = true;
    // Show the prompt at once and empty the box; a failed send puts the text back. `/clear` gets
    // no bubble: it empties the thread instead (_chatViewClearThread). The pending copy shows what
    // goes to the pane: the payload without its submitting CR.
    const pending = intent?.kind === 'clear' ? null : this._chatViewAddPending(sessionId, payload.slice(0, -1));
    if (view.sessionId === sessionId) {
      view.input.value = '';
      this._chatViewSlashClose();
      this._chatViewAutosize();
    }
    this._chatViewDrafts().delete(sessionId);
    // The CLI drops its suggestion when a prompt goes in; drop the page's copy now rather than
    // when the turn's state arrives, so the box does not offer it again meanwhile.
    const session = this.sessions?.get(sessionId);
    if (session?.promptSuggestion) {
      delete session.promptSuggestion;
      if (view.sessionId === sessionId) this._chatViewSync();
    }
    this._chatViewSyncComposer();
    let sent = false;
    let refusal = '';
    try {
      for (let attempt = 0; attempt < CHAT_VIEW_SEND_ATTEMPTS && !sent; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, CHAT_VIEW_SEND_BACKOFF_MS * attempt));
        // An attempt that hangs is aborted, which _api answers with null, so the loop retries it.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CHAT_VIEW_SEND_TIMEOUT_MS);
        try {
          const res = await this._api(`/api/sessions/${encodeURIComponent(sessionId)}/input`, {
            method: 'POST',
            body: { input: payload, useMux: true, clientId: this._chatViewClientId, seq },
            signal: controller.signal,
          });
          if (res && res.ok) {
            sent = true;
          } else if (res && res.status >= 400 && res.status < 500) {
            // Refused: the same request would be refused again.
            const body = await res.json().catch(() => null);
            refusal = body?.error || `HTTP ${res.status}`;
            break;
          }
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      view.sending = false;
    }
    if (sent) {
      if (intent?.kind === 'clear') this._chatViewClearThread(sessionId);
      if (intent?.kind === 'bare') void this._chatViewOpenPicker(sessionId, intent.name);
    }
    if (sent && pending) {
      pending.postedAt = Date.now();
      // The user's own prompt makes the running turn theirs, as the server's endKeepAliveTurn()
      // treats any other submit, so the status line and Stop show for it again.
      this._chatViewKeepAliveTurns?.delete(sessionId);
      if (view.sessionId === sessionId) this._chatViewRenderStatus();
      if (/^\s*\//.test(value)) {
        // Claude Code writes `/compact` to the transcript only when its turn ends, which can be
        // minutes later. While that turn runs, the bubble stays drawn, and the end of the turn
        // lets it go (onChatViewTurnEvent). A skill's row arrives as its turn starts and takes
        // the bubble's place then.
        setTimeout(() => {
          if (!this._chatViewBusy(sessionId)) this._chatViewDropPending(pending);
        }, CHAT_VIEW_SLASH_PENDING_MS);
      }
      this._chatViewReload();
    } else if (!sent) {
      if (pending) this._chatViewDropPending(pending);
      // Put the text back. When something was typed meanwhile, the failed message goes first and
      // what was typed follows it after a blank line, so neither is lost. The draft is written
      // too: a view switch that bypasses onChatViewActiveSession (the tile grid) reloads the box
      // from it.
      const restored = value.trimEnd();
      const merge = (current) => (current.trim() === '' ? restored : `${restored}\n\n${current}`);
      if (view.sessionId === sessionId) {
        view.input.value = merge(view.input.value);
        this._chatViewDrafts().set(sessionId, view.input.value);
        this._chatViewAutosize();
      } else {
        this._chatViewDrafts().set(sessionId, merge(this._chatViewDrafts().get(sessionId) || ''));
      }
      this.showToast?.(
        refusal ? `Message not sent: ${refusal}` : 'Message not sent. Check the connection and try again.',
        'error'
      );
    }
    this._chatViewSyncComposer();
  },

  /**
   * After `/clear`: empty the thread at once. Until the server reads the new conversation, every
   * message no newer than the newest one drawn now belongs to the old one, so a read that still
   * returns it is cut to what came after (_chatViewFetch). The cut is the newest drawn timestamp,
   * which comes from the server's clock. When the thread holds no timestamped message, the
   * browser's clock stands in, so a browser clock ahead of the server's can hide the new
   * conversation's first messages until their timestamps pass it. The server moves to the new
   * conversation when Claude's statusline reports it, about a second after the `/clear`. A
   * session without the statusline exporter (Docker, or Plan Usage Limits off) moves with its
   * next prompt.
   */
  _chatViewClearThread(sessionId) {
    const view = this._chatView;
    const drawn = view?.sessionId === sessionId ? view.lastMessages : [];
    const newest = Math.max(0, ...drawn.map((m) => Date.parse(m.timestamp)).filter((t) => Number.isFinite(t)));
    if (!this._chatViewClearedAfter) this._chatViewClearedAfter = new Map();
    this._chatViewClearedAfter.set(sessionId, newest || Date.now());
    if (view?.sessionId === sessionId && this._chatViewShowing()) this._chatViewRender([]);
  },

  /**
   * The messages of a read, without the ones from before a `/clear` sent from this page while
   * the server still reads the old conversation. Once a read holds nothing older, the server has
   * moved to the new conversation, and the cut is dropped.
   */
  _chatViewAfterClear(sessionId, messages) {
    const cut = this._chatViewClearedAfter?.get(sessionId);
    if (cut === undefined) return messages;
    const kept = messages.filter((m) => Date.parse(m.timestamp) > cut);
    if (kept.length === messages.length) this._chatViewClearedAfter.delete(sessionId);
    return kept;
  },

  /**
   * A bare built-in such as `/model` or `/config` opens a picker or panel inside Claude's
   * terminal interface, which the chat view cannot draw. Show the terminal for it, without
   * changing the session's remembered choice; switching back (the switch or Alt+Shift+C) ends it.
   */
  async _chatViewOpenPicker(sessionId, name) {
    let commands = this._chatViewSlashCommands(sessionId);
    if (!commands) {
      // Nothing cached yet: wait for the read that call has just started.
      await this._chatViewSlashCache.get(sessionId)?.promise;
      commands = this._chatViewSlashCache.get(sessionId)?.commands ?? [];
    }
    if (!commands.some((command) => command.name === name && command.opensTerminal)) return;
    if (!this._chatViewPickerSessions) this._chatViewPickerSessions = new Set();
    this._chatViewPickerSessions.add(sessionId);
    if (this.activeSessionId === sessionId) this._chatViewSync({ focus: true });
    this.showToast?.(this._chatViewT(`/${name} opens in the terminal. Press Alt+Shift+C to go back to Chat.`), 'info');
  },

  /** Interrupt the running turn: Esc, the key Claude stops on. */
  _chatViewStop() {
    const sessionId = this._chatView?.sessionId;
    if (!sessionId) return;
    this._sendInputAsync(sessionId, '\x1b');
    if (this._shouldFocusTerminalForTabSwitch?.() ?? true) this._chatView.input.focus({ preventScroll: true });
  },

  /**
   * Add dictated text to the message box (voice-input.js direct mode while Chat shows). Typed
   * into the hidden pane, it would sit unseen in Claude's composer, and the next Send would paste
   * after it.
   */
  _chatViewInsertText(text) {
    const view = this._chatView;
    if (!view || !view.sessionId || !text) return;
    const current = view.input.value;
    const sep = current && !/\s$/.test(current) ? ' ' : '';
    view.input.value = `${current}${sep}${text}`;
    this._chatViewDrafts().set(view.sessionId, view.input.value);
    this._chatViewAutosize();
    this._chatViewSyncComposer();
    view.input.focus({ preventScroll: true });
  },

  /** Upload picked or dropped files and put their paths in the message box. */
  async _chatViewAttach(files) {
    if (!this._chatView?.sessionId || !files?.length || typeof this._admitPromptAttachments !== 'function') return;
    const media = this._admitPromptAttachments(files);
    if (media.length > 0) await this._chatViewUpload(media);
  },

  /**
   * Upload files the attach rules already admitted into the session's workspace, and put their
   * paths in the message box (or in that session's draft, when the user moved on meanwhile).
   */
  async _chatViewUpload(media) {
    const view = this._chatView;
    const sessionId = view?.sessionId;
    if (!sessionId || !media?.length) return;
    const paths = await this._uploadAndInsertImages(media, { insert: false, sessionId });
    if (!paths?.length) return;
    const text = paths.join(' ');
    if (view.sessionId === sessionId) {
      this._chatViewInsertText(`${text} `);
    } else {
      const draft = this._chatViewDrafts().get(sessionId) || '';
      this._chatViewDrafts().set(sessionId, `${draft}${draft && !/\s$/.test(draft) ? ' ' : ''}${text} `);
    }
  },
});
