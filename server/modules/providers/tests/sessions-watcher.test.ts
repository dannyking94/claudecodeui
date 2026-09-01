import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  captureSessionDbBaseline,
  closeSessionsWatcher,
  pollExternalSessionDbChanges,
} from '@/modules/providers/services/sessions-watcher.service.js';
import { connectedClients } from '@/modules/websocket/index.js';

/**
 * Minimal stand-in for a websocket connection: collects every JSON frame the
 * watcher broadcasts so assertions can inspect the outbound protocol.
 */
class FakeConnection {
  readyState = 1; // WS_OPEN_STATE
  frames: Array<Record<string, unknown>> = [];

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  sessionUpserts(): Array<Record<string, unknown>> {
    return this.frames.filter((frame) => frame.kind === 'session_upserted');
  }
}

/** Longer than the watcher's 500ms broadcast debounce. */
const DEBOUNCE_SETTLE_MS = 800;
const settle = () => new Promise((resolve) => setTimeout(resolve, DEBOUNCE_SETTLE_MS));

async function withIsolatedDatabase(
  runTest: (context: { connection: FakeConnection; databasePath: string }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-watcher-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  const connection = new FakeConnection();
  connectedClients.add(connection as never);

  try {
    await runTest({ connection, databasePath });
  } finally {
    connectedClients.clear();
    // Also clears the pending-flush timer and the change-detection baseline, so
    // module state never leaks into the next test.
    await closeSessionsWatcher();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes to the database the way an outside process does — its own connection,
 * so SQLite's `data_version` moves and no file the watcher watches is touched.
 * This is what `dk-ai-0/scripts/session-name.py` does when it names a worker
 * session and links it to the session that spawned it.
 */
function writeAsExternalProcess(databasePath: string, apply: (db: Database.Database) => void): void {
  const externalDb = new Database(databasePath);
  try {
    externalDb.pragma('busy_timeout = 5000');
    apply(externalDb);
  } finally {
    externalDb.close();
  }
}

test('an external database-only write broadcasts a session_upserted delta', async () => {
  await withIsolatedDatabase(async ({ connection, databasePath }) => {
    sessionsDb.createSession('worker-1', 'claude', '/workspace/demo', 'Untitled Claude Session');
    captureSessionDbBaseline();

    writeAsExternalProcess(databasePath, (db) => {
      db.prepare('UPDATE sessions SET custom_name = ? WHERE session_id = ?').run('worker one', 'worker-1');
    });

    pollExternalSessionDbChanges();
    await settle();

    const upserts = connection.sessionUpserts();
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0]?.sessionId, 'worker-1');
    assert.equal((upserts[0]?.session as { summary?: string })?.summary, 'worker one');
  });
});

test('a parent link written after the row carries the corrected parent in the delta', async () => {
  await withIsolatedDatabase(async ({ connection, databasePath }) => {
    // The real ordering: the worker's first transcript lines are indexed before
    // anything knows which session spawned it, so the row starts out flat.
    sessionsDb.createSession('secretary-1', 'claude', '/workspace/secretary', 'secretary dk-ai-0');
    sessionsDb.createSession('worker-2', 'claude', '/workspace/worker', 'Untitled Claude Session');
    assert.equal(sessionsDb.getSessionById('worker-2')?.parent_session_id, null);
    captureSessionDbBaseline();

    writeAsExternalProcess(databasePath, (db) => {
      db.prepare('UPDATE sessions SET custom_name = ?, parent_session_id = ? WHERE session_id = ?')
        .run('worker two', 'secretary-1', 'worker-2');
    });

    pollExternalSessionDbChanges();
    await settle();

    const upsert = connection.sessionUpserts().find((frame) => frame.sessionId === 'worker-2');
    assert.ok(upsert, 'the late parent link must produce a delta for the child row');
    const session = upsert.session as {
      summary?: string;
      parentSessionId?: string | null;
      parentSummary?: string | null;
    };
    // Without these the sidebar would merge the delta over its loaded row and
    // drop the session back out of its parent's subtree.
    assert.equal(session.parentSessionId, 'secretary-1');
    assert.equal(session.parentSummary, 'secretary dk-ai-0');
    assert.equal(session.summary, 'worker two');
  });
});

test("this server's own writes never trigger a delta", async () => {
  await withIsolatedDatabase(async ({ connection }) => {
    sessionsDb.createSession('worker-3', 'claude', '/workspace/demo', 'Untitled Claude Session');
    captureSessionDbBaseline();

    // Same connection as the watcher, so `data_version` does not move: the app's
    // own writes already broadcast through the chat gateway, and re-announcing
    // them here would double every rename the user performs.
    sessionsDb.updateSessionCustomName('worker-3', 'renamed in app');

    pollExternalSessionDbChanges();
    await settle();

    assert.deepEqual(connection.sessionUpserts(), []);
  });
});

test('a quiet database produces no deltas however often it is polled', async () => {
  await withIsolatedDatabase(async ({ connection }) => {
    sessionsDb.createSession('worker-4', 'claude', '/workspace/demo', 'worker four');
    captureSessionDbBaseline();

    for (let poll = 0; poll < 25; poll += 1) {
      pollExternalSessionDbChanges();
    }
    await settle();

    assert.deepEqual(connection.sessionUpserts(), []);
  });
});

test('an archived row changed externally is not announced to the sidebar', async () => {
  await withIsolatedDatabase(async ({ connection, databasePath }) => {
    sessionsDb.createSession('worker-5', 'claude', '/workspace/demo', 'worker five');
    captureSessionDbBaseline();

    writeAsExternalProcess(databasePath, (db) => {
      db.prepare('UPDATE sessions SET isArchived = 1, custom_name = ? WHERE session_id = ?')
        .run('archived worker', 'worker-5');
    });

    pollExternalSessionDbChanges();
    await settle();

    // The change is detected, but an archived session has left the sidebar, so
    // the delta builder declines to describe it.
    assert.deepEqual(connection.sessionUpserts(), []);
  });
});
