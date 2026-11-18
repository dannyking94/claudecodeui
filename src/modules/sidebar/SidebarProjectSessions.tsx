import { useMemo, useState } from 'react';
import { CheckSquare, ChevronDown, ChevronRight, ChevronUp, Plus, Trash2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, Project, ProjectSession, SessionWithProvider, SidebarSessionSelection } from '@/shared/types';
import SidebarSessionItem from '@/modules/sidebar/SidebarSessionItem';
import { useCompactSidebar } from '@/modules/sidebar/hooks/useCompactSidebar';
import { buildProjectSessionTree } from '@/modules/sidebar/utils/projectSessionTree';
import {
  VISIBLE_SESSION_LIMIT,
  foldChildSessions,
  isSpawnNestingEnabled,
} from '@/modules/sidebar/utils/sessionTree';
import type { ChildSessionFold } from '@/modules/sidebar/utils/sessionTree';
import {
  RECENT_ACTIVITY_WINDOW_MS,
  readExpandedParentSessionIds,
  writeExpandedParentSessionId,
} from '@/modules/sidebar/utils/sidebarProjectFormatting';

const FORK_INDENT_PX = 12;
const MAX_FORK_INDENT_DEPTH = 4;

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  activeSessions: ReadonlySet<string>;
  backgroundSessionIds: ReadonlySet<string>;
  attentionSessionIds: ReadonlySet<string>;
  currentTime: Date;
  /** The session being renamed, when it belongs to this project. */
  sessionRenameId: string | null;
  sessionRenameDraft: string;
  onRenameDraftChange: (draft: string) => void;
  onStartEditingSession: (projectId: string, sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onArchiveSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string, sessionTitle: string) => void;
  onForkSession?: (session: SessionWithProvider) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  /** The sessions ticked here, or null when this project's list is not in selection mode. */
  selectedSessionIds: ReadonlySet<string> | null;
  onSetSessionSelection: (selection: SidebarSessionSelection) => void;
  onToggleSessionSelected: (projectId: string, sessionId: string) => void;
  onCancelSessionSelection: () => void;
  onDeleteSelectedSessions: (sessionIds: string[]) => void;
  t: TFunction;
};

type ProjectSessionTreeRow = ReturnType<typeof buildProjectSessionTree>[number];

/**
 * Recomputes the two facts the connectors are drawn from after rows were taken
 * out of the tree (quiet spawned children folded away, or everything past the
 * project's "Show N more" cut): whether a row still has a child on screen, and
 * whether it is the last of its siblings still on screen.
 */
const relinkVisibleRows = (rows: ProjectSessionTreeRow[]): ProjectSessionTreeRow[] => {
  const lastIndexByParentId = new Map<string | null, number>();
  const parentIdsWithChildren = new Set<string>();
  rows.forEach((row, index) => {
    lastIndexByParentId.set(row.parentId, index);
    if (row.parentId) parentIdsWithChildren.add(row.parentId);
  });

  return rows.map((row, index) => {
    const hasChildren = parentIdsWithChildren.has(row.session.id);
    const isLastSibling = lastIndexByParentId.get(row.parentId) === index;
    return hasChildren === row.hasChildren && isLastSibling === row.isLastSibling
      ? row
      : { ...row, hasChildren, isLastSibling };
  });
};

/**
 * Dots on the project's "Show N more" toggle, standing in for the sessions it
 * is holding: amber for anything blocked on the user, green for anything still
 * running. Only this fold needs them — it cuts by top-level conversation, so a
 * whole branch with a worker mid-turn can fall past the cut. The arrows on
 * parent rows cannot: a running or blocked child is never one they fold.
 */
function FoldedSessionIndicators({
  foldedLiveCount,
  foldedWaitingCount,
  t,
}: {
  foldedLiveCount: number;
  foldedWaitingCount: number;
  t: TFunction;
}) {
  const runningCount = Math.max(foldedLiveCount - foldedWaitingCount, 0);

  return (
    <>
      {foldedWaitingCount > 0 && (
        <span
          role="status"
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500"
          aria-label={t('tooltips.attentionRequiredIndicator', { defaultValue: 'Session needs attention' })}
        />
      )}
      {runningCount > 0 && (
        <span
          role="status"
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500"
          aria-label={t('tooltips.activeSessionIndicator')}
        />
      )}
    </>
  );
}

