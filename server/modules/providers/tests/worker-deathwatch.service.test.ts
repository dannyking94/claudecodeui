import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createWorkerDeathwatchReader } from '@/modules/providers/services/worker-deathwatch.service.js';

const GENERATED_EPOCH = 1_795_491_359;
const NOW = GENERATED_EPOCH * 1000 + 30_000;

const worker = (overrides: Record<string, unknown>) => ({
  name: 'w',
  session_id: 'sid',
  tmux: 'w0-w',
  engine: 'claude',
  state: 'working',
  cause: '',
  since: '2026-11-24 11:10:12',
  report: null,
  last_activity: '2026-11-24 11:09:00',
  mem_bytes: null,
  ...overrides,
});

const snapshot = (workers: unknown[], overrides: Record<string, unknown> = {}) => JSON.stringify({
  version: 1,
  instance: 'dk-ai-0',
  prefix: 'w0-',
  generated: '2026-11-24 12:35:59',
  generated_epoch: GENERATED_EPOCH,
  workers,
  ...overrides,
});

async function withFleet(
  instances: Record<string, string | null>,
  runTest: (context: { root: string; registryPath: string; snapshotPath: (name: string) => string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deathwatch-'));
  const registryPath = path.join(root, 'registry.json');
  const snapshotPath = (name: string) => path.join(root, name, 'states', 'deathwatch-state.json');
  const registry: Record<string, { cwd: string }> = {};
  for (const [name, content] of Object.entries(instances)) {
    registry[name] = { cwd: path.join(root, name) };
    await mkdir(path.join(root, name, 'states'), { recursive: true });
    if (content !== null) {
      await writeFile(snapshotPath(name), content, 'utf8');
    }
  }
  await writeFile(registryPath, JSON.stringify({ instances: registry }), 'utf8');
  try {
    await runTest({ root, registryPath, snapshotPath });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('keeps only died, stalled, reported and blackout workers with a session id', async () => {
  await withFleet({
    'dk-ai-0': snapshot([
      worker({ name: 'dead', session_id: 'sid-dead', state: 'died', cause: 'OOM-killed 11:10:01 — node (vitest 12), anon-rss 51.9 GB' }),
      worker({ name: 'busy', session_id: 'sid-busy', state: 'working' }),
      worker({ name: 'idle', session_id: 'sid-idle', state: 'done' }),
      worker({ name: 'slow', session_id: 'sid-slow', state: 'stalled', cause: 'no activity 34 min' }),
      worker({ name: 'sent', session_id: 'sid-sent', state: 'reported' }),
      worker({ name: 'dark', session_id: 'sid-dark', state: 'blackout' }),
      worker({ name: 'orphan', session_id: '', state: 'died' }),
      worker({ name: 'odd', session_id: 'sid-odd', state: 'exploded' }),
    ]),
  }, async ({ registryPath }) => {
    const reader = createWorkerDeathwatchReader({ registryPath: () => registryPath, now: () => NOW });
    const entries = await reader.listNotableWorkers();
    assert.deepEqual(entries.map((entry) => [entry.worker, entry.state]), [
      ['dead', 'died'], ['slow', 'stalled'], ['sent', 'reported'], ['dark', 'blackout'],
    ]);
    assert.deepEqual(entries[0], {
      providerSessionId: 'sid-dead',
      state: 'died',
      cause: 'OOM-killed 11:10:01 — node (vitest 12), anon-rss 51.9 GB',
      since: Date.parse('2026-11-24T11:10:12'),
      lastActivity: Date.parse('2026-11-24T11:09:00'),
      instance: 'dk-ai-0',
      worker: 'dead',
    });
  });
});

test('reads every registered instance, and a missing or corrupt snapshot contributes nothing', async () => {
  await withFleet({
    'dk-ai-0': snapshot([worker({ session_id: 'a', state: 'died' })]),
    'dk-ai-1': null,
    'dk-ai-2': '{"version": 1, "workers": [',
    'dk-ai-3': snapshot([worker({ session_id: 'b', state: 'stalled' })], { instance: 'dk-ai-3', version: 2 }),
    'dk-ai-4': snapshot([worker({ session_id: 'c', state: 'reported' })], { instance: 'dk-ai-4' }),
  }, async ({ registryPath }) => {
    const reader = createWorkerDeathwatchReader({ registryPath: () => registryPath, now: () => NOW });
    const entries = await reader.listNotableWorkers();
    assert.deepEqual(entries.map((entry) => [entry.instance, entry.providerSessionId]), [['dk-ai-0', 'a'], ['dk-ai-4', 'c']]);
  });
});

test('no registry, or a corrupt one, means no badges', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deathwatch-none-'));
  try {
    const missing = createWorkerDeathwatchReader({ registryPath: () => path.join(root, 'nope.json'), now: () => NOW });
    assert.deepEqual(await missing.listNotableWorkers(), []);
    await writeFile(path.join(root, 'bad.json'), 'not json', 'utf8');
    const corrupt = createWorkerDeathwatchReader({ registryPath: () => path.join(root, 'bad.json'), now: () => NOW });
    assert.deepEqual(await corrupt.listNotableWorkers(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a snapshot the timer stopped writing is ignored', async () => {
  await withFleet({ 'dk-ai-0': snapshot([worker({ state: 'stalled' })]) }, async ({ registryPath }) => {
    const reader = createWorkerDeathwatchReader({
      registryPath: () => registryPath,
      now: () => GENERATED_EPOCH * 1000 + 16 * 60_000,
    });
    assert.deepEqual(await reader.listNotableWorkers(), []);
  });
});

test('re-parses a snapshot only when it changes on disk', async () => {
  await withFleet({ 'dk-ai-0': snapshot([worker({ state: 'reported' })]) }, async ({ registryPath, snapshotPath }) => {
    let now = NOW;
    const reader = createWorkerDeathwatchReader({ registryPath: () => registryPath, now: () => now });
    assert.equal((await reader.listNotableWorkers())[0]?.state, 'reported');

    // Same mtime and size: served from memory, so a same-length rewrite the
    // writer never makes (it always replaces the file) goes unseen.
    const file = snapshotPath('dk-ai-0');
    const fixedTime = new Date(NOW - 5_000);
    await utimes(file, fixedTime, fixedTime);
    assert.equal((await reader.listNotableWorkers())[0]?.state, 'reported');
    await writeFile(file, snapshot([worker({ state: 'blackout' })]), 'utf8');
    await utimes(file, fixedTime, fixedTime);
    assert.equal((await reader.listNotableWorkers())[0]?.state, 'reported', 'cached while mtime and size match');

    // The ledger moved on: the worker left `stalled`, and a new mtime is read.
    await writeFile(file, snapshot([worker({ state: 'working' })]), 'utf8');
    now += 1;
    assert.deepEqual(await reader.listNotableWorkers(), []);
  });
});
