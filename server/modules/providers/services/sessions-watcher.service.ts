import os from 'node:os';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import chokidar, { type FSWatcher } from 'chokidar';

import { readDataVersion, sessionsDb } from '@/modules/database/index.js';
import { claudeSecretaryActivity } from '@/modules/providers/list/claude/claude-secretary-activity.provider.js';
import { sessionSynchronizerService } from '@/modules/providers/services/session-synchronizer.service.js';
import { broadcastSessionUpsertedBatch } from '@/modules/websocket/index.js';
import type { LLMProvider, SessionChangeSignature } from '@/shared/types.js';

/**
 * What prompted a pending delta. `add` and `change` come from chokidar; `db`
 * comes from a session row an outside process committed, which never produces
 * a filesystem event at all.
 */
type WatcherEventType = 'add' | 'change' | 'db';

const PROVIDER_WATCH_PATHS: Array<{ provider: LLMProvider; rootPath: string }> = [
  {
    provider: 'claude',
    rootPath: path.join(os.homedir(), '.claude', 'projects'),
  },
  {
    provider: 'cursor',
    rootPath: path.join(os.homedir(), '.cursor', 'projects'),
  },
  {
    provider: 'codex',
    rootPath: path.join(os.homedir(), '.codex', 'sessions'),
  },
  {
    provider: 'opencode',
    rootPath: path.join(os.homedir(), '.local', 'share', 'opencode'),
  },
];

/**
 * What the watcher never descends into or reports. These used to be glob
 * strings, which chokidar v4 no longer understands: it takes a path, a RegExp
 * or a function, so the globs matched nothing and every file under every
 * provider root was watched and, with polling, stat()ed every interval (#1156).
 */
const IGNORED_DIRECTORY_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  // Claude writes a subagent's transcript and large tool outputs here. The
  // synchronizer skips them already (#880); ignoring them here keeps the
  // watcher from walking them at all.
  'subagents',
  'tool-results',
]);
const IGNORED_FILE_NAMES = new Set(['.DS_Store']);
const IGNORED_FILE_SUFFIXES = ['.tmp', '.swp'];

/**
 * Builds chokidar's `ignored` matcher for one watch root.
 *
 * Only the part of the path below `rootPath` is checked, so a home directory
 * that happens to sit under `/build` or `/dist` cannot hide a whole provider.
 *
 * Exported for the providers module's tests, which run it against chokidar on
 * a real directory tree.
 */
export function createWatcherIgnoredMatcher(rootPath: string): (filePath: string) => boolean {
  return (filePath: string) => {
    const relativePath = path.relative(rootPath, filePath);
    // Outside the root is `..` as a whole component, or an absolute result
    // (another drive on Windows). A child called `..archive` is still inside.
    const isOutsideRoot = relativePath === '..'
      || relativePath.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativePath);
    if (!relativePath || isOutsideRoot) {
      return false;
    }

    const segments = relativePath.split(path.sep);
    const baseName = segments[segments.length - 1];
    if (IGNORED_FILE_NAMES.has(baseName) || IGNORED_FILE_SUFFIXES.some((suffix) => baseName.endsWith(suffix))) {
      return true;
    }

    return segments.some((segment) => IGNORED_DIRECTORY_NAMES.has(segment));
  };
}

const PROJECTS_UPDATE_DEBOUNCE_MS = 500;
const PROJECTS_UPDATE_MAX_WAIT_MS = 2_000;

/**
 * How often the watcher asks SQLite whether another process committed.
 *
 * The check itself is one `PRAGMA data_version` read — microseconds, no table
 * access — and the row scan behind it runs only when that counter actually
 * moved. Two seconds therefore buys a sidebar that keeps up with an external
 * spawner at a cost that does not register next to the file watchers already
 * running, and without ever re-fetching the session list on a timer.
 */
const SESSION_DB_POLL_INTERVAL_MS = 2_000;

const watchers: FSWatcher[] = [];

type PendingWatcherUpdate = {
  providers: Set<LLMProvider>;
  changeTypes: Set<WatcherEventType>;
  /**
   * Provider-native session ids reported by the synchronizers. They are
   * translated back to app-facing session rows at flush time, because the
   * transcript file names on disk only ever contain provider ids.
   */
  updatedSessionIds: Set<string>;
};

let pendingWatcherUpdate: PendingWatcherUpdate | null = null;
let pendingWatcherUpdateStartedAt: number | null = null;
let pendingWatcherFlushTimer: ReturnType<typeof setTimeout> | null = null;
let watcherRefreshInFlight = false;
let watcherRescheduleAfterRefresh = false;

/**
 * Filters watcher events to provider-specific session artifact file types.
 */
function isWatcherTargetFile(provider: LLMProvider, filePath: string): boolean {
  if (provider === 'opencode') {
    return path.basename(filePath) === 'opencode.db';
  }

  return filePath.endsWith('.jsonl');
}

