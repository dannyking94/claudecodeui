/**
 * Tells a registered secretary's cloudcli row whether that secretary is
 * mid-turn, so the row shows the same activity indicator a cloudcli-spawned
 * run does.
 *
 * Why this exists: a message typed in a secretary's row is delivered to its
 * chat-bridge inbox (see claude-secretary-inbox.provider.ts) and nothing is
 * spawned, so no run exists for the chat layer to report as processing. The
 * secretary itself runs in tmux and writes the transcript this row already
 * renders; that transcript is the truthful, already-watched source of "is it
 * working".
 *
 * The signal, from the real transcripts: every finished turn ends with an
 * assistant entry whose `stop_reason` is `end_turn` followed by a `system`
 * `turn_duration` row. Anything conversational after the last of those — a
 * queued or dequeued wake, a user/tool_result row, an assistant `tool_use` —
 * means a turn is in flight. Bookkeeping rows (`api-request`, `mode`,
 * `attachment`, …) say nothing either way and are skipped.
 *
 * Two guards keep the indicator from spinning forever: a turn with no write
 * for SECRETARY_STALE_TURN_MS reads as idle, and while it reads as working the
 * tracker polls and drops to idle the moment no claude process is attached to
 * the session any more (the secretary died mid-turn).
 */

import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import {
  findClaudeSessionHolder,
  findRegisteredClaudeSecretary,
} from '@/modules/providers/list/claude/claude-session-hold.provider.js';

/**
 * A turn with no transcript write for this long reads as idle. Claude Code's
 * Bash tool caps a foreground command at ten minutes and long thinking blocks
 * land well inside that, so a live turn writes more often than this.
 */
export const SECRETARY_STALE_TURN_MS = 10 * 60_000;

/**
 * How long a delivered message counts as "working" before the secretary has
 * written anything for it. The bridge wakes an idle secretary within seconds;
 * this only covers its wake cooldown and a slow first write.
 */
export const SECRETARY_DELIVERY_GRACE_MS = 2 * 60_000;

/** Tolerates a transcript timestamp a hair before the server noted the delivery. */
const DELIVERY_CLOCK_SKEW_MS = 1_000;

/** Re-check cadence while a turn is in flight (transcript stat + liveness). */
const WORKING_POLL_INTERVAL_MS = 5_000;

/** First tail window; request blobs make some lines large, so it can grow. */
const INITIAL_TAIL_BYTES = 512 * 1024;
const MAX_TAIL_BYTES = 4 * 1024 * 1024;

/** Assistant stop reasons that close a turn rather than hand off to a tool. */
const TURN_ENDING_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);

/**
 * Whether a secretary is mid-turn. `since` is when the turn began (epoch ms),
 * used for the indicator's elapsed time; null whenever `working` is false.
 */
export type ClaudeTranscriptActivity = { working: boolean; since: number | null };

type TurnMark = 'end' | 'active' | null;

type TranscriptEntry = Record<string, unknown>;

