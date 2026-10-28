import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The runtime's import chain opens the database at module load (auth reads its
// JWT secret then). Point it at a scratch file BEFORE importing, so the suite
// can never open a developer's real auth.db through an inherited DATABASE_PATH.
const scratchDatabaseDir = mkdtempSync(path.join(os.tmpdir(), 'runtime-hold-db-'));
const previousDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(scratchDatabaseDir, 'auth.db');

const { claudeAgentPool } = await import('@/modules/providers/list/claude/claude-agent-pool.provider.js');
const { overrideClaudeRuntimeDependencies, queryClaudeSDK } = await import(
  '@/modules/providers/list/claude/claude-runtime.provider.js'
);

test.after(() => {
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  rmSync(scratchDatabaseDir, { recursive: true, force: true });
});

const APP_SESSION_ID = 'app-session-hold';
const PROVIDER_SESSION_ID = 'db2bae93-fe31-4ac3-b616-875f97c5ec69';

function createWriter() {
  return {
    isWebSocketWriter: true,
    sent: [],
    send(frame) {
      this.sent.push(frame);
    },
  };
}

function createContext() {
  return {
    resolveProviderSessionId: () => PROVIDER_SESSION_ID,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
}

/**
 * A query that answers each pushed turn with one result frame, which is all
 * the pool needs to call a turn finished.
 */
function createAnsweringQuery(spawns) {
  return ({ prompt, options }) => {
    spawns.push(options);
    const frames = [];
    let wake = null;
    let closed = false;
    (async () => {
      for await (const _message of prompt) {
        frames.push({ type: 'system', subtype: 'init', session_id: PROVIDER_SESSION_ID });
        frames.push({ type: 'result', subtype: 'success', session_id: PROVIDER_SESSION_ID });
        wake?.();
      }
    })();
    return {
      async interrupt() {},
      async setModel() {},
      async setPermissionMode() {},
      close() {
        closed = true;
        wake?.();
      },
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          if (frames.length > 0) {
            yield frames.shift();
            continue;
          }
          await new Promise((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      },
    };
  };
}

let restoreDependencies = () => {};
let previousHome;
let scratchHome;

test.beforeEach(async () => {
  // loadMcpConfig reads ~/.claude.json; keep it off the developer's real home.
  previousHome = process.env.HOME;
  scratchHome = await mkdtemp(path.join(os.tmpdir(), 'runtime-hold-home-'));
  process.env.HOME = scratchHome;
});

test.afterEach(async () => {
  restoreDependencies();
  claudeAgentPool.closeAll();
  process.env.HOME = previousHome;
  await rm(scratchHome, { recursive: true, force: true });
});

test('a session held elsewhere spawns nothing and tells the row why', async () => {
  const spawns = [];
  const checked = [];
  restoreDependencies = overrideClaudeRuntimeDependencies({
    createQuery: createAnsweringQuery(spawns),
    findSessionHolder: async (providerSessionId) => {
      checked.push(providerSessionId);
      return { pid: 503742, tmuxSession: 'dk-ai-0', registryName: null, inbox: null };
    },
    deliverToSecretaryInbox: async () => assert.fail('a non-secretary holder must not be sent to any inbox'),
  });
  const writer = createWriter();

  await queryClaudeSDK('hello', { sessionId: APP_SESSION_ID }, writer, createContext());

  assert.deepEqual(checked, [PROVIDER_SESSION_ID]);
  assert.equal(spawns.length, 0, 'no claude process was started');
  assert.equal(claudeAgentPool.get(APP_SESSION_ID), undefined, 'the pool gained no agent');

  const [error, complete] = writer.sent;
  assert.equal(error.kind, 'error');
  assert.equal(error.errorCode, 'session_held_elsewhere');
  assert.equal(error.sessionId, APP_SESSION_ID);
  assert.match(error.content, /running elsewhere \(pid 503742, tmux session dk-ai-0\)/);
  assert.equal(complete.kind, 'complete');
  assert.equal(complete.exitCode, 1);
  assert.equal(writer.sent.length, 2);
});

test('a session held elsewhere is refused even when this server already pools an agent for it', async () => {
  const spawns = [];
  let held = false;
  restoreDependencies = overrideClaudeRuntimeDependencies({
    createQuery: createAnsweringQuery(spawns),
    findSessionHolder: async () => (held ? { pid: 9, tmuxSession: null, registryName: null, inbox: null } : null),
  });

  await queryClaudeSDK('first', { sessionId: APP_SESSION_ID }, createWriter(), createContext());
  const pooled = claudeAgentPool.get(APP_SESSION_ID);
  assert.ok(pooled);

  held = true;
  const writer = createWriter();
  await queryClaudeSDK('second', { sessionId: APP_SESSION_ID }, writer, createContext());

  assert.equal(spawns.length, 1);
  assert.equal(writer.sent[0].errorCode, 'session_held_elsewhere');
  assert.equal(claudeAgentPool.get(APP_SESSION_ID), pooled, 'the pool is unchanged');
});

test('a free session still resumes through the pool', async () => {
  const spawns = [];
  restoreDependencies = overrideClaudeRuntimeDependencies({
    createQuery: createAnsweringQuery(spawns),
    findSessionHolder: async () => null,
  });
  const writer = createWriter();

  await queryClaudeSDK('hello', { sessionId: APP_SESSION_ID }, writer, createContext());

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].resume, PROVIDER_SESSION_ID);
  assert.ok(claudeAgentPool.get(APP_SESSION_ID));
  assert.equal(writer.sent.some((frame) => frame.kind === 'error'), false);
  assert.equal(writer.sent.at(-1).kind, 'complete');
  assert.equal(writer.sent.at(-1).exitCode, 0);
});

