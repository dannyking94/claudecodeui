import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type {
  AllProjectAppsView,
  ProjectAppAction,
  ProjectAppActionResult,
  ProjectAppLogEntry,
  ProjectAppsView,
  ProjectAppWithOwner,
  ProjectChatLink,
} from '@/shared/types';

/** Which apps the panel lists: the selected project's, or every project's. */
export type ProjectAppsScope = 'project' | 'all';

/**
 * What the panel renders in either scope. In the project scope every app is
 * tagged with the selected project; in the all scope `projectPath` is null and
 * there are no chat links (those are scanned per project).
 */
type AppsPanelView = {
  projectPath: string | null;
  source: ProjectAppsView['source'];
  checkedAt: number;
  error: string | null;
  apps: ProjectAppWithOwner[];
  chatLinks: ProjectChatLink[];
};

// The dashboard re-probes every app at most every 3 s; a slower poll keeps the
// tab live without making a phone wake the server constantly.
const POLL_INTERVAL_MS = 15_000;

// The server wraps every answer in `{ success, data }`; readApiJson throws on errors with the server's message.
async function readData<T>(response: Response): Promise<T> {
  return (await readApiJson<{ data: T }>(response)).data;
}

async function loadView(projectId: string, scope: ProjectAppsScope): Promise<AppsPanelView> {
  if (scope === 'all') {
    const all = await readData<AllProjectAppsView>(await api.projectApps.all());
    return { ...all, projectPath: null, chatLinks: [] };
  }
  const view = await readData<ProjectAppsView>(await api.projectApps.view(projectId));
  return {
    ...view,
    apps: view.apps.map((app) => ({ ...app, projectId, projectPath: view.projectPath, projectName: null })),
  };
}

/**
 * Loads the Apps view for one project or for all of them, keeps it fresh
 * while the tab is visible, and runs manage actions through the server's
 * dashboard proxy. Used only by the Apps panel.
 */
export function useProjectApps(projectId: string | null, scope: ProjectAppsScope = 'project') {
  // The last view the server returned, tagged with its scope; kept across polls so a failed
  // refresh does not blank the grid, and ignored after a scope switch so the other scope's
  // cards never show under the wrong heading.
  const [loaded, setLoaded] = useState<{ scope: ProjectAppsScope; view: AppsPanelView } | null>(null);
  // Why the last load failed (network/auth), shown above the grid.
  const [loadError, setLoadError] = useState<string | null>(null);
  // The scope whose first answer (or failure) has arrived; until then the panel shows "Loading…".
  const [settledScope, setSettledScope] = useState<ProjectAppsScope | null>(null);
  const view = loaded?.scope === scope ? loaded.view : null;
  const isLoading = settledScope !== scope;
  // Which app has an action in flight, so its buttons disable and show progress; one at a time per tab.
  const [pendingAction, setPendingAction] = useState<{ appId: string; action: ProjectAppAction } | null>(null);
  // The latest action outcome per app, shown on its card until the next action.
  const [actionResults, setActionResults] = useState<Record<string, ProjectAppActionResult | { error: string }>>({});
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    const seq = ++requestSeq.current;
    try {
      const next = await loadView(projectId, scope);
      if (seq !== requestSeq.current) return;
      setLoaded({ scope, view: next });
      setLoadError(null);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === requestSeq.current) setSettledScope(scope);
    }
  }, [projectId, scope]);

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
