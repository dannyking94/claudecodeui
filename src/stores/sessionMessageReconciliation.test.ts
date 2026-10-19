import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from './useSessionStore';
import { mergeRefreshedTail, removeOptimisticUserEchoes } from './sessionMessageReconciliation';

const createUserMessage = (
  id: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: '',
  ...overrides,
});

test('replaces an optimistic image-only turn with its persisted Claude copy', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png', name: 'image.png' }],
  });
  const persisted = createUserMessage('claude_image', '2026-07-28T20:30:26.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('does not collapse an attachment-only turn into a server row without attachments', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png' }],
  });
  const persisted = createUserMessage('claude_empty', '2026-07-28T20:30:22.000Z');

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), [local]);
});

test('matches optimistic attachment turns to persisted turns one-to-one', () => {
  const firstLocal = createUserMessage('local_first', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/first.png' }],
  });
  const secondLocal = createUserMessage('local_second', '2026-07-28T20:30:25.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/second.png' }],
  });
  const firstPersisted = createUserMessage('claude_first', '2026-07-28T20:30:22.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    [firstPersisted],
    [firstLocal, secondLocal],
  );

  assert.deepEqual(remainingRealtime.map((message) => message.id), ['local_second']);
});

test('keeps the existing optimistic text reconciliation behavior', () => {
  const local = createUserMessage('local_text', '2026-07-28T20:30:21.000Z', {
    content: 'hello',
  });
  const persisted = createUserMessage('claude_text', '2026-07-28T20:30:26.000Z', {
    content: 'hello',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

const row = (id: string): NormalizedMessage => createUserMessage(id, '2026-07-28T20:30:21.000Z');
const ids = (messages: NormalizedMessage[]) => messages.map((message) => message.id);

test('mergeRefreshedTail appends new rows and keeps older loaded rows by identity', () => {
  const loaded = ['a', 'b', 'c', 'd'].map(row);
  const fetched = ['c', 'd', 'e'].map(row);
  const merged = mergeRefreshedTail(loaded, fetched);

  assert.deepEqual(ids(merged!.messages), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(merged!.messages[0], loaded[0]);
  assert.equal(merged!.messages[2], fetched[0]);
  assert.equal(merged!.keptOlderRows, true);
});

test('mergeRefreshedTail drops fetched rows above the loaded range', () => {
  const loaded = ['c', 'd'].map(row);
  const merged = mergeRefreshedTail(loaded, ['a', 'b', 'c', 'd', 'e'].map(row));

  assert.deepEqual(ids(merged!.messages), ['c', 'd', 'e']);
  assert.equal(merged!.droppedOlderRows, true);
});

test('mergeRefreshedTail asks for a longer tail when there is no clean overlap', () => {
  const loaded = ['a', 'b', 'c'].map(row);
  assert.equal(mergeRefreshedTail(loaded, ['x', 'y'].map(row)), null);
  assert.equal(mergeRefreshedTail(loaded, ['x', 'b', 'c'].map(row)), null);
});

test('mergeRefreshedTail takes the fetched tail as-is when nothing was loaded', () => {
  const fetched = ['a', 'b'].map(row);
  assert.equal(mergeRefreshedTail([], fetched)!.messages, fetched);
});