function clearPendingWatcherFlushTimer(): void {
  if (pendingWatcherFlushTimer) {
    clearTimeout(pendingWatcherFlushTimer);
    pendingWatcherFlushTimer = null;
  }
}

function schedulePendingWatcherFlush(): void {
  if (!pendingWatcherUpdate) {
    return;
  }

  const now = Date.now();
  if (pendingWatcherUpdateStartedAt === null) {
    pendingWatcherUpdateStartedAt = now;
  }

  const elapsed = now - pendingWatcherUpdateStartedAt;
  const remainingMaxWait = Math.max(0, PROJECTS_UPDATE_MAX_WAIT_MS - elapsed);
  const delay = Math.min(PROJECTS_UPDATE_DEBOUNCE_MS, remainingMaxWait);

  clearPendingWatcherFlushTimer();
  pendingWatcherFlushTimer = setTimeout(() => {
    void flushPendingWatcherUpdate();
  }, delay);
}

function queuePendingWatcherUpdate(
  eventType: WatcherEventType,
  provider: LLMProvider,
  updatedSessionId: string | null
): void {
  if (!pendingWatcherUpdate) {
    pendingWatcherUpdate = {
      providers: new Set<LLMProvider>(),
      changeTypes: new Set<WatcherEventType>(),
      updatedSessionIds: new Set<string>(),
    };
  }

  pendingWatcherUpdate.providers.add(provider);
  pendingWatcherUpdate.changeTypes.add(eventType);
  if (updatedSessionId) {
    pendingWatcherUpdate.updatedSessionIds.add(updatedSessionId);
  }

  schedulePendingWatcherFlush();
}

