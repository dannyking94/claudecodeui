import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// The provider's import chain reaches the websocket and database barrels.
// Point any database open at a scratch file BEFORE importing, so the suite can
// never touch a developer's real auth.db through an inherited DATABASE_PATH.
const scratchDatabaseDir = mkdtempSync(path.join(os.tmpdir(), 'secretary-activity-db-'));
const previousDatabasePath = process.env.DATABASE_PATH;
process.env.DATABASE_PATH = path.join(scratchDatabaseDir, 'auth.db');

const {
  SECRETARY_DELIVERY_GRACE_MS,
  SECRETARY_STALE_TURN_MS,
  classifyClaudeTranscriptActivity,
  createClaudeSecretaryActivityTracker,
} = await import('@/modules/providers/list/claude/claude-secretary-activity.provider.js');

test.after(() => {
  if (previousDatabasePath === undefined) {
    delete process.env.DATABASE_PATH;
  } else {
    process.env.DATABASE_PATH = previousDatabasePath;
  }
  rmSync(scratchDatabaseDir, { recursive: true, force: true });
});

// Row shapes follow a dk-ai-0 transcript as written by Claude Code 2.1.312 on
// 2026-10-28; contents are trimmed to the fields the classifier reads.

const T0 = Date.parse('2026-10-28T09:26:30.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const row = (fields: Record<string, unknown>) => JSON.stringify(fields);

const lastTurnEnd = [
  row({ type: 'assistant', timestamp: at(-30), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }),
  row({ type: 'system', subtype: 'stop_hook_summary', timestamp: at(-30) }),
  row({ type: 'system', subtype: 'turn_duration', timestamp: at(-30), durationMs: 12_000 }),
];
const wake = [
  row({ type: 'queue-operation', operation: 'enqueue', timestamp: at(0), content: '<channel source="chat" wake="true">…' }),
  row({ type: 'queue-operation', operation: 'dequeue', timestamp: at(0) }),
  row({ type: 'user', isMeta: true, timestamp: at(0), message: { role: 'user', content: '<channel source="chat" wake="true">…' } }),
  row({ type: 'api-request', timestamp: at(0) }),
];
const toolUse = row({ type: 'assistant', timestamp: at(3), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
const toolResult = row({ type: 'user', timestamp: at(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
const bookkeeping = [
  row({ type: 'api-request', timestamp: at(5) }),
  row({ type: 'last-prompt' }),
  row({ type: 'mode' }),
  row({ type: 'permission-mode' }),
  row({ type: 'atis-latch' }),
  row({ type: 'bridge-session' }),
  row({ type: 'api-request-blob', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } }),
];
const finalAnswer = [
  row({ type: 'assistant', timestamp: at(9), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }] } }),
  row({ type: 'assistant', timestamp: at(10), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'reply' }] } }),
  row({ type: 'system', subtype: 'stop_hook_summary', timestamp: at(10) }),
  row({ type: 'system', subtype: 'turn_duration', timestamp: at(10), durationMs: 10_000 }),
];

const clockAt = (seconds: number, lastWriteSeconds = seconds, deliveredSeconds: number | null = null) => ({
  now: T0 + seconds * 1000,
  lastWriteAt: T0 + lastWriteSeconds * 1000,
  deliveredAt: deliveredSeconds === null ? null : T0 + deliveredSeconds * 1000,
});

test('an assistant tool_use mid-turn reads as working, since the wake that started the turn', () => {
  const activity = classifyClaudeTranscriptActivity([...lastTurnEnd, ...wake, toolUse], clockAt(5));
  assert.deepEqual(activity, { working: true, since: T0 });
});

test('a pending tool_result, with bookkeeping rows after it, still reads as working', () => {
  const activity = classifyClaudeTranscriptActivity(
    [...lastTurnEnd, ...wake, toolUse, toolResult, ...bookkeeping],
    clockAt(6),
  );
  assert.deepEqual(activity, { working: true, since: T0 });
});

test('a wake that has only been enqueued reads as working', () => {
  const activity = classifyClaudeTranscriptActivity([...lastTurnEnd, wake[0]], clockAt(1));
  assert.deepEqual(activity, { working: true, since: T0 });
});

