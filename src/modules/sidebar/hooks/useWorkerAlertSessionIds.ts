import { useEffect, useMemo, useState } from 'react';

import type { WorkerStateEntry } from '@/shared/types';

/**
 * Died and stalled workers the user has opened since they entered that state,
 * remembered per browser so an acknowledged alert stays folded after a reload.
 * An entry is the session, the state and when it began, so a worker that
 * stalls again later — or dies after stalling — is a new alert.
 */
const SEEN_WORKER_ALERTS_STORAGE_KEY = 'cloudcli.seenWorkerAlerts';
/** Enough for days of a busy fleet; the oldest acknowledgements go first. */
const MAX_SEEN_WORKER_ALERTS = 200;

const isAlertState = (entry: WorkerStateEntry): boolean => entry.state === 'died' || entry.state === 'stalled';

const alertKey = (entry: WorkerStateEntry): string =>
  [entry.sessionId, entry.state, entry.since ?? ''].join('\u0001');

const readSeenWorkerAlerts = (): string[] => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_WORKER_ALERTS_STORAGE_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
};

/** Read-modify-write, because every project list runs this hook and must not drop another's keys. */
const writeSeenWorkerAlert = (key: string): void => {
  try {
    const seen = readSeenWorkerAlerts().filter((existing) => existing !== key);
    seen.push(key);
    localStorage.setItem(
      SEEN_WORKER_ALERTS_STORAGE_KEY,
      JSON.stringify(seen.slice(-MAX_SEEN_WORKER_ALERTS)),
    );
  } catch {
    // Without storage the acknowledgement lasts for this page only.
  }
};

/**
 * The sessions whose row must stay on screen because their worker died or
 * stalled and nobody has looked yet — exempt from the "+N inactive" fold.
 *
 * An alert ends when its row is opened (the open row is pinned anyway, and
 * folds normally once the user moves on) or when the deathwatch stops listing
 * the worker as died/stalled: the ledger closed it, or the worker resumed.
 *
 * Used by SidebarProjectSessions.
 */
export function useWorkerAlertSessionIds(
  workerStates: ReadonlyMap<string, WorkerStateEntry>,
  selectedSessionId: string | null,
): ReadonlySet<string> {
  const [seenKeys, setSeenKeys] = useState<ReadonlySet<string>>(() => new Set(readSeenWorkerAlerts()));

  const selectedEntry = selectedSessionId ? workerStates.get(selectedSessionId) : undefined;
  const selectedAlertKey = selectedEntry && isAlertState(selectedEntry) ? alertKey(selectedEntry) : null;
  // Adjusted during render (React's pattern for state derived from props), so
  // the acknowledgement lands in the same commit as the selection; only the
  // storage write, a side effect, waits for the effect.
  if (selectedAlertKey && !seenKeys.has(selectedAlertKey)) {
    setSeenKeys(new Set([...seenKeys, selectedAlertKey]));
  }
  useEffect(() => {
    if (selectedAlertKey) {
      writeSeenWorkerAlert(selectedAlertKey);
    }
  }, [selectedAlertKey]);

  return useMemo(() => {
    const ids = new Set<string>();
    for (const entry of workerStates.values()) {
      if (isAlertState(entry) && !seenKeys.has(alertKey(entry))) {
        ids.add(entry.sessionId);
      }
    }
    return ids;
  }, [workerStates, seenKeys]);
}
