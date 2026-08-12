import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import {
  getRetainedSampleCountForTests,
  resetSystemStatsForTests,
  startSystemStatsCollection,
  stopSystemStatsCollectionIfIdle,
  subscribeToSystemStats,
  unsubscribeFromSystemStats,
} from '../system-stats.service.js';

const WS_OPEN_STATE = 1;

type FakeClient = {
  readyState: number;
  send(data: string): void;
  frames: string[];
};

function createClient(readyState = WS_OPEN_STATE): FakeClient {
  const frames: string[] = [];
  return {
    readyState,
    frames,
    send(data: string) {
      frames.push(data);
    },
  };
}

/** Lets the 1 Hz poller's first (immediate) tick and its nvidia-smi probe finish. */
function waitForFirstSample(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300));
}

afterEach(() => {
  resetSystemStatsForTests();
});

test('platform deployments report telemetry as disabled and never sample', async () => {
  const client = createClient();

  subscribeToSystemStats(client, { isPlatform: true });
  await waitForFirstSample();

  assert.equal(client.frames.length, 1);
  const frame = JSON.parse(client.frames[0]);
  assert.equal(frame.kind, 'system_stats');
  assert.equal(frame.disabled, true);
  assert.deepEqual(frame.samples, []);
});

test('a subscriber receives samples and unsubscribing stops them', async () => {
  const client = createClient();

  subscribeToSystemStats(client, { isPlatform: false });
  await waitForFirstSample();

  assert.ok(client.frames.length >= 1, 'expected at least one sample frame');
  const frame = JSON.parse(client.frames[0]);
  assert.equal(frame.kind, 'system_stats');
  assert.equal(frame.samples.length, 1);
  assert.equal(typeof frame.samples[0].timestamp, 'number');
  assert.equal(typeof frame.samples[0].cpuUtilization, 'number');
  assert.ok(frame.samples[0].memoryTotalBytes > 0);

  unsubscribeFromSystemStats(client);
  const framesAtUnsubscribe = client.frames.length;

  await waitForFirstSample();
  assert.equal(client.frames.length, framesAtUnsubscribe, 'no frames after unsubscribe');
});

test('collection keeps running after unsubscribe so the next open has a full window', async () => {
  const client = createClient();

  startSystemStatsCollection({ isPlatform: false });
  subscribeToSystemStats(client, { isPlatform: false });
  await waitForFirstSample();
  unsubscribeFromSystemStats(client);

  // Samples taken while nothing was subscribed must still be retained.
  await new Promise((resolve) => setTimeout(resolve, 2_200));

  const reopened = createClient();
  subscribeToSystemStats(reopened, { isPlatform: false });

  assert.ok(reopened.frames.length >= 1, 'expected a backlog frame on resubscribe');
  const backlog = JSON.parse(reopened.frames[0]);
  assert.ok(
    backlog.samples.length > 1,
    `expected retained history, got ${backlog.samples.length} sample(s)`,
  );
});

test('collection stops once the last client disconnects', async () => {
  const client = createClient();

  startSystemStatsCollection({ isPlatform: false });
  subscribeToSystemStats(client, { isPlatform: false });
  await waitForFirstSample();

  unsubscribeFromSystemStats(client);
  stopSystemStatsCollectionIfIdle(0);

  // Read the buffer directly: resubscribing would restart collection and mask
  // whether it had actually stopped.
  const atStop = getRetainedSampleCountForTests();
  await new Promise((resolve) => setTimeout(resolve, 2_200));

  assert.equal(
    getRetainedSampleCountForTests(),
    atStop,
    'no samples should be collected while nothing is connected',
  );
});

test('collection does not start in platform mode', async () => {
  startSystemStatsCollection({ isPlatform: true });
  await new Promise((resolve) => setTimeout(resolve, 1_200));

  assert.equal(getRetainedSampleCountForTests(), 0, 'expected no samples in platform mode');
});

test('a socket that closed without unsubscribing is dropped on the next broadcast', async () => {
  const closing = createClient();
  const open = createClient();

  subscribeToSystemStats(closing, { isPlatform: false });
  subscribeToSystemStats(open, { isPlatform: false });
  await waitForFirstSample();

  const framesAtClose = closing.frames.length;
  closing.readyState = 3; // CLOSED

  await waitForFirstSample();

  assert.equal(closing.frames.length, framesAtClose, 'closed socket receives nothing further');
  assert.ok(open.frames.length > framesAtClose - 1, 'open socket keeps receiving');
});

test('unsubscribing a client that never subscribed is a no-op', () => {
  assert.doesNotThrow(() => unsubscribeFromSystemStats(createClient()));
});
