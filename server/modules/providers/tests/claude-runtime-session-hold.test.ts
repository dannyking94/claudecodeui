import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

// The runtime's import chain opens the database at module load (auth reads its
// JWT secret then). Point it at a scratch file BEFORE importing, so the suite
// can never open a developer's real auth.db through an inherited DATABASE_PATH.
const scratchDatabaseDir = mkdtempSync(path.join(os.tmpdir(), 'runtime-hold-db-'));
const previousDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(scratchDatabaseDir, 'auth.db');

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

type Frame = AnyRecord;

function createWriter() {
  const sent: Frame[] = [];
  return {
    isWebSocketWriter: true,
    userId: null,
    sent,
    send(frame: unknown) {
      sent.push(frame as Frame);
    },
  };
}

/**
 * A query that answers each message on its input with one result frame and
 * ends its stream when the runtime closes that input — which the runtime does
 * as soon as a turn with nothing outstanding has reported its result.
 */
function createAnsweringQuery(spawns: AnyRecord[]): NonNullable<ProviderRuntimeContext['createQuery']> {
  return ({ prompt, options }) => {
    spawns.push(options);
    const frames: AnyRecord[] = [];
    // Held on an object so the narrowing of a `let` does not hide the reassignment below.
    const waiter: { wake: (() => void) | null } = { wake: null };
    let closed = false;
    void (async () => {
      for await (const _message of prompt) {
        frames.push({ type: 'system', subtype: 'init', session_id: PROVIDER_SESSION_ID });
        frames.push({ type: 'result', subtype: 'success', session_id: PROVIDER_SESSION_ID });
        waiter.wake?.();
      }
      closed = true;
      waiter.wake?.();
    })();
    return {
      async interrupt() {},
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (frames.length > 0) {
            yield frames.shift();
            continue;
          }
          if (closed) {
            return;
          }
          await new Promise<void>((resolve) => {
            waiter.wake = resolve;
          });
          waiter.wake = null;
        }
      },
    };
  };
}

function createContext(spawns: AnyRecord[] = []): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => PROVIDER_SESSION_ID,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
    createQuery: createAnsweringQuery(spawns),
  } as unknown as ProviderRuntimeContext;
}

let restoreDependencies = () => {};
let previousHome: string | undefined;
let scratchHome = '';

test.beforeEach(async () => {
  // loadMcpConfig reads ~/.claude.json; keep it off the developer's real home.
  previousHome = process.env.HOME;
  scratchHome = await mkdtemp(path.join(os.tmpdir(), 'runtime-hold-home-'));
  process.env.HOME = scratchHome;
});

test.afterEach(async () => {
  restoreDependencies();
  restoreDependencies = () => {};
  process.env.HOME = previousHome;
  await rm(scratchHome, { recursive: true, force: true });
});

test('a session held elsewhere spawns nothing and tells the row why', async () => {
  const spawns: AnyRecord[] = [];
  const checked: string[] = [];
  restoreDependencies = overrideClaudeRuntimeDependencies({
    findSessionHolder: async (providerSessionId) => {
      checked.push(providerSessionId);
      return { pid: 503742, tmuxSession: 'dk-ai-0', registryName: null, inbox: null };
    },
    deliverToSecretaryInbox: async () => assert.fail('a non-secretary holder must not be sent to any inbox'),
  });
  const writer = createWriter();

  await queryClaudeSDK('hello', { sessionId: APP_SESSION_ID }, writer, createContext(spawns));

  assert.deepEqual(checked, [PROVIDER_SESSION_ID]);
  assert.equal(spawns.length, 0, 'no claude process was started');

  const [error, complete] = writer.sent;
  assert.equal(error.kind, 'error');
  assert.equal(error.errorCode, 'session_held_elsewhere');
  assert.equal(error.sessionId, APP_SESSION_ID);
  assert.match(error.content, /running elsewhere \(pid 503742, tmux session dk-ai-0\)/);
  assert.equal(complete.kind, 'complete');
  assert.equal(complete.exitCode, 1);
  assert.equal(writer.sent.length, 2);
});

test('a session that becomes held elsewhere is refused on its next turn', async () => {
  const spawns: AnyRecord[] = [];
  let held = false;
  restoreDependencies = overrideClaudeRuntimeDependencies({
    findSessionHolder: async () => (held ? { pid: 9, tmuxSession: null, registryName: null, inbox: null } : null),
  });

  await queryClaudeSDK('first', { sessionId: APP_SESSION_ID }, createWriter(), createContext(spawns));
  assert.equal(spawns.length, 1);

  held = true;
  const writer = createWriter();
  await queryClaudeSDK('second', { sessionId: APP_SESSION_ID }, writer, createContext(spawns));

  assert.equal(spawns.length, 1, 'the refused turn started no second process');
  assert.equal(writer.sent[0].errorCode, 'session_held_elsewhere');
});

