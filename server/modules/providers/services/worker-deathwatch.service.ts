/**
 * Reads the secretaries' worker-deathwatch snapshots so the sidebar can mark a
 * worker that died, stalled, was blacked out, or sent its report.
 *
 * Each registered secretary (`~/.config/dk-secretaries/registry.json`, one
 * entry per instance with its checkout `cwd`) runs `worker_deathwatch.py` every
 * minute, which rewrites `<cwd>/states/deathwatch-state.json` atomically. That
 * file — schema version 1, documented in the script's docstring — is the only
 * thing read under `states/`: the rest of that directory holds tokens. Nothing
 * here ever writes either file.
 *
 * Read on every running-sessions poll (5 s per open tab), so both the registry
 * and each snapshot are parsed once per mtime change and served from memory
 * otherwise; a poll costs one `stat` per file.
 *
 * Anything unexpected — no registry, an instance with no snapshot, a corrupt or
 * half-understood file, a future schema version — yields no entries for that
 * source rather than an error: the badges are an aid, and the poll they ride on
 * must never fail because of them.
 */

import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** The deathwatch states the sidebar marks; `working` and `done` are already said by the liveness dots. */
const NOTABLE_STATES = new Set(['died', 'stalled', 'reported', 'blackout'] as const);

type NotableWorkerState = 'died' | 'stalled' | 'reported' | 'blackout';

/**
 * A snapshot this much older than now is ignored: the timer that writes it has
 * stopped (uninstalled, or the machine slept), and a `stalled` that has since
 * resumed would otherwise stay on screen indefinitely. The writer runs every
 * minute, so this tolerates many missed runs.
 */
const STALE_SNAPSHOT_MS = 15 * 60_000;

/** One notable worker, keyed by the provider session id the snapshot records. */
export type DeathwatchWorkerEntry = {
  providerSessionId: string;
  state: NotableWorkerState;
  /** Why, in the detector's words, e.g. "OOM-killed 11:10:01 — node (vitest 12), anon-rss 51.9 GB"; '' if none. */
  cause: string;
  /** When it entered this state, epoch ms; null when the snapshot gave none or an unparseable one. */
  since: number | null;
  /** The transcript's last write, epoch ms; null when unknown. Lets the client say "no activity 34 min". */
  lastActivity: number | null;
  /** The secretary instance whose fleet the worker belongs to, e.g. "dk-ai-0". */
  instance: string;
  /** The worker's ledger name, e.g. "cloudcli-sidebar-live". */
  worker: string;
};

type ReaderDependencies = {
  /** Resolved per read, so a test that swaps the home directory is honoured. */
  registryPath: () => string;
  now: () => number;
};

type CachedFile<T> = { mtimeMs: number; size: number; value: T };

/** The snapshot's local "YYYY-MM-DD HH:MM:SS" (the writer's own clock and zone) as epoch ms. */
function parseLocalTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value.trim().replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRegistryInstanceDirectories(raw: string): string[] {
  const registry = JSON.parse(raw) as { instances?: unknown } | null;
  const instances = registry?.instances;
  if (!instances || typeof instances !== 'object') {
    return [];
  }
  const directories = new Set<string>();
  for (const entry of Object.values(instances as Record<string, unknown>)) {
    const cwd = (entry as { cwd?: unknown } | null)?.cwd;
    if (typeof cwd === 'string' && path.isAbsolute(cwd)) {
      directories.add(path.normalize(cwd));
    }
  }
  return [...directories];
}

type ParsedSnapshot = { generatedAt: number | null; workers: DeathwatchWorkerEntry[] };

/** One snapshot's notable workers; anything not schema version 1 has none. */
function parseDeathwatchSnapshot(raw: string): ParsedSnapshot {
  const snapshot = JSON.parse(raw) as Record<string, unknown> | null;
  if (!snapshot || typeof snapshot !== 'object' || snapshot.version !== 1 || !Array.isArray(snapshot.workers)) {
    return { generatedAt: null, workers: [] };
  }

  const generatedEpoch = snapshot.generated_epoch;
  const generatedAt = typeof generatedEpoch === 'number' && Number.isFinite(generatedEpoch)
    ? generatedEpoch * 1000
    : parseLocalTimestamp(snapshot.generated);
  const instance = typeof snapshot.instance === 'string' ? snapshot.instance : '';

  const workers: DeathwatchWorkerEntry[] = [];
  for (const item of snapshot.workers) {
    const worker = item as Record<string, unknown> | null;
    if (!worker || typeof worker !== 'object') {
      continue;
    }
    const state = worker.state;
    const providerSessionId = typeof worker.session_id === 'string' ? worker.session_id.trim() : '';
    // An orphan has no session id, so there is no row to mark.
    if (!providerSessionId || typeof state !== 'string' || !NOTABLE_STATES.has(state as NotableWorkerState)) {
      continue;
    }
    workers.push({
      providerSessionId,
      state: state as NotableWorkerState,
      cause: typeof worker.cause === 'string' ? worker.cause : '',
      since: parseLocalTimestamp(worker.since),
      lastActivity: parseLocalTimestamp(worker.last_activity),
      instance,
      worker: typeof worker.name === 'string' ? worker.name : '',
    });
  }
  return { generatedAt, workers };
}

/**
 * Builds a reader with its own mtime caches. The module keeps one default
 * instance; tests build their own against a temporary registry.
 */
export function createWorkerDeathwatchReader(overrides: Partial<ReaderDependencies> = {}) {
  const dependencies: ReaderDependencies = {
    registryPath: () => path.join(os.homedir(), '.config', 'dk-secretaries', 'registry.json'),
    now: Date.now,
    ...overrides,
  };
  const cache = new Map<string, CachedFile<unknown>>();

  /** The file parsed by `parse`, re-read only when its mtime or size moved; null when missing or unparseable. */
  async function readCached<T>(filePath: string, parse: (raw: string) => T): Promise<T | null> {
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      cache.delete(filePath);
      return null;
    }
    const cached = cache.get(filePath) as CachedFile<T | null> | undefined;
    if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      return cached.value;
    }
    let value: T | null;
    try {
      value = parse(await readFile(filePath, 'utf8'));
    } catch {
      // A corrupt file is cached as "nothing" too, so it is not re-parsed every
      // poll; the writer's next atomic replace changes the mtime.
      value = null;
    }
    cache.set(filePath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, value });
    return value;
  }

  return {
    /**
     * Every notable worker across all registered secretaries, newest snapshot
     * entries first as each file lists them. A session listed by two
     * snapshots keeps the first one read.
     */
    async listNotableWorkers(): Promise<DeathwatchWorkerEntry[]> {
      const directories = await readCached(dependencies.registryPath(), parseRegistryInstanceDirectories) ?? [];
      const snapshots = await Promise.all(directories.map((directory) =>
        readCached(path.join(directory, 'states', 'deathwatch-state.json'), parseDeathwatchSnapshot)));

      const now = dependencies.now();
      const seen = new Set<string>();
      const entries: DeathwatchWorkerEntry[] = [];
      for (const snapshot of snapshots) {
        if (!snapshot || snapshot.generatedAt === null || now - snapshot.generatedAt > STALE_SNAPSHOT_MS) {
          continue;
        }
        for (const worker of snapshot.workers) {
          if (seen.has(worker.providerSessionId)) {
            continue;
          }
          seen.add(worker.providerSessionId);
          entries.push(worker);
        }
      }
      return entries;
    },
  };
}

/** Used by sessionsService.readSessionLiveness, which maps each entry to its app session for the sidebar poll. */
export const workerDeathwatch = createWorkerDeathwatchReader();