/**
 * A stand-in for the cc-chat bridge's local inbox: records every request line
 * and answers each with `answer(request)`.
 */
async function startFakeInbox(answer) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inbox-'));
  const socketPath = path.join(directory, 'local-inbox.sock');
  const received = [];
  const server = net.createServer((socket) => {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        received.push(request);
        socket.write(`${JSON.stringify(answer(request))}\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    received,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function registeredSecretary(inbox) {
  return { pid: 503742, tmuxSession: 'dk-ai-0', registryName: 'dk-ai-0', inbox };
}

test('a message for a registered secretary is delivered to its inbox and spawns nothing', async () => {
  const inbox = await startFakeInbox(() => ({ ok: true, id: 'm-1', room: 'local/owner' }));
  const spawns = [];
  restoreDependencies = overrideClaudeRuntimeDependencies({
    createQuery: createAnsweringQuery(spawns),
    findSessionHolder: async () => registeredSecretary(inbox.socketPath),
  });
  const writer = createWriter();
  try {
    await queryClaudeSDK('  do X  ', { sessionId: APP_SESSION_ID }, writer, createContext());
  } finally {
    await inbox.close();
  }

  assert.equal(spawns.length, 0, 'no claude process was started');
  assert.equal(claudeAgentPool.get(APP_SESSION_ID), undefined, 'the pool gained no agent');
  assert.equal(inbox.received.length, 1, 'exactly one inbox message');
  const [request] = inbox.received;
  assert.equal(request.source, 'cloudcli');
  assert.equal(request.author, 'owner');
  assert.equal(request.text, 'do X');
  assert.equal(typeof request.ts, 'number');

  const [notice, complete] = writer.sent;
  assert.equal(writer.sent.length, 2);
  assert.equal(notice.kind, 'task_notification');
  assert.equal(notice.status, 'completed');
  assert.equal(notice.sessionId, APP_SESSION_ID);
  assert.match(notice.summary, /^Delivered to the dk-ai-0 secretary/);
  assert.equal(complete.kind, 'complete');
  assert.equal(complete.exitCode, 0);
  assert.equal(writer.sent.some((frame) => frame.kind === 'error'), false);
});

test('a registered secretary whose inbox socket is missing keeps the refusal, with the reason', async () => {
  const spawns = [];
  restoreDependencies = overrideClaudeRuntimeDependencies({
    createQuery: createAnsweringQuery(spawns),
    findSessionHolder: async () => registeredSecretary(path.join(scratchHome, 'no-such.sock')),
  });
  const writer = createWriter();

  await queryClaudeSDK('do X', { sessionId: APP_SESSION_ID }, writer, createContext());

  assert.equal(spawns.length, 0);
  const [error, complete] = writer.sent;
  assert.equal(error.errorCode, 'session_held_elsewhere');
  assert.match(error.content, /^Could not deliver to the dk-ai-0 secretary's inbox: the inbox socket is unreachable \(ENOENT\)/);
  assert.match(error.content, /send it via Discord DM instead/);
  assert.equal(complete.exitCode, 1);
});

test('a registered secretary whose inbox answers an error keeps the refusal, with the reason', async () => {
  const inbox = await startFakeInbox(() => ({ ok: false, error: 'queue full' }));
  const spawns = [];
  restoreDependencies = overrideClaudeRuntimeDependencies({
    createQuery: createAnsweringQuery(spawns),
    findSessionHolder: async () => registeredSecretary(inbox.socketPath),
  });
  const writer = createWriter();
  try {
    await queryClaudeSDK('do X', { sessionId: APP_SESSION_ID }, writer, createContext());
  } finally {
    await inbox.close();
  }

  assert.equal(spawns.length, 0);
  assert.equal(inbox.received.length, 1);
  const [error, complete] = writer.sent;
  assert.equal(error.errorCode, 'session_held_elsewhere');
  assert.match(error.content, /inbox refused it \(queue full\)/);
  assert.match(error.content, /Discord DM/);
  assert.equal(complete.exitCode, 1);
});

test('a registered secretary with no inbox in the registry keeps the refusal', async () => {
  const spawns = [];
  restoreDependencies = overrideClaudeRuntimeDependencies({
    createQuery: createAnsweringQuery(spawns),
    findSessionHolder: async () => registeredSecretary(null),
    deliverToSecretaryInbox: async () => assert.fail('no inbox to deliver to'),
  });
  const writer = createWriter();

  await queryClaudeSDK('do X', { sessionId: APP_SESSION_ID }, writer, createContext());

  assert.equal(spawns.length, 0);
  assert.match(writer.sent[0].content, /publishes no inbox socket/);
  assert.equal(writer.sent[1].exitCode, 1);
});

test('an inbox that never answers times out into the refusal', async () => {
  const { deliverToSecretaryInbox } = await import(
    '@/modules/providers/list/claude/claude-secretary-inbox.provider.js'
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inbox-'));
  const socketPath = path.join(directory, 'silent.sock');
  const sockets = [];
  const server = net.createServer((socket) => sockets.push(socket));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const result = await deliverToSecretaryInbox(socketPath, 'hello', 100);
    assert.deepEqual(result, { ok: false, reason: 'the inbox did not answer within 100 ms' });
  } finally {
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
