import { fireEvent, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { TFunction } from 'i18next';
import { afterEach, expect, test, vi } from 'vitest';

import SidebarProjectSessions from '@/modules/sidebar/SidebarProjectSessions';
import type { SessionWithProvider, WorkerStateEntry } from '@/shared/types';

const workerStates = vi.hoisted(() => ({ current: new Map() as ReadonlyMap<string, unknown> }));

vi.mock('@/modules/sidebar/hooks/useCompactSidebar', () => ({ useCompactSidebar: () => false }));
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({ useSessionForkingProviders: () => new Set(['claude', 'codex']) }));
vi.mock('@/modules/sidebar/SessionOptions', () => ({ default: () => null }));
vi.mock('@/shared/context/SessionProtectionContext', () => ({
  useIdleProcessSessionIdSet: () => new Set(),
  useWorkerStateMap: () => workerStates.current,
}));

const t = ((key: string, options?: Record<string, unknown>) => {
  const values = Object.entries(options ?? {})
    .filter(([name]) => name !== 'defaultValue')
    .map(([, value]) => String(value));
  return [key, ...values].join(' ');
}) as TFunction;
const noop = () => {};
const NOW = new Date('2026-11-24T12:00:00');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

// A secretary with three stopped workers; none is live, so all would fold.
const secretary: SessionWithProvider = { id: 'secretary', summary: 'Secretary', __provider: 'claude', lastActivity: minutesAgo(1) };
const deadWorker: SessionWithProvider = { id: 'dead', summary: 'Dead worker', __provider: 'claude', parentSessionId: 'secretary', lastActivity: minutesAgo(50) };
const slowWorker: SessionWithProvider = { id: 'slow', summary: 'Slow worker', __provider: 'claude', parentSessionId: 'secretary', lastActivity: minutesAgo(34) };
const doneWorker: SessionWithProvider = { id: 'done', summary: 'Done worker', __provider: 'claude', parentSessionId: 'secretary', lastActivity: minutesAgo(5) };
const sessions = [secretary, deadWorker, slowWorker, doneWorker];

const entry = (overrides: Partial<WorkerStateEntry> & Pick<WorkerStateEntry, 'sessionId' | 'state'>): WorkerStateEntry => ({
  cause: '', since: NOW.getTime() - 50 * 60_000, lastActivity: null, worker: overrides.sessionId, ...overrides,
});
const setWorkerStates = (entries: WorkerStateEntry[]) => {
  workerStates.current = new Map(entries.map((item) => [item.sessionId, item]));
};

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
const badge = (container: HTMLElement, id: string) => container.querySelector(`[data-session-id="${id}"] [data-worker-state]`);
const foldLabel = (container: HTMLElement) => container.querySelector('[data-session-id="secretary"] [data-folded-children]')?.textContent ?? null;

afterEach(() => {
  workerStates.current = new Map();
  localStorage.clear();
  sessionStorage.clear();
});

test('without deathwatch data every stopped worker folds and no row has a badge', () => {
  const { container } = render(<SidebarProjectSessions {...props()} />);
  expect(rowIds(container)).toEqual(['secretary']);
  expect(foldLabel(container)).toBe('sessions.foldedIdleChildren 3');
  expect(container.querySelector('[data-worker-state]')).toBeNull();
});

test('a died or stalled worker is never folded into "+N inactive", and its badge says why', () => {
  setWorkerStates([
    entry({ sessionId: 'dead', state: 'died', cause: 'OOM-killed 11:10 · vitest 52 GB' }),
    entry({ sessionId: 'slow', state: 'stalled', lastActivity: NOW.getTime() - 34 * 60_000 }),
    entry({ sessionId: 'done', state: 'reported', since: new Date('2026-11-24T11:55:00').getTime() }),
  ]);
  const { container } = render(<SidebarProjectSessions {...props()} />);

  // The reported worker folds like any stopped one; the alerts stay up.
  expect(rowIds(container)).toEqual(['secretary', 'dead', 'slow']);
  expect(foldLabel(container)).toBe('sessions.foldedIdleChildren 1');

  expect(badge(container, 'dead')?.getAttribute('data-worker-state')).toBe('died');
  expect(badge(container, 'dead')?.textContent).toBe('workerState.died');
  expect(badge(container, 'dead')?.getAttribute('aria-label')).toBe('workerState.diedLabel OOM-killed 11:10 · vitest 52 GB');
  expect(badge(container, 'slow')?.getAttribute('aria-label')).toBe('workerState.stalledLabel 34');
});

test('a reported worker shows a quiet tick once unfolded, and blackout its own chip', () => {
  setWorkerStates([
    entry({ sessionId: 'done', state: 'reported', since: new Date('2026-11-24T11:55:00').getTime() }),
    entry({ sessionId: 'slow', state: 'blackout', cause: 'codex blacked out at 11:20' }),
  ]);
  const { container } = render(<SidebarProjectSessions {...props()} />);
  expect(rowIds(container)).toEqual(['secretary']);
  fireEvent.click(container.querySelector('[data-child-fold="folded"]')!);

  expect(badge(container, 'done')?.textContent).toBe('✓');
  expect(badge(container, 'done')?.getAttribute('aria-label')).toBe('workerState.reportedLabelAt 11:55');
  expect(badge(container, 'slow')?.textContent).toBe('workerState.blackout');
  expect(badge(container, 'dead')).toBeNull();
});

test('opening a died worker acknowledges it: it folds once the user moves on, and stays folded on reload', () => {
  setWorkerStates([entry({ sessionId: 'dead', state: 'died' })]);
  const view = render(<SidebarProjectSessions {...props({ selectedSession: deadWorker })} />);
  expect(rowIds(view.container)).toContain('dead');

  view.rerender(<SidebarProjectSessions {...props({ selectedSession: secretary })} />);
  expect(rowIds(view.container)).toEqual(['secretary']);
  view.unmount();

  const reloaded = render(<SidebarProjectSessions {...props()} />);
  expect(rowIds(reloaded.container)).toEqual(['secretary']);
  // The badge itself stays: the worker is still dead.
  fireEvent.click(reloaded.container.querySelector('[data-child-fold="folded"]')!);
  expect(badge(reloaded.container, 'dead')?.getAttribute('data-worker-state')).toBe('died');
});

test('a new alert on an acknowledged worker shows again, and one the ledger closes folds', () => {
  setWorkerStates([entry({ sessionId: 'slow', state: 'stalled', since: 1 })]);
  const view = render(<SidebarProjectSessions {...props({ selectedSession: slowWorker })} />);
  view.rerender(<SidebarProjectSessions {...props()} />);
  expect(rowIds(view.container)).toEqual(['secretary']);

  // Stalled again later is a second alert.
  setWorkerStates([entry({ sessionId: 'slow', state: 'stalled', since: 2 })]);
  view.rerender(<SidebarProjectSessions {...props({ currentTime: new Date(NOW.getTime() + 1) })} />);
  expect(rowIds(view.container)).toEqual(['secretary', 'slow']);

  // The deathwatch no longer lists it as stalled: back to the ordinary fold.
  setWorkerStates([entry({ sessionId: 'slow', state: 'reported' })]);
  view.rerender(<SidebarProjectSessions {...props({ currentTime: new Date(NOW.getTime() + 2) })} />);
  expect(rowIds(view.container)).toEqual(['secretary']);
});
