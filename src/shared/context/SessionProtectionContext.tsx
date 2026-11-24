import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import {
  useSessionProtection,
} from '@/shared/hooks/useSessionProtection';
import type { BackgroundTaskSummary, GetSessionActivity, IsSessionProcessing, MarkSessionBackground, MarkSessionIdle, MarkSessionProcessing, SessionActivity, SessionActivityMap, SyncProcessingSessions } from '@/shared/types';
import { api } from '@/shared/api';

type RunningSessionApiItem = {
  sessionId?: unknown;
  startedAt?: unknown;
  statusText?: unknown;
  canInterrupt?: unknown;
  background?: unknown;
  tasks?: unknown;
  external?: unknown;
};

type RunningSessionsApiPayload = {
  data?: {
    sessions?: RunningSessionApiItem[];
    idleProcessSessionIds?: unknown;
    includesExternalActivity?: unknown;
  };
};

/**
 * How often the open app re-reads which sessions are live. It is what turns a
 * worker that exited, a turn that ended in a terminal, or a secretary whose
 * idle broadcast this client missed into the right row state without a
 * reload. Paused while the page is hidden; a page coming back reads at once.
 */
const RUNNING_SESSIONS_POLL_MS = 5000;

type SessionProtectionActions = {
  markSessionProcessing: MarkSessionProcessing;
  markSessionIdle: MarkSessionIdle;
  markSessionBackground: MarkSessionBackground;
  syncProcessingSessions: SyncProcessingSessions;
  isSessionProcessing: IsSessionProcessing;
  getSessionActivity: GetSessionActivity;
};

const SessionProtectionStateContext = createContext<SessionActivityMap | null>(null);
const SessionProtectionActionsContext = createContext<SessionProtectionActions | null>(null);
const BusySessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const BackgroundSessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const IdleProcessSessionIdsContext = createContext<ReadonlySet<string> | null>(null);
const EMPTY_SESSION_ID_SET: ReadonlySet<string> = new Set();

/** The poll's idle-process ids, sorted and joined so an unchanged set keeps its identity. */
const readIdleProcessMembershipKey = (value: unknown): string =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && id.length > 0).sort().join('\u0000')
    : '';

/**
 * The set of session ids whose activity passes `include`, with a stable
 * identity while membership is unchanged.
 *
 * Every provider `status` frame rewrites an entry's `statusText`, which
 * allocates a new activity map several times a second during a run. Consumers
 * that only need membership — the sidebar renders a dot per row and a running
 * count — would re-render on all of it.
 */
function useSessionIdSet(
  processingSessions: SessionActivityMap,
  include: (activity: SessionActivity) => boolean,
): ReadonlySet<string> {
  // Deriving the set from a membership key, rather than from the map, keeps its
  // identity stable across the `statusText` rewrites without reading a ref
  // during render. Session ids never contain a NUL, so it is a safe separator.
  const membershipKey = [...processingSessions]
    .filter(([, activity]) => include(activity))
    .map(([sessionId]) => sessionId)
    .sort()
    .join('\u0000');

  return useMemo(
    () => new Set(membershipKey ? membershipKey.split('\u0000') : []),
    [membershipKey],
  );
}

const isAnyActivity = () => true;
const isBackgroundOnly = (activity: SessionActivity) => Boolean(activity.background);

const parseStartedAt = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** The poll's task list, kept only when every entry has the shape the indicator reads. */
const parseBackgroundTasks = (value: unknown): BackgroundTaskSummary[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tasks: BackgroundTaskSummary[] = [];
  for (const item of value) {
    const task = item as Partial<Record<keyof BackgroundTaskSummary, unknown>> | null;
    if (
      !task
      || typeof task.taskId !== 'string'
      || typeof task.toolUseId !== 'string'
      || typeof task.taskType !== 'string'
      || typeof task.description !== 'string'
      || typeof task.startedAt !== 'number'
    ) {
      // One entry the server wrote in a shape this client does not read
      // should not hide the rest of the session's work.
      continue;
    }
    tasks.push({
      taskId: task.taskId,
      toolUseId: task.toolUseId,
      taskType: task.taskType,
      description: task.description,
      ...(typeof task.workflowName === 'string' ? { workflowName: task.workflowName } : {}),
      startedAt: task.startedAt,
      ...(task.nested === true ? { nested: true } : {}),
    });
  }
  return tasks;
};

