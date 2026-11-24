import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import type { ProjectAppsServices } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';
import { createAppsDashboardClient } from '@/modules/project-apps/services/apps-dashboard.service.js';
import { createChatLinkCollector, type ChatTranscript } from '@/modules/project-apps/services/chat-urls.service.js';
import { buildAllProjectAppsView, buildProjectAppsView } from '@/modules/project-apps/services/project-apps-view.service.js';
import { createProjectAppsRouter } from '@/modules/project-apps/project-apps.routes.js';

/**
 * Where the fleet app dashboard listens. Only cloudcli's server talks to it;
 * the browser never does.
 */
const DASHBOARD_URL = process.env.CLOUDCLI_APPS_DASHBOARD_URL?.trim() || 'http://127.0.0.1:8790';

/**
 * The dashboard's `apps.json` file(s), separated by `:` or `,`. They supply
 * `repo` / `code_paths` (which `/api/state` leaves out) for project mapping,
 * and the app list itself when the dashboard is down. Unset means apps are
 * mapped by workdir only and there is no fallback.
 */
const REGISTRY_PATHS = (process.env.CLOUDCLI_APPS_REGISTRY ?? '')
  .split(/[:,]/)
  .map((entry) => entry.trim())
  .filter(Boolean);

// Scanning every transcript of a busy project would be slow; recent ones carry the live links.
const MAX_SCANNED_TRANSCRIPTS = 40;

const dashboard = createAppsDashboardClient({ baseUrl: DASHBOARD_URL, registryPaths: REGISTRY_PATHS });
const chatLinks = createChatLinkCollector();

function listProjectTranscripts(projectPath: string): ChatTranscript[] {
  return sessionsDb
    .getSessionsByProjectPath(projectPath)
    .filter((session) => Boolean(session.jsonl_path))
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
    .slice(0, MAX_SCANNED_TRANSCRIPTS)
    .map((session) => ({
      sessionId: session.session_id,
      sessionName: session.custom_name,
      provider: session.provider,
      jsonlPath: session.jsonl_path as string,
    }));
}

const projectAppsServices: ProjectAppsServices = {
  resolveProjectPath(projectId) {
    const projectPath = projectsDb.getProjectPathById(projectId);
    if (!projectPath) {
      throw new AppError(`Unable to resolve project path for "${projectId}"`, { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
    }
    return projectPath;
  },
  getView: (projectPath) => buildProjectAppsView(projectPath, {
    getSnapshot: dashboard.getSnapshot,
    listProjectPaths: () => projectsDb.getProjectPaths().map((row) => row.project_path),
    listProjectTranscripts,
    collectChatLinks: chatLinks.collectChatLinks,
  }),
  getAllView: () => buildAllProjectAppsView({
    getSnapshot: dashboard.getSnapshot,
    listProjects: () => projectsDb.getProjectPaths().map((row) => ({
      projectId: row.project_id,
      projectPath: row.project_path,
      // The sidebar's own name when set; otherwise the folder name (the sidebar
      // may show a package.json name instead, but the path is shown beside it).
      displayName: row.custom_project_name?.trim() || path.basename(row.project_path) || row.project_path,
    })),
  }),
  runAction: dashboard.runAction,
  getLog: dashboard.getLog,
};

/**
 * Project Apps router mounted by the server entrypoint at `/api/project-apps`.
 * Composed here so the entrypoint only touches the module barrel.
 */
export const projectAppsRoutes = createProjectAppsRouter(projectAppsServices);
