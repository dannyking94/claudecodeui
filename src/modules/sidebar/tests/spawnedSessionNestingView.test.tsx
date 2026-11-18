import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { TFunction } from 'i18next';
import { afterEach, expect, test, vi } from 'vitest';

import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import { SPAWN_NESTING_STORAGE_KEY } from '@/modules/sidebar/utils/sessionTree';
import type { Project, SessionWithProvider } from '@/shared/types';

vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => false }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set(['claude', 'codex']) }));
vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));

const t = ((key: string, options?: Record<string, unknown>) => {
  if (options?.name) return `${key} ${String(options.name)}`;
  if (options?.session) return `${key} ${String(options.session)}`;
  if (options?.hidden !== undefined) return `${key} ${String(options.hidden)}`;
  if (options?.count !== undefined) return `${key} ${String(options.count)}`;
  return key;
}) as TFunction;
const noop = () => {};
const NOW = new Date('2026-10-18T12:00:00Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

// A secretary (claude) with two workers it spawned — one still writing, one at
// rest — plus a fork of the secretary and an unrelated conversation. The worker
// runs on another provider than its parent, which a fork never does.
const secretary: SessionWithProvider = { id: 'secretary', summary: 'Secretary', __provider: 'claude', lastActivity: minutesAgo(1) };
const busyWorker: SessionWithProvider = { id: 'busy', summary: 'Busy worker', __provider: 'codex', parentSessionId: 'secretary', lastActivity: minutesAgo(2) };
const quietWorker: SessionWithProvider = { id: 'quiet', summary: 'Quiet worker', __provider: 'claude', parentSessionId: 'secretary', lastActivity: minutesAgo(300) };
const fork: SessionWithProvider = { id: 'fork', summary: 'Fork', __provider: 'claude', forkedFromSessionId: 'secretary', lastActivity: minutesAgo(600) };
const other: SessionWithProvider = { id: 'other', summary: 'Other', __provider: 'claude', lastActivity: minutesAgo(900) };
const sessions = [secretary, busyWorker, quietWorker, fork, other];

const props = (overrides: Partial<ComponentProps<typeof SidebarProjectSessions>> = {}): ComponentProps<typeof SidebarProjectSessions> => ({
  project: { projectId: 'project', displayName: 'Project', fullPath: '/workspace/project' },
  isExpanded: true, sessions, selectedSession: null, initialSessionsLoaded: true,
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
const row = (container: HTMLElement, id: string) => container.querySelector(`[data-session-id="${id}"]`)!;

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

test('a working spawned session shows under its parent, a quiet one folds behind the arrow, a fork stays open', () => {
  const { container } = render(<SidebarProjectSessions {...props()} />);

  // The quiet fork is not folded: only spawned children fold on inactivity.
  expect(rowIds(container)).toEqual(['secretary', 'busy', 'fork', 'other']);
  expect(row(container, 'busy').getAttribute('data-session-link')).toBe('spawn');
  expect(row(container, 'busy').getAttribute('data-parent-session-id')).toBe('secretary');
  expect(row(container, 'fork').getAttribute('data-session-link')).toBe('fork');
  expect(row(container, 'secretary').querySelector('[data-folded-children]')?.textContent).toBe('sessions.foldedIdleChildren 1');

  fireEvent.click(screen.getByRole('button', { name: 'sessions.unfoldIdleChildren Secretary' }));
  expect(rowIds(container)).toEqual(['secretary', 'busy', 'quiet', 'fork', 'other']);
  expect(row(container, 'secretary').querySelector('[data-folded-children]')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'sessions.foldIdleChildren Secretary' }));
  expect(rowIds(container)).toEqual(['secretary', 'busy', 'fork', 'other']);
});

test('a quiet spawned session never folds while it runs, waits on the user, or is open', () => {
  const running = render(<SidebarProjectSessions {...props({ activeSessions: new Set(['quiet']) })} />);
  expect(rowIds(running.container)).toContain('quiet');
  running.unmount();

  const waiting = render(<SidebarProjectSessions {...props({ attentionSessionIds: new Set(['quiet']) })} />);
  expect(rowIds(waiting.container)).toContain('quiet');
  waiting.unmount();

  const open = render(<SidebarProjectSessions {...props({ selectedSession: quietWorker })} />);
  expect(rowIds(open.container)).toContain('quiet');
});

test('a spawned session opens in the project it runs in, not the group it is shown under', () => {
  const ownerProject: Project = { projectId: 'worktree', displayName: 'Worktree', fullPath: '/workspace/worktree' };
  const movedWorker: SessionWithProvider = { ...busyWorker, __ownerProject: ownerProject };
  const onSessionSelect = vi.fn();
  render(<SidebarProjectSessions {...props({ sessions: [secretary, movedWorker], onSessionSelect })} />);

  fireEvent.click(screen.getByText('Busy worker'));
  expect(onSessionSelect.mock.calls).toEqual([[movedWorker, 'worktree']]);
  expect(screen.getByText('worktree')).toBeTruthy();
});

test('a project shows three top-level conversations and folds the rest behind "show more"', () => {
  const roots = Array.from({ length: 5 }, (_, index): SessionWithProvider => ({
    id: `root-${index + 1}`, summary: `Root ${index + 1}`, __provider: 'claude', lastActivity: minutesAgo(index + 1),
  }));
  const child: SessionWithProvider = { id: 'child', summary: 'Child', __provider: 'claude', parentSessionId: 'root-1', lastActivity: minutesAgo(1) };
  const { container } = render(<SidebarProjectSessions {...props({ sessions: [...roots, child], hasMoreSessions: true })} />);

  // Each top-level conversation is counted with its subtree.
  expect(rowIds(container)).toEqual(['root-1', 'child', 'root-2', 'root-3']);
  expect(screen.queryByText('Load more sessions')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /sessions\.showAllSessions 2/ }));
  expect(rowIds(container)).toEqual(['root-1', 'child', 'root-2', 'root-3', 'root-4', 'root-5']);
  expect(screen.getByText('Load more sessions')).toBeTruthy();
});

test('the session that is open stays on screen past the project fold', () => {
  const roots = Array.from({ length: 5 }, (_, index): SessionWithProvider => ({
    id: `root-${index + 1}`, summary: `Root ${index + 1}`, __provider: 'claude', lastActivity: minutesAgo(index + 1),
  }));
  const { container } = render(<SidebarProjectSessions {...props({ sessions: roots, selectedSession: roots[4] })} />);

  expect(rowIds(container)).toEqual(['root-1', 'root-2', 'root-3', 'root-5']);
});

test('with the switch off the list is the plain fork tree: no spawn nesting, no fold, no cap', () => {
  localStorage.setItem(SPAWN_NESTING_STORAGE_KEY, 'off');
  const roots = Array.from({ length: 3 }, (_, index): SessionWithProvider => ({
    id: `root-${index + 1}`, summary: `Root ${index + 1}`, __provider: 'claude', lastActivity: minutesAgo(1000 + index),
  }));
  const { container } = render(<SidebarProjectSessions {...props({ sessions: [...sessions, ...roots] })} />);

  expect(rowIds(container)).toEqual(['secretary', 'fork', 'busy', 'quiet', 'other', 'root-1', 'root-2', 'root-3']);
  expect(row(container, 'busy').getAttribute('data-parent-session-id')).toBeNull();
  expect(row(container, 'fork').getAttribute('data-parent-session-id')).toBe('secretary');
  expect(screen.queryByRole('button', { name: /showAllSessions/ })).toBeNull();
});
