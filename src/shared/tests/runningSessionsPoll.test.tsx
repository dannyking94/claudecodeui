import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, test, vi } from 'vitest';

/**
 * The running-sessions poll is what a refreshed page or a second tab learns a
 * session's background work from. Its task entries must reach the activity
 * map whole — including the `nested` flag that tells a task the session's own
 * turn launched from one its agents launched for themselves — or the pill
 * counts an agent's backgrounded command as a second task of the session's.
 */

const runningSessions = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { runningSessions: () => runningSessions() },
}));

beforeEach(() => {
  vi.resetModules();
  runningSessions.mockReset();
});

test('the poll carries each task through whole, nested flag included', async () => {
  runningSessions.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        sessions: [{
          sessionId: 'held-session',
          provider: 'claude',
          startedAt: 1_700_000_000_000,
          lastSeq: 0,
          background: true,
          canInterrupt: false,
          tasks: [
            { taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'one agent that waits', workflowName: 'probe', startedAt: 1_700_000_000_000 },
            { taskId: 'b1', toolUseId: 'toolu_inner', taskType: 'local_bash', description: 'Sleep for 60 seconds', startedAt: 1_700_000_001_000, nested: true },
          ],
        }],
      },
    }),
  });

  const { SessionProtectionProvider, useProcessingSessions } = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, null, children);
  const { result } = renderHook(() => useProcessingSessions(), { wrapper });

  await waitFor(() => assert.ok(result.current.get('held-session')));
  const activity = result.current.get('held-session');
  assert.equal(activity?.background, true);
  assert.deepEqual(activity?.tasks?.map((task) => [task.taskId, task.nested ?? false]), [['w1', false], ['b1', true]]);
});

test('one task entry in a shape the client does not read hides only itself', async () => {
  // A newer server may list a task kind this client never learned; the
  // session's other work must still show.
  runningSessions.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        sessions: [{
          sessionId: 'held-session',
          provider: 'claude',
          startedAt: 1_700_000_000_000,
          lastSeq: 0,
          background: true,
          canInterrupt: false,
          tasks: [
            { taskId: 'w1', toolUseId: 'toolu_wf', taskType: 'local_workflow', description: 'one agent that waits', startedAt: 1_700_000_000_000 },
            { taskId: 'x1', toolUseId: 'toolu_x', taskType: 'remote_agent', description: 'Unreadable', startedAt: 'yesterday' },
          ],
        }],
      },
    }),
  });

  const { SessionProtectionProvider, useProcessingSessions } = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, null, children);
  const { result } = renderHook(() => useProcessingSessions(), { wrapper });

  await waitFor(() => assert.ok(result.current.get('held-session')));
  assert.deepEqual(result.current.get('held-session')?.tasks?.map((task) => task.taskId), ['w1']);
});

//----------------- LIVENESS WITHOUT A RELOAD ------------
// The owner's 2026-11-24 report: a secretary's process had exited, yet its row
// looked active until the page was reloaded. These drive the poll by `focus` and
// `visibilitychange` rather than waiting out its five seconds.

const payload = (data: Record<string, unknown>) => ({ ok: true, json: async () => ({ data }) });

const renderLiveness = async () => {
  const context = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(context.SessionProtectionProvider, null, children);
  return renderHook(() => ({
    busy: context.useBusySessionIdSet(),
    idleProcess: context.useIdleProcessSessionIdSet(),
    actions: context.useSessionProtectionActions(),
  }), { wrapper });
};

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
};

test('a process that exits leaves the idle-process set on the next poll, with no reload', async () => {
  runningSessions.mockResolvedValue(payload({ sessions: [], idleProcessSessionIds: ['worker'], includesExternalActivity: true }));
  const { result } = await renderLiveness();
  await waitFor(() => assert.equal(result.current.idleProcess.has('worker'), true));

  runningSessions.mockResolvedValue(payload({ sessions: [], idleProcessSessionIds: [], includesExternalActivity: true }));
  window.dispatchEvent(new Event('focus'));
  await waitFor(() => assert.equal(result.current.idleProcess.has('worker'), false));
});

