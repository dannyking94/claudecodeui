import { useState } from 'react';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '../../../../shared/view/ui';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import {
  MAX_SESSION_TREE_DEPTH,
  NESTED_SESSION_INDENT_PX,
  countSessionSubtreeRows,
  foldChildSessions,
  type SessionTreeRow,
} from '../../utils/sessionTree';

import SidebarSessionItem from './SidebarSessionItem';

type SidebarProjectSessionsProps = {
  project: Project;
  isExpanded: boolean;
  sessions: SessionWithProvider[];
  selectedSession: ProjectSession | null;
  initialSessionsLoaded: boolean;
  hasMoreSessions: boolean;
  isLoadingMoreSessions: boolean;
  activeSessions: SessionActivityMap;
  attentionSessionIds: ReadonlySet<string>;
  currentTime: Date;
  editingSession: string | null;
  editingSessionName: string;
  onEditingSessionNameChange: (value: string) => void;
  onStartEditingSession: (sessionId: string, initialName: string) => void;
  onCancelEditingSession: () => void;
  onSaveEditingSession: (projectName: string, sessionId: string, summary: string, provider: LLMProvider) => void;
  onProjectSelect: (project: Project) => void;
  onSessionSelect: (session: SessionWithProvider, projectName: string) => void;
  onDeleteSession: (
    projectName: string,
    sessionId: string,
    sessionTitle: string,
    provider: LLMProvider,
  ) => void;
  onLoadMoreSessions: (projectId: string) => void;
  onNewSession: (project: Project) => void;
  t: TFunction;
};

/**
 * Rows shown per project before the rest are folded away. Three keeps a project
 * with a long history from pushing every other project off the sidebar, while
 * still covering the "jump back to what I was just doing" case.
 */
const VISIBLE_SESSION_LIMIT = 3;

/**
 * Index just past the first `VISIBLE_SESSION_LIMIT` top-level sessions.
 *
 * Each one is counted together with its whole subtree, so the fold never cuts
 * between a parent and the children indented under it — and a project whose
 * top rows spawned workers still shows three conversations, not three rows.
 */
const findFoldCutIndex = (rows: SessionTreeRow[]): number => {
  let cutIndex = 0;
  let topLevelCount = 0;

  while (cutIndex < rows.length && topLevelCount < VISIBLE_SESSION_LIMIT) {
    cutIndex += countSessionSubtreeRows(rows, cutIndex);
    topLevelCount += 1;
  }

  return cutIndex;
};

/** Matches the indentation `SidebarSessionItem` gives a row at the same depth. */
const readRowIndentPx = (depth: number): number =>
  Math.min(Math.max(Math.trunc(depth), 0), MAX_SESSION_TREE_DEPTH) * NESTED_SESSION_INDENT_PX;

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

