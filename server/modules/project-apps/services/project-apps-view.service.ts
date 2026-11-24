import type {
  AllProjectAppsView,
  ProjectAppsProjectRef,
  ProjectAppsSnapshot,
  ProjectAppsView,
  ProjectChatLink,
} from '@/shared/types.js';
import { findAppProject, selectProjectApps } from '@/modules/project-apps/services/app-project-mapping.service.js';
import type { ChatTranscript } from '@/modules/project-apps/services/chat-urls.service.js';

/** Collaborators the view needs; the module composition supplies the real ones. */
type ProjectAppsViewDependencies = {
  getSnapshot(): Promise<ProjectAppsSnapshot>;
  listProjectPaths(): string[];
  listProjectTranscripts(projectPath: string): ChatTranscript[];
  collectChatLinks(transcripts: ChatTranscript[], registeredPorts: Set<number>): Promise<ProjectChatLink[]>;
};

/**
 * Assembles the Apps tab for one project: the registry apps that belong to
 * it (see `findAppProject`) and the unregistered URLs its chats mention.
 * Chat scanning failing never hides the registry, and vice versa. Used by the
 * module composition behind `GET /api/project-apps`.
 */
export async function buildProjectAppsView(
  projectPath: string,
  dependencies: ProjectAppsViewDependencies,
): Promise<ProjectAppsView> {
  const snapshot = await dependencies.getSnapshot();
  const apps = selectProjectApps(snapshot.apps, projectPath, dependencies.listProjectPaths());
  // Every registered port, not only this project's: an app another project
  // owns is still registered and must not reappear here as "from chat".
  const registeredPorts = new Set(snapshot.apps.flatMap((app) => app.ports));

  let chatLinks: ProjectChatLink[] = [];
  try {
    chatLinks = await dependencies.collectChatLinks(dependencies.listProjectTranscripts(projectPath), registeredPorts);
  } catch (error) {
    console.warn('[project-apps] chat link scan failed:', error instanceof Error ? error.message : error);
  }

  return {
    projectPath,
    source: snapshot.source,
    checkedAt: snapshot.checkedAt,
    error: snapshot.error,
    apps,
    chatLinks,
  };
}

/**
 * Assembles the all-projects Apps view: every registry app, each tagged with
 * the project `findAppProject` gives it (the same rule as the per-project tab,
 * so an app never shows under two projects) or with nulls when none claims it.
 * Used by the module composition behind `GET /api/project-apps/all`, the
 * fallback for an app whose project is hard to find in the sidebar.
 */
export async function buildAllProjectAppsView(dependencies: {
  getSnapshot(): Promise<ProjectAppsSnapshot>;
  listProjects(): ProjectAppsProjectRef[];
}): Promise<AllProjectAppsView> {
  const snapshot = await dependencies.getSnapshot();
  const projects = dependencies.listProjects();
  const projectByPath = new Map(projects.map((project) => [project.projectPath.replace(/\/+$/, '') || '/', project]));
  const projectPaths = projects.map((project) => project.projectPath);

  return {
    source: snapshot.source,
    checkedAt: snapshot.checkedAt,
    error: snapshot.error,
    apps: snapshot.apps.map((app) => {
      const assignment = findAppProject(app, projectPaths);
      const project = assignment ? projectByPath.get(assignment.projectPath) ?? null : null;
      return {
        ...app,
        matchedBy: project ? assignment?.matchedBy ?? null : null,
        projectId: project?.projectId ?? null,
        projectPath: project?.projectPath ?? null,
        projectName: project?.displayName ?? null,
      };
    }),
  };
}
