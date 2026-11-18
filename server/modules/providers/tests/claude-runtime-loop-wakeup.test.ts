import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

// The runtime's import chain opens the database at module load. Point it at a
// scratch file BEFORE importing, so the suite can never open a developer's
// real auth.db through an inherited DATABASE_PATH.
const scratchDirectory = mkdtempSync(path.join(os.tmpdir(), 'runtime-loop-wakeup-'));
const previousDatabasePath = process.env.DATABASE_PATH;
const previousHome = process.env.HOME;
process.env.DATABASE_PATH = path.join(scratchDirectory, 'auth.db');
// loadMcpConfig reads ~/.claude.json; keep it off the developer's real home.
process.env.HOME = scratchDirectory;

const { overrideClaudeRuntimeDependencies, queryClaudeSDK } = await import(
  '@/modules/providers/list/claude/claude-runtime.provider.js'
);

const restoreDependencies = overrideClaudeRuntimeDependencies({ findSessionHolder: async () => null });

test.after(() => {
  restoreDependencies();
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  process.env.HOME = previousHome;
  rmSync(scratchDirectory, { recursive: true, force: true });
});

const PROVIDER_SESSION_ID = '0d3f6d0e-64f5-4a53-9a40-3f4f4a1c9b10';
const MINUTE_MS = 60_000;
const GRACE_MS = 90_000;

/**
 * A scripted CLI: `respond` turns each message read from stdin into the frames
 * that turn produces, and the output stream ends when the runtime closes stdin.
 */
function createScriptedQuery(respond: (prompt: string, turnIndex: number) => AnyRecord[]) {
  const prompts: string[] = [];
  const state = { stdinClosed: false };
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    const frames: AnyRecord[] = [];
    const waiter: { wake: (() => void) | null } = { wake: null };
    void (async () => {
      for await (const message of prompt) {
        const content = (message as AnyRecord).message?.content;
        prompts.push(typeof content === 'string' ? content : JSON.stringify(content));
        frames.push(...respond(prompts[prompts.length - 1], prompts.length - 1));
        waiter.wake?.();
      }
      state.stdinClosed = true;
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
          if (state.stdinClosed) {
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
  return { createQuery, prompts, state };
}

function createContext(createQuery: NonNullable<ProviderRuntimeContext['createQuery']>): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => PROVIDER_SESSION_ID,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'default' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
    createQuery,
  } as unknown as ProviderRuntimeContext;
}

function createWriter() {
  const sent: AnyRecord[] = [];
  return {
    userId: null,
    sent,
    send(frame: unknown) {
      sent.push(frame as AnyRecord);
    },
  };
}

const init = { type: 'system', subtype: 'init', session_id: PROVIDER_SESSION_ID };
const result = { type: 'result', subtype: 'success', session_id: PROVIDER_SESSION_ID };
const armWakeup = (delaySeconds: number, prompt: string) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  session_id: PROVIDER_SESSION_ID,
  message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'ScheduleWakeup', input: { delaySeconds, prompt } }] },
});

/**
 * Waits for the runtime to reach a state, yielding to real I/O in between. The
 * runtime reads the filesystem on its way to the first prompt, so how many
 * turns of the event loop that takes is not fixed; timers stay mocked.
 */
async function until(reached: () => boolean, what: string) {
  for (let round = 0; round < 5000 && !reached(); round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(reached(), `timed out waiting until ${what}`);
  // Let whatever that state triggered (the turn's result handling) finish.
  for (let round = 0; round < 50; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test('a held run delivers the loop tick its CLI never fired, then lets the process go', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const cli = createScriptedQuery((_prompt, turnIndex) => (
    // The first turn arms a 45-minute wakeup — past the 30-minute idle ceiling
    // — and the tick's turn arms nothing more, which ends the loop.
    turnIndex === 0 ? [init, armWakeup(2700, 'check the build'), result] : [init, result]
  ));
  const writer = createWriter();

  const run = queryClaudeSDK('/loop check the build', { sessionId: 'app-loop-1' }, writer, createContext(cli.createQuery));
  await until(() => writer.sent.some((frame) => frame.kind === 'complete'), 'the first turn completes');

  assert.equal(cli.prompts.length, 1);
  assert.equal(writer.sent.filter((frame) => frame.kind === 'complete').length, 1, 'the turn itself completed');
  assert.equal(cli.state.stdinClosed, false, 'the process is held for the armed wakeup');

  // The idle ceiling alone would have released the process here.
  t.mock.timers.tick(31 * MINUTE_MS);
  await until(() => true, 'the idle timers have run');
  assert.equal(cli.state.stdinClosed, false, 'the hold outlasts the ceiling while a wakeup is armed');
  assert.equal(cli.prompts.length, 1);

  t.mock.timers.tick(14 * MINUTE_MS + GRACE_MS);
  await until(() => cli.prompts.length === 2, 'the tick is delivered into the held process');
  assert.match(cli.prompts[1], /^# \/loop tick — delivered by cloudcli/);
  assert.match(cli.prompts[1], /check the build/);

  await run;
  assert.equal(cli.state.stdinClosed, true, 'a tick that armed nothing releases the process');
  assert.equal(writer.sent.filter((frame) => frame.kind === 'complete').length, 1, 'no second terminal complete');
});

test('a new turn inherits the wakeup armed by the run it supersedes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const first = createScriptedQuery(() => [init, armWakeup(1800, 'check the build'), result]);
  const firstWriter = createWriter();
  const firstRun = queryClaudeSDK('/loop check the build', { sessionId: 'app-loop-2' }, firstWriter, createContext(first.createQuery));
  await until(() => firstWriter.sent.some((frame) => frame.kind === 'complete'), 'the loop turn completes');
  assert.equal(first.state.stdinClosed, false);

  t.mock.timers.tick(10 * MINUTE_MS);
  // The user sends an ordinary message; the new process knows nothing of the wakeup.
  const second = createScriptedQuery(() => [init, result]);
  const secondWriter = createWriter();
  const secondRun = queryClaudeSDK('how is it going?', { sessionId: 'app-loop-2' }, secondWriter, createContext(second.createQuery));
  await until(() => secondWriter.sent.some((frame) => frame.kind === 'complete'), 'the user turn completes');
  await firstRun;
  assert.equal(first.state.stdinClosed, true, 'the superseded process was released');
  assert.equal(second.prompts.length, 1);
  assert.equal(second.state.stdinClosed, false, 'the new process is held for the inherited wakeup');

  t.mock.timers.tick(20 * MINUTE_MS + GRACE_MS);
  await until(() => second.prompts.length === 2, 'the inherited tick is delivered');
  assert.match(second.prompts[1], /check the build/);
  assert.equal(first.prompts.length, 1, 'the dead process received nothing');

  await secondRun;
});
