import { AppWindow, FolderOpen, MessageSquare, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Project, ProjectAppWithOwner } from '@/shared/types';
import { cn, formatCompactAge } from '@/shared/utils';
import { AppCard } from '@/modules/project-apps/AppCard';
import { AppDetailsDialog } from '@/modules/project-apps/AppDetailsDialog';
import { ChatLinkCard } from '@/modules/project-apps/ChatLinkCard';
import { useProjectApps, type ProjectAppsScope } from '@/modules/project-apps/hooks/useProjectApps';

type SortMode = 'recent' | 'name' | 'port';

type ProjectAppsPanelProps = {
  selectedProject: Project;
  /** Opens a chat in this project; used by "from chat" cards to jump to the message's session. */
  onOpenSession: (sessionId: string) => void;
  /** Switches the workspace to another project; used by the "All projects" group headers. */
  onOpenProject: (project: Project) => void;
};

/** One project's apps in the "All projects" scope; `projectId` is null for apps no project claims. */
type AppGroup = { key: string; projectId: string | null; name: string; path: string | null; apps: ProjectAppWithOwner[] };

const SORT_LABELS: Record<SortMode, string> = { recent: 'Recent', name: 'A–Z', port: 'Port' };

/** Down apps first, so a dead app is never below the fold; then the chosen order. */
function sortApps(apps: ProjectAppWithOwner[], mode: SortMode): ProjectAppWithOwner[] {
  const rank = (app: ProjectAppWithOwner) => (app.status === 'down' ? 0 : 1);
  return [...apps].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (mode === 'port') return (a.ports[0] ?? 0) - (b.ports[0] ?? 0);
    if (mode === 'recent' && (a.lastOpened ?? 0) !== (b.lastOpened ?? 0)) return (b.lastOpened ?? 0) - (a.lastOpened ?? 0);
    return a.name.localeCompare(b.name);
  });
}

function matchesFilter(text: string, needle: string): boolean {
  return text.toLowerCase().includes(needle);
}

/**
 * Groups already-sorted apps by owning project: the selected project first,
 * then by name, and apps no project claims last.
 */
