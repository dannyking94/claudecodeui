import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resetRemoteStatsForTests } from '../remote-stats.service.js';
import {
  resetSystemStatsForTests,
  stopSystemStatsCollectionIfIdle,
  subscribeToSystemStats,
  unsubscribeFromSystemStats,
} from '../system-stats.service.js';
import type { SystemStatsSample } from '../system-stats.service.js';

const GPU_ROW = '0, Test GPU, 8, 1985, 16303, 52, 43.64, 360.00';
const REMOTE_OUTPUT = `${GPU_ROW}\n@@cloudcli-cpu@@\ncpu 100 0 50 850 0 0 0 0 0 0\n@@cloudcli-mem@@\nMemTotal: 1024 kB\nMemFree: 512 kB`;

type Frame = { gpuAvailable: boolean; samples: SystemStatsSample[] };

// Real subprocesses exercise spawn errors, exit codes and timeouts without a GPU
// or SSH access. Only the polling interval and retry clock are advanced manually.
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cloudcli-gpu-test-'));
  const originalPath = process.env.PATH;
  const originalHosts = process.env.CLOUDCLI_REMOTE_HOSTS;
  process.env.PATH = `${directory}:${originalPath}`;
  process.env.CLOUDCLI_REMOTE_HOSTS = 'GPU Node 1=fake-one,GPU Node 2=fake-two';
  resetSystemStatsForTests();
  resetRemoteStatsForTests();
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 100_000 });
  t.after(async () => {
    resetSystemStatsForTests();
    resetRemoteStatsForTests();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHosts === undefined) delete process.env.CLOUDCLI_REMOTE_HOSTS;
    else process.env.CLOUDCLI_REMOTE_HOSTS = originalHosts;
    await rm(directory, { recursive: true, force: true });
  });
  const command = (name: string, body: string) => writeFile(
    path.join(directory, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 },
  );
  const remoteHealthy = () => command('ssh', `printf '%s\\n' '${REMOTE_OUTPUT}'`);
  await remoteHealthy();
  const healthy = () => command('nvidia-smi', `printf '%s\\n' '${GPU_ROW}'`);
  const frames: Frame[] = [];
  const client = { readyState: 1, send: (data: string) => frames.push(JSON.parse(data) as Frame) };
  async function nextSample(advance = 1_000) {
    const count = frames.length;
    t.mock.timers.tick(advance);
    for (let attempt = 0; attempt < 300 && frames.length === count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(frames.length > count, 'sampler should publish even when GPU queries fail');
    return frames.at(-1)!;
  }
  return { command, healthy, remoteHealthy, client, nextSample };
}

for (const failure of ['exit 1', "printf ''", 'exec sleep 10']) {
  test(`GPU detection recovers after an initial failed probe: ${failure}`, async (t) => {
    const f = await fixture(t);
    await f.command('nvidia-smi', failure);
    subscribeToSystemStats(f.client, { isPlatform: false });
    const failed = await f.nextSample();
    assert.equal(failed.gpuAvailable, false);
    await f.healthy();
    assert.equal((await f.nextSample()).gpuAvailable, false, 'detection retries are throttled');
    const recovered = await f.nextSample(29_000);
    assert.equal(recovered.gpuAvailable, true);
    assert.equal(recovered.samples[0].gpus[0]?.name, 'Test GPU');
  });
}

test('a later failed query recovers and never republishes old GPU readings as current', async (t) => {
  const f = await fixture(t);
  await f.healthy();
  subscribeToSystemStats(f.client, { isPlatform: false });
  assert.equal((await f.nextSample()).samples[0].gpus.length, 1);
  await f.command('nvidia-smi', 'exit 1');
  const failed = await f.nextSample();
  assert.equal(failed.gpuAvailable, true);
  assert.deepEqual(failed.samples[0].gpus, []);
  await f.healthy();
  assert.equal((await f.nextSample()).samples[0].gpus.length, 1);
});

test('a new subscription restarts local and both remote GPU collectors after idle', async (t) => {
  const f = await fixture(t);
  await f.healthy();
  subscribeToSystemStats(f.client, { isPlatform: false });
  await f.nextSample();
  const before = await f.nextSample();
  assert.deepEqual(before.samples[0].remotes.map((host) => host.gpus.length), [1, 1]);
  unsubscribeFromSystemStats(f.client);
  stopSystemStatsCollectionIfIdle(0);
  t.mock.timers.tick(61_000);
  subscribeToSystemStats(f.client, { isPlatform: false });
  await f.nextSample();
  const after = await f.nextSample();
  assert.equal(after.samples[0].gpus.length, 1);
  assert.deepEqual(after.samples[0].remotes.map((host) => host.gpus.length), [1, 1]);
  assert.ok(after.samples[0].remotes[0].timestamp > before.samples[0].remotes[0].timestamp);
});

test('both remote hosts recover after SSH failures while local GPU sampling continues', async (t) => {
  const f = await fixture(t);
  await f.healthy();
  subscribeToSystemStats(f.client, { isPlatform: false });
  await f.nextSample();
  await f.nextSample();
  await f.command('ssh', 'exit 1');
  await f.nextSample();
  const offline = await f.nextSample(6_000);
  assert.equal(offline.samples[0].gpus.length, 1);
  assert.deepEqual(offline.samples[0].remotes.map((host) => host.online), [false, false]);
  await f.remoteHealthy();
  await f.nextSample(30_000);
  const recovered = await f.nextSample();
  assert.deepEqual(recovered.samples[0].remotes.map((host) => host.gpus.length), [1, 1]);
});
