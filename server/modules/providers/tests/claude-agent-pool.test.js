import assert from 'node:assert/strict';
import test from 'node:test';

import { claudeAgentPool } from '@/modules/providers/list/claude/claude-agent-pool.provider.js';

/**
 * Stand-in for the SDK `Query`: an async generator the test drives frame by
 * frame, plus the control methods the pool calls.
 *
 * The real query only ends when the input stream closes, which is the whole
 * point of the pool — so this fake mirrors that: `emit()` pushes a frame, and
 * the generator parks between frames instead of returning.
 */
function createFakeQuery() {
  const pending = [];
  let deliver = null;
  let ended = false;

  const fake = {
    emitted: [],
    closed: false,
    interrupts: 0,
    modelChanges: [],
    permissionModeChanges: [],

    emit(message) {
      fake.emitted.push(message);
      if (deliver) {
        const resolve = deliver;
        deliver = null;
        resolve({ value: message, done: false });
        return;
      }
      pending.push(message);
    },

    async interrupt() {
      fake.interrupts += 1;
    },
    async setModel(model) {
      fake.modelChanges.push(model);
    },
    async setPermissionMode(mode) {
      fake.permissionModeChanges.push(mode);
    },
    close() {
      fake.closed = true;
      ended = true;
      if (deliver) {
        const resolve = deliver;
        deliver = null;
        resolve({ value: undefined, done: true });
      }
    },

    [Symbol.asyncIterator]() {
      return {
        next() {
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift(), done: false });
          }
          if (ended) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            deliver = resolve;
          });
        },
      };
    },
  };

  return fake;
}

const INIT = { type: 'system', subtype: 'init', session_id: 'provider-session' };
const ASSISTANT = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } };
const RESULT = { type: 'result', subtype: 'success' };

/** An assistant frame calling a scheduling tool. */
const toolCall = (name, input) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name, input }] },
});

const loopTurn = (prompt = '/loop check progress') => ({
  type: 'user',
  message: { role: 'user', content: prompt },
});

/** Lets the pool's reader loop drain everything queued so far. */
const drain = () => new Promise((resolve) => setImmediate(resolve));

/** Long enough for the shortened keepalive timer below to have fired. */
const settleTimers = () => new Promise((resolve) => setTimeout(resolve, 40));

function setup({ key = 'session-1', fingerprint = 'fp-1', openSpontaneousRun } = {}) {
  const fake = createFakeQuery();
  const routed = [];
  const pushed = [];
  let input = null;
  const state = {
    appSessionId: key,
    capturedSessionId: null,
    toolSettings: { allowedTools: [], disallowedTools: [] },
    permissionMode: undefined,
    model: 'model-a',
    currentWriter: () => null,
  };

  const agent = claudeAgentPool.acquire({
    key,
    fingerprint,
    sdkOptions: {},
    state,
    route: (message, writer) => routed.push({ message, writer }),
    openSpontaneousRun,
    createQuery: (options) => {
      // Drain the input stream the way the real subprocess does, so a turn the
      // pool pushes by itself is observable.
      input = options.prompt;
      (async () => {
        for await (const message of input) {
          pushed.push(message);
        }
      })();
      return fake;
    },
  });

  return { agent, fake, routed, state, pushed };
}

test.afterEach(() => {
  claudeAgentPool.closeAll();
  delete process.env.CLOUDCLI_CLAUDE_LOOP_KEEPALIVE_MS;
});

test('a user turn resolves at the result frame and leaves the session open', async () => {
  const { agent, fake, routed } = setup();
  const writer = { id: 'writer' };

  const turn = agent.runTurn({ type: 'user' }, writer);
  assert.equal(agent.hasActiveTurn(), true);

  fake.emit(INIT);
  fake.emit(ASSISTANT);
  fake.emit(RESULT);

  const settled = await turn;
  assert.equal(settled.error, null);
  assert.equal(settled.result, RESULT);
  assert.equal(agent.hasActiveTurn(), false);
  // The session must survive its own turn — this is what keeps cron jobs alive.
  assert.equal(fake.closed, false);
  assert.equal(claudeAgentPool.get('session-1'), agent);
  assert.deepEqual(routed.map((entry) => entry.writer), [writer, writer, writer]);
});

