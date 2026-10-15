import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ClaudeSessionsProvider } from '../list/claude/claude-sessions.provider.js';

// Copied from d907f689-d706-4b5c-9d60-5fddec873728, lines 17906–17909
// and 18168–18170 (excluding the unrelated hook payload). Never read live history.
const rows = readFileSync(new URL('./fixtures/claude-queued-user-replay.jsonl', import.meta.url), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line));
const [oldTurn, newTurn] = rows.filter((row) => row.type === 'user');
const provider = new ClaudeSessionsProvider();
const sessionId = oldTurn.sessionId;

test('Claude resume replay cannot reinsert an earlier queued user turn at receive time', () => {
  // SDK resume echoes can omit timestamp and wrap persisted string content in
  // text blocks. That used to create uuid_text_0 instead of the persisted uuid,
  // so even ID reconciliation could not remove the freshly dated duplicate.
  const replay = {
    type: 'user',
    uuid: oldTurn.uuid,
    session_id: sessionId,
    isReplay: true,
    message: { role: 'user', content: [{ type: 'text', text: oldTurn.message.content }] },
  };
  assert.deepEqual(provider.normalizeMessage(replay, sessionId), []);
  assert.deepEqual(provider.normalizeMessage({ ...replay, timestamp: oldTurn.timestamp }, sessionId), []);
  assert.deepEqual(provider.normalizeMessage({ ...replay, message: oldTurn.message }, sessionId), []);

  const visible = [...rows, replay].flatMap((row) => provider.normalizeMessage(row, sessionId));
  assert.deepEqual(visible.map(({ content, timestamp }) => ({ content, timestamp })), [oldTurn, newTurn]
    .map((row) => ({ content: row.message.content, timestamp: row.timestamp })));
});

test('Claude still renders fresh user events, repeated text, and tool results', () => {
  const fresh = {
    type: 'user',
    uuid: 'fresh-turn',
    timestamp: newTurn.timestamp,
    message: { role: 'user', content: [{ type: 'text', text: oldTurn.message.content }] },
  };
  for (const isReplay of [undefined, false]) {
    const [message] = provider.normalizeMessage({ ...fresh, isReplay }, sessionId);
    assert.equal(message.content, oldTurn.message.content);
    assert.equal(message.timestamp, newTurn.timestamp);
  }
  const [result] = provider.normalizeMessage({
    ...fresh,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }] },
  }, sessionId);
  assert.equal(result.kind, 'tool_result');
  assert.equal(result.content, 'done');
});
