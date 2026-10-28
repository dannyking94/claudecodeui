import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  normalizeChatWakeRow,
  presentChatBridgeTurns,
} from '@/modules/providers/list/claude/claude-chat-bridge-view.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import type { NormalizedMessage } from '@/shared/types.js';

// Shapes follow the cc-chat bridge as seen in a dk-ai-0 transcript on
// 2026-10-28; the texts are made up.

const SESSION = 'secretary-session';

function wakeText(rooms: Array<[string, number]>): string {
  const total = rooms.reduce((sum, [, count]) => sum + count, 0);
  const roomLines = rooms.map(([room, count]) => `[${room}] +${count} new · latest 15:44`).join('\n');
  return `<channel source="chat" wake="true">\n📬 Local — ${total} new\n\n${roomLines}\n\n⏳ wake 쿨다운 30초.\n</channel>`;
}

function ownerLine(index: number, messageId: string, text: string): string {
  return `#${index} msg=${messageId} [wake: dm] 15:44:13 uid=local.owner "owner via cloudcli": ${JSON.stringify(text)}`;
}

function draftResult(dryRunId: string, text: string): string {
  return `=== DRAFT PREVIEW (not sent) ===\ndry_run_id: ${dryRunId}\nhandle: local/owner\n\n--- text ---\n${text}\n--- end text ---\n\nSELF-CHECK …`;
}

let clock = 0;
function base(id: string): Pick<NormalizedMessage, 'id' | 'sessionId' | 'timestamp' | 'provider'> {
  clock += 1;
  return { id, sessionId: SESSION, timestamp: new Date(Date.UTC(2026, 9, 28, 6, 44, clock)).toISOString(), provider: 'claude' };
}

function wake(id: string, rooms: Array<[string, number]>): NormalizedMessage {
  return { ...base(id), kind: 'text', role: 'user', content: wakeText(rooms) };
}

function toolCall(id: string, toolName: string, toolInput: unknown, result?: string, isError = false): NormalizedMessage[] {
  const use: NormalizedMessage = {
    ...base(id),
    kind: 'tool_use',
    toolName,
    toolInput,
    toolId: `toolu_${id}`,
    // History serializes a block-array result as JSON; exercise that form.
    toolResult: result === undefined
      ? undefined
      : { content: JSON.stringify([{ type: 'text', text: result }]), isError },
  };
  if (result === undefined) {
    return [use];
  }
  return [use, { ...base(`${id}_r`), kind: 'tool_result', toolId: `toolu_${id}`, content: result, isError }];
}

function assistantText(id: string, content: string): NormalizedMessage {
  return { ...base(id), kind: 'text', role: 'assistant', content };
}

/** One owner exchange: read (listing `lines`), draft, send. */
function answer(prefix: string, lines: string[], reply: string, dryRunId: string): NormalizedMessage[] {
  return [
    ...toolCall(`${prefix}read`, 'mcp__chat__read', { handle: 'local/owner', unread_only: true }, `[local/owner]\n${lines.join('\n')}`),
    ...toolCall(`${prefix}draft`, 'mcp__chat__reply_dry_run', { handle: 'local/owner', text: reply }, draftResult(dryRunId, reply)),
    ...toolCall(`${prefix}send`, 'mcp__chat__reply', { dry_run_id: dryRunId }, 'sent (id: 1793169804420002)'),
  ];
}

function view(messages: NormalizedMessage[]): string[] {
  return presentChatBridgeTurns(messages)
    .filter((message) => message.kind !== 'tool_result')
    .map((message) => (message.kind === 'tool_use'
      ? `tool ${message.toolName}`
      : `${message.role} ${message.content}`));
}

test('a single wake becomes the owner bubble and the sent reply an assistant message', () => {
  const messages = [
    wake('w1', [['local/owner', 1]]),
    ...answer('a', [ownerLine(1, '1001', 'you there?')], 'Here — what do you need?', 'd1'),
    ...toolCall('mark', 'mcp__chat__mark_read', { handle: 'local/owner' }, 'ok'),
    assistantText('t1', 'I answered in local/owner.'),
  ];
  assert.deepEqual(view(messages), [
    'user you there?',
    'assistant Here — what do you need?',
    'assistant I answered in local/owner.',
  ]);
  const presented = presentChatBridgeTurns(messages);
  // The bubble keeps the wake's time so an optimistic local echo reconciles with it.
  assert.equal(presented[0].timestamp, messages[0].timestamp);
  assert.equal(presented[0].id, 'w1_chat_1001');
  // Hidden calls take their tool_result rows with them.
  assert.ok(!presented.some((message) => message.kind === 'tool_result'));
});