function groupByProject(apps: ProjectAppWithOwner[], selectedProjectId: string, unassignedName: string): AppGroup[] {
  const groups = new Map<string, AppGroup>();
  for (const app of apps) {
    const key = app.projectId ?? '';
    let group = groups.get(key);
    if (!group) {
      group = { key, projectId: app.projectId, name: app.projectName ?? unassignedName, path: app.projectPath, apps: [] };
      groups.set(key, group);
    }
    group.apps.push(app);
  }
  const rank = (group: AppGroup) => (group.projectId === selectedProjectId ? 0 : group.projectId === null ? 2 : 1);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * The project's Apps tab: every registered web app that belongs to this
 * project (by repo/workdir/code paths), live status and manage buttons from
 * the fleet app dashboard, and unregistered addresses found in its chats.
 * An "All projects" scope lists every app grouped by project, so an app is
 * reachable even when its project is hard to find in the sidebar.
 * Rendered by the project-workspace module as a workspace tab, keyed by
 * project so every project starts with fresh state.
 */
export function ProjectAppsPanel({ selectedProject, onOpenSession, onOpenProject }: ProjectAppsPanelProps) {
  const { t } = useTranslation();
  // "All projects" is the way to an app whose project is hard to find in the sidebar.
  const [scope, setScope] = useState<ProjectAppsScope>('project');
  const { view, loadError, isLoading, pendingAction, actionResults, refresh, runAction } = useProjectApps(selectedProject.projectId, scope);
  // Free-text filter over name, purpose, port and links.
  const [filter, setFilter] = useState('');
  // Card order chosen with the chips; down apps always lead regardless.
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  // The app whose details dialog is open (looked up fresh from the view so it updates with polls).
  const [detailsAppId, setDetailsAppId] = useState<string | null>(null);

  const needle = filter.trim().toLowerCase();
  const apps = useMemo(() => {
    const all = view?.apps ?? [];
    const filtered = needle
      ? all.filter((app) => matchesFilter(
        [app.name, app.purpose, app.id, app.ports.join(' '), app.links.join(' '), app.projectName ?? '', app.projectPath ?? ''].join(' '),
        needle,
      ))
      : all;
    return sortApps(filtered, sortMode);
  }, [view, needle, sortMode]);
  const unassignedName = t('projectApps.noProject', { defaultValue: 'No project' });
  const groups = useMemo(
    () => (scope === 'all' ? groupByProject(apps, selectedProject.projectId, unassignedName) : []),
    [apps, scope, selectedProject.projectId, unassignedName],
  );
  const chatLinks = useMemo(
    () => (view?.chatLinks ?? []).filter((link) => !needle || matchesFilter(`${link.url} ${link.paths.join(' ')}`, needle)),
    [view, needle],
  );

  const total = view?.apps.length ?? 0;
  const live = view?.apps.filter((app) => app.status === 'up').length ?? 0;
  const down = view?.apps.filter((app) => app.status === 'down') ?? [];
  const detailsApp = view?.apps.find((app) => app.id === detailsAppId) ?? null;
  const checkedAge = formatCompactAge(view?.checkedAt ?? null);

  const renderCard = (app: ProjectAppWithOwner) => (
    <AppCard
      key={app.id}
      app={app}
      pendingAction={pendingAction?.appId === app.id ? pendingAction.action : null}
      isBusyElsewhere={pendingAction !== null && pendingAction.appId !== app.id}
      lastResult={actionResults[app.id]}
      onAction={(action) => void runAction(app.id, action)}
      onShowDetails={() => setDetailsAppId(app.id)}
    />
  );

  return (
    <div className="h-full overflow-y-auto" data-testid="project-apps-panel">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-3 py-3 sm:px-6 sm:py-5">
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label={t('projectApps.scope', { defaultValue: 'Which apps' })} className="flex rounded-lg border border-border p-0.5">
            {(['project', 'all'] as ProjectAppsScope[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setScope(option)}
                aria-pressed={scope === option}
                className={cn(
                  'h-8 rounded-md px-3 text-xs font-medium transition-colors',
                  scope === option ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {option === 'project'
                  ? t('projectApps.scopeProject', { defaultValue: 'This project' })
                  : t('projectApps.scopeAll', { defaultValue: 'All projects' })}
              </button>
            ))}
          </div>
          <label className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t('projectApps.filter', { defaultValue: 'Filter…' })}
              className="h-9 w-full rounded-lg border border-border bg-muted/40 pl-8 pr-2 text-base outline-none focus:border-primary/60 sm:text-sm"
            />
          </label>
          <div className="flex items-center gap-1.5">
            {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSortMode(mode)}
                aria-pressed={sortMode === mode}
                className={cn(
                  'h-8 rounded-full border px-3 text-xs font-medium transition-colors',
                  sortMode === mode ? 'border-foreground bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {SORT_LABELS[mode]}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            {view && (
              <span>
                {view.source === 'dashboard' && t('projectApps.sourceDashboard', { defaultValue: 'via app dashboard' })}
                {view.source === 'registry' && t('projectApps.sourceRegistry', { defaultValue: 'from apps.json (dashboard down)' })}
                {checkedAge && ` · ${t('projectApps.checked', { defaultValue: 'checked' })} ${checkedAge}`}
              </span>
            )}
            <button type="button" onClick={() => void refresh()} aria-label={t('projectApps.refresh', { defaultValue: 'Refresh' })} className="rounded-md p-1.5 hover:bg-muted hover:text-foreground">
              <RefreshCw className={cn('h-3.5 w-3.5', isLoading && 'animate-spin')} />
            </button>
          </div>
        </div>

        {(loadError || (view?.error && view.source !== 'dashboard')) && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">
              {loadError ?? (view?.source === 'registry'
                ? t('projectApps.registryFallback', { defaultValue: 'The app dashboard is unreachable, so status is unknown and start/stop is unavailable.' })
                : view?.error)}
            </span>
          </div>
        )}

        <section aria-labelledby="project-apps-registered">
          <h2 id="project-apps-registered" className="mb-2 flex flex-wrap items-center gap-x-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <AppWindow className="h-3.5 w-3.5" />
            <span>{t('projectApps.registered', { defaultValue: 'Registered apps' })}</span>
            {view && view.source === 'dashboard' && total > 0 && <span>· {live}/{total} {t('projectApps.live', { defaultValue: 'live' })}</span>}
            {view && view.source !== 'dashboard' && <span>· {total}</span>}
            {down.length > 0 && (
              <span title={down.map((app) => app.name).join(', ')} className="rounded-full bg-red-100 px-2 py-0.5 normal-case tracking-normal text-red-700 dark:bg-red-950/50 dark:text-red-300">
                {down.length} {t('projectApps.down', { defaultValue: 'down' })}
                {down.length <= 3 && `: ${down.map((app) => app.name).join(', ')}`}
              </span>
            )}
          </h2>
          {isLoading && !view ? (
            <p className="py-6 text-sm text-muted-foreground">{t('projectApps.loading', { defaultValue: 'Loading…' })}</p>
          ) : apps.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              {needle
                ? t('projectApps.noMatch', { defaultValue: 'No app matches the filter.' })
                : scope === 'all'
                  ? t('projectApps.noneAnywhere', { defaultValue: 'No web app is registered.' })
                  : t('projectApps.none', { defaultValue: 'No registered web app belongs to this project.' })}
              {scope === 'project' && (
                <button type="button" onClick={() => setScope('all')} className="ml-1 font-medium text-primary hover:underline">
                  {t('projectApps.showAll', { defaultValue: 'Show apps of all projects' })}
                </button>
              )}
            </div>
          ) : scope === 'all' ? (
            <div className="flex flex-col gap-5">
              {groups.map((group) => (
                <div key={group.key} data-testid="project-apps-group">
                  <div className="mb-2 flex min-w-0 items-center gap-2 text-sm">
                    <span className="truncate font-medium text-foreground">{group.name}</span>
                    {group.path && <span className="hidden truncate text-xs text-muted-foreground sm:inline">{group.path}</span>}
                    <span className="shrink-0 text-xs text-muted-foreground">· {group.apps.length}</span>
                    {group.projectId && group.projectId !== selectedProject.projectId && (
                      <button
                        type="button"
                        onClick={() => onOpenProject({ projectId: group.projectId as string, displayName: group.name, fullPath: group.path ?? '', path: group.path ?? '' })}
                        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        {t('projectApps.openProject', { defaultValue: 'Open project' })}
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {group.apps.map(renderCard)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {apps.map(renderCard)}
            </div>
          )}
        </section>

        {chatLinks.length > 0 && (
          <section aria-labelledby="project-apps-chat">
            <h2 id="project-apps-chat" className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <MessageSquare className="h-3.5 w-3.5" />
              {t('projectApps.foundInChats', { defaultValue: "Found in this project's chats" })} · {chatLinks.length}
            </h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {chatLinks.map((link) => (
                <ChatLinkCard key={link.origin} link={link} projectPath={view?.projectPath ?? ''} onOpenSession={onOpenSession} />
              ))}
            </div>
          </section>
        )}
      </div>

      {detailsApp && <AppDetailsDialog key={detailsApp.id} app={detailsApp} onClose={() => setDetailsAppId(null)} />}
    </div>
  );
}
