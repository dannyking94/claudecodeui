import type { ProjectAppsSnapshot, ProjectAppsView, ProjectChatLink } from '@/shared/types.js';
import { selectProjectApps } from '@/modules/project-apps/services/app-project-mapping.service.js';
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