/** Mounted by the project-workspace route; tracks which sessions are busy — producing a response or running background tasks — so chat, sidebar and project-workspace agree on session activity. */
export function SessionProtectionProvider({ children }: { children: ReactNode }) {
  const {
    processingSessions,
    markSessionProcessing,
    markSessionIdle,
    markSessionBackground,
    syncProcessingSessions,
    isSessionProcessing,
    getSessionActivity,
  } = useSessionProtection();
  const [idleProcessMembershipKey, setIdleProcessMembershipKey] = useState('');

  const refreshRunningSessions = useCallback(async () => {
    try {
      const response = await api.runningSessions();
      if (!response.ok) {
        return;
      }

      const payload = (await response.json()) as RunningSessionsApiPayload;
      const sessions = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];
      setIdleProcessMembershipKey(readIdleProcessMembershipKey(payload.data?.idleProcessSessionIds));

      syncProcessingSessions(
        sessions
          .map((session) => {
            if (typeof session.sessionId !== 'string' || !session.sessionId) {
              return null;
            }

            return {
              sessionId: session.sessionId,
              startedAt: parseStartedAt(session.startedAt),
              statusText: typeof session.statusText === 'string' ? session.statusText : undefined,
              canInterrupt: typeof session.canInterrupt === 'boolean' ? session.canInterrupt : undefined,
              background: session.background === true,
              tasks: parseBackgroundTasks(session.tasks),
              ...(session.external === true ? { external: true } : {}),
            };
          })
          .filter((session): session is NonNullable<typeof session> => Boolean(session)),
        { includesExternalActivity: payload.data?.includesExternalActivity === true },
      );
    } catch (error) {
      console.error('[SessionProtection] Failed to sync running sessions:', error);
    }
  }, [syncProcessingSessions]);

  useEffect(() => {
    let interval: number | null = null;
    const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const stop = () => {
      if (interval !== null) {
        window.clearInterval(interval);
        interval = null;
      }
    };
    const start = () => {
      stop();
      void refreshRunningSessions();
      interval = window.setInterval(() => {
        void refreshRunningSessions();
      }, RUNNING_SESSIONS_POLL_MS);
    };
    // A hidden tab stops asking; one shown again (an iPhone tab brought back,
    // a laptop woken) reads at once rather than showing what it saw before.
    const onVisibilityChange = () => (isHidden() ? stop() : start());
    const onWake = () => {
      if (!isHidden()) {
        void refreshRunningSessions();
      }
    };

    if (!isHidden()) {
      start();
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [refreshRunningSessions]);

  const actions = useMemo<SessionProtectionActions>(
    () => ({
      markSessionProcessing,
      markSessionIdle,
      markSessionBackground,
      syncProcessingSessions,
      isSessionProcessing,
      getSessionActivity,
    }),
    [
      getSessionActivity,
      isSessionProcessing,
      markSessionBackground,
      markSessionIdle,
      markSessionProcessing,
      syncProcessingSessions,
    ],
  );

  const busySessionIds = useSessionIdSet(processingSessions, isAnyActivity);
  const backgroundSessionIds = useSessionIdSet(processingSessions, isBackgroundOnly);
  const idleProcessSessionIds = useMemo<ReadonlySet<string>>(
    () => new Set(idleProcessMembershipKey ? idleProcessMembershipKey.split('\u0000') : []),
    [idleProcessMembershipKey],
  );

  return (
    <SessionProtectionActionsContext.Provider value={actions}>
      <BusySessionIdsContext.Provider value={busySessionIds}>
        <BackgroundSessionIdsContext.Provider value={backgroundSessionIds}>
          <IdleProcessSessionIdsContext.Provider value={idleProcessSessionIds}>
            <SessionProtectionStateContext.Provider value={processingSessions}>
              {children}
            </SessionProtectionStateContext.Provider>
          </IdleProcessSessionIdsContext.Provider>
        </BackgroundSessionIdsContext.Provider>
      </BusySessionIdsContext.Provider>
    </SessionProtectionActionsContext.Provider>
  );
}

/**
 * Membership-only view of the busy sessions, background work included. Prefer
 * this over useProcessingSessions wherever the activity details are not
 * rendered.
 */
export function useBusySessionIdSet(): ReadonlySet<string> {
  const busySessionIds = useContext(BusySessionIdsContext);
  if (!busySessionIds) {
    throw new Error('useBusySessionIdSet must be used within SessionProtectionProvider');
  }
  return busySessionIds;
}

/**
 * The busy sessions that are only running background tasks — no response in
 * flight. A subset of useBusySessionIdSet, with the same stable identity, for
 * the sidebar to draw those rows differently.
 */
export function useBackgroundSessionIdSet(): ReadonlySet<string> {
  const backgroundSessionIds = useContext(BackgroundSessionIdsContext);
  if (!backgroundSessionIds) {
    throw new Error('useBackgroundSessionIdSet must be used within SessionProtectionProvider');
  }
  return backgroundSessionIds;
}

/**
 * Sessions whose Claude CLI process is alive but idle at its prompt — a worker
 * that finished its turn and has not been stopped. Disjoint from the busy set.
 * Used by the sidebar module to keep such rows on screen and mark them live.
 *
 * Unlike the hooks above it tolerates a missing provider (an empty set), so a
 * sidebar list rendered on its own, as in tests, needs no provider around it.
 */
export function useIdleProcessSessionIdSet(): ReadonlySet<string> {
  return useContext(IdleProcessSessionIdsContext) ?? EMPTY_SESSION_ID_SET;
}

export function useProcessingSessions(): SessionActivityMap {
  const processingSessions = useContext(SessionProtectionStateContext);
  if (!processingSessions) {
    throw new Error('useProcessingSessions must be used within SessionProtectionProvider');
  }
  return processingSessions;
}

export function useSessionProtectionActions(): SessionProtectionActions {
  const actions = useContext(SessionProtectionActionsContext);
  if (!actions) {
    throw new Error('useSessionProtectionActions must be used within SessionProtectionProvider');
  }
  return actions;
}