test('a secretary whose idle broadcast was missed stops spinning once the poll stops listing it', async () => {
  runningSessions.mockResolvedValue(payload({
    sessions: [{ sessionId: 'secretary', startedAt: 1_000, canInterrupt: false, external: true }],
    idleProcessSessionIds: [],
    includesExternalActivity: true,
  }));
  const { result } = await renderLiveness();
  await waitFor(() => assert.equal(result.current.busy.has('secretary'), true));

  runningSessions.mockResolvedValue(payload({ sessions: [], idleProcessSessionIds: [], includesExternalActivity: true }));
  window.dispatchEvent(new Event('focus'));
  await waitFor(() => assert.equal(result.current.busy.has('secretary'), false));
});

test('an older server that never lists external activity cannot end it', async () => {
  runningSessions.mockResolvedValue(payload({ sessions: [] }));
  const { result } = await renderLiveness();
  await waitFor(() => assert.equal(runningSessions.mock.calls.length > 0, true));

  result.current.actions.markSessionProcessing('secretary', { external: true, startedAt: 1_000 });
  await waitFor(() => assert.equal(result.current.busy.has('secretary'), true));
  const callsBefore = runningSessions.mock.calls.length;
  window.dispatchEvent(new Event('focus'));
  await waitFor(() => assert.equal(runningSessions.mock.calls.length > callsBefore, true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(result.current.busy.has('secretary'), true);
});

test('a hidden page does not poll, and reads at once when shown again', async () => {
  setVisibility('hidden');
  try {
    runningSessions.mockResolvedValue(payload({ sessions: [], idleProcessSessionIds: ['worker'], includesExternalActivity: true }));
    const { result } = await renderLiveness();
    window.dispatchEvent(new Event('focus'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runningSessions.mock.calls.length, 0);

    setVisibility('visible');
    await waitFor(() => assert.equal(result.current.idleProcess.has('worker'), true));
  } finally {
    setVisibility('visible');
  }
});

test('the poll carries the deathwatch verdicts by session, skipping entries it cannot read', async () => {
  runningSessions.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: {
        sessions: [],
        workerStates: [
          { sessionId: 'dead', state: 'died', cause: 'OOM-killed 11:10', since: 1_795_000_000_000, lastActivity: null, instance: 'dk-ai-0', worker: 'w' },
          { sessionId: 'slow', state: 'stalled', cause: '', since: null, lastActivity: 1_795_000_000_000, worker: 'v' },
          { sessionId: 'weird', state: 'exploded' },
          { state: 'died' },
        ],
      },
    }),
  });

  const { SessionProtectionProvider, useWorkerStateMap } = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, null, children);
  const { result } = renderHook(() => useWorkerStateMap(), { wrapper });

  await waitFor(() => assert.equal(result.current.size, 2));
  assert.deepEqual(result.current.get('dead'), {
    sessionId: 'dead', state: 'died', cause: 'OOM-killed 11:10', since: 1_795_000_000_000, lastActivity: null, worker: 'w',
  });
  assert.equal(result.current.get('slow')?.state, 'stalled');
  assert.equal(result.current.has('weird'), false);
});

test('an older server with no deathwatch field means no worker badges', async () => {
  runningSessions.mockResolvedValue({ ok: true, json: async () => ({ data: { sessions: [] } }) });

  const { SessionProtectionProvider, useWorkerStateMap } = await import('@/shared/context/SessionProtectionContext');
  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(SessionProtectionProvider, null, children);
  const { result } = renderHook(() => useWorkerStateMap(), { wrapper });

  await waitFor(() => assert.equal(runningSessions.mock.calls.length > 0, true));
  assert.equal(result.current.size, 0);
});
