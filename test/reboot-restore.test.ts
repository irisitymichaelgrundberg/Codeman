/**
 * @fileoverview SPIKE — the decision half of reboot restore, plus proof that the
 * existing recovery construction path can CREATE a resumed pane.
 *
 * Two things are under test. The first is `src/reboot-restore.ts`, which decides
 * whether the machine rebooted and which dead sessions may be rebuilt. The second
 * is the claim the whole spike rests on: a `Session` built the way
 * `restoreMuxSessions()` already builds one, but given no `muxSession` and a
 * `resumeSessionId`, creates a fresh pane that resumes the old conversation. If
 * that holds, boot restore needs no new session-creation service.
 *
 * `reconcileSessions()` reports every session ALIVE under vitest, so the server's
 * own pass cannot be reached from here. The decision logic is therefore driven
 * directly, and the construction claim is driven through a real `Session` against
 * the in-memory tmux layer vitest substitutes.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';
import type { SessionState } from '../src/types.js';
import {
  looksLikeHostReboot,
  newestPersistedActivity,
  planRebootRestore,
  resolveResumeConversationId,
} from '../src/reboot-restore.js';

const HOUR = 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

function persistedSession(overrides: Partial<SessionState> & { id: string }): SessionState {
  return {
    pid: 99999,
    status: 'idle',
    workingDir: '/tmp/spike',
    currentTaskId: null,
    createdAt: NOW - 4 * HOUR,
    lastActivityAt: NOW - 2 * HOUR,
    mode: 'claude',
    ...overrides,
  } as SessionState;
}

describe('reboot detection', () => {
  const base = {
    livePaneCount: 0,
    deadSessionCount: 2,
    // The host came up 10 minutes ago, well after the sessions were last active.
    uptimeSeconds: 600,
    newestPersistedActivityAt: NOW - 2 * HOUR,
    now: NOW,
  };

  it('calls it a reboot when the socket is empty and the host booted after the last activity', () => {
    expect(looksLikeHostReboot(base)).toBe(true);
  });

  it('refuses when some panes survived, which is an ordinary server restart', () => {
    expect(looksLikeHostReboot({ ...base, livePaneCount: 3 })).toBe(false);
  });

  it('refuses on a long-uptime host, where someone wiped the tmux socket by hand', () => {
    // Up for 30 days: the sessions were active long AFTER this boot, so the panes
    // went away for some reason other than the machine restarting.
    expect(looksLikeHostReboot({ ...base, uptimeSeconds: 30 * 24 * 60 * 60 })).toBe(false);
  });

  it('refuses when nothing died', () => {
    expect(looksLikeHostReboot({ ...base, deadSessionCount: 0 })).toBe(false);
  });

  it('reads the newest activity stamp across the persisted records', () => {
    const persisted = {
      a: persistedSession({ id: 'a', lastActivityAt: NOW - 5 * HOUR }),
      b: persistedSession({ id: 'b', lastActivityAt: NOW - 1 * HOUR }),
    };
    expect(newestPersistedActivity(persisted)).toBe(NOW - 1 * HOUR);
  });
});

describe('which dead sessions may be rebuilt', () => {
  it('rebuilds a session that was simply running when the power went out', () => {
    const persisted = { live: persistedSession({ id: 'live', status: 'busy' }) };
    const plan = planRebootRestore(['live'], persisted);
    expect(plan.restore.map((s) => s.id)).toEqual(['live']);
  });

  it('never revives a session the user killed while pinned (COD-142 demotes it to stopped)', () => {
    const persisted = { killed: persistedSession({ id: 'killed', status: 'stopped', pinned: true }) };
    const plan = planRebootRestore(['killed'], persisted);
    expect(plan.restore).toEqual([]);
    expect(plan.skipped).toEqual([{ sessionId: 'killed', reason: 'intentionally-ended' }]);
  });

  it('never revives a session whose record an unpinned kill already deleted', () => {
    const plan = planRebootRestore(['gone'], {});
    expect(plan.restore).toEqual([]);
    expect(plan.skipped).toEqual([{ sessionId: 'gone', reason: 'no-persisted-record' }]);
  });

  it('never revives a pane whose PTY-exit breaker had tripped', () => {
    const persisted = { crashy: persistedSession({ id: 'crashy', respawnBlocked: true }) };
    expect(planRebootRestore(['crashy'], persisted).skipped[0].reason).toBe('respawn-blocked');
  });

  it('leaves remote sessions to the COD-108 reconnect watcher', () => {
    const persisted = {
      r: persistedSession({
        id: 'r',
        remote: { hostId: 'h', host: 'example.test', username: 'u', sessionName: 'n', owned: true },
      } as Partial<SessionState> & { id: string }),
    };
    expect(planRebootRestore(['r'], persisted).skipped[0].reason).toBe('remote-or-docker');
  });

  it('leaves docker sessions alone, since the container may not be up', () => {
    const persisted = {
      d: persistedSession({ id: 'd', docker: { containerId: 'abc', caseId: 'c' } } as Partial<SessionState> & {
        id: string;
      }),
    };
    expect(planRebootRestore(['d'], persisted).skipped[0].reason).toBe('remote-or-docker');
  });

  it('skips a CLI whose history the claude transcript reader does not understand', () => {
    const persisted = { c: persistedSession({ id: 'c', mode: 'codex' }) };
    expect(planRebootRestore(['c'], persisted).skipped[0].reason).toBe('unsupported-mode');
  });
});

describe('which conversation a rebuilt pane resumes', () => {
  it('prefers the chain tail, the conversation the CLI reported last', () => {
    const state = persistedSession({
      id: 'sess-1',
      resumeSessionId: 'launch-id',
      claudeSessionChain: ['launch-id', 'after-clear'],
    });
    expect(resolveResumeConversationId(state)).toBe('after-clear');
  });

  it('falls back to the id the session originally resumed', () => {
    const state = persistedSession({ id: 'sess-1', resumeSessionId: 'resumed-id' });
    expect(resolveResumeConversationId(state)).toBe('resumed-id');
  });

  it('falls back to the session id, which is what Claude was launched with', () => {
    expect(resolveResumeConversationId(persistedSession({ id: 'sess-1' }))).toBe('sess-1');
  });
});

describe('the recovery construction path can create a resumed pane', () => {
  const workingDir = join(homedir(), 'codeman-cases', 'reboot-restore-spike');
  const sessions: Session[] = [];

  afterEach(() => {
    for (const s of sessions.splice(0)) s.stop();
    rmSync(workingDir, { recursive: true, force: true });
  });

  /** Built exactly as the reboot pass builds one: no `muxSession`, plus a resume id. */
  function rebuildFromPersistedState(state: SessionState, mux: TmuxManager): Session {
    mkdirSync(workingDir, { recursive: true });
    const session = new Session({
      id: state.id,
      workingDir,
      mode: state.mode,
      name: state.name,
      createdAt: state.createdAt,
      mux,
      useMux: true,
      resumeSessionId: resolveResumeConversationId(state),
      owner: state.owner,
      lastActivityAt: state.lastActivityAt,
      claudeSessionChain: state.claudeSessionChain,
    });
    sessions.push(session);
    return session;
  }

  it('creates a NEW mux session rather than needing one to attach to', async () => {
    const mux = new TmuxManager();
    const state = persistedSession({ id: 'aaaaaaa1-1111-4111-8111-111111111111', name: 'w1-spike' });
    const session = rebuildFromPersistedState(state, mux);

    expect(mux.getSessions()).toHaveLength(0);
    await session.startInteractive();

    const created = mux.getSessions();
    expect(created).toHaveLength(1);
    expect(created[0].sessionId).toBe('aaaaaaa1-1111-4111-8111-111111111111');
    expect(created[0].workingDir).toBe(workingDir);
  });

  it('comes back pointed at the conversation the pane was holding', async () => {
    const mux = new TmuxManager();
    const state = persistedSession({
      id: 'aaaaaaa2-2222-4222-8222-222222222222',
      resumeSessionId: 'launch-id',
      claudeSessionChain: ['launch-id', 'after-clear'],
    });
    const session = rebuildFromPersistedState(state, mux);

    await session.startInteractive();

    // The chain tail wins: a `/clear` before the reboot moved the CLI off the launch id.
    expect(session.claudeSessionId).toBe('after-clear');
  });

  it('comes back idle, with no prompt sent and no autonomous loop armed', async () => {
    const mux = new TmuxManager();
    const state = persistedSession({
      id: 'aaaaaaa3-3333-4333-8333-333333333333',
      ralphEnabled: true,
      respawnEnabled: true,
    });
    const session = rebuildFromPersistedState(state, mux);

    await session.startInteractive();

    // No prompt was queued: nothing is waiting on a task. The status itself is not
    // assertable here, because the test PTY echoes and the activity detector reads
    // that echo as work; in production the pane settles once the CLI finishes booting.
    expect(session.currentTaskId).toBeNull();
    // The pass never touches the tracker, so a persisted Ralph loop stays cold.
    expect(session.ralphTracker.enabled).toBe(false);
  });

  it('keeps the owner it was persisted with, there being no request to read one from', async () => {
    const mux = new TmuxManager();
    const state = persistedSession({ id: 'aaaaaaa4-4444-4444-8444-444444444444', owner: 'alice' });
    const session = rebuildFromPersistedState(state, mux);

    await session.startInteractive();

    expect(session.owner).toBe('alice');
    expect(mux.getSessions()[0].owner).toBe('alice');
  });
});
