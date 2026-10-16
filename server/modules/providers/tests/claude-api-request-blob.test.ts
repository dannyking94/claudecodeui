import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Loads a copied transcript through the real history path: a throwaway
 * database row pointing at a temp copy of the fixture, then `fetchHistory`.
 */
async function fetchFixtureHistory(fixtureName: string, providerSessionId: string) {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-request-blob-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    const projectDirectory = path.join(tempDirectory, 'projects', '-workspace');
    await mkdir(projectDirectory, { recursive: true });
    const transcriptPath = path.join(projectDirectory, `${providerSessionId}.jsonl`);
    await copyFile(path.join(FIXTURES, fixtureName), transcriptPath);
    sessionsDb.createSession(providerSessionId, 'claude', '/workspace', undefined, undefined, undefined, transcriptPath);

    return await new ClaudeSessionsProvider().fetchHistory(providerSessionId);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function userBubbles(messages: Array<{ kind: string; role?: string; content?: string; timestamp: string }>) {
  return messages
    .filter((message) => message.kind === 'text' && message.role === 'user')
    .map(({ content, timestamp }) => ({ content, timestamp }));
}

// Rows copied (and trimmed) from 8ecd00e6-bc1d-4eb2-b726-d6877333ea43, lines
// 8, 9, 12, 29, 69, 76–78, 84, 85. Line 29 is the `api-request-blob` that
// restates the session's first prompt with no timestamp or uuid.
test('an api-request-blob does not re-show the first prompt during a later turn', async () => {
  const { messages } = await fetchFixtureHistory(
    'claude-api-request-blob-8ecd00e6.jsonl',
    '8ecd00e6-bc1d-4eb2-b726-d6877333ea43',
  );

  assert.deepEqual(userBubbles(messages), [
    { content: "ok summerize what has been done and what's next", timestamp: '2026-10-16T13:11:34.698Z' },
    {
      content: 'tecpcentre is landed so can you create labels with dexonomy that are tcp aligned?',
      timestamp: '2026-10-16T13:22:42.404Z',
    },
  ]);
  // The tool call from the blob-free turn still renders with its result.
  const toolUse = messages.find((message) => message.kind === 'tool_use');
  assert.equal(toolUse?.toolResult?.content, '(trimmed)');
});

// Lines 1–3 of claude-queued-user-replay.jsonl plus the trimmed
// `api-request-blob` at line 17996 of d907f689-d706-4b5c-9d60-5fddec873728.
test('an api-request-blob does not duplicate a queued prompt at fetch time', async () => {
  const { messages, total } = await fetchFixtureHistory(
    'claude-api-request-blob-d907f689.jsonl',
    'd907f689-d706-4b5c-9d60-5fddec873728',
  );

  assert.deepEqual(userBubbles(messages), [{
    content: 'i have read ib4-meshfail but how does wrist is placed? because wrist placement is bad from the start',
    timestamp: '2026-10-15T08:07:29.633Z',
  }]);
  assert.equal(total, 1);
});