export default function SidebarProjectSessions({
  project,
  isExpanded,
  sessions,
  selectedSession,
  initialSessionsLoaded,
  hasMoreSessions,
  isLoadingMoreSessions,
  activeSessions,
  attentionSessionIds,
  currentTime,
  editingSession,
  editingSessionName,
  onEditingSessionNameChange,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  onProjectSelect,
  onSessionSelect,
  onDeleteSession,
  onLoadMoreSessions,
  onNewSession,
  t,
}: SidebarProjectSessionsProps) {
  const [isShowingAllSessions, setIsShowingAllSessions] = useState(false);
  const [expandedParentIds, setExpandedParentIds] = useState<ReadonlySet<string>>(() => new Set());

  if (!isExpanded) {
    return null;
  }

  const toggleFoldedChildren = (parentSessionId: string) => {
    setExpandedParentIds((previous) => {
      const next = new Set(previous);
      if (!next.delete(parentSessionId)) {
        next.add(parentSessionId);
      }

      return next;
    });
  };

  const hasSessions = sessions.length > 0;
  // Running, or waiting on the user. Ids belonging to other projects are
  // harmless: the fold only looks up sessions it is already rendering.
  const liveSessionIds = new Set<string>([...activeSessions.keys(), ...attentionSessionIds]);
  const rows = foldChildSessions(sessions, {
    expandedParentIds,
    liveSessionIds,
    // The session on screen keeps its row even once siblings overtake it.
    pinnedSessionIds: selectedSession ? new Set([String(selectedSession.id)]) : undefined,
  });

  const foldCutIndex = findFoldCutIndex(rows);
  const isFoldable = foldCutIndex < rows.length;
  const isFolded = isFoldable && !isShowingAllSessions;

  // A selection past the cut would otherwise disappear the moment it is opened,
  // so the fold keeps the current session pinned below the first three rows
  // rather than hiding where the user actually is. It is pinned flat: shown
  // apart from its subtree, indentation would only read as a child of whatever
  // row the fold happened to end on.
  const selectedIndex = selectedSession
    ? rows.findIndex((row) => row.kind === 'session' && row.session.id === selectedSession.id)
    : -1;
  const selectedRow = selectedIndex >= 0 ? rows[selectedIndex] : null;
  const visibleRows: SessionTreeRow[] = !isFolded
    ? rows
    : selectedRow?.kind === 'session' && selectedIndex >= foldCutIndex
      ? [
          ...rows.slice(0, foldCutIndex),
          { ...selectedRow, __depth: 0, session: { ...selectedRow.session, __depth: 0 } },
        ]
      : rows.slice(0, foldCutIndex);

  // Everything the user cannot currently see under this project, counted once:
  // the rows this fold took off screen, plus the children each toggle down
  // there is holding. A toggle above the cut is on screen and speaks for
  // itself.
  const foldedRows = isFolded
    ? rows.slice(foldCutIndex).filter((_, offset) => foldCutIndex + offset !== selectedIndex)
    : [];
  const foldedSessionCount = foldedRows.reduce(
    (total, row) => total + (row.kind === 'session' ? 1 : row.foldedCount),
    0,
  );
  // Folding must not swallow the green/amber dots: a session that is running or
  // waiting on the user still reports itself through the toggle, whether it was
  // this fold or a parent's that took it off screen.
  const foldedLiveCount = foldedRows.reduce(
    (total, row) => total + (
      row.kind === 'session'
        ? (liveSessionIds.has(row.session.id) ? 1 : 0)
        : row.foldedLiveCount
    ),
    0,
  );

  return (
    <div className="ml-3 space-y-1 border-l border-border pl-3">
      <div className="px-3 pb-1 pt-1 md:hidden">
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

      <Button
        variant="default"
        size="sm"
        className="hidden h-8 w-full justify-start gap-2 bg-primary text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 md:flex"
        onClick={() => onNewSession(project)}
      >
        <Plus className="h-3 w-3" />
        {t('sessions.newSession')}
      </Button>

      {!initialSessionsLoaded ? (
        <SessionListSkeleton />
      ) : !hasSessions ? (
        <div className="px-3 py-2 text-left">
          <p className="text-xs text-muted-foreground">{t('sessions.noSessions')}</p>
        </div>
      ) : (
        <>
          {visibleRows.map((row) => (row.kind === 'session' ? (
            <SidebarSessionItem
              key={row.session.id}
              project={project}
              session={row.session}
              selectedSession={selectedSession}
              isProcessing={activeSessions.has(row.session.id)}
              needsAttention={attentionSessionIds.has(row.session.id)}
              currentTime={currentTime}
              editingSession={editingSession}
              editingSessionName={editingSessionName}
              onEditingSessionNameChange={onEditingSessionNameChange}
              onStartEditingSession={onStartEditingSession}
              onCancelEditingSession={onCancelEditingSession}
              onSaveEditingSession={onSaveEditingSession}
              onProjectSelect={onProjectSelect}
              onSessionSelect={onSessionSelect}
              onDeleteSession={onDeleteSession}
              t={t}
            />
          ) : (
            // Sits where the children it stands in for would be, indented and
            // on the same tree line, so the count reads as part of that branch.
            <div
              key={`folded-children:${row.parentSessionId}`}
              className="relative"
              style={{ marginLeft: readRowIndentPx(row.__depth) }}
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute -left-2 top-0 h-full w-px bg-border"
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-full justify-start gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => toggleFoldedChildren(row.parentSessionId)}
                aria-expanded={row.foldedCount === 0}
              >
                {row.foldedCount > 0 ? (
                  <>
                    <ChevronDown className="h-3 w-3" />
                    {t('sessions.showAllSessions', {
                      hidden: row.foldedCount,
                      defaultValue: 'Show {{hidden}} more',
                    })}
                    {row.foldedLiveCount > 0 && (
                      <span
                        className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500"
                        aria-label={t('tooltips.activeSessionIndicator')}
                      />
                    )}
                  </>
                ) : (
                  <>
                    <ChevronUp className="h-3 w-3" />
                    {t('sessions.showFewerSessions', { defaultValue: 'Show less' })}
                  </>
                )}
              </Button>
            </div>
          )))}

          {isFoldable && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setIsShowingAllSessions((previous) => !previous)}
              aria-expanded={!isFolded}
            >
              {isFolded ? (
                <>
                  <ChevronDown className="h-3 w-3" />
                  {t('sessions.showAllSessions', {
                    hidden: foldedSessionCount,
                    defaultValue: 'Show {{hidden}} more',
                  })}
                  {foldedLiveCount > 0 && (
                    <span
                      className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-500"
                      aria-label={t('tooltips.activeSessionIndicator')}
                    />
                  )}
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
          {!isFolded && hasMoreSessions && (
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