test('scheduled work opens a spontaneous run and completes it', async () => {
  const opened = [];
  const completions = [];
  const spontaneousWriter = { id: 'spontaneous' };

  const { agent, fake, routed } = setup({
    openSpontaneousRun: (input) => {
      opened.push(input);
      return {
        writer: spontaneousWriter,
        complete: (opts) => completions.push(opts),
      };
    },
  });

  // Finish a normal turn first so the session is idle, as it would be when a
  // cron job fires.
  const turn = agent.runTurn({ type: 'user' }, { id: 'writer' });
  fake.emit(INIT);
  fake.emit(RESULT);
  await turn;
  routed.length = 0;

  // Now a turn nobody sent.
  fake.emit(INIT);
  fake.emit(ASSISTANT);
  fake.emit(RESULT);
  await drain();

  assert.equal(opened.length, 1);
  assert.equal(opened[0].sessionId, 'session-1');
  assert.deepEqual(completions, [{ exitCode: 0 }]);
  assert.equal(agent.hasActiveTurn(), false);
  assert.ok(routed.length >= 2);
  assert.ok(routed.every((entry) => entry.writer === spontaneousWriter));
});

test('idle bookkeeping frames do not open a run', async () => {
  const opened = [];
  const { agent, fake } = setup({
    openSpontaneousRun: (input) => {
      opened.push(input);
      return { writer: {}, complete: () => {} };
    },
  });

  const turn = agent.runTurn({ type: 'user' }, { id: 'writer' });
  fake.emit(INIT);
  fake.emit(RESULT);
  await turn;

  // A rate-limit notice between turns must not be mistaken for scheduled work:
  // no `result` would follow, wedging the session in "processing" forever.
  fake.emit({ type: 'rate_limit_event' });
  fake.emit({ type: 'system', subtype: 'post_turn_summary' });
  await drain();

  assert.deepEqual(opened, []);
  assert.equal(agent.hasActiveTurn(), false);
});

test('interrupting a turn settles it without ending the session', async () => {
  const { agent, fake } = setup();

  const turn = agent.runTurn({ type: 'user' }, { id: 'writer' });
  fake.emit(INIT);

  assert.equal(await agent.interrupt(), true);
  assert.equal(fake.interrupts, 1);

  // The SDK reports an interrupted turn as a result, not a thrown generator.
  fake.emit({ type: 'result', subtype: 'error_during_execution' });
  const settled = await turn;

  assert.equal(settled.error, null);
  assert.equal(fake.closed, false);
  assert.equal(claudeAgentPool.get('session-1'), agent);

  // And the session still takes another turn afterwards.
  const next = agent.runTurn({ type: 'user' }, { id: 'writer-2' });
  fake.emit(INIT);
  fake.emit(RESULT);
  await next;
});

test('scheduling tool use marks the session as holding scheduled work', async () => {
  const { agent, fake } = setup();

  const turn = agent.runTurn({ type: 'user' }, { id: 'writer' });
  fake.emit(INIT);
  fake.emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'CronCreate', input: {} }] },
  });
  fake.emit(RESULT);
  await turn;

  assert.equal(agent.hasScheduledWork, true);
  // Idle eviction must not reclaim a session that owes the user a wake-up.
  assert.equal(agent.isExpired(Date.now() + 60 * 60 * 1000), false);
});

/**
 * A dynamic `/loop` only survives because each tick arms the next one, and the
 * CLI's guard for a tick that forgets is REPL-only — under the SDK transport the
 * pool drives, a single skipped `ScheduleWakeup` ends the loop silently. These
 * cover the pool's stand-in for that guard.
 */
const spontaneous = () => {
  const completions = [];
  return {
    completions,
    openSpontaneousRun: () => ({ writer: { id: 'spontaneous' }, complete: (o) => completions.push(o) }),
  };
};

async function runLoopTick(agent, fake, frames = []) {
  const turn = agent.runTurn(loopTurn(), { id: 'writer' });
  fake.emit(INIT);
  for (const frame of frames) {
    fake.emit(frame);
  }
  fake.emit(RESULT);
  await turn;
}

test('a loop tick that arms no wakeup gets one fallback tick from the pool', async () => {
  process.env.CLOUDCLI_CLAUDE_LOOP_KEEPALIVE_MS = '5';
  const { agent, fake, pushed } = setup(spontaneous());

  await runLoopTick(agent, fake, [ASSISTANT]);
  await settleTimers();

  assert.equal(pushed.length, 2);
  const tick = pushed[1].message.content;
  assert.match(tick, /check progress/);
  // The tick has to carry the re-arm contract itself: it is delivered outside
  // the CLI's loop machinery, which is what normally states it.
  assert.match(tick, /ScheduleWakeup/);
  assert.match(tick, /stop: true/);
  // And the session must not be evicted as idle before it lands.
  assert.equal(agent.hasScheduledWork, true);
});

test('a loop tick that arms its own wakeup is left alone', async () => {
  process.env.CLOUDCLI_CLAUDE_LOOP_KEEPALIVE_MS = '5';
  const { agent, fake, pushed } = setup(spontaneous());

  await runLoopTick(agent, fake, [
    toolCall('ScheduleWakeup', { delaySeconds: 1200, prompt: '/loop check progress' }),
  ]);
  await settleTimers();

  assert.equal(pushed.length, 1);
});

