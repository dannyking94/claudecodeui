import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { ProjectAppAction, ProjectAppActionResult, ProjectAppLogEntry, ProjectAppsView } from '@/shared/types';

// The dashboard re-probes every app at most every 3 s; a slower poll keeps the
// tab live without making a phone wake the server constantly.
const POLL_INTERVAL_MS = 15_000;

// The server wraps every answer in `{ success, data }`; readApiJson throws on errors with the server's message.
async function readData<T>(response: Response): Promise<T> {
  return (await readApiJson<{ data: T }>(response)).data;
}

/**
 * Loads one project's Apps view, keeps it fresh while the tab is visible, and
 * runs manage actions through the server's dashboard proxy. Used only by the
 * Apps panel.
 */
export function useProjectApps(projectId: string | null) {
  // The last view the server returned; kept across polls so a failed refresh does not blank the grid.
  const [view, setView] = useState<ProjectAppsView | null>(null);
  // Why the last load failed (network/auth), shown above the grid.
  const [loadError, setLoadError] = useState<string | null>(null);
  // True only until the first answer for this project arrives, to show a loading state instead of "no apps".
  const [isLoading, setIsLoading] = useState(true);
  // Which app has an action in flight, so its buttons disable and show progress; one at a time per tab.
  const [pendingAction, setPendingAction] = useState<{ appId: string; action: ProjectAppAction } | null>(null);
  // The latest action outcome per app, shown on its card until the next action.
  const [actionResults, setActionResults] = useState<Record<string, ProjectAppActionResult | { error: string }>>({});
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const seq = ++requestSeq.current;
    try {
      const next = await readData<ProjectAppsView>(await api.projectApps.view(projectId));
      if (seq !== requestSeq.current) return;
      setView(next);
      setLoadError(null);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === requestSeq.current) setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // State is per project: the panel is keyed by project id, so it remounts on a switch.
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      // Drop answers for a project the user has already left.
      requestSeq.current += 1;
    };
  }, [refresh]);

  const runAction = useCallback(async (appId: string, action: ProjectAppAction) => {
    setPendingAction({ appId, action });
    try {
      const result = await readData<ProjectAppActionResult>(await api.projectApps.action(appId, action));
      setActionResults((prev) => ({ ...prev, [appId]: result }));
    } catch (error) {
      setActionResults((prev) => ({ ...prev, [appId]: { error: error instanceof Error ? error.message : String(error) } }));
    } finally {
      setPendingAction(null);
      void refresh();
    }
  }, [refresh]);

  return { view, loadError, isLoading, pendingAction, actionResults, refresh, runAction };
}

/** Fetches an app's start/stop history for the details dialog. */
export async function fetchProjectAppLog(appId: string) {
  return readData<ProjectAppLogEntry[]>(await api.projectApps.log(appId));
}