test('a batched wake shows both messages, in order', () => {
  const messages = [
    wake('w1', [['local/owner', 2]]),
    ...answer('a', [ownerLine(1, '1001', 'first'), ownerLine(2, '1002', 'second\nwith "quotes"')], 'Both done.', 'd1'),
  ];
  assert.deepEqual(view(messages), ['user first', 'user second\nwith "quotes"', 'assistant Both done.']);
});

test('messages a later read re-lists are not shown again', () => {
  const messages = [
    wake('w1', [['local/owner', 1]]),
    ...answer('a', [ownerLine(1, '1001', 'you there?')], 'Here.', 'd1'),
    wake('w2', [['local/owner', 1]]),
    ...answer('b', [ownerLine(1, '1001', 'you there?'), ownerLine(3, '1003', 'all good?')], 'Yes.', 'd2'),
  ];
  assert.deepEqual(view(messages), ['user you there?', 'assistant Here.', 'user all good?', 'assistant Yes.']);
});

test('a wake takes only the newest unshown messages, not the backlog a fresh transcript re-lists', () => {
  const messages = [
    wake('w1', [['local/owner', 1]]),
    ...answer('a', [ownerLine(1, '1001', 'old one'), ownerLine(3, '1003', 'old two'), ownerLine(5, '1005', 'new')], 'Hi.', 'd1'),
  ];
  assert.deepEqual(view(messages), ['user new', 'assistant Hi.']);
});

test('a draft that was never sent does not appear, and only the sent revision does', () => {
  const messages = [
    wake('w1', [['local/owner', 1]]),
    ...toolCall('r', 'mcp__chat__read', { handle: 'local/owner' }, `[local/owner]\n${ownerLine(1, '1001', 'status?')}`),
    ...toolCall('d1', 'mcp__chat__reply_dry_run', { handle: 'local/owner', text: 'rough draft' }, draftResult('x1', 'rough draft')),
    ...toolCall('d2', 'mcp__chat__reply_dry_run', { handle: 'local/owner', text: 'final answer' }, draftResult('x2', 'final answer')),
    ...toolCall('s', 'mcp__chat__reply', { dry_run_id: 'x2' }, 'sent (id: 9)'),
    ...toolCall('d3', 'mcp__chat__reply_dry_run', { handle: 'local/owner', text: 'abandoned' }, draftResult('x3', 'abandoned')),
  ];
  assert.deepEqual(view(messages), ['user status?', 'assistant final answer']);
});

test('a reply that failed stays visible as the raw tool call', () => {
  const messages = [
    ...toolCall('d', 'mcp__chat__reply_dry_run', { handle: 'local/owner', text: 'hello' }, draftResult('x1', 'hello')),
    ...toolCall('s', 'mcp__chat__reply', { dry_run_id: 'x1' }, 'dry run expired', true),
  ];
  assert.deepEqual(view(messages), ['tool mcp__chat__reply']);
});

test('non-chat tool calls, thinking and assistant text pass through untouched', () => {
  const bash = toolCall('b', 'Bash', { command: 'make test' }, 'ok');
  const thinking: NormalizedMessage = { ...base('th'), kind: 'thinking', content: 'checking' };
  const other = toolCall('c', 'mcp__chat__conversations', {}, '[]');
  const messages = [
    wake('w1', [['local/owner', 1]]),
    ...toolCall('r', 'mcp__chat__read', { handle: 'local/owner' }, `[local/owner]\n${ownerLine(1, '1001', 'run tests')}`),
    thinking,
    ...bash,
    ...other,
    assistantText('t', 'Tests pass.'),
  ];
  const presented = presentChatBridgeTurns(messages);
  assert.deepEqual(presented.slice(1), [thinking, ...bash, ...other, messages.at(-1)]);
});

test('a Discord wake shows the sender and room, and the reply is tagged with the handle', () => {
  const room = 'dc/비바트로보틱스#3 · dk-worker';
  const messages = [
    wake('w1', [[room, 1]]),
    ...toolCall('r', 'mcp__chat__read', { handle: 'dc/비바트로보틱스#3' }, [
      `[${room}]`,
      '#0 msg=155 [no wake] 10:59:56 uid=154 "dk-ai-worker": "older report"',
      '#0 msg=156 [wake: mention] 14:49:07 uid=154 "dk-ai-worker": "<@1> task DONE"',
    ].join('\n')),
    ...toolCall('d', 'mcp__chat__reply_dry_run', { handle: 'dc/비바트로보틱스#3', text: 'Landed.' }, draftResult('x1', 'Landed.')),
    ...toolCall('s', 'mcp__chat__reply', { dry_run_id: 'x1' }, 'sent (id: 157)'),
  ];
  assert.deepEqual(view(messages), [
    `user [${room}] dk-ai-worker:\n<@1> task DONE`,
    'assistant *→ dc/비바트로보틱스#3*\n\nLanded.',
  ]);
});

