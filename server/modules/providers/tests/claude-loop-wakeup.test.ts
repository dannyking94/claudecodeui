import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { createLoopWakeupWatchdog } from '@/modules/providers/list/claude/claude-loop-wakeup.provider.js';

const GRACE_MS = 90_000;
const MINUTE_MS = 60_000;

/** An assistant frame in which the main thread arms (or stops) a wakeup. */
function wakeupFrame(input: Record<string, unknown>, parentToolUseId: string | null = null) {
  return {
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    message: { content: [{ type: 'tool_use', name: 'ScheduleWakeup', input }] },
  };
}

const TURN_OPENING = { type: 'system', subtype: 'init' };

function createHarness(t: TestContext, canDeliver: () => boolean = () => true) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const delivered: string[] = [];
  const watchdog = createLoopWakeupWatchdog({
    sessionLabel: () => 'session-1',
    deliver: (tickPrompt) => {
      if (!canDeliver()) {
        return false;
      }
      delivered.push(tickPrompt);
      return true;
    },
  });
  // Lets the async delivery a fired timer started run to completion.
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return { watchdog, delivered, flush };
}

test('a wakeup that never fires is delivered once it is overdue', async (t) => {
  const { watchdog, delivered, flush } = createHarness(t);

  watchdog.observe(wakeupFrame({ delaySeconds: 1800, prompt: 'check the build' }));
  assert.equal(watchdog.msUntilDeadline(), 30 * MINUTE_MS + GRACE_MS);

  t.mock.timers.tick(30 * MINUTE_MS + GRACE_MS - 1);
  await flush();
  assert.deepEqual(delivered, [], 'the CLI still has its grace window');

  t.mock.timers.tick(1);
  await flush();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /^# \/loop tick — delivered by cloudcli because the wakeup this loop armed never fired/);
  assert.match(delivered[0], /check the build/);
  assert.match(delivered[0], /call ScheduleWakeup at the end of this turn/);
  assert.equal(watchdog.msUntilDeadline(), null, 'the delivered tick owes nothing more');
});

test('a wakeup the CLI does fire is not delivered twice', async (t) => {
  const { watchdog, delivered, flush } = createHarness(t);

  watchdog.observe(wakeupFrame({ delaySeconds: 600, prompt: 'check the build' }));
  t.mock.timers.tick(10 * MINUTE_MS + 5_000);
  // The CLI opened the tick's turn itself, inside the grace window.
  watchdog.observe(TURN_OPENING);

  t.mock.timers.tick(GRACE_MS * 2);
  await flush();
  assert.deepEqual(delivered, []);
  assert.equal(watchdog.msUntilDeadline(), null);
});

test('a turn that opens before the wakeup is due leaves it pending', async (t) => {
  const { watchdog, delivered, flush } = createHarness(t);

  watchdog.observe(wakeupFrame({ delaySeconds: 1800, prompt: 'check the build' }));
  t.mock.timers.tick(5 * MINUTE_MS);
  // A background task reporting in, or a user turn: not the loop's tick.
  watchdog.observe(TURN_OPENING);
  assert.notEqual(watchdog.msUntilDeadline(), null);

  t.mock.timers.tick(25 * MINUTE_MS + GRACE_MS);
  await flush();
  assert.equal(delivered.length, 1);
});

test('a wakeup armed again moves the deadline out instead of adding a second tick', async (t) => {
  const { watchdog, delivered, flush } = createHarness(t);

  watchdog.observe(wakeupFrame({ delaySeconds: 600, prompt: 'first' }));
  t.mock.timers.tick(5 * MINUTE_MS);
  watchdog.observe(wakeupFrame({ delaySeconds: 1200, prompt: 'second' }));

  t.mock.timers.tick(5 * MINUTE_MS + GRACE_MS);
  await flush();
  assert.deepEqual(delivered, [], 'the first deadline no longer applies');

  t.mock.timers.tick(15 * MINUTE_MS);
  await flush();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /second/);
});

