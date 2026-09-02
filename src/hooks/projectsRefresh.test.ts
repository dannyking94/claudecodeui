import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProjectsRefreshCoalescer,
  shouldRefreshProjectsAfterWebSocketEvent,
  type RefreshScheduler,
} from './projectsRefresh';

test('requests project catch-up only for the synthetic reconnect event', () => {
  assert.equal(shouldRefreshProjectsAfterWebSocketEvent('websocket_reconnected'), true);
  assert.equal(shouldRefreshProjectsAfterWebSocketEvent('session_upserted'), false);
  assert.equal(shouldRefreshProjectsAfterWebSocketEvent(undefined), false);
});

test('coalesces reconnect and tab-wake refresh requests', () => {
  let refreshCount = 0;
  let nextHandle = 0;
  const callbacks = new Map<number, () => void>();
  const schedule: RefreshScheduler = (callback) => {
    nextHandle += 1;
    callbacks.set(nextHandle, callback);
    return nextHandle as unknown as ReturnType<typeof setTimeout>;
  };
  const cancel = (handle: ReturnType<typeof setTimeout>) => {
    callbacks.delete(handle as unknown as number);
  };
  const coalescer = createProjectsRefreshCoalescer(
    () => { refreshCount += 1; },
    250,
    schedule,
    cancel,
  );

  coalescer.request(); // websocket_reconnected
  coalescer.request(); // online
  coalescer.request(); // visibilitychange → visible

  assert.equal(callbacks.size, 1);
  callbacks.values().next().value?.();
  assert.equal(refreshCount, 1);
});

test('cancels a pending refresh when disposed', () => {
  let refreshCount = 0;
  const callbacks = new Map<number, () => void>();
  const schedule: RefreshScheduler = (callback) => {
    callbacks.set(1, callback);
    return 1 as unknown as ReturnType<typeof setTimeout>;
  };
  const coalescer = createProjectsRefreshCoalescer(
    () => { refreshCount += 1; },
    250,
    schedule,
    (handle) => { callbacks.delete(handle as unknown as number); },
  );

  coalescer.request();
  coalescer.dispose();

  assert.equal(callbacks.size, 0);
  assert.equal(refreshCount, 0);
});