function readTimestamp(entry: TranscriptEntry): number | null {
  const parsed = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function contentBlocks(entry: TranscriptEntry): Array<Record<string, unknown>> {
  const content = (entry.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? content.filter((block) => block && typeof block === 'object') : [];
}

/** What one transcript row says about the turn, or null when it says nothing. */
function turnMarkOf(entry: TranscriptEntry): TurnMark {
  const mark = mainChainTurnMarkOf(entry);
  // A subagent finishing its own turn does not finish the secretary's.
  return entry.isSidechain === true && mark === 'end' ? null : mark;
}

function mainChainTurnMarkOf(entry: TranscriptEntry): TurnMark {
  switch (entry.type) {
    case 'system':
      return entry.subtype === 'turn_duration' ? 'end' : null;
    case 'queue-operation':
      // A wake (or a message typed mid-turn) waiting for, or taken by, the model.
      return entry.operation === 'enqueue' || entry.operation === 'dequeue' ? 'active' : null;
    case 'assistant': {
      if (entry.isApiErrorMessage === true) {
        return 'end';
      }
      const stopReason = (entry.message as { stop_reason?: unknown } | undefined)?.stop_reason;
      const callsTool = contentBlocks(entry).some((block) => block.type === 'tool_use');
      return typeof stopReason === 'string' && TURN_ENDING_STOP_REASONS.has(stopReason) && !callsTool
        ? 'end'
        : 'active';
    }
    case 'user': {
      const content = (entry.message as { content?: unknown } | undefined)?.content;
      const text = typeof content === 'string'
        ? content
        : contentBlocks(entry).map((block) => (typeof block.text === 'string' ? block.text : '')).join('');
      // Esc in the secretary's pane writes this instead of a turn_duration.
      return text.startsWith('[Request interrupted by user') ? 'end' : 'active';
    }
    default:
      return null;
  }
}

/**
 * Derives working/idle from the tail of a Claude transcript.
 *
 * `lines` are raw jsonl lines in file order (a partial or malformed line is
 * skipped). `lastWriteAt` is the file's mtime, which drives the stale-turn
 * timeout. `deliveredAt` is when cloudcli last delivered a message to the
 * secretary's inbox: until a wake row written after it shows up, the row reads
 * as working, so the indicator starts on send instead of on the first write.
 *
 * Consumed by this module's tracker; exported for the providers tests.
 */
export function classifyClaudeTranscriptActivity(
  lines: readonly string[],
  clock: { now: number; lastWriteAt: number; deliveredAt: number | null },
): ClaudeTranscriptActivity {
  let lastMark: TurnMark = null;
  let turnStartedAt: number | null = null;
  let deliveryPickedUp = false;
  const deliveryCutoff = clock.deliveredAt === null ? null : clock.deliveredAt - DELIVERY_CLOCK_SKEW_MS;

  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object') {
        continue;
      }
      entry = parsed as TranscriptEntry;
    } catch {
      continue;
    }

    const mark = turnMarkOf(entry);
    if (mark === null) {
      continue;
    }
    const timestamp = readTimestamp(entry);
    if (mark === 'end') {
      turnStartedAt = null;
    } else {
      turnStartedAt ??= timestamp;
      if (deliveryCutoff !== null && timestamp !== null && timestamp >= deliveryCutoff) {
        deliveryPickedUp = true;
      }
    }
    lastMark = mark;
  }

  const turnInFlight = lastMark === 'active' && clock.now - clock.lastWriteAt <= SECRETARY_STALE_TURN_MS;
  const deliveryPending = clock.deliveredAt !== null
    && !deliveryPickedUp
    && clock.now - clock.deliveredAt < SECRETARY_DELIVERY_GRACE_MS;

  if (!turnInFlight && !deliveryPending) {
    return { working: false, since: null };
  }
  const turnSince = turnInFlight ? turnStartedAt ?? clock.lastWriteAt : null;
  const candidates = [turnSince, deliveryPending ? clock.deliveredAt : null]
    .filter((value): value is number => value !== null);
  return { working: true, since: Math.min(...candidates) };
}

// ---------------------------

type TranscriptTail = { lines: string[]; mtimeMs: number; size: number };

/**
 * Reads the last lines of a transcript. The first line of a window that does
 * not start at byte 0 is dropped as partial; the window grows while it holds
 * no turn marker at all, so one huge request-blob line cannot hide the state.
 */
async function readTranscriptTail(filePath: string): Promise<TranscriptTail | null> {
  let handle;
  try {
    const stats = await stat(filePath);
    handle = await open(filePath, 'r');
    let windowBytes = INITIAL_TAIL_BYTES;
    for (;;) {
      const start = Math.max(0, stats.size - windowBytes);
      const buffer = Buffer.alloc(stats.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim());
      if (start > 0) {
        lines.shift();
      }
      const hasMarker = lines.some((line) => /"type":"(?:system|assistant|user|queue-operation)"/.test(line));
      if (hasMarker || start === 0 || windowBytes >= MAX_TAIL_BYTES) {
        return { lines, mtimeMs: stats.mtimeMs, size: stats.size };
      }
      windowBytes *= 2;
    }
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Finds `<id>.jsonl` under `~/.claude/projects/*` when the session row has no path. */
async function locateTranscript(providerSessionId: string): Promise<string | null> {
  const row = sessionsDb.getSessionByProviderSessionId(providerSessionId);
  if (row?.jsonl_path) {
    return row.jsonl_path;
  }
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  try {
    for (const project of await readdir(projectsRoot)) {
      const candidate = path.join(projectsRoot, project, `${providerSessionId}.jsonl`);
      if (await stat(candidate).then(() => true, () => false)) {
        return candidate;
      }
    }
  } catch {
    // No projects root.
  }
  return null;
}

/**
 * Sends one frame to every connected client. The websocket barrel is imported
 * lazily: the Claude runtime imports this module, and a static import would
 * close the cycle websocket → providers barrel → runtime while the runtime is
 * still initialising.
 */
async function broadcastToClients(event: Record<string, unknown>): Promise<void> {
  const { WS_OPEN_STATE, connectedClients } = await import('@/modules/websocket/index.js');
  const frame = JSON.stringify(event);
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(frame);
    }
  });
}

