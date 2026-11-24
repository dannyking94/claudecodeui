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

// A secretary (claude) with two workers it spawned — one running, one stopped —
// plus a fork of the secretary and an unrelated conversation. The worker runs
// on another provider than its parent, which a fork never does. Only `busy` is
// live (in `activeSessions`): folding reads liveness, never how recently a
// transcript was written.
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
  activeSessions: new Set(['busy']), backgroundSessionIds: new Set(), attentionSessionIds: new Set(),
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

test('a spawned session stays on screen while it runs, has background work, or is open', () => {
  const running = render(<SidebarProjectSessions {...props({ activeSessions: new Set(['busy', 'quiet']) })} />);
  expect(rowIds(running.container)).toContain('quiet');
  running.unmount();

  const background = render(<SidebarProjectSessions {...props({ activeSessions: new Set(['busy', 'quiet']), backgroundSessionIds: new Set(['quiet']) })} />);
  expect(rowIds(background.container)).toContain('quiet');
  background.unmount();

  const open = render(<SidebarProjectSessions {...props({ selectedSession: quietWorker })} />);
  expect(rowIds(open.container)).toContain('quiet');
});

test('a stopped worker folds however recently it wrote, and unread does not keep it up', () => {
  // The owner's screenshot: a worker that reported a minute ago and was stopped
  // still had a dot and its own row. Not live means folded.
  const justStopped: SessionWithProvider = { ...quietWorker, lastActivity: minutesAgo(1) };
  const { container } = render(<SidebarProjectSessions {...props({
    sessions: [secretary, busyWorker, justStopped, fork, other],
    attentionSessionIds: new Set(['quiet']),
  })} />);

  expect(rowIds(container)).toEqual(['secretary', 'busy', 'fork', 'other']);
  expect(row(container, 'secretary').querySelector('[data-folded-children]')?.textContent).toBe('sessions.foldedIdleChildren 1');
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
  // A fork: always drawn, but not live, so root-1 still takes one of the three slots.
  const child: SessionWithProvider = { id: 'child', summary: 'Child', __provider: 'claude', forkedFromSessionId: 'root-1', lastActivity: minutesAgo(1) };
  const { container } = render(<SidebarProjectSessions {...props({ sessions: [...roots, child], hasMoreSessions: true, activeSessions: new Set() })} />);

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

test('the "+N inactive" label is a second target for its arrow, and does not open the session', () => {
  const onSessionSelect = vi.fn();
  const { container } = render(<SidebarProjectSessions {...props({ onSessionSelect })} />);
  const label = row(container, 'secretary').querySelector('[data-folded-children]')!;

  fireEvent.click(label);
  expect(rowIds(container)).toEqual(['secretary', 'busy', 'quiet', 'fork', 'other']);
  expect(onSessionSelect).not.toHaveBeenCalled();
  // Folding back goes through the arrow, which stays the accessible control.
  fireEvent.click(screen.getByRole('button', { name: 'sessions.foldIdleChildren Secretary' }));
  expect(rowIds(container)).toEqual(['secretary', 'busy', 'fork', 'other']);
});

test('while selecting, the label is plain text and the click ticks the row', () => {
  const onToggleSessionSelected = vi.fn();
  const { container } = render(<SidebarProjectSessions {...props({ selectedSessionIds: new Set(), onToggleSessionSelected })} />);

  fireEvent.click(row(container, 'secretary').querySelector('[data-folded-children]')!);
  expect(rowIds(container)).toEqual(['secretary', 'busy', 'fork', 'other']);
  expect(onToggleSessionSelected).toHaveBeenCalledWith('project', 'secretary');
});
