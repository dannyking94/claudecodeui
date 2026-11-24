import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCodexCliLivenessScanner } from '@/modules/providers/services/codex-cli-liveness.service.js';

const THREAD_A = '01a20c30-d436-7f50-9c0b-6973e5cb0682';
const THREAD_B = '019aa001-0000-7000-8000-00000000000b';

type FakeProcess = { pid: number; comm: string; argv: string[]; startTicks?: number; rollouts?: string[] };

/** A fake procfs: `<root>/stat` with btime, and per pid stat, cmdline and fd symlinks. */
async function makeProc(processes: FakeProcess[]): Promise<{ root: string; add: (p: FakeProcess) => Promise<void>; remove: (pid: number) => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fake-proc-'));
  await writeFile(path.join(root, 'stat'), 'cpu 1 2 3\nbtime 1700000000\nprocesses 9\n');
  const add = async ({ pid, comm, argv, startTicks = 500, rollouts = [] }: FakeProcess) => {
    const dir = path.join(root, String(pid));
    await mkdir(path.join(dir, 'fd'), { recursive: true });
    // Fields after comm: state(3) ... starttime is the 20th.
    const rest = ['S', ...Array.from({ length: 18 }, () => '0'), String(startTicks), '0', '0'];
    await writeFile(path.join(dir, 'stat'), `${pid} (${comm}) ${rest.join(' ')}\n`);
    await writeFile(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
    await symlink('/dev/null', path.join(dir, 'fd', '0'));
    let fd = 3;
    for (const thread of rollouts) {
      await symlink(`/home/u/.codex/sessions/2026/11/24/rollout-2026-11-24T15-14-16-${thread}.jsonl`, path.join(dir, 'fd', String(fd++)));
    }
    await symlink('/home/u/.codex/state_5.sqlite', path.join(dir, 'fd', String(fd)));
  };
  for (const p of processes) await add(p);
  return { root, add, remove: (pid) => rm(path.join(root, String(pid)), { recursive: true, force: true }) };
}

test('a codex exec process is a busy live thread, the TUI an idle one; servers and others are ignored', async () => {
  const proc = await makeProc([
    { pid: 100, comm: 'codex', argv: ['/x/codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '-C', '/w', 'a prompt mentioning exec'], rollouts: [THREAD_A] },
    { pid: 101, comm: 'codex', argv: ['codex', 'resume', THREAD_B], rollouts: [THREAD_B] },
    { pid: 102, comm: 'codex', argv: ['codex', 'app-server'], rollouts: ['019aa001-0000-7000-8000-0000000000cc'] },
    { pid: 103, comm: 'node', argv: ['node', '/x/bin/codex.js', 'exec'], rollouts: ['019aa001-0000-7000-8000-0000000000dd'] },
    { pid: 104, comm: 'bash', argv: ['bash'] },
  ]);
  try {
    const scanner = createCodexCliLivenessScanner({ procRoot: proc.root, platform: 'linux', now: () => 0 });
    const live = (await scanner.listLiveSessions()).sort((a, b) => a.providerSessionId.localeCompare(b.providerSessionId));
    assert.deepEqual(live, [
      { providerSessionId: THREAD_B, startedAt: 1_700_000_005_000, isBusy: false },
      { providerSessionId: THREAD_A, startedAt: 1_700_000_005_000, isBusy: true },
    ].sort((a, b) => a.providerSessionId.localeCompare(b.providerSessionId)));
  } finally {
    await rm(proc.root, { recursive: true, force: true });
  }
});

test('an exited codex is no longer live; scans within the interval are shared', async () => {
  const proc = await makeProc([{ pid: 200, comm: 'codex', argv: ['codex', 'exec', 'go'], rollouts: [THREAD_A] }]);
  try {
    let now = 10_000;
    const scanner = createCodexCliLivenessScanner({ procRoot: proc.root, platform: 'linux', now: () => now });
    assert.deepEqual((await scanner.listLiveSessions()).map((s) => s.providerSessionId), [THREAD_A]);

    await proc.remove(200);
    now += 500; // within the shared window: the cached scan is served
    assert.equal((await scanner.listLiveSessions()).length, 1);
    now += 5_000;
    assert.deepEqual(await scanner.listLiveSessions(), []);
  } finally {
    await rm(proc.root, { recursive: true, force: true });
  }
});

test('a codex that has not opened its rollout yet is looked at again on the next scan', async () => {
  const proc = await makeProc([{ pid: 300, comm: 'codex', argv: ['codex', 'exec', 'go'] }]);
  try {
    let now = 0;
    const scanner = createCodexCliLivenessScanner({ procRoot: proc.root, platform: 'linux', now: () => now });
    assert.deepEqual(await scanner.listLiveSessions(), []);
    await symlink(`/h/.codex/sessions/2026/11/24/rollout-2026-11-24T00-00-00-${THREAD_A}.jsonl`, path.join(proc.root, '300', 'fd', '9'));
    now += 5_000;
    assert.deepEqual((await scanner.listLiveSessions()).map((s) => s.providerSessionId), [THREAD_A]);
  } finally {
    await rm(proc.root, { recursive: true, force: true });
  }
});

test('a pid that execs into codex after a not-codex reading is found once the recheck window passes', async () => {
  const proc = await makeProc([{ pid: 400, comm: 'bwrap', argv: ['/usr/bin/bwrap', '--', 'codex', 'exec'] }]);
  try {
    let now = 0;
    const scanner = createCodexCliLivenessScanner({ procRoot: proc.root, platform: 'linux', now: () => now });
    assert.deepEqual(await scanner.listLiveSessions(), []);
    await proc.remove(400);
    await proc.add({ pid: 400, comm: 'codex', argv: ['codex', 'exec', 'go'], rollouts: [THREAD_A] });
    now += 5_000;
    assert.deepEqual(await scanner.listLiveSessions(), [], 'a known not-codex pid is not re-read every poll');
    now += 30_000;
    assert.deepEqual((await scanner.listLiveSessions()).map((s) => s.providerSessionId), [THREAD_A]);
  } finally {
    await rm(proc.root, { recursive: true, force: true });
  }
});

test('nothing is reported off Linux', async () => {
  const scanner = createCodexCliLivenessScanner({ procRoot: '/nonexistent', platform: 'darwin' });
  assert.deepEqual(await scanner.listLiveSessions(), []);
});