test('a wake with no read yet shows a compact owner bubble, never the raw notice', () => {
  const messages = [wake('w1', [['local/owner', 1]]), ...toolCall('r', 'mcp__chat__read', { handle: 'local/owner' })];
  assert.deepEqual(view(messages), ['user 📬 Message from owner']);
});

test('a transcript without the chat bridge is returned as is', () => {
  const messages = [{ ...base('u'), kind: 'text', role: 'user', content: 'hi' } as NormalizedMessage, ...toolCall('b', 'Bash', {}, 'ok')];
  assert.equal(presentChatBridgeTurns(messages), messages);
});

test('normalizeChatWakeRow surfaces the isMeta wake row and nothing else', () => {
  const row = {
    type: 'user',
    uuid: 'wake-uuid',
    timestamp: '2026-10-28T06:44:13.541Z',
    isMeta: true,
    origin: { kind: 'channel', server: 'chat' },
    message: { role: 'user', content: wakeText([['local/owner', 1]]) },
  };
  const message = normalizeChatWakeRow(row, SESSION);
  assert.equal(message?.id, 'wake-uuid');
  assert.equal(message?.role, 'user');
  assert.equal(message?.timestamp, row.timestamp);
  assert.equal(normalizeChatWakeRow({ ...row, message: { role: 'user', content: 'hello' } }, SESSION), null);
  assert.equal(normalizeChatWakeRow({ ...row, message: { role: 'user', content: '<channel source="telegram">x</channel>' } }, SESSION), null);
});

test('fetchHistory renders a secretary transcript as the conversation', async () => {
  const providerSessionId = 'c0ffee00-0000-4000-8000-000000000001';
  const row = (uuid: string, second: number, fields: Record<string, unknown>) => JSON.stringify({
    uuid,
    sessionId: providerSessionId,
    timestamp: `2026-10-28T06:44:${String(second).padStart(2, '0')}.000Z`,
    ...fields,
  });
  const tool = (id: string, name: string, input: unknown) => ({ type: 'tool_use', id, name, input });
  const result = (id: string, text: string) => ({ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] });
  const transcript = [
    row('u1', 13, { type: 'user', isMeta: true, message: { role: 'user', content: wakeText([['local/owner', 1]]) } }),
    row('a1', 16, { type: 'assistant', message: { role: 'assistant', content: [tool('t1', 'mcp__chat__read', { handle: 'local/owner' })] } }),
    row('u2', 16, { type: 'user', message: { role: 'user', content: [result('t1', `[local/owner]\n${ownerLine(1, '1001', 'you there?')}`)] } }),
    row('a2', 17, { type: 'assistant', message: { role: 'assistant', content: [tool('t2', 'Bash', { command: 'uptime' })] } }),
    row('u3', 17, { type: 'user', message: { role: 'user', content: [result('t2', 'up 3 days')] } }),
    row('a3', 18, { type: 'assistant', message: { role: 'assistant', content: [tool('t3', 'mcp__chat__reply_dry_run', { handle: 'local/owner', text: 'Here.' })] } }),
    row('u4', 18, { type: 'user', message: { role: 'user', content: [result('t3', draftResult('dd', 'Here.'))] } }),
    row('a4', 20, { type: 'assistant', message: { role: 'assistant', content: [tool('t4', 'mcp__chat__reply', { dry_run_id: 'dd' })] } }),
    row('u5', 20, { type: 'user', message: { role: 'user', content: [result('t4', 'sent (id: 1002)')] } }),
  ].join('\n');

  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-chat-bridge-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    const projectDirectory = path.join(tempDirectory, 'projects', '-workspace');
    await mkdir(projectDirectory, { recursive: true });
    const transcriptPath = path.join(projectDirectory, `${providerSessionId}.jsonl`);
    await writeFile(transcriptPath, `${transcript}\n`);
    sessionsDb.createSession(providerSessionId, 'claude', '/workspace', undefined, undefined, undefined, transcriptPath);

    const { messages, total } = await new ClaudeSessionsProvider().fetchHistory(providerSessionId);
    const visible = messages.filter((message) => message.kind !== 'tool_result');
    assert.deepEqual(visible.map((message) => (message.kind === 'tool_use' ? `tool ${message.toolName}` : `${message.role} ${message.content}`)), [
      'user you there?',
      'tool Bash',
      'assistant Here.',
    ]);
    assert.equal(visible[1].toolResult?.content, JSON.stringify([{ type: 'text', text: 'up 3 days' }]));
    assert.equal(total, 3);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
