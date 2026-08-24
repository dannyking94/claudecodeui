import { useState } from 'react';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '../../../../shared/view/ui';
import type { SessionActivityMap } from '../../../../hooks/useSessionProtection';
import type { Project, ProjectSession, LLMProvider } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';

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

  if (!isExpanded) {
    return null;
  }

  const hasSessions = sessions.length > 0;
  const isFoldable = sessions.length > VISIBLE_SESSION_LIMIT;
  const isFolded = isFoldable && !isShowingAllSessions;

  // A selection past the cut would otherwise disappear the moment it is opened,
  // so the fold keeps the current session pinned below the first three rows
  // rather than hiding where the user actually is.
  const selectedIndex = selectedSession
    ? sessions.findIndex((session) => session.id === selectedSession.id)
    : -1;
  const visibleSessions = !isFolded
    ? sessions
    : selectedIndex >= VISIBLE_SESSION_LIMIT
      ? [...sessions.slice(0, VISIBLE_SESSION_LIMIT), sessions[selectedIndex]]
      : sessions.slice(0, VISIBLE_SESSION_LIMIT);

  const foldedSessions = sessions.filter((session) => !visibleSessions.includes(session));
  // Folding must not swallow the green/amber dots: a session that is running or
  // waiting on the user still reports itself through the toggle.
  const foldedLiveCount = foldedSessions.filter(
    (session) => activeSessions.has(session.id) || attentionSessionIds.has(session.id),
  ).length;

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
          {visibleSessions.map((session) => (
            <SidebarSessionItem
              key={session.id}
              project={project}
              session={session}
              selectedSession={selectedSession}
              isProcessing={activeSessions.has(session.id)}
              needsAttention={attentionSessionIds.has(session.id)}
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
          ))}

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
                    hidden: foldedSessions.length,
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
