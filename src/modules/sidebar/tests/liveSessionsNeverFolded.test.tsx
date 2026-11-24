import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import {
  SessionProtectionProvider,
  useBackgroundSessionIdSet,
  useBusySessionIdSet,
} from '@/shared/context/SessionProtectionContext';
import type { SessionWithProvider } from '@/shared/types';

/**
 * The owner, 2026-11-24: "active sessions are folded together. i want active
 * session to be visible". A project with more than three top-level
 * conversations cut everything past the third, live or not. Whatever is live —
 * spinner, purple background work, hollow-green process open — now keeps its
 * conversation on screen, and the three slots count only the idle ones.
 */

const runningSessions = vi.fn();
vi.mock('@/shared/api', () => ({ api: { runningSessions: () => runningSessions() } }));
vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => false }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set(['claude', 'codex']) }));
vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));

const t = ((key: string, options?: Record<string, unknown>) => {
  if (options?.hidden !== undefined) return `${key} ${String(options.hidden)}`;
  if (options?.count !== undefined) return `${key} ${String(options.count)}`;
  return key;
}) as TFunction;
const noop = () => {};
const NOW = new Date('2026-11-24T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const root = (index: number): SessionWithProvider => ({
  id: `root-${index}`, summary: `Root ${index}`, __provider: 'claude', lastActivity: minutesAgo(index * 10),
});
// Seven top-level conversations, newest first.
const roots = Array.from({ length: 7 }, (_, index) => root(index + 1));

const props = (overrides: Partial<ComponentProps<typeof SidebarProjectSessions>> = {}): ComponentProps<typeof SidebarProjectSessions> => ({
  project: { projectId: 'project', displayName: 'Project', fullPath: '/workspace/project' },
  isExpanded: true, sessions: roots, selectedSession: null, initialSessionsLoaded: true,
  hasMoreSessions: false, isLoadingMoreSessions: false,
  activeSessions: new Set(), backgroundSessionIds: new Set(), attentionSessionIds: new Set(),
  currentTime: NOW, sessionRenameId: null, sessionRenameDraft: '',
  onRenameDraftChange: noop, onStartEditingSession: noop, onCancelEditingSession: noop,
  onSaveEditingSession: noop, onProjectSelect: noop, onSessionSelect: noop, onArchiveSession: noop, onDeleteSession: noop,
  onForkSession: noop, onLoadMoreSessions: noop, onNewSession: noop, selectedSessionIds: null,
  onSetSessionSelection: noop, onToggleSessionSelected: noop, onCancelSessionSelection: noop,
  onDeleteSelectedSessions: noop, t, ...overrides,
});
const rowIds = (container: HTMLElement) => Array.from(container.querySelectorAll('[data-session-id]')).map((row) => row.getAttribute('data-session-id'));
const showMore = () => screen.getByRole('button', { name: /sessions\.showAllSessions/ });

beforeEach(() => {
  runningSessions.mockReset();
  runningSessions.mockResolvedValue({ ok: true, json: async () => ({ data: { sessions: [], idleProcessSessionIds: [] } }) });
});
afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

test('live top-level conversations past the third stay on screen, and the three slots count only idle ones', () => {
  // root-4 runs a turn, root-6 has background work only; the rest are idle.
  const { container } = render(<SidebarProjectSessions {...props({
    activeSessions: new Set(['root-4', 'root-6']),
    backgroundSessionIds: new Set(['root-6']),
  })} />);

  // In their own order, nothing jumps: three idle, plus every live one.
  expect(rowIds(container)).toEqual(['root-1', 'root-2', 'root-3', 'root-4', 'root-6']);
  // The count is exactly what is off screen: root-5 and root-7.
  expect(showMore().textContent).toContain('sessions.showAllSessions 2');

  fireEvent.click(showMore());
  expect(rowIds(container)).toEqual(['root-1', 'root-2', 'root-3', 'root-4', 'root-5', 'root-6', 'root-7']);
});