test('end_turn followed by turn_duration reads as idle', () => {
  const lines = [...lastTurnEnd, ...wake, toolUse, toolResult, ...finalAnswer];
  assert.deepEqual(classifyClaudeTranscriptActivity(lines, clockAt(11)), { working: false, since: null });
});

test('an end_turn text answer reads as idle even before its turn_duration row lands', () => {
  const lines = [...lastTurnEnd, ...wake, toolUse, toolResult, finalAnswer[1]];
  assert.deepEqual(classifyClaudeTranscriptActivity(lines, clockAt(11)), { working: false, since: null });
});

test('an interrupted turn and an API error both read as idle', () => {
  const interrupted = row({ type: 'user', timestamp: at(6), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });
  assert.equal(classifyClaudeTranscriptActivity([...wake, toolUse, interrupted], clockAt(7)).working, false);

  const apiError = row({ type: 'assistant', isApiErrorMessage: true, timestamp: at(6), message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error' }] } });
  assert.equal(classifyClaudeTranscriptActivity([...wake, toolUse, apiError], clockAt(7)).working, false);
});

test('a subagent ending its own turn does not end the secretary turn', () => {
  const sidechainEnd = row({ type: 'assistant', isSidechain: true, timestamp: at(6), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'sub done' }] } });
  assert.equal(classifyClaudeTranscriptActivity([...wake, toolUse, sidechainEnd], clockAt(7)).working, true);
});

test('a turn with no write for the stale timeout reads as idle instead of spinning forever', () => {
  const lines = [...lastTurnEnd, ...wake, toolUse];
  const staleSeconds = SECRETARY_STALE_TURN_MS / 1000;
  assert.equal(classifyClaudeTranscriptActivity(lines, clockAt(3 + staleSeconds - 1, 3)).working, true);
  assert.deepEqual(
    classifyClaudeTranscriptActivity(lines, clockAt(3 + staleSeconds + 1, 3)),
    { working: false, since: null },
  );
});

test('delivered but not yet written reads as working from the delivery, until the grace runs out', () => {
  // Idle transcript; cloudcli delivered at T0 and nothing has been written since.
  const graceSeconds = SECRETARY_DELIVERY_GRACE_MS / 1000;
  assert.deepEqual(classifyClaudeTranscriptActivity(lastTurnEnd, clockAt(2, -30, 0)), { working: true, since: T0 });
  assert.equal(classifyClaudeTranscriptActivity(lastTurnEnd, clockAt(graceSeconds + 1, -30, 0)).working, false);
});

test('a delivery is settled by the wake it caused, after which the transcript alone decides', () => {
  // Picked up and already answered: idle, though the grace has not run out.
  const answered = [...lastTurnEnd, ...wake, toolUse, toolResult, ...finalAnswer];
  assert.equal(classifyClaudeTranscriptActivity(answered, clockAt(11, 10, 0)).working, false);

  // A previous turn finishing after the delivery does not settle it: the wake
  // for the new message has not been written yet.
  const previousTurnEndsLate = [...wake.slice(0, 3), toolUse, ...finalAnswer];
  assert.deepEqual(
    classifyClaudeTranscriptActivity(previousTurnEndsLate, clockAt(11, 10, 8)),
    { working: true, since: T0 + 8_000 },
  );
});

test('malformed and partial lines are skipped', () => {
  const activity = classifyClaudeTranscriptActivity(['{"type":"assis', 'not json', ...wake, toolUse], clockAt(4));
  assert.equal(activity.working, true);
});

// ---------------------------

type Broadcast = { sessionId: string; isProcessing: boolean; startedAt: number | null };

