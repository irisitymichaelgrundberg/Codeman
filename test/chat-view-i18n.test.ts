/**
 * @fileoverview The chat view's strings in Chinese (zh-CN), run through the real translator.
 *
 * chat-view.js looks its strings up itself (`_chatViewT`), because i18n.js skips the textarea
 * and the `data-i18n-skip` conversation. Pinned here:
 * - each string the chat view draws or toasts reads in Chinese, and the numbers in it survive;
 * - the "too long" and "not sent" toasts are taken by their own patterns, ahead of the bare
 *   `Message (.+)` one, which would otherwise turn them into a garbled "send a message to" line;
 * - the setting that shows or hides the Chat / Terminal switch reads in Chinese.
 * - the toast for a picker command that opens in the terminal keeps the command;
 * - every built-in command description in the `/` menu has a Chinese entry of its own.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, describe, expect, it } from 'vitest';
import { CLAUDE_BUILTIN_COMMANDS } from '../src/claude-slash-commands.js';

const I18N = readFileSync(resolve(import.meta.dirname, '../src/web/public/i18n.js'), 'utf8');

type Api = { t(s: string, vars?: Record<string, string>): string; configure(o: Record<string, string>): void };

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  runScripts: 'outside-only',
  url: 'http://localhost/',
});
vm.runInContext(I18N, dom.getInternalVMContext(), { filename: 'i18n.js' });
const api = (dom.window as unknown as { CodemanI18n: Api }).CodemanI18n;
api.configure({ language: 'zh-CN' });
afterAll(() => dom.window.close());

describe('the chat view in zh-CN', () => {
  it('takes the too-long toast by its own pattern and keeps the limit', () => {
    const text = api.t('Message too long to send (maximum 1,000 characters)');
    expect(text).toBe('消息过长，无法发送（最多 1,000 个字符）');
    expect(text).not.toContain('发消息');
  });

  it('takes the refused-send toast by its own pattern and keeps the reason', () => {
    expect(api.t('Message not sent: Input too long')).toBe('消息未发送：Input too long');
  });

  it("translates the `/` menu's accessible name", () => {
    expect(api.t('Commands')).toBe('命令');
  });

  it('translates the message box placeholders', () => {
    expect(api.t('Message Claude')).toBe('给 Claude 发消息');
    expect(api.t('Message Claude (Enter to send, Shift+Enter for a new line)')).toBe(
      '给 Claude 发消息（Enter 发送，Shift+Enter 换行）'
    );
  });

  it('takes the connection-failure toast by its static entry, ahead of the bare Message pattern', () => {
    const text = api.t('Message not sent. Check the connection and try again.');
    expect(text).toBe('消息未发送。请检查连接后重试。');
    expect(text).not.toContain('发消息');
  });

  it('translates the message box label and the composer buttons', () => {
    expect(api.t('Message')).toBe('消息');
    expect(api.t('Attach files')).toBe('附加文件');
    expect(api.t('Interrupt the current turn (sends Esc)')).toBe('中断当前轮次（发送 Esc）');
  });

  it('translates the fold button, the empty notice, the status line and the dialog notice', () => {
    expect(api.t('Show all (3 lines)')).toBe('显示全部（3 行）');
    expect(api.t('No messages yet. Send a prompt to start.')).toBe('还没有消息。发送提示词开始。');
    expect(api.t('Working')).toBe('工作中');
    expect(api.t('Claude is waiting for your answer in the terminal.')).toBe('Claude 正在终端中等待你的回答。');
    // The notification drawer shows the same sentence without the period.
    expect(api.t('Codex is waiting for your answer in the terminal')).toBe('Codex 正在终端中等待你的回答');
  });

  it('translates the Chat / Terminal switch setting', () => {
    expect(api.t('Show the Chat / Terminal switch')).toBe('显示聊天 / 终端开关');
    expect(
      api.t(
        'Show the Chat / Terminal switch at the top right of a Claude session. Alt+Shift+C switches views without it. Not on phones.'
      )
    ).toBe('在 Claude 会话右上角显示聊天 / 终端开关。没有它时，Alt+Shift+C 也能切换视图。手机上不可用。');
  });

  it('takes the picker toast by its own pattern and keeps the command', () => {
    expect(api.t('/model opens in the terminal. Press Alt+Shift+C to go back to Chat.')).toBe(
      '/model 在终端中打开。按 Alt+Shift+C 返回聊天。'
    );
  });

  it("translates every built-in command's description in the `/` menu", () => {
    for (const command of CLAUDE_BUILTIN_COMMANDS) {
      const text = api.t(command.description);
      expect(text, command.name).not.toBe(command.description);
      expect(text, command.name).toMatch(/[\u4e00-\u9fff]/);
    }
    expect(api.t("Set the model's effort level")).toBe('设置模型的思考强度');
  });
});