test('a free session still resumes', async () => {
  const spawns: AnyRecord[] = [];
  restoreDependencies = overrideClaudeRuntimeDependencies({
    findSessionHolder: async () => null,
  });
  const writer = createWriter();

  await queryClaudeSDK('hello', { sessionId: APP_SESSION_ID }, writer, createContext(spawns));

  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].resume, PROVIDER_SESSION_ID);
  assert.equal(writer.sent.some((frame) => frame.kind === 'error'), false);
  assert.equal(writer.sent.at(-1)?.kind, 'complete');
  assert.equal(writer.sent.at(-1)?.exitCode, 0);
});

/**
 * A stand-in for the cc-chat bridge's local inbox: records every request line
 * and answers each with `answer(request)`.
 */
async function startFakeInbox(answer: (request: AnyRecord) => AnyRecord) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'inbox-'));
  const socketPath = path.join(directory, 'local-inbox.sock');
  const received: AnyRecord[] = [];
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
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return {
    socketPath,
    received,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function registeredSecretary(inbox: string | null) {
  return { pid: 503742, tmuxSession: 'dk-ai-0', registryName: 'dk-ai-0', inbox };
}

test('a message for a registered secretary is delivered to its inbox and spawns nothing', async () => {
  const inbox = await startFakeInbox(() => ({ ok: true, id: 'm-1', room: 'local/owner' }));
  const spawns: AnyRecord[] = [];
  const deliveriesNoted: string[][] = [];
  restoreDependencies = overrideClaudeRuntimeDependencies({
    findSessionHolder: async () => registeredSecretary(inbox.socketPath),
    noteSecretaryDelivery: async (...ids: string[]) => {
      deliveriesNoted.push(ids);
    },
  });
  const writer = createWriter();
  try {
    await queryClaudeSDK('  do X  ', { sessionId: APP_SESSION_ID }, writer, createContext(spawns));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await inbox.close();
  }

  // The row's activity indicator is told the secretary is now working.
  assert.deepEqual(deliveriesNoted, [[PROVIDER_SESSION_ID, APP_SESSION_ID]]);

  assert.equal(spawns.length, 0, 'no claude process was started');
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
  const spawns: AnyRecord[] = [];
  restoreDependencies = overrideClaudeRuntimeDependencies({
    findSessionHolder: async () => registeredSecretary(path.join(scratchHome, 'no-such.sock')),
  });
  const writer = createWriter();

  await queryClaudeSDK('do X', { sessionId: APP_SESSION_ID }, writer, createContext(spawns));

  assert.equal(spawns.length, 0);
  const [error, complete] = writer.sent;
  assert.equal(error.errorCode, 'session_held_elsewhere');
  assert.match(error.content, /^Could not deliver to the dk-ai-0 secretary's inbox: the inbox socket is unreachable \(ENOENT\)/);
  assert.match(error.content, /send it via Discord DM instead/);
  assert.equal(complete.exitCode, 1);
});

test('a registered secretary whose inbox answers an error keeps the refusal, with the reason', async () => {
  const inbox = await startFakeInbox(() => ({ ok: false, error: 'queue full' }));
  const spawns: AnyRecord[] = [];
  restoreDependencies = overrideClaudeRuntimeDependencies({
    findSessionHolder: async () => registeredSecretary(inbox.socketPath),
  });
  const writer = createWriter();
  try {
    await queryClaudeSDK('do X', { sessionId: APP_SESSION_ID }, writer, createContext(spawns));
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
  const spawns: AnyRecord[] = [];
  restoreDependencies = overrideClaudeRuntimeDependencies({
    findSessionHolder: async () => registeredSecretary(null),
    deliverToSecretaryInbox: async () => assert.fail('no inbox to deliver to'),
  });
  const writer = createWriter();

  await queryClaudeSDK('do X', { sessionId: APP_SESSION_ID }, writer, createContext(spawns));

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
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => sockets.push(socket));
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  try {
    const result = await deliverToSecretaryInbox(socketPath, 'hello', 100);
    assert.deepEqual(result, { ok: false, reason: 'the inbox did not answer within 100 ms' });
  } finally {
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