test('the fallback tick is delivered once, then the loop is let go', async () => {
  process.env.CLOUDCLI_CLAUDE_LOOP_KEEPALIVE_MS = '5';
  const { agent, fake, pushed } = setup(spontaneous());

  await runLoopTick(agent, fake, [ASSISTANT]);
  await settleTimers();
  assert.equal(pushed.length, 2);

  // The fallback tick arrives as a turn nobody sent — and also declines to
  // re-arm. A loop that will not continue on a free tick is over.
  fake.emit(INIT);
  fake.emit(ASSISTANT);
  fake.emit(RESULT);
  await drain();
  await settleTimers();

  assert.equal(pushed.length, 2);
});

test('stopping the loop cancels the pool fallback', async () => {
  process.env.CLOUDCLI_CLAUDE_LOOP_KEEPALIVE_MS = '5';
  const { agent, fake, pushed } = setup(spontaneous());

  await runLoopTick(agent, fake, [toolCall('ScheduleWakeup', { stop: true })]);
  await settleTimers();

  assert.equal(pushed.length, 1);
});

test('a fixed-interval loop is left to its recurring cron', async () => {
  process.env.CLOUDCLI_CLAUDE_LOOP_KEEPALIVE_MS = '5';
  const { agent, fake, pushed } = setup(spontaneous());

  const turn = agent.runTurn(loopTurn('/loop 5m check progress'), { id: 'writer' });
  fake.emit(INIT);
  fake.emit(toolCall('CronCreate', { cron: '*/5 * * * *', recurring: true }));
  fake.emit(RESULT);
  await turn;
  await settleTimers();

  assert.equal(pushed.length, 1);
});

test('an ordinary turn during a live loop does not spend its budget', async () => {
  process.env.CLOUDCLI_CLAUDE_LOOP_KEEPALIVE_MS = '5';
  const { agent, fake, pushed } = setup(spontaneous());

  await runLoopTick(agent, fake, [
    toolCall('ScheduleWakeup', { delaySeconds: 1200, prompt: '/loop check progress' }),
  ]);

  // The user asking something mid-loop says nothing about the loop: its wakeup
  // is still pending in the CLI and will fire on its own.
  const aside = agent.runTurn({ type: 'user', message: { role: 'user', content: 'how is it?' } }, { id: 'writer' });
  fake.emit(INIT);
  fake.emit(ASSISTANT);
  fake.emit(RESULT);
  await aside;
  await settleTimers();

  assert.equal(pushed.length, 2);
});

test('interrupting a loop tick stops the pool from re-ticking it', async () => {
  process.env.CLOUDCLI_CLAUDE_LOOP_KEEPALIVE_MS = '5';
  const { agent, fake, pushed } = setup(spontaneous());

  const turn = agent.runTurn(loopTurn(), { id: 'writer' });
  fake.emit(INIT);
  await agent.interrupt();
  fake.emit({ type: 'result', subtype: 'error_during_execution' });
  await turn;
  await settleTimers();

  assert.equal(pushed.length, 1);
});

test('per-turn settings are applied in place rather than restarting the session', async () => {
  const { agent, fake, state } = setup();

  await agent.applyTurnSettings({
    model: 'model-b',
    permissionMode: 'plan',
    allowedTools: ['Read'],
    disallowedTools: ['Bash'],
  });

  assert.deepEqual(fake.modelChanges, ['model-b']);
  assert.deepEqual(fake.permissionModeChanges, ['plan']);
  assert.equal(state.model, 'model-b');
  assert.deepEqual(state.toolSettings.allowedTools, ['Read']);
  assert.equal(fake.closed, false);

  // Unchanged settings must not churn the subprocess.
  await agent.applyTurnSettings({ model: 'model-b', permissionMode: 'plan' });
  assert.deepEqual(fake.modelChanges, ['model-b']);
  assert.deepEqual(fake.permissionModeChanges, ['plan']);
});

test('a changed fingerprint replaces the agent', async () => {
  const first = setup({ fingerprint: 'fp-1' });
  const second = setup({ fingerprint: 'fp-2' });

  assert.notEqual(second.agent, first.agent);
  assert.equal(first.fake.closed, true);
  assert.equal(claudeAgentPool.get('session-1'), second.agent);
});

test('an unchanged fingerprint reuses the agent and its state', () => {
  const first = setup({ fingerprint: 'fp-1' });
  const second = setup({ fingerprint: 'fp-1' });

  assert.equal(second.agent, first.agent);
  // The reused agent keeps the state its SDK closures were built around.
  assert.equal(second.agent.state, first.state);
  assert.equal(first.fake.closed, false);
});