type SecretaryActivityDependencies = {
  isRegisteredSecretary: (providerSessionId: string) => Promise<boolean>;
  /** True while some claude process is attached to the session. */
  isSecretaryAlive: (providerSessionId: string) => Promise<boolean>;
  resolveAppSessionId: (providerSessionId: string) => string;
  resolveProviderSessionId: (appSessionId: string) => string;
  locateTranscript: (providerSessionId: string) => Promise<string | null>;
  readTranscriptTail: (filePath: string) => Promise<TranscriptTail | null>;
  broadcast: (event: Record<string, unknown>) => void | Promise<void>;
  now: () => number;
  pollIntervalMs: number;
};

const defaultDependencies: SecretaryActivityDependencies = {
  isRegisteredSecretary: async (providerSessionId) =>
    (await findRegisteredClaudeSecretary(providerSessionId)) !== null,
  isSecretaryAlive: async (providerSessionId) =>
    (await findClaudeSessionHolder(providerSessionId))?.pid != null,
  resolveAppSessionId: (providerSessionId) =>
    sessionsDb.getSessionByProviderSessionId(providerSessionId)?.session_id ?? providerSessionId,
  resolveProviderSessionId: (appSessionId) =>
    sessionsDb.getSessionById(appSessionId)?.provider_session_id ?? appSessionId,
  locateTranscript,
  readTranscriptTail,
  broadcast: broadcastToClients,
  now: Date.now,
  pollIntervalMs: WORKING_POLL_INTERVAL_MS,
};

type TrackedSecretary = {
  providerSessionId: string;
  appSessionId: string;
  transcriptPath: string | null;
  activity: ClaudeTranscriptActivity;
  deliveredAt: number | null;
  tail: TranscriptTail | null;
  pollTimer: ReturnType<typeof setTimeout> | null;
  evaluating: boolean;
  /** Another evaluation was asked for while one ran; `force` is OR-ed in. */
  rerun: { force: boolean } | null;
};

/**
 * Builds the tracker. Production uses the single `claudeSecretaryActivity`
 * below; the providers tests build their own over fake dependencies.
 */