function createHarness(options: { lines: string[]; mtimeSeconds: number; alive?: boolean; registered?: boolean }) {
  const state = { ...options, alive: options.alive ?? true, nowSeconds: options.mtimeSeconds };
  const broadcasts: Broadcast[] = [];
  const tracker = createClaudeSecretaryActivityTracker({
    isRegisteredSecretary: async () => state.registered ?? true,
    isSecretaryAlive: async () => state.alive,
    resolveAppSessionId: (id) => `app-${id}`,
    resolveProviderSessionId: (id) => id.replace(/^app-/, ''),
    locateTranscript: async (id) => `/fake/${id}.jsonl`,
    readTranscriptTail: async () => ({ lines: state.lines, mtimeMs: T0 + state.mtimeSeconds * 1000, size: 1 }),
    broadcast: (event) => {
      broadcasts.push(event as unknown as Broadcast);
    },
    now: () => T0 + state.nowSeconds * 1000,
    pollIntervalMs: 60_000,
  });
  return { state, broadcasts, tracker };
}

test('the tracker announces a working secretary once, then idle when the turn ends', async () => {
  const harness = createHarness({ lines: [...lastTurnEnd, ...wake, toolUse], mtimeSeconds: 3 });
  try {
    await harness.tracker.noteTranscriptChanged('/home/x/.claude/projects/p/sec-1.jsonl');
    await harness.tracker.noteTranscriptChanged('/home/x/.claude/projects/p/sec-1.jsonl');
    assert.deepEqual(harness.broadcasts.map(({ sessionId, isProcessing, startedAt }) => ({ sessionId, isProcessing, startedAt })), [
      { sessionId: 'app-sec-1', isProcessing: true, startedAt: T0 },
    ]);
    assert.deepEqual(harness.tracker.getActivity('app-sec-1'), { working: true, since: T0 });

    harness.state.lines = [...lastTurnEnd, ...wake, toolUse, ...finalAnswer];
    harness.state.mtimeSeconds = 10;
    harness.state.nowSeconds = 11;
    await harness.tracker.noteTranscriptChanged('/home/x/.claude/projects/p/sec-1.jsonl');
    assert.equal(harness.broadcasts.length, 2);
    assert.equal(harness.broadcasts[1].isProcessing, false);
    assert.equal(harness.tracker.getActivity('app-sec-1'), null);
  } finally {
    harness.tracker.stop();
  }
});

test('the tracker ignores transcripts that are not a registered secretary', async () => {
  const harness = createHarness({ lines: [...wake, toolUse], mtimeSeconds: 3, registered: false });
  try {
    await harness.tracker.noteTranscriptChanged('/home/x/.claude/projects/p/worker.jsonl');
    assert.equal(harness.broadcasts.length, 0);
  } finally {
    harness.tracker.stop();
  }
});

test('a delivery re-announces working even when the secretary was already mid-turn', async () => {
  const harness = createHarness({ lines: [...lastTurnEnd, ...wake, toolUse], mtimeSeconds: 3 });
  try {
    await harness.tracker.noteTranscriptChanged('/p/sec-1.jsonl');
    harness.state.nowSeconds = 4;
    await harness.tracker.noteDelivered('sec-1', 'app-sec-1');
    assert.deepEqual(harness.broadcasts.map((event) => event.isProcessing), [true, true]);
  } finally {
    harness.tracker.stop();
  }
});

test('a delivery to an idle secretary shows working at once, with no transcript write yet', async () => {
  const harness = createHarness({ lines: lastTurnEnd, mtimeSeconds: -30 });
  try {
    harness.state.nowSeconds = 0;
    await harness.tracker.noteDelivered('sec-1', 'app-sec-1');
    assert.deepEqual(harness.broadcasts.map(({ isProcessing, startedAt }) => ({ isProcessing, startedAt })), [
      { isProcessing: true, startedAt: T0 },
    ]);
  } finally {
    harness.tracker.stop();
  }
});

test('a secretary that died mid-turn reads as idle without waiting for the stale timeout', async () => {
  const harness = createHarness({ lines: [...lastTurnEnd, ...wake, toolUse], mtimeSeconds: 3 });
  try {
    await harness.tracker.noteTranscriptChanged('/p/sec-1.jsonl');
    harness.state.alive = false;
    harness.state.nowSeconds = 8;
    await harness.tracker.noteTranscriptChanged('/p/sec-1.jsonl');
    assert.deepEqual(harness.broadcasts.map((event) => event.isProcessing), [true, false]);
  } finally {
    harness.tracker.stop();
  }
});
