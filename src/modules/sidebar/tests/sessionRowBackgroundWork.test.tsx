import assert from 'node:assert/strict';

import { render } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

import type { Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * The Projects list draws a session's state as one dot on the row's left edge,
 * and only for something it actually observed: purple while the tasks a turn
 * launched still run, a hollow green ring while its Claude process is alive at
 * the prompt, amber for activity the user has not opened yet. A turn in flight
 * has the spinner instead, and how recently the transcript was written draws
 * nothing — a stopped worker must not look active.
 *
 * Assertions compare strings and booleans, never DOM nodes: node:assert
 * inspecting a React-rendered element for its failure message walks the whole
 * fiber graph, and once grew a vitest worker to 54 GB.
 */

const recordedOptionsProps: Record<string, unknown>[] = [];

vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set(),
}));

vi.mock('@/modules/sidebar/SessionOptions', () => ({
  default: (props: Record<string, unknown>) => {
    recordedOptionsProps.push(props);
    return null;
  },
}));

const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const NOW = new Date('2026-08-21T10:00:00.000Z');
const noop = () => {};

const PROJECT = { projectId: 'project-1', name: 'project-1', displayName: 'project one', fullPath: '/tmp/project-1', sessions: [] } as unknown as Project;
// Touched a minute ago: the old "recently active" rule would have drawn a green dot.
const SESSION = { id: 's1', summary: 'session one', lastActivity: '2026-08-21T09:59:00.000Z', __provider: 'claude' } as unknown as SessionWithProvider;

type RowState = { isProcessing: boolean; hasBackgroundWork: boolean; hasIdleProcess?: boolean; needsAttention?: boolean };

const renderRow = (state: RowState) => render(
  React.createElement(SidebarSessionItem, {
    project: PROJECT,
    session: SESSION,
    selectedSession: null,
    needsAttention: false,
    currentTime: NOW,
    isEditing: false,
    renameDraft: '',
    onRenameDraftChange: noop,
    onStartEditingSession: noop,
    onCancelEditingSession: noop,
    onSaveEditingSession: noop,
    onProjectSelect: noop,
    onSessionSelect: noop,
    onArchiveSession: noop,
    onDeleteSession: noop,
    isSelecting: false,
    isChecked: false,
    onToggleSessionSelected: noop,
    t,
    ...state,
  }),
);

/** The status dot's kind and label, or null when the row has none. */
const readStatus = (container: HTMLElement): { kind: string | null; label: string | null; title: string | null } | null => {
  const status = container.querySelector('[data-session-status]');
  return status
    ? { kind: status.getAttribute('data-session-status'), label: status.getAttribute('aria-label'), title: status.getAttribute('title') }
    : null;
};

const countSpinners = (container: HTMLElement): number => container.querySelectorAll('.animate-spin').length;

beforeEach(() => {
  recordedOptionsProps.length = 0;
});

test('a session touched a minute ago with nothing running shows no dot', () => {
  const { container } = renderRow({ isProcessing: false, hasBackgroundWork: false });

  assert.equal(readStatus(container), null);
  assert.equal(countSpinners(container), 0);
});

test('background work shows as the purple dot, with nothing spinning', () => {
  const { container } = renderRow({ isProcessing: false, hasBackgroundWork: true });

  assert.deepEqual(readStatus(container), {
    kind: 'background',
    label: 'tooltips.backgroundWorkIndicator',
    title: 'tooltips.backgroundWorkIndicator',
  });
  assert.equal(countSpinners(container), 0);
  assert.equal(recordedOptionsProps.at(-1)?.isProcessing, false, 'the row is not locked the way a responding one is');
});

test('a response in flight still spins and shows no dot', () => {
  const { container } = renderRow({ isProcessing: true, hasBackgroundWork: false });

  assert.equal(readStatus(container), null);
  assert.equal(countSpinners(container), 1);
  assert.equal(recordedOptionsProps[0].isProcessing, true);
});

test('a process alive at its prompt shows the hollow ring, and outranks unread', () => {
  const { container } = renderRow({ isProcessing: false, hasBackgroundWork: false, hasIdleProcess: true, needsAttention: true });

  assert.equal(readStatus(container)?.kind, 'idle-process');
  assert.equal(readStatus(container)?.title, 'tooltips.idleProcessIndicator');
  assert.equal(countSpinners(container), 0);
});

test('unread activity on a stopped session is amber, and says so on hover', () => {
  const { container } = renderRow({ isProcessing: false, hasBackgroundWork: false, needsAttention: true });

  assert.deepEqual(readStatus(container), {
    kind: 'unread',
    label: 'tooltips.unreadActivityIndicator',
    title: 'tooltips.unreadActivityIndicator',
  });
});