export function createClaudeSecretaryActivityTracker(overrides: Partial<SecretaryActivityDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  const tracked = new Map<string, TrackedSecretary>();

  const track = (providerSessionId: string, appSessionId: string, transcriptPath: string | null) => {
    let entry = tracked.get(providerSessionId);
    if (!entry) {
      entry = {
        providerSessionId,
        appSessionId,
        transcriptPath,
        activity: { working: false, since: null },
        deliveredAt: null,
        tail: null,
        pollTimer: null,
        evaluating: false,
        rerun: null,
      };
      tracked.set(providerSessionId, entry);
    }
    entry.transcriptPath ??= transcriptPath;
    return entry;
  };

  const schedulePoll = (entry: TrackedSecretary) => {
    if (entry.pollTimer) {
      clearTimeout(entry.pollTimer);
    }
    entry.pollTimer = setTimeout(() => {
      entry.pollTimer = null;
      void evaluate(entry, false);
    }, dependencies.pollIntervalMs);
    entry.pollTimer.unref?.();
  };

  async function evaluate(entry: TrackedSecretary, force: boolean): Promise<void> {
    if (entry.evaluating) {
      entry.rerun = { force: force || Boolean(entry.rerun?.force) };
      return;
    }
    entry.evaluating = true;
    try {
      entry.transcriptPath ??= await dependencies.locateTranscript(entry.providerSessionId);
      if (entry.transcriptPath) {
        const fresh = await dependencies.readTranscriptTail(entry.transcriptPath);
        // Missing now (moved, or not created yet): keep the last tail we saw.
        entry.tail = fresh ?? entry.tail;
      }

      const now = dependencies.now();
      let activity = classifyClaudeTranscriptActivity(entry.tail?.lines ?? [], {
        now,
        lastWriteAt: entry.tail?.mtimeMs ?? 0,
        deliveredAt: entry.deliveredAt,
      });
      if (entry.deliveredAt !== null && now - entry.deliveredAt >= SECRETARY_DELIVERY_GRACE_MS) {
        entry.deliveredAt = null;
      }
      // Only a turn that looks in flight pays for the /proc scan.
      if (activity.working && !(await dependencies.isSecretaryAlive(entry.providerSessionId))) {
        activity = { working: false, since: null };
        entry.deliveredAt = null;
      }

      const changed = activity.working !== entry.activity.working;
      entry.activity = activity;
      if (changed || (force && activity.working)) {
        await dependencies.broadcast({
          kind: 'session_activity',
          sessionId: entry.appSessionId,
          provider: 'claude',
          isProcessing: activity.working,
          startedAt: activity.since,
          timestamp: new Date(now).toISOString(),
        });
      }

      if (activity.working) {
        schedulePoll(entry);
      } else if (entry.pollTimer) {
        clearTimeout(entry.pollTimer);
        entry.pollTimer = null;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Secretary activity evaluation failed', { sessionId: entry.providerSessionId, error: message });
    } finally {
      entry.evaluating = false;
      const rerun = entry.rerun;
      entry.rerun = null;
      if (rerun) {
        void evaluate(entry, rerun.force);
      }
    }
  }

  return {
    /**
     * A Claude transcript changed on disk. Consumed by the sessions watcher for
     * every claude jsonl event; anything not a registered secretary costs one
     * registry read and is dropped.
     */
    async noteTranscriptChanged(filePath: string): Promise<void> {
      const providerSessionId = path.basename(filePath, '.jsonl');
      let entry = tracked.get(providerSessionId);
      if (!entry) {
        if (!(await dependencies.isRegisteredSecretary(providerSessionId).catch(() => false))) {
          return;
        }
        entry = track(providerSessionId, dependencies.resolveAppSessionId(providerSessionId), filePath);
      }
      await evaluate(entry, false);
    },

    /**
     * cloudcli just delivered an owner message to this secretary's inbox.
     * Consumed by the Claude runtime right after it sends the row its
     * `complete`, which cleared the indicator — so this always re-announces a
     * working state, even one that did not change.
     */
    async noteDelivered(providerSessionId: string, appSessionId: string): Promise<void> {
      const entry = track(providerSessionId, appSessionId, null);
      entry.appSessionId = appSessionId;
      entry.deliveredAt = dependencies.now();
      await evaluate(entry, true);
    },

    /**
     * The last known activity of a tracked secretary row, by app session id;
     * null when it is idle or not a secretary. Consumed by the chat websocket's
     * `chat.subscribe` ack. An unknown row is looked up in the background, and
     * a working one is then announced with `session_activity`.
     */
    getActivity(appSessionId: string): ClaudeTranscriptActivity | null {
      for (const entry of tracked.values()) {
        if (entry.appSessionId === appSessionId) {
          return entry.activity.working ? entry.activity : null;
        }
      }
      void (async () => {
        const providerSessionId = dependencies.resolveProviderSessionId(appSessionId);
        if (tracked.has(providerSessionId)
          || !(await dependencies.isRegisteredSecretary(providerSessionId).catch(() => false))) {
          return;
        }
        await evaluate(track(providerSessionId, appSessionId, null), false);
      })().catch(() => {
        // Best effort: the row simply shows no indicator until the next write.
      });
      return null;
    },

    /** Stops every poll timer. Consumed by tests and server shutdown. */
    stop(): void {
      for (const entry of tracked.values()) {
        if (entry.pollTimer) {
          clearTimeout(entry.pollTimer);
        }
      }
      tracked.clear();
    },
  };
}

/**
 * The server's tracker. Fed by the sessions watcher and the Claude runtime,
 * read by the chat websocket (`chat.subscribe`), all through the providers
 * barrel or this module.
 */
export const claudeSecretaryActivity = createClaudeSecretaryActivityTracker();
