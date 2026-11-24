import type { TFunction } from 'i18next';

import type {
  LLMProvider,
  Project,
  ProjectSession,
  ProjectSortOrder,
  SessionWithProvider,
  SettingsProject,
} from '@/shared/types';

// Presentation data the sidebar derives from a session before rendering its row.
type SessionViewModel = {
  sessionName: string;
  sessionTime: string;
  messageCount: number;
};

export const formatCompactAge = (
  dateString: string | null | undefined,
  currentTime: Date,
): string => {
  if (!dateString) return '';

  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return '';

  const minutes = Math.floor(Math.max(0, currentTime.getTime() - date.getTime()) / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}hr` : `${Math.floor(hours / 24)}d`;
};

const LAST_VISITED_SESSIONS_STORAGE_KEY = 'sidebarLastVisitedSessions';

export const readLastVisitedSessionId = (projectId: string): string | null => {
  try {
    const saved = localStorage.getItem(LAST_VISITED_SESSIONS_STORAGE_KEY);
    if (!saved) {
      return null;
    }

    const parsed = JSON.parse(saved) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const sessionId = (parsed as Record<string, unknown>)[projectId];
    return typeof sessionId === 'string' && sessionId.trim() ? sessionId : null;
  } catch {
    return null;
  }
};

export const writeLastVisitedSessionId = (projectId: string, sessionId: string): void => {
  try {
    const saved = localStorage.getItem(LAST_VISITED_SESSIONS_STORAGE_KEY);
    let parsed: unknown = null;
    try {
      parsed = saved ? JSON.parse(saved) as unknown : null;
    } catch {
      // Replace malformed legacy/user-edited data with a fresh map below.
    }
    const lastVisitedByProject = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};

    localStorage.setItem(LAST_VISITED_SESSIONS_STORAGE_KEY, JSON.stringify({
      ...lastVisitedByProject,
      [projectId]: sessionId,
    }));
  } catch {
    // Keep navigation responsive when storage is unavailable or malformed.
  }
};

/**
 * Parent sessions whose inactive children the user unfolded. Kept in
 * sessionStorage, so the fold survives a reload of the tab but a new tab
 * starts with everything at rest folded away again.
 */
const EXPANDED_PARENT_SESSIONS_STORAGE_KEY = 'sidebarExpandedParentSessions';

export const readExpandedParentSessionIds = (): Set<string> => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(EXPANDED_PARENT_SESSIONS_STORAGE_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
};

/**
 * Records one parent as unfolded or folded. Read-modify-write against storage
 * rather than writing a caller's whole set, because every project list holds
 * its own copy and must not overwrite another project's parents.
 */
export const writeExpandedParentSessionId = (parentSessionId: string, isExpanded: boolean): void => {
  try {
    const expandedIds = readExpandedParentSessionIds();
    if (isExpanded) {
      expandedIds.add(parentSessionId);
    } else {
      expandedIds.delete(parentSessionId);
    }

    sessionStorage.setItem(EXPANDED_PARENT_SESSIONS_STORAGE_KEY, JSON.stringify([...expandedIds]));
  } catch {
    // The fold still works for this render when storage is unavailable.
  }
};

const getCreatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.createdAt || session.created_at || '');
};

const getUpdatedTimestamp = (session: SessionWithProvider): string => {
  return String(session.lastActivity || '');
};

const getSessionProvider = (session: ProjectSession): LLMProvider => {
  const provider = session.__provider ?? session.provider;
  return typeof provider === 'string' && provider.trim()
    ? provider as LLMProvider
    : 'claude';
};

export const getSessionDate = (session: SessionWithProvider): Date => {
  return new Date(getUpdatedTimestamp(session) || getCreatedTimestamp(session) || 0);
};

const getSessionName = (session: SessionWithProvider, t: TFunction): string => {
  return session.summary || session.name || t('projects.newSession');
};

const getSessionTime = (session: SessionWithProvider): string => {
  return getUpdatedTimestamp(session) || getCreatedTimestamp(session);
};

export const createSessionViewModel = (
  session: SessionWithProvider,
  currentTime: Date,
  t: TFunction,
): SessionViewModel => {
  return {
    sessionName: getSessionName(session, t),
    sessionTime: getSessionTime(session),
    messageCount: Number(session.messageCount || 0),
  };
};

/**
 * Cached against the project object, not its id.
 *
 * Every sidebar render asks for each project's sessions, and this builds a new
 * array of new session objects. Without the cache the array is a different
 * reference each time, which is enough on its own to defeat the memo boundary
 * on every project and session row. `useProjectsState` always replaces a
 * project rather than mutating it, so a stale entry is unreachable: a changed
 * project is a different key.
 */
const sortedSessionsByProject = new WeakMap<Project, SessionWithProvider[]>();

export const getAllSessions = (project: Project): SessionWithProvider[] => {
  const cached = sortedSessionsByProject.get(project);
  if (cached) {
    return cached;
  }

  const sessions = (project.sessions || []).map((session) => ({
    ...session,
    __provider: getSessionProvider(session),
  })).sort(
    (a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime(),
  );

  sortedSessionsByProject.set(project, sessions);
  return sessions;
};

const getProjectLastActivity = (project: Project): Date => {
  const sessions = getAllSessions(project);
  if (sessions.length === 0) {
    return new Date(0);
  }

  return sessions.reduce((latest, session) => {
    const sessionDate = getSessionDate(session);
    return sessionDate > latest ? sessionDate : latest;
  }, new Date(0));
};

export const sortProjects = (
  projects: Project[],
  projectSortOrder: ProjectSortOrder,
): Project[] => {
  const byName = [...projects];

  byName.sort((projectA, projectB) => {
    // Star order now comes from backend `projects.isStarred`.
    const aStarred = Boolean(projectA.isStarred);
    const bStarred = Boolean(projectB.isStarred);

    if (aStarred && !bStarred) {
      return -1;
    }

    if (!aStarred && bStarred) {
      return 1;
    }

    if (projectSortOrder === 'date') {
      return getProjectLastActivity(projectB).getTime() - getProjectLastActivity(projectA).getTime();
    }

    return (projectA.displayName || projectA.projectId).localeCompare(projectB.displayName || projectB.projectId);
  });

  return byName;
};

export const filterProjects = (projects: Project[], searchFilter: string): Project[] => {
  const normalizedSearch = searchFilter.trim().toLowerCase();
  if (!normalizedSearch) {
    return projects;
  }

  return projects.filter((project) => {
    const displayName = (project.displayName || project.projectId).toLowerCase();
    // `project.path`/`fullPath` is the most useful search target now that the
    // folder-derived name is gone; fall back to displayName above.
    const searchPath = (project.path || project.fullPath || '').toLowerCase();
    return displayName.includes(normalizedSearch) || searchPath.includes(normalizedSearch);
  });
};

export const getTaskIndicatorStatus = (
  project: Project,
  mcpServerStatus: { hasMCPServer?: boolean; isConfigured?: boolean } | null,
) => {
  const projectConfigured = Boolean(project.taskmaster?.hasTaskmaster);
  const mcpConfigured = Boolean(mcpServerStatus?.hasMCPServer && mcpServerStatus?.isConfigured);

  if (projectConfigured && mcpConfigured) {
    return 'fully-configured';
  }

  if (projectConfigured) {
    return 'taskmaster-only';
  }

  if (mcpConfigured) {
    return 'mcp-only';
  }

  return 'not-configured';
};

export const normalizeProjectForSettings = (project: Project): SettingsProject => {
  const fallbackPath =
    typeof project.fullPath === 'string' && project.fullPath.length > 0
      ? project.fullPath
      : typeof project.path === 'string'
        ? project.path
        : '';

  // Legacy SettingsProject still expects a `name` field; use the projectId so
  // downstream consumers that rely on a stable identifier continue to work.
  return {
    name: project.projectId,
    displayName:
      typeof project.displayName === 'string' && project.displayName.trim().length > 0
        ? project.displayName
        : project.projectId,
    fullPath: fallbackPath,
    path:
      typeof project.path === 'string' && project.path.length > 0
        ? project.path
        : fallbackPath,
  };
};

/** Display names for the providers a session row can belong to. */
export const PROVIDER_LABELS: Record<LLMProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
};
