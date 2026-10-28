import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
      return { pid: 503742, tmuxSession: 'dk-ai-0', registryName: null };
    },
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
    findSessionHolder: async () => (held ? { pid: 9, tmuxSession: null, registryName: null } : null),
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
