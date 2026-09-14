/**
 * @fileoverview SPIKE — decide which sessions a host reboot destroyed and may be rebuilt.
 *
 * A server restart and a host reboot both leave `reconcileSessions()` reporting
 * dead sessions, but they need opposite handling. A server restart leaves the
 * tmux panes running, so recovery ATTACHES to them. A host reboot takes the tmux
 * server down with it, so there is nothing to attach to and the pane has to be
 * created again. This module holds the decision half of that second case, kept
 * free of tmux and disk access so it can be unit tested without either.
 *
 * "Eligible" here means a session the user did not end on purpose. The COD-108
 * invariant says an intentional kill or detach must never be auto-revived, and
 * its in-memory guard in `TmuxManager` does not survive a reboot. The durable
 * equivalent is the record `cleanupSession()` leaves behind. An unpinned kill
 * deletes the record outright, so it is already absent here. A pinned kill
 * demotes the record to `status: 'stopped'` (COD-142), which is the marker this
 * module refuses. A record that was still `idle`, `busy` or `error` when the
 * power went out is one nobody ended.
 */

import type { SessionState } from './types.js';
import { getCli } from './config/cli-registry/registry.js';

/** Session statuses a reboot restore may rebuild. `stopped` is the COD-142 kill marker. */
const RESTORABLE_STATUSES: ReadonlySet<string> = new Set(['idle', 'busy', 'error']);

/** Observations the reboot heuristic reads. Gathered by the caller, never here. */
export interface RebootEvidence {
  /** Sessions that still had a live pane during reconciliation. */
  livePaneCount: number;
  /** Sessions reconciliation just marked dead. */
  deadSessionCount: number;
  /** `os.uptime()`, in seconds. */
  uptimeSeconds: number;
  /** Newest `lastActivityAt` across the persisted records, in ms since the epoch. */
  newestPersistedActivityAt: number;
  /** `Date.now()` when the evidence was gathered, in ms. */
  now: number;
}

/**
 * Decide whether the machine plausibly rebooted rather than the server restarting.
 *
 * Two signals have to agree. The socket must hold no panes at all while state
 * still lists sessions, which rules out an ordinary server restart. The host
 * must also have booted after the newest persisted session activity, which is
 * the corroboration `os.uptime()` provides cheaply. A wiped tmux socket on a
 * long-uptime host fails the second test, so a user who killed the tmux server
 * by hand does not get every session resurrected under him.
 */
export function looksLikeHostReboot(evidence: RebootEvidence): boolean {
  if (evidence.deadSessionCount === 0) return false;
  if (evidence.livePaneCount > 0) return false;
  if (evidence.newestPersistedActivityAt <= 0) return false;
  const bootedAt = evidence.now - evidence.uptimeSeconds * 1000;
  return bootedAt > evidence.newestPersistedActivityAt;
}

/**
 * Pick the Claude conversation the rebuilt pane should resume.
 *
 * The chain's tail outranks everything else, because it is the conversation the
 * CLI reported first-hand before the server stopped, and a `/clear` moves the
 * CLI off the launch id without changing it. A session that never resumed and
 * never cleared is still on its launch conversation, and Codeman launches Claude
 * with `--session-id <session id>`, so the session's own id is the last fallback.
 */
export function resolveResumeConversationId(state: SessionState): string {
  const chain = state.claudeSessionChain;
  const chainTail = Array.isArray(chain) && chain.length > 0 ? chain[chain.length - 1] : undefined;
  return chainTail || state.resumeSessionId || state.id;
}

/** Why one dead session was passed over. Reported for logging and assertions. */
export interface RebootRestoreRejection {
  sessionId: string;
  reason:
    | 'no-persisted-record'
    | 'intentionally-ended'
    | 'respawn-blocked'
    | 'remote-or-docker'
    | 'unsupported-mode'
    | 'no-working-dir';
}

export interface RebootRestorePlan {
  restore: SessionState[];
  skipped: RebootRestoreRejection[];
}

/**
 * Split the sessions reconciliation just killed into the ones a reboot restore
 * may rebuild and the ones it must leave alone.
 *
 * @param deadSessionIds Session ids `reconcileSessions()` reported as dead.
 * @param persisted The `state.json` session records, which `cleanupStaleSessions()`
 *   has not pruned yet at the point this runs.
 */
export function planRebootRestore(
  deadSessionIds: readonly string[],
  persisted: Readonly<Record<string, SessionState>>
): RebootRestorePlan {
  const restore: SessionState[] = [];
  const skipped: RebootRestoreRejection[] = [];

  for (const sessionId of deadSessionIds) {
    const state = persisted[sessionId];
    if (!state) {
      // An unpinned kill already deleted the record, so absence IS the COD-108 guard.
      skipped.push({ sessionId, reason: 'no-persisted-record' });
      continue;
    }
    if (!RESTORABLE_STATUSES.has(state.status)) {
      // COD-142 demoted a pinned kill to `stopped`. Reviving it would undo the kill.
      skipped.push({ sessionId, reason: 'intentionally-ended' });
      continue;
    }
    if (state.respawnBlocked === true) {
      // COD-118 tripped its breaker on this pane. Re-creating it restarts the crash loop.
      skipped.push({ sessionId, reason: 'respawn-blocked' });
      continue;
    }
    if (state.remote || state.docker) {
      // Both need another host or a container to be up, which a just-booted machine
      // cannot promise. COD-108's own reconnect watcher owns the remote case.
      skipped.push({ sessionId, reason: 'remote-or-docker' });
      continue;
    }
    // Capability, not a CLI id: this pass resumes by handing the CLI a conversation
    // id through the top-level `resumeSessionId`, which only a CLI whose history the
    // claude-jsonl reader understands can consume that way. Others carry their thread
    // id in their own `<Mode>Config`, which this spike does not thread through.
    if (getCli(state.mode ?? 'claude')?.capabilities.transcript !== 'claude-jsonl') {
      skipped.push({ sessionId, reason: 'unsupported-mode' });
      continue;
    }
    if (!state.workingDir) {
      skipped.push({ sessionId, reason: 'no-working-dir' });
      continue;
    }
    restore.push(state);
  }

  return { restore, skipped };
}

/** Newest `lastActivityAt` across persisted records, or 0 when there are none. */
export function newestPersistedActivity(persisted: Readonly<Record<string, SessionState>>): number {
  let newest = 0;
  for (const state of Object.values(persisted)) {
    const stamp = state.lastActivityAt ?? state.createdAt ?? 0;
    if (stamp > newest) newest = stamp;
  }
  return newest;
}
