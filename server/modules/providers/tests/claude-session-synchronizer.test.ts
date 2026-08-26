import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionSynchronizer } from '@/modules/providers/list/claude/claude-session-synchronizer.provider.js';

const PROVIDER_SESSION_ID = 'claude-worker-session';
const WORKER_PROJECT_PATH = '/workspace/worker-repo';

type SynchronizerTestContext = {
  synchronizer: ClaudeSessionSynchronizer;
  transcriptPath: string;
};

/**
 * Runs one test with a throwaway database and a throwaway `$HOME` holding a
 * single Claude transcript.
 *
 * The synchronizer resolves `~/.claude` in its constructor, so the home
 * override has to be in place before it is built — otherwise the test would
 * scan the machine's real Claude projects folder.
 */
async function withSynchronizer(
  runTest: (context: SynchronizerTestContext) => void | Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousHome = process.env.HOME;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'claude-synchronizer-'));
  const claudeProjectDirectory = path.join(
    tempDirectory,
    'home',
    '.claude',
    'projects',
    '-workspace-worker-repo',
  );

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  process.env.HOME = path.join(tempDirectory, 'home');
  await initializeDatabase();

  await mkdir(claudeProjectDirectory, { recursive: true });
  const transcriptPath = path.join(claudeProjectDirectory, `${PROVIDER_SESSION_ID}.jsonl`);
  await writeFile(
    transcriptPath,
    `${JSON.stringify({ sessionId: PROVIDER_SESSION_ID, cwd: WORKER_PROJECT_PATH })}\n`,
  );

  try {
    await runTest({ synchronizer: new ClaudeSessionSynchronizer(), transcriptPath });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes the two columns an outside spawner owns, the way it does it: straight
 * into the database, with no API key and no running app.
 */
function writeParentLinkExternally(sessionId: string, parentSessionId: string, customName: string): void {
  getConnection()
    .prepare('UPDATE sessions SET parent_session_id = ?, custom_name = ? WHERE session_id = ?')
    .run(parentSessionId, customName, sessionId);
}

test('re-indexing one transcript preserves a parent link written outside the app', async () => {
  await withSynchronizer(async ({ synchronizer, transcriptPath }) => {
    sessionsDb.createSession('secretary-session', 'claude', '/workspace/cloudcli', 'Secretary');
    await synchronizer.synchronizeFile(transcriptPath);
    writeParentLinkExternally(PROVIDER_SESSION_ID, 'secretary-session', 'Worker: session nesting');

    // Nothing on disk changed, but the file watcher re-indexes the transcript.
    await synchronizer.synchronizeFile(transcriptPath);

    const worker = sessionsDb.getSessionById(PROVIDER_SESSION_ID);
    assert.equal(worker?.parent_session_id, 'secretary-session');
    assert.equal(worker?.custom_name, 'Worker: session nesting');
  });
});

test('a full rescan of ~/.claude/projects preserves a parent link', async () => {
  await withSynchronizer(async ({ synchronizer }) => {
    sessionsDb.createSession('secretary-session', 'claude', '/workspace/cloudcli', 'Secretary');
    assert.equal(await synchronizer.synchronize(), 1);
    writeParentLinkExternally(PROVIDER_SESSION_ID, 'secretary-session', 'Worker: session nesting');

    assert.equal(await synchronizer.synchronize(), 1);

    const worker = sessionsDb.getSessionById(PROVIDER_SESSION_ID);
    assert.equal(worker?.parent_session_id, 'secretary-session');
    assert.equal(worker?.custom_name, 'Worker: session nesting');
  });
});

test('a Claude sync still records a session that has no parent', async () => {
  await withSynchronizer(async ({ synchronizer, transcriptPath }) => {
    const sessionId = await synchronizer.synchronizeFile(transcriptPath);

    assert.equal(sessionId, PROVIDER_SESSION_ID);
    const session = sessionsDb.getSessionById(PROVIDER_SESSION_ID);
    assert.equal(session?.project_path, WORKER_PROJECT_PATH);
    assert.equal(session?.parent_session_id, null);
  });
});