async function flushPendingWatcherUpdate(): Promise<void> {
  clearPendingWatcherFlushTimer();

  if (!pendingWatcherUpdate) {
    return;
  }

  if (watcherRefreshInFlight) {
    watcherRescheduleAfterRefresh = true;
    return;
  }

  const queuedUpdate = pendingWatcherUpdate;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = true;

  try {
    // Per-session deltas instead of full project snapshots: an upsert of one
    // session can never clobber unrelated client state, so the frontend needs
    // no "suppress updates while a run is active" protection logic.
    await broadcastSessionUpsertedBatch(queuedUpdate.updatedSessionIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Session watcher refresh failed while broadcasting session_upserted', { error: message });
  } finally {
    watcherRefreshInFlight = false;

    if (pendingWatcherUpdate || watcherRescheduleAfterRefresh) {
      watcherRescheduleAfterRefresh = false;
      schedulePendingWatcherFlush();
    }
  }
}

/**
 * Last `PRAGMA data_version` observed, and the row fingerprints that went with
 * it. Both are module-private: the diff only means anything against the
 * snapshot this watcher itself took.
 */
let lastSeenDataVersion: number | null = null;
let lastSessionRevisions = new Map<string, string>();
let sessionDbPollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Records the current database state as the baseline for later diffs.
 *
 * Called once at startup so the first poll compares against what was already
 * there, instead of reporting every existing session as freshly changed.
 *
 * Exported for this module's tests, which need a baseline without starting the
 * filesystem watchers `initializeSessionsWatcher` would otherwise spin up over
 * the real home directory.
 */
export function captureSessionDbBaseline(): void {
  lastSeenDataVersion = readDataVersion();
  lastSessionRevisions = new Map(
    sessionsDb.getSessionChangeSignatures().map((signature) => [signature.sessionId, signature.revision])
  );
}

/**
 * Emits `session_upserted` for rows a process other than this server rewrote.
 *
 * Session nesting is invisible to the file watchers above: an external spawner
 * writes `custom_name`, `model` and `parent_session_id` straight into SQLite,
 * touching nothing on disk. Worse, the ordering guarantees a stale row — a
 * worker's first transcript lines land *before* its parent link is set, so the
 * delta the file event produced carries `parentSessionId: null`. Without the
 * corrected delta below, the sidebar keeps that flat row until a full reload.
 *
 * `data_version` never moves for this server's own writes, so the common case
 * costs a single pragma read and returns. When it has moved, the row scan finds
 * the changed sessions and hands them to the same debounce and broadcast the
 * file watchers use — one mechanism, two ways of noticing.
 *
 * The interval started by `initializeSessionsWatcher` is the production caller.
 * It is exported so this module's tests can run one check synchronously instead
 * of waiting on that timer.
 */
export function pollExternalSessionDbChanges(): void {
  try {
    const dataVersion = readDataVersion();
    if (dataVersion === lastSeenDataVersion) {
      return;
    }
    lastSeenDataVersion = dataVersion;

    const signatures = sessionsDb.getSessionChangeSignatures();
    const nextRevisions = new Map<string, string>();
    const changedSessions: SessionChangeSignature[] = [];

    for (const signature of signatures) {
      nextRevisions.set(signature.sessionId, signature.revision);
      if (lastSessionRevisions.get(signature.sessionId) !== signature.revision) {
        changedSessions.push(signature);
      }
    }

    // A row this server wrote itself did not move `data_version`, so its
    // snapshot entry is stale until some outside commit brings us here. That
    // makes it look "changed" now and re-broadcast a delta the app already
    // sent. Harmless — `session_upserted` is a keyed upsert — and it keeps the
    // snapshot honest for the next diff.
    lastSessionRevisions = nextRevisions;

    for (const signature of changedSessions) {
      // The column is free text; every row this app writes holds a provider id
      // the registry knows, and the delta builder reads the provider off the
      // row again anyway, so the value only labels the pending update here.
      queuePendingWatcherUpdate('db', signature.provider as LLMProvider, signature.sessionId);
    }

    if (changedSessions.length > 0) {
      console.log('Session rows changed outside this server', {
        dataVersion,
        changedSessions: changedSessions.length,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Session database change poll failed', { error: message });
  }
}

/**
 * Handles file watcher updates and triggers provider file-level synchronization.
 */
async function onUpdate(
  eventType: WatcherEventType,
  filePath: string,
  provider: LLMProvider
): Promise<void> {
  if (!isWatcherTargetFile(provider, filePath)) {
    return;
  }

  if (provider === 'claude') {
    // A secretary's row has no cloudcli run to report as processing; its
    // transcript is what says whether it is mid-turn.
    void claudeSecretaryActivity.noteTranscriptChanged(filePath).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Secretary activity update failed', { filePath, error: message });
    });
  }

  try {
    const result = await sessionSynchronizerService.synchronizeProviderFile(provider, filePath);
    if (!result.indexed) {
      return;
    }

    console.log(`Session synchronization triggered by ${eventType} event for provider "${provider}"`, {
      filePath,
      sessionId: result.sessionId,
    });
    queuePendingWatcherUpdate(eventType, provider, result.sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Session watcher sync failed for provider "${provider}"`, {
      eventType,
      filePath,
      error: message,
    });
  }
}

/**
 * Starts provider filesystem watchers and performs initial DB synchronization.
 */
export async function initializeSessionsWatcher(): Promise<void> {
  console.log('Setting up session watchers');

  const initialSync = await sessionSynchronizerService.synchronizeSessions();
  console.log('Initial session synchronization complete', {
    processedByProvider: initialSync.processedByProvider,
    prunedOrphans: initialSync.prunedOrphans,
    failures: initialSync.failures,
  });

  // Baseline first, timer second: a poll that ran before the snapshot existed
  // would report every indexed session as newly changed.
  captureSessionDbBaseline();
  sessionDbPollTimer = setInterval(pollExternalSessionDbChanges, SESSION_DB_POLL_INTERVAL_MS);
  // Never a reason on its own to keep the process alive.
  sessionDbPollTimer.unref?.();

  for (const { provider, rootPath } of PROVIDER_WATCH_PATHS) {
    try {
      await fsPromises.mkdir(rootPath, { recursive: true });

      const watcher = chokidar.watch(rootPath, {
        ignored: createWatcherIgnoredMatcher(rootPath),
        persistent: true,
        ignoreInitial: true,
        followSymlinks: false,
        depth: 6,
        // Polling reaches filesystems that native events cannot: WSL's /mnt/c,
        // network shares, some container mounts. Where native events do work,
        // chokidar's own CHOKIDAR_USEPOLLING=false overrides this and a finished
        // turn reaches the sidebar at once instead of up to 6 s later.
        usePolling: true,
        interval: 6_000,
        binaryInterval: 6_000,
      });

      watcher
        .on('add', (filePath: string) => {
          void onUpdate('add', filePath, provider);
        })
        .on('change', (filePath: string) => {
          void onUpdate('change', filePath, provider);
        })
        .on('error', (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Session watcher error for provider "${provider}"`, { error: message });
        });

      watchers.push(watcher);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to initialize session watcher for provider "${provider}"`, {
        rootPath,
        error: message,
      });
    }
  }
}

/**
 * Stops all active provider session watchers.
 */
export async function closeSessionsWatcher(): Promise<void> {
  clearPendingWatcherFlushTimer();
  claudeSecretaryActivity.stop();

  if (sessionDbPollTimer) {
    clearInterval(sessionDbPollTimer);
    sessionDbPollTimer = null;
  }
  lastSeenDataVersion = null;
  lastSessionRevisions = new Map();

  await Promise.all(
    watchers.map(async (watcher) => {
      try {
        await watcher.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('Failed to close session watcher', { error: message });
      }
    })
  );
  watchers.length = 0;
  pendingWatcherUpdate = null;
  pendingWatcherUpdateStartedAt = null;
  watcherRefreshInFlight = false;
  watcherRescheduleAfterRefresh = false;
}