test('a live grandchild keeps its idle root and parent on screen past the cut', () => {
  // root-7 (the oldest) is idle, as is the worker it spawned; that worker's own
  // worker is running. root-7 still ranks by its own activity, last.
  const worker: SessionWithProvider = { id: 'worker', summary: 'Worker', __provider: 'claude', parentSessionId: 'root-7', lastActivity: minutesAgo(500) };
  const grandchild: SessionWithProvider = { id: 'grandchild', summary: 'Grandchild', __provider: 'codex', parentSessionId: 'worker', lastActivity: minutesAgo(501) };
  const idleSibling: SessionWithProvider = { id: 'idle-sibling', summary: 'Idle sibling', __provider: 'codex', parentSessionId: 'root-7', lastActivity: minutesAgo(502) };
  const { container } = render(<SidebarProjectSessions {...props({
    sessions: [...roots, worker, grandchild, idleSibling],
    activeSessions: new Set(['grandchild']),
  })} />);

  expect(rowIds(container)).toEqual(['root-1', 'root-2', 'root-3', 'root-7', 'worker', 'grandchild']);
  // The idle sibling sits behind root-7's own arrow; the toggle holds root-4..6.
  expect(container.querySelector('[data-session-id="root-7"] [data-folded-children]')?.textContent).toBe('sessions.foldedIdleChildren 1');
  expect(showMore().textContent).toContain('sessions.showAllSessions 3');
});

test('a process open at its prompt (hollow green) is live too, and folds again once it exits', () => {
  runningSessions.mockResolvedValue({
    ok: true, json: async () => ({ data: { sessions: [], idleProcessSessionIds: ['root-5'], includesExternalActivity: true } }),
  });
  const view = render(<SessionProtectionProvider><SidebarProjectSessions {...props()} /></SessionProtectionProvider>);
  return waitFor(() => expect(rowIds(view.container)).toEqual(['root-1', 'root-2', 'root-3', 'root-5'])).then(async () => {
    runningSessions.mockResolvedValue({
      ok: true, json: async () => ({ data: { sessions: [], idleProcessSessionIds: [], includesExternalActivity: true } }),
    });
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(rowIds(view.container)).toEqual(['root-1', 'root-2', 'root-3']));
    expect(showMore().textContent).toContain('sessions.showAllSessions 4');
  });
});

/** The sidebar's wiring: the busy and background sets come from the same poll. */
function PolledSidebar() {
  const activeSessions = useBusySessionIdSet();
  const backgroundSessionIds = useBackgroundSessionIdSet();
  return <SidebarProjectSessions {...props({ activeSessions, backgroundSessionIds })} />;
}

test('external sessions from the running-sessions poll (a tmux secretary, a terminal turn) count as live', async () => {
  runningSessions.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        sessions: [
          { sessionId: 'root-5', startedAt: 1_000, canInterrupt: false, external: true },
          { sessionId: 'root-7', startedAt: 1_000, canInterrupt: false, external: true, background: true },
        ],
        idleProcessSessionIds: ['root-6'],
        includesExternalActivity: true,
      },
    }),
  });
  const { container } = render(<SessionProtectionProvider><PolledSidebar /></SessionProtectionProvider>);

  await waitFor(() => expect(rowIds(container)).toEqual(['root-1', 'root-2', 'root-3', 'root-5', 'root-6', 'root-7']));
  expect(showMore().textContent).toContain('sessions.showAllSessions 1');
});

test('with every conversation live there is nothing to fold', () => {
  const { container } = render(<SidebarProjectSessions {...props({ activeSessions: new Set(roots.map((session) => session.id)) })} />);

  expect(rowIds(container)).toEqual(roots.map((session) => session.id));
  expect(screen.queryByRole('button', { name: /sessions\.showAllSessions/ })).toBeNull();
});