/** Last path segment of a project path; splits on both separators so a Windows path reads like a POSIX one. */
const readProjectFolderName = (projectPath: string): string =>
  projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;

function SessionListSkeleton() {
  return (
    <>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-md p-2">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${60 + index * 15}%` }} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

/** Rendered by SidebarProjectItem to show an expanded project's sessions, delegating each row to SidebarSessionItem. */
export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessions,
  backgroundSessionIds,
  attentionSessionIds,
  currentTime,
  sessionRenameId,
  sessionRenameDraft,
  onRenameDraftChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onArchiveSession,
  onDeleteSession,
  onForkSession,
  onLoadMoreSessions,
  onNewSession,
  selectedSessionIds,
  onSetSessionSelection,
  onToggleSessionSelected,
  onCancelSessionSelection,
  onDeleteSelectedSessions,
  t,
}: SidebarProjectSessionsProps) {
  const isCompact = useCompactSidebar();
  // Spawned-session nesting (ours) rides on the fork tree (upstream's): the same
  // builder hangs a worker under the session that launched it, and the block
  // below folds the quiet ones and caps the project at a few conversations.
  // With the switch off this component is the plain fork tree.
  const [spawnNesting] = useState(isSpawnNestingEnabled);
  const treeRows = useMemo(
    () => buildProjectSessionTree(sessions, project.projectId, { includeSpawnLinks: spawnNesting }),
    [sessions, project.projectId, spawnNesting],
  );
  const selectedSessionId = selectedSession?.id ?? null;
  const [expandedParentIds, setExpandedParentIds] = useState<ReadonlySet<string>>(readExpandedParentSessionIds);
  const [isShowingAllSessions, setIsShowingAllSessions] = useState(false);
  const toggleFoldedChildren = (parentSessionId: string) => {
    const isExpanding = !expandedParentIds.has(parentSessionId);
    writeExpandedParentSessionId(parentSessionId, isExpanding);
    setExpandedParentIds((previous) => {
      const next = new Set(previous);
      if (isExpanding) next.add(parentSessionId);
      else next.delete(parentSessionId);
      return next;
    });
  };
  const currentTimeMs = currentTime.getTime();
  const spawnTree = useMemo(() => {
    if (!spawnNesting) {
      return null;
    }

    const spawnedSessionIds = new Set(treeRows.filter((row) => row.link === 'spawn').map((row) => row.session.id));
    // Running, or waiting on the user. Ids belonging to other projects are
    // harmless: the fold only looks up sessions it is already rendering.
    const liveSessionIds = new Set<string>([...activeSessions, ...attentionSessionIds]);
    const foldedRows = foldChildSessions(
      treeRows.map((row) => ({ ...row.session, __depth: row.depth })),
      {
        expandedParentIds,
        liveSessionIds,
        // Blocked on a permission dialog or a question: not streaming, and
        // quiet on disk, so it is named separately or the fold would read it
        // as at rest and take away the one row the user has to act on.
        waitingSessionIds: attentionSessionIds,
        // The session on screen, and one being renamed, keep their rows.
        pinnedSessionIds: new Set([selectedSessionId, sessionRenameId].filter((id): id is string => Boolean(id))),
        // The same window the row's own green dot is drawn from, so a child
        // folds only once it has stopped claiming to be recently active.
        activeSince: currentTimeMs - RECENT_ACTIVITY_WINDOW_MS,
        // A fork keeps the fork tree's own always-open default.
        isFoldableChild: (session) => spawnedSessionIds.has(session.id),
      },
    );
    const childFoldBySessionId = new Map<string, ChildSessionFold | null>(
      foldedRows.map((row) => [row.session.id, row.childFold]),
    );
    const rows = treeRows.filter((row) => childFoldBySessionId.has(row.session.id));

    // The project-level fold: the first few top-level conversations, each
    // counted together with its whole subtree so the cut never lands between a
    // parent and the children indented under it.
    let cutIndex = rows.length;
    let topLevelCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index].depth > 0) continue;
      topLevelCount += 1;
      if (topLevelCount > VISIBLE_SESSION_LIMIT) {
        cutIndex = index;
        break;
      }
    }
    const isFoldable = cutIndex < rows.length;
    const isFolded = isFoldable && !isShowingAllSessions;
    // A selection past the cut would otherwise disappear the moment it is
    // opened, so it stays pinned below the visible rows — flat, since apart
    // from its subtree an indent would read as a child of whatever row the
    // fold happened to end on.
    const selectedIndex = selectedSessionId ? rows.findIndex((row) => row.session.id === selectedSessionId) : -1;
    const isSelectedPastCut = isFolded && selectedIndex >= cutIndex;
    const cappedRows: ProjectSessionTreeRow[] = !isFolded
      ? rows
      : isSelectedPastCut
        ? [...rows.slice(0, cutIndex), { ...rows[selectedIndex], parentId: null, link: null, depth: 0 }]
        : rows.slice(0, cutIndex);
    if (isSelectedPastCut) {
      // Its children stay past the cut, so it offers no arrow to show them.
      childFoldBySessionId.set(rows[selectedIndex].session.id, null);
    }

    // Everything the user cannot currently see under this project, counted
    // once: the rows this fold took off screen, plus the children each arrow
    // down there is holding.
    const rowsPastCut = isFolded ? rows.slice(cutIndex) : [];
    const hiddenRows = rowsPastCut.filter((row) => row.session.id !== selectedSessionId);

    return {
      rows: relinkVisibleRows(cappedRows),
      childFoldBySessionId,
      isFoldable,
      isFolded,
      foldedSessionCount: hiddenRows.length + rowsPastCut.reduce(
        (total, row) => total + (childFoldBySessionId.get(row.session.id)?.foldedCount ?? 0),
        0,
      ),
      foldedLiveCount: hiddenRows.filter((row) => liveSessionIds.has(row.session.id)).length,
      foldedWaitingCount: hiddenRows.filter((row) => attentionSessionIds.has(row.session.id)).length,
    };
  }, [
    spawnNesting, treeRows, activeSessions, attentionSessionIds, expandedParentIds,
    selectedSessionId, sessionRenameId, currentTimeMs, isShowingAllSessions,
  ]);
  const baseRows = spawnTree?.rows ?? treeRows;
  const childFoldBySessionId = spawnTree?.childFoldBySessionId ?? null;
  const targetAncestors = useMemo(() => {
    const parents = new Map(treeRows.map((row) => [row.session.id, row.parentId]));
    const reveal = new Set<string>();
    for (const target of [selectedSessionId, sessionRenameId]) {
      let parentId = target ? parents.get(target) : null;
      while (parentId && !reveal.has(parentId)) {
        reveal.add(parentId);
        parentId = parents.get(parentId);
      }
    }
    return reveal;
  }, [treeRows, selectedSessionId, sessionRenameId]);
  // Retain explicit branch collapses, while revealing a newly selected or renamed descendant.
  const [forkTreeState, setForkTreeState] = useState(() => ({
    targetAncestors, selectedSessionId, sessionRenameId, collapsedForks: new Set<string>(),
  }));
  const { collapsedForks } = forkTreeState;

  // Reveal a newly selected/renamed fork before committing a hidden row. Later
  // title/activity updates must not undo an explicit collapse by the user.
  if (forkTreeState.selectedSessionId !== selectedSessionId
    || forkTreeState.sessionRenameId !== sessionRenameId
    || forkTreeState.targetAncestors.size !== targetAncestors.size
    || [...targetAncestors].some((id) => !forkTreeState.targetAncestors.has(id))) {
    setForkTreeState({
      targetAncestors, selectedSessionId, sessionRenameId,
      collapsedForks: new Set([...collapsedForks].filter((id) => !targetAncestors.has(id))),
    });
  }

  const visibleRows = useMemo(() => {
    let hiddenBelowDepth = Infinity;
    const visible: (typeof treeRows[number] & { continuationDepths: number[] })[] = [];
    const continuingAncestors = new Set<number>();
    for (const row of baseRows) {
      if (row.depth > hiddenBelowDepth) continue;
      // A parent carrying a spawn fold is opened and closed through that fold
      // alone, so one arrow never means two things.
      const isCollapsed = row.hasChildren && collapsedForks.has(row.session.id) && !childFoldBySessionId?.get(row.session.id);
      hiddenBelowDepth = isCollapsed ? row.depth : Infinity;
      // Keep sibling rails running through an expanded child's descendants.
      // Only visible columns are retained, so a deep chain stays linear in size.
      for (const depth of continuingAncestors) {
        if (depth >= row.depth) continuingAncestors.delete(depth);
      }
      visible.push({ ...row, continuationDepths: [...continuingAncestors] });
      if (row.depth > 0 && row.depth < MAX_FORK_INDENT_DEPTH && !row.isLastSibling) {
        continuingAncestors.add(row.depth);
      }
    }
    return visible;
  }, [baseRows, childFoldBySessionId, collapsedForks]);
  const hasForks = treeRows.some((row) => row.hasChildren);

  if (!isExpanded) {
    return null;
  }

  const hasSessions = treeRows.length > 0;
  const isSelecting = selectedSessionIds !== null;
  // A session with a response in flight cannot be deleted — the same rule the
  // row's options menu applies — so it is not selectable either.
  const isSessionRunning = (session: SessionWithProvider) =>
    activeSessions.has(session.id) && !backgroundSessionIds.has(session.id);
  const selectableSessionIds = treeRows.filter(({ session }) => !isSessionRunning(session)).map(({ session }) => session.id);
  // Re-derived from the selectable rows rather than read straight off the
  // selection, so a row that started running after it was ticked drops out of
  // the count, the button and the ids the confirmation is opened with.
  const effectiveSelectedIds = selectedSessionIds
    ? selectableSessionIds.filter((sessionId) => selectedSessionIds.has(sessionId))
    : [];
  const checkedSessionIds = new Set(effectiveSelectedIds);
  const allLoadedSelected =
    selectableSessionIds.length > 0 && effectiveSelectedIds.length === selectableSessionIds.length;
  // With more sessions on the server than on screen, the button only reaches the
  // loaded rows, so it offers "Select all loaded" rather than a "Select all" it
  // could not honour. Once those rows are ticked it flips to "Clear" either way.
  const selectAllLabel = allLoadedSelected
    ? t('sessions.clearSelection')
    : hasMoreSessions
      ? t('sessions.selectAllLoaded')
      : t('sessions.selectAll');

  return (
    <div className="ml-1.5 space-y-1 border-l border-border/70 pl-1.5">
      {isCompact ? (
        <div className="px-3 pb-1 pt-1">
          <button
            className="flex h-8 w-full items-center justify-center gap-2 rounded-md bg-primary text-xs font-medium text-primary-foreground transition-all duration-150 hover:bg-primary/90 active:scale-[0.98]"
            onClick={() => {
              onProjectSelect(project);
              onNewSession(project);
            }}
          >
            <Plus className="h-3 w-3" />
            {t('sessions.newSession')}
          </button>
        </div>
      ) : (
        <Button
          variant="default"
          size="sm"
          className="flex h-8 w-full justify-start gap-2 bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          onClick={() => onNewSession(project)}
        >
          <Plus className="h-3 w-3" />
          {t('sessions.newSession')}
        </Button>
      )}

      {(isSelecting || (initialSessionsLoaded && selectableSessionIds.length > 0)) && (
        <div className={cn('space-y-1', isCompact && 'px-3')}>
          {isSelecting ? (
            <>
              {/* Wraps rather than clips: at the narrowest sidebar width a long
                  translated "Select all loaded" leaves no room for Cancel. */}
              <div className="flex flex-wrap items-center justify-between gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    onSetSessionSelection({
                      projectId: project.projectId,
                      sessionIds: new Set(allLoadedSelected ? [] : selectableSessionIds),
                    })
                  }
                  disabled={selectableSessionIds.length === 0}
                >
                  {selectAllLabel}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={onCancelSessionSelection}
                >
                  {t('actions.cancel')}
                </Button>
              </div>
              <Button
                variant="destructive"
                size="sm"
                className="h-8 w-full justify-center gap-2 bg-red-600 text-xs font-medium text-white hover:bg-red-700"
                onClick={() => onDeleteSelectedSessions(effectiveSelectedIds)}
                disabled={effectiveSelectedIds.length === 0}
              >
                <Trash2 className="h-3 w-3" />
                {t('sessions.deleteSelected', { count: effectiveSelectedIds.length })}
              </Button>
            </>
          ) : (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() =>
                  onSetSessionSelection({ projectId: project.projectId, sessionIds: new Set() })
                }
              >
                <CheckSquare className="h-3 w-3" />
                {t('sessions.select')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* A page emptied by deleting every loaded row still has sessions behind
          it on the server, so it keeps its "Load more" instead of "No sessions". */}
      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions && !hasMoreSessions ? (
        <div className="px-3 py-2 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        <>
          <div className={cn(!hasForks && 'space-y-1')} data-testid="project-session-tree">
            {visibleRows.map(({ session, parentId, link, depth, hasChildren, isLastSibling, continuationDepths }) => {
              const childFold = childFoldBySessionId?.get(session.id) ?? null;
              const isBranchOpen = childFold ? childFold.isExpanded : !collapsedForks.has(session.id);
              const sessionTitle = session.summary || session.name || t('projects.newSession');
              // A spawned session whose parent is not in this list (another
              // repository not loaded here, or not paged in yet) stays a flat
              // row that names what launched it.
              let spawnedByLabel: string | null = null;
              if (spawnNesting && !parentId && session.parentSessionId) {
                const parentName = session.parentSummary?.trim() || t('projects.newSession');
                const parentProjectPath = session.parentProjectPath?.trim() ?? '';
                const ownProjectPath = (project.fullPath || project.path || '').trim();
                spawnedByLabel = !parentProjectPath || parentProjectPath === ownProjectPath
                  ? parentName
                  : `${parentName} · ${readProjectFolderName(parentProjectPath)}`;
              }
              return (
              <div
                key={session.id}
                data-session-id={session.id}
                data-parent-session-id={parentId ?? undefined}
                data-session-link={link ?? undefined}
                data-fork-depth={depth}
                data-fork-branch={hasChildren || undefined}
                className="relative flex min-w-0 items-stretch"
                style={depth > 0 ? { paddingLeft: `${Math.min(depth, MAX_FORK_INDENT_DEPTH) * FORK_INDENT_PX}px` } : undefined}
              >
                {parentId && (
                  <span
                    aria-hidden="true"
                    data-fork-connector={isLastSibling ? 'last' : 'branch'}
                    className="pointer-events-none absolute inset-y-0"
                    style={{ left: `${(Math.min(depth, MAX_FORK_INDENT_DEPTH) - 1) * FORK_INDENT_PX + FORK_INDENT_PX / 2}px`, width: `${FORK_INDENT_PX}px` }}
                  >
                    <span className={cn('absolute left-0 top-0 border-l border-muted-foreground/50', isLastSibling ? 'bottom-1/2' : 'bottom-0')} />
                    <span className="absolute left-0 top-1/2 border-t border-muted-foreground/50" style={{ width: hasChildren ? '6px' : '12px' }} />
                  </span>
                )}
                {continuationDepths.map((ancestorDepth) => (
                  <span
                    key={ancestorDepth}
                    aria-hidden="true"
                    data-fork-continuation={ancestorDepth}
                    className="pointer-events-none absolute inset-y-0 border-l border-muted-foreground/50"
                    style={{ left: `${(ancestorDepth - 1) * FORK_INDENT_PX + FORK_INDENT_PX / 2}px` }}
                  />
                ))}
                {hasChildren && (childFold || !collapsedForks.has(session.id)) && (
                  <span
                    aria-hidden="true"
                    data-fork-stem=""
                    className="pointer-events-none absolute bottom-0 border-l border-muted-foreground/50"
                    style={{ left: `${Math.min(depth, MAX_FORK_INDENT_DEPTH - 1) * FORK_INDENT_PX + FORK_INDENT_PX / 2}px`, top: 'calc(50% + 7px)' }}
                  />
                )}
                {hasForks && (
                  hasChildren || childFold ? (
                    <button
                      type="button"
                      className="relative flex w-3 flex-shrink-0 items-center justify-center rounded text-foreground/70 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-expanded={isBranchOpen}
                      data-child-fold={childFold ? (childFold.isExpanded ? 'unfolded' : 'folded') : undefined}
                      aria-label={childFold
                        ? childFold.isExpanded
                          ? t('sessions.foldIdleChildren', { name: sessionTitle, defaultValue: 'Fold inactive sessions under {{name}}' })
                          : t('sessions.unfoldIdleChildren', { name: sessionTitle, count: childFold.foldedCount, defaultValue: 'Show {{count}} inactive sessions under {{name}}' })
                        : collapsedForks.has(session.id)
                          ? t('sessions.expandForks', { session: sessionTitle })
                          : t('sessions.collapseForks', { session: sessionTitle })}
                      onClick={() => {
                        if (childFold) {
                          toggleFoldedChildren(session.id);
                          return;
                        }
                        setForkTreeState((previous) => {
                          const next = new Set(previous.collapsedForks);
                          if (next.has(session.id)) next.delete(session.id);
                          else next.add(session.id);
                          return { ...previous, collapsedForks: next };
                        });
                      }}
                    >
                      <ChevronRight className={cn('h-3 w-3 transition-transform', isBranchOpen && 'rotate-90')} strokeWidth={2.5} aria-hidden="true" />
                    </button>
                  ) : <span className="w-3 flex-shrink-0" aria-hidden="true" />
                )}
                <div className="min-w-0 flex-1">
                  <SidebarSessionItem
                    project={project}
                    session={session}
                    selectedSession={selectedSession}
                    isProcessing={isSessionRunning(session)}
                    hasBackgroundWork={backgroundSessionIds.has(session.id)}
                    needsAttention={attentionSessionIds.has(session.id)}
                    currentTime={currentTime}
                    onRenameDraftChange={onRenameDraftChange}
                    isEditing={session.id === sessionRenameId}
                    renameDraft={session.id === sessionRenameId ? sessionRenameDraft : ''}
                    onStartEditingSession={onStartEditingSession}
                    onCancelEditingSession={onCancelEditingSession}
                    onSaveEditingSession={onSaveEditingSession}
                    onProjectSelect={onProjectSelect}
                    onSessionSelect={onSessionSelect}
                    onArchiveSession={onArchiveSession}
                    onDeleteSession={onDeleteSession}
                    onForkSession={onForkSession}
                    isSelecting={isSelecting}
                    isChecked={checkedSessionIds.has(session.id)}
                    onToggleSessionSelected={onToggleSessionSelected}
                    treeRow={hasForks}
                    foldedChildrenLabel={childFold && !childFold.isExpanded && childFold.foldedCount > 0
                      ? t('sessions.foldedIdleChildren', { count: childFold.foldedCount, defaultValue: '+{{count}} inactive' })
                      : null}
                    spawnedByLabel={spawnedByLabel}
                    t={t}
                  />
                </div>
              </div>
              );
            })}
          </div>

          {spawnTree?.isFoldable && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setIsShowingAllSessions((previous) => !previous)}
              aria-expanded={!spawnTree.isFolded}
            >
              {spawnTree.isFolded ? (
                <>
                  <ChevronDown className="h-3 w-3" />
                  {t('sessions.showAllSessions', { hidden: spawnTree.foldedSessionCount, defaultValue: 'Show {{hidden}} more' })}
                  <FoldedSessionIndicators
                    foldedLiveCount={spawnTree.foldedLiveCount}
                    foldedWaitingCount={spawnTree.foldedWaitingCount}
                    t={t}
                  />
                </>
              ) : (
                <>
                  <ChevronUp className="h-3 w-3" />
                  {t('sessions.showFewerSessions', { defaultValue: 'Show less' })}
                </>
              )}
            </Button>
          )}

          {/* Fetching the next page only makes sense once everything already
              fetched is on screen. */}
          {!spawnTree?.isFolded && hasMoreSessions && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-full justify-center text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onLoadMoreSessions(project.projectId)}
              disabled={isLoadingMoreSessions}
            >
              {isLoadingMoreSessions ? t('sessions.loadingSessions') : 'Load more sessions'}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
