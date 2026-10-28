import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  describeClaudeSessionHold,
  findClaudeSessionHolder,
} from '@/modules/providers/list/claude/claude-session-hold.provider.js';

const HELD_ID = 'db2bae93-fe31-4ac3-b616-875f97c5ec69';
const SERVER_PID = 1000;

type FakeProcess = { pid: number; ppid: number; argv: string[] };

/**
 * Builds a throwaway `/proc` with just the two files the detector reads, plus
 * an optional registry, so each case states the machine it runs against.
 */
async function createHost(processes: FakeProcess[], registry?: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'session-hold-'));
  const procRoot = path.join(root, 'proc');
  await mkdir(procRoot);
  for (const { pid, ppid, argv } of processes) {
    const dir = path.join(procRoot, String(pid));
    await mkdir(dir);
    await writeFile(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
    // A comm with a space and a ')' is exactly what a naive split gets wrong.
    await writeFile(path.join(dir, 'stat'), `${pid} (weird) name) S ${ppid} 1 1 0 -1`);
  }
  const registryPath = path.join(root, 'registry.json');
  if (registry !== undefined) {
    await writeFile(registryPath, typeof registry === 'string' ? registry : JSON.stringify(registry));
  }

  return {
    find: (sessionId: string, panes = new Map<number, string>()) =>
      findClaudeSessionHolder(sessionId, {
        procRoot,
        registryPath,
        selfPid: SERVER_PID,
        listTmuxPanes: async () => panes,
      }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const SERVER = { pid: SERVER_PID, ppid: 1, argv: ['node', 'server/index.js'] };

test('a foreign claude attached with --session-id holds the session, named by its tmux pane', async () => {
  const host = await createHost([
    SERVER,
    { pid: 500, ppid: 1, argv: ['tmux', 'new-session', '-d', '-s', 'dk-ai-0'] },
    { pid: 503742, ppid: 500, argv: ['claude', '--session-id', HELD_ID, '--model', 'opus'] },
  ]);
  try {
    const holder = await host.find(HELD_ID, new Map([[503742, 'dk-ai-0']]));
    assert.deepEqual(holder, { pid: 503742, tmuxSession: 'dk-ai-0', registryName: null, inbox: null });
    assert.match(describeClaudeSessionHold(holder!), /running elsewhere \(pid 503742, tmux session dk-ai-0\)/);
    assert.match(describeClaudeSessionHold(holder!), /send it via Discord DM instead/);
  } finally {
    await host.cleanup();
  }
});

test('the --resume=<id> form and a full executable path are recognised', async () => {
  const host = await createHost([
    SERVER,
    { pid: 77, ppid: 1, argv: ['/home/u/.local/share/claude/versions/2.1.0', `--resume=${HELD_ID}`] },
  ]);
  try {
    assert.equal((await host.find(HELD_ID))?.pid, 77);
  } finally {
    await host.cleanup();
  }
});

test('a session id quoted inside argv is not an attachment', async () => {
  const host = await createHost([
    SERVER,
    // A worker whose task prompt names the secretary's id, including a
    // "--resume <id>" phrase — one argv element, not a flag and its value.
    { pid: 10, ppid: 1, argv: ['claude', '--session-id', 'other-id', `talk to ${HELD_ID} via --resume ${HELD_ID}`] },
    // A search that mentions the id.
    { pid: 11, ppid: 1, argv: ['ugrep', HELD_ID, '/home/u/.claude'] },
    // A tmux server keeps the argv it was launched with long after its claude exited.
    { pid: 12, ppid: 1, argv: ['tmux', 'new-session', '-d', 'claude', '--session-id', HELD_ID] },
  ]);
  try {
    assert.equal(await host.find(HELD_ID), null);
  } finally {
    await host.cleanup();
  }
});

test("this server's own SDK child is not a second writer, but a terminal claude it hosts is", async () => {
  const ownPoolChild = {
    pid: 20,
    ppid: SERVER_PID,
    argv: ['claude', '--output-format', 'stream-json', '--input-format', 'stream-json', '--resume', HELD_ID],
  };
  const pooledOnly = await createHost([SERVER, ownPoolChild]);
  try {
    assert.equal(await pooledOnly.find(HELD_ID), null);
  } finally {
    await pooledOnly.cleanup();
  }

  const withTerminal = await createHost([
    SERVER,
    { pid: 30, ppid: SERVER_PID, argv: ['bash', '-c', 'claude --resume x'] },
    { pid: 31, ppid: 30, argv: ['claude', '--resume', HELD_ID] },
  ]);
  try {
    assert.equal((await withTerminal.find(HELD_ID))?.pid, 31);
  } finally {
    await withTerminal.cleanup();
  }
});

test('another server\'s SDK child is foreign', async () => {
  const host = await createHost([
    SERVER,
    { pid: 40, ppid: 1, argv: ['claude', '--input-format', 'stream-json', '--resume', HELD_ID] },
  ]);
  try {
    assert.equal((await host.find(HELD_ID))?.pid, 40);
  } finally {
    await host.cleanup();
  }
});

test('a registered secretary is held even with no process attached', async () => {
  const host = await createHost([SERVER], {
    instances: { 'dk-ai-0': { session_id: HELD_ID }, 'dk-ai-1': { session_id: 'other' } },
  });
  try {
    const holder = await host.find(HELD_ID);
    assert.deepEqual(holder, { pid: null, tmuxSession: null, registryName: 'dk-ai-0', inbox: null });
    assert.match(describeClaudeSessionHold(holder!), /registered secretary dk-ai-0/);
    assert.equal(await host.find('unregistered-id'), null);
  } finally {
    await host.cleanup();
  }
});

test('a registered secretary reports its inbox socket, and an inbox failure leads the refusal', async () => {
  const host = await createHost([SERVER], {
    instances: { 'dk-ai-0': { session_id: HELD_ID, inbox: '/run/dk-ai-0/local-inbox.sock' } },
  });
  try {
    const holder = await host.find(HELD_ID);
    assert.equal(holder?.inbox, '/run/dk-ai-0/local-inbox.sock');
    assert.match(
      describeClaudeSessionHold(holder!, 'the inbox socket is unreachable (ENOENT)'),
      /^Could not deliver to the dk-ai-0 secretary's inbox: the inbox socket is unreachable \(ENOENT\)\. This session is running elsewhere.*Discord DM/,
    );
  } finally {
    await host.cleanup();
  }
});

test('a missing or malformed registry falls back to the process check', async () => {
  for (const registry of [undefined, '{ not json', { instances: 'nope' }]) {
    const host = await createHost([SERVER], registry);
    try {
      assert.equal(await host.find(HELD_ID), null);
    } finally {
      await host.cleanup();
    }
  }
});

test('a host without /proc reports nothing rather than throwing', async () => {
  const holder = await findClaudeSessionHolder(HELD_ID, {
    procRoot: path.join(os.tmpdir(), 'does-not-exist-session-hold'),
    registryPath: path.join(os.tmpdir(), 'does-not-exist-registry.json'),
    selfPid: SERVER_PID,
    listTmuxPanes: async () => new Map(),
  });
  assert.equal(holder, null);
});

test('with a terminal claude and another server\'s SDK copy both attached, the terminal one is reported', async () => {
  const host = await createHost([
    SERVER,
    { pid: 50, ppid: 1, argv: ['claude', '--input-format', 'stream-json', '--resume', HELD_ID] },
    { pid: 60, ppid: 1, argv: ['claude', '--session-id', HELD_ID] },
  ]);
  try {
    assert.equal((await host.find(HELD_ID))?.pid, 60);
  } finally {
    await host.cleanup();
  }
});