test('stopping the loop cancels the pending delivery', async (t) => {
  const { watchdog, delivered, flush } = createHarness(t);

  watchdog.observe(wakeupFrame({ delaySeconds: 600, prompt: 'check the build' }));
  watchdog.observe(wakeupFrame({ stop: true }));
  assert.equal(watchdog.msUntilDeadline(), null);

  t.mock.timers.tick(60 * MINUTE_MS);
  await flush();
  assert.deepEqual(delivered, []);
});

test('a user abort lets the loop go', async (t) => {
  const { watchdog, delivered, flush } = createHarness(t);

  watchdog.observe(wakeupFrame({ delaySeconds: 600, prompt: 'check the build' }));
  watchdog.cancel();

  t.mock.timers.tick(60 * MINUTE_MS);
  await flush();
  assert.deepEqual(delivered, []);
  assert.equal(watchdog.snapshot(), null);
});

test('the delay is clamped the way the CLI clamps it', (t) => {
  const { watchdog } = createHarness(t);

  watchdog.observe(wakeupFrame({ delaySeconds: 5, prompt: 'soon' }));
  assert.equal(watchdog.msUntilDeadline(), MINUTE_MS + GRACE_MS);

  watchdog.observe(wakeupFrame({ delaySeconds: 99_999, prompt: 'late' }));
  assert.equal(watchdog.msUntilDeadline(), 60 * MINUTE_MS + GRACE_MS);
});

test("a subagent's wakeup is not this session's loop", (t) => {
  const { watchdog } = createHarness(t);

  watchdog.observe(wakeupFrame({ delaySeconds: 600, prompt: 'check the build' }, 'toolu_parent'));
  assert.equal(watchdog.msUntilDeadline(), null);
});

test('a wakeup with no prompt is left to the CLI', (t) => {
  const { watchdog } = createHarness(t);

  watchdog.observe(wakeupFrame({ delaySeconds: 600 }));
  assert.equal(watchdog.msUntilDeadline(), null);
});

test('a delivery the run cannot take yet is retried', async (t) => {
  let busy = true;
  const { watchdog, delivered, flush } = createHarness(t, () => !busy);

  watchdog.observe(wakeupFrame({ delaySeconds: 600, prompt: 'check the build' }));
  t.mock.timers.tick(10 * MINUTE_MS + GRACE_MS);
  await flush();
  assert.deepEqual(delivered, []);

  busy = false;
  t.mock.timers.tick(MINUTE_MS);
  await flush();
  assert.equal(delivered.length, 1);
});

test('a run that takes the session over adopts the wakeup its predecessor armed', async (t) => {
  const { watchdog: superseded, delivered: deliveredToSuperseded, flush } = createHarness(t);
  superseded.observe(wakeupFrame({ delaySeconds: 1800, prompt: 'check the build' }));
  t.mock.timers.tick(10 * MINUTE_MS);

  const delivered: string[] = [];
  const successor = createLoopWakeupWatchdog({
    sessionLabel: () => 'session-1',
    deliver: (tickPrompt) => {
      delivered.push(tickPrompt);
      return true;
    },
  }, superseded.snapshot());
  // The superseded run's process is gone; so is its watchdog.
  superseded.dispose();
  assert.equal(successor.msUntilDeadline(), 20 * MINUTE_MS + GRACE_MS);

  // The user's own turn opens and ends well before the wakeup is due.
  successor.observe(TURN_OPENING);

  t.mock.timers.tick(20 * MINUTE_MS + GRACE_MS);
  await flush();
  assert.deepEqual(deliveredToSuperseded, []);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /check the build/);
});

test('a disposed watchdog delivers nothing', async (t) => {
  const { watchdog, delivered, flush } = createHarness(t);

  watchdog.observe(wakeupFrame({ delaySeconds: 600, prompt: 'check the build' }));
  watchdog.dispose();

  t.mock.timers.tick(60 * MINUTE_MS);
  await flush();
  assert.deepEqual(delivered, []);
  assert.equal(watchdog.snapshot(), null);
});
