import path from 'node:path';

import type { ProjectAppMatch, ProjectAppRecord } from '@/shared/types.js';

type MappableApp = Pick<ProjectAppRecord, 'repo' | 'workdir' | 'codePaths' | 'startedBy'>;

type AppProjectAssignment = { projectPath: string; matchedBy: ProjectAppMatch };

const trimTrailingSlash = (value: string): string => (value.length > 1 ? value.replace(/\/+$/, '') : value);

function isInside(candidate: string, projectPath: string): boolean {
  if (candidate === projectPath) return true;
  // The filesystem root would own everything; it only matches exactly.
  if (projectPath === '/') return false;
  return candidate.startsWith(`${projectPath}/`);
}

/** Absolute paths that place an app: its workdir, its repo and each code path under the repo. */
function appPaths(app: MappableApp): string[] {
  const paths = [app.workdir, app.repo]
    .filter((p) => p && path.isAbsolute(p))
    .map(trimTrailingSlash);
  if (app.repo && path.isAbsolute(app.repo)) {
    for (const codePath of app.codePaths) {
      paths.push(trimTrailingSlash(path.isAbsolute(codePath) ? codePath : path.join(app.repo, codePath)));
    }
  }
  return paths;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Picks the one project an app belongs to.
 *
 * An app belongs to the project whose path contains its workdir, repo or a
 * code path — not to the session that started it — and the most specific
 * (longest) project path wins, so an app in a repo also registered as a
 * parent folder (e.g. `~/Repo`) lands in the repo's own project. Only when no
 * project contains any of its paths does `started_by` decide: the project
 * whose folder name appears there as a whole word (e.g. "secretary dk-ai-1").
 * Returns null when neither rule finds a project. Used by the view service.
 */
export function findAppProject(app: MappableApp, projectPaths: string[]): AppProjectAssignment | null {
  const projects = projectPaths.map(trimTrailingSlash);
  const candidates = appPaths(app);

  let best: string | null = null;
  for (const projectPath of projects) {
    if (candidates.some((candidate) => isInside(candidate, projectPath)) && (!best || projectPath.length > best.length)) {
      best = projectPath;
    }
  }
  if (best) return { projectPath: best, matchedBy: 'path' };

  const startedBy = app.startedBy.toLowerCase();
  if (!startedBy) return null;
  let bestByName: { projectPath: string; name: string } | null = null;
  for (const projectPath of projects) {
    const name = path.basename(projectPath).toLowerCase();
    // Very short folder names ("tmp", "src") would match by accident.
    if (name.length < 4) continue;
    const wholeWord = new RegExp(`(^|[^\\w-])${escapeRegExp(name)}($|[^\\w-])`);
    if (wholeWord.test(startedBy) && (!bestByName || name.length > bestByName.name.length)) {
      bestByName = { projectPath, name };
    }
  }
  return bestByName ? { projectPath: bestByName.projectPath, matchedBy: 'started-by' } : null;
}

/**
 * Keeps the apps shown under `projectPath`, tagged with how they got there:
 * every app whose owning project (see `findAppProject`) is `projectPath`, plus
 * every app another project owns (or none does) that lists `projectPath` in
 * its `alsoInProjects` — tagged `also` and carrying `ownerProjectPath`, the
 * owner's path or null. Ownership itself never changes, so the all-projects
 * view still files each app once. Used by the view service.
 */
export function selectProjectApps<TApp extends MappableApp & Partial<Pick<ProjectAppRecord, 'alsoInProjects'>>>(
  apps: TApp[],
  projectPath: string,
  allProjectPaths: string[],
): Array<TApp & { matchedBy: ProjectAppMatch; ownerProjectPath: string | null }> {
  const target = trimTrailingSlash(projectPath);
  const projects = allProjectPaths.includes(projectPath) ? allProjectPaths : [...allProjectPaths, projectPath];
  const selected: Array<TApp & { matchedBy: ProjectAppMatch; ownerProjectPath: string | null }> = [];
  for (const app of apps) {
    const assignment = findAppProject(app, projects);
    if (assignment && assignment.projectPath === target) {
      selected.push({ ...app, matchedBy: assignment.matchedBy, ownerProjectPath: null });
    } else if ((app.alsoInProjects ?? []).some((also) => trimTrailingSlash(also) === target)) {
      selected.push({ ...app, matchedBy: 'also', ownerProjectPath: assignment?.projectPath ?? null });
    }
  }
  return selected;
}
