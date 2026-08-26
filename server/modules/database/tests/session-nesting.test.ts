import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

/**
 * Runs one test against a throwaway database file.
 *
 * `seedLegacyDatabase` runs before the schema and migrations are applied, so a
 * test can hand `initializeDatabase` a database that already looks like an
 * older, populated install.
 */
async function withIsolatedDatabase(
  runTest: () => void | Promise<void>,
  seedLegacyDatabase?: (databasePath: string) => void,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-nesting-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  seedLegacyDatabase?.(databasePath);
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
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

/**
 * Writes the sessions schema as it shipped *before* `parent_session_id`
 * existed, with rows in it, so the migration is exercised against real data
 * rather than an empty file.
 */
function seedDatabaseWithoutParentColumn(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE projects (
        project_id TEXT PRIMARY KEY NOT NULL,
        project_path TEXT NOT NULL UNIQUE,
        custom_project_name TEXT DEFAULT NULL,
        isStarred BOOLEAN DEFAULT 0,
        isArchived BOOLEAN DEFAULT 0
      );

      CREATE TABLE sessions (
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'claude',
        provider_session_id TEXT,
        custom_name TEXT,
        project_path TEXT,
        jsonl_path TEXT,
        model TEXT,
        isArchived BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (session_id),
        FOREIGN KEY (project_path) REFERENCES projects(project_path)
        ON DELETE SET NULL
        ON UPDATE CASCADE
      );
    `);

    database
      .prepare('INSERT INTO projects (project_id, project_path) VALUES (?, ?)')
      .run('project-legacy', '/workspace/legacy');
    database
      .prepare(
        `INSERT INTO sessions (session_id, provider, provider_session_id, custom_name, project_path)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('legacy-session', 'claude', 'legacy-session', 'Legacy Session', '/workspace/legacy');
  } finally {
    database.close();
  }
}

test('the parent column is added to an already-populated database without touching its rows', async () => {
  await withIsolatedDatabase(() => {
    const columnNames = (getConnection().prepare('PRAGMA table_info(sessions)').all() as Array<{
      name: string;
    }>).map((column) => column.name);
    assert.ok(columnNames.includes('parent_session_id'));

    // The pre-existing row survives, and nesting starts out unset because
    // nothing in an older install describes it.
    const migrated = sessionsDb.getSessionById('legacy-session');
    assert.equal(migrated?.custom_name, 'Legacy Session');
    assert.equal(migrated?.project_path, '/workspace/legacy');
    assert.equal(migrated?.parent_session_id, null);
  }, seedDatabaseWithoutParentColumn);
});

test('the parent migration is safe to run twice', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('parent', 'claude', '/workspace/legacy');
    sessionsDb.createSession('child', 'claude', '/workspace/legacy');
    sessionsDb.updateSessionParentSessionId('child', 'parent');

    // Every app start re-runs migrations against the same file.
    await initializeDatabase();

    assert.equal(sessionsDb.getSessionById('child')?.parent_session_id, 'parent');
  }, seedDatabaseWithoutParentColumn);
});

test('the parent link is set and cleared through the repository', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('parent', 'claude', '/workspace/demo');
    sessionsDb.createSession('child', 'claude', '/workspace/demo');

    sessionsDb.updateSessionParentSessionId('child', 'parent');
    assert.equal(sessionsDb.getSessionById('child')?.parent_session_id, 'parent');

    sessionsDb.updateSessionParentSessionId('child', null);
    assert.equal(sessionsDb.getSessionById('child')?.parent_session_id, null);
  });
});

test('a session rescan leaves an externally written parent alone', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('parent', 'claude', '/workspace/demo', 'Secretary');
    sessionsDb.createSession('worker', 'claude', '/workspace/worker-repo', 'Worker');

    // The spawning process has no API key, so it writes the column directly.
    getConnection()
      .prepare('UPDATE sessions SET parent_session_id = ? WHERE session_id = ?')
      .run('parent', 'worker');

    // A synchronizer pass rewrites the row from what it found on disk.
    sessionsDb.createSession(
      'worker',
      'claude',
      '/workspace/worker-repo',
      'Worker',
      undefined,
      undefined,
      '/transcripts/worker.jsonl',
    );

    const worker = sessionsDb.getSessionById('worker');
    assert.equal(worker?.parent_session_id, 'parent');
    assert.equal(worker?.jsonl_path, '/transcripts/worker.jsonl');
  });
});

test('a re-inserted session row keeps its parent link', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('parent', 'claude', '/workspace/demo');
    sessionsDb.createSession('worker', 'claude', '/workspace/demo');
    sessionsDb.updateSessionParentSessionId('worker', 'parent');

    // Archiving and rediscovering a session takes the ON CONFLICT branch of
    // createSession rather than the UPDATE branch above.
    sessionsDb.updateSessionIsArchived('worker', true);
    getConnection().prepare('UPDATE sessions SET provider_session_id = NULL WHERE session_id = ?').run('worker');
    sessionsDb.createSession('worker', 'claude', '/workspace/demo', 'Rediscovered');

    const worker = sessionsDb.getSessionById('worker');
    assert.equal(worker?.parent_session_id, 'parent');
    assert.equal(worker?.isArchived, 0);
  });
});

test('merging a watcher-created duplicate carries its parent onto the app row', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('secretary', 'claude', '/workspace/demo', 'Secretary');
    sessionsDb.createAppSession('app-worker', 'claude', '/workspace/worker-repo');

    // The watcher indexed the transcript before the runtime announced its id,
    // and the spawner nested that provider-keyed row.
    sessionsDb.createSession('provider-worker', 'claude', '/workspace/worker-repo', 'Worker');
    sessionsDb.updateSessionParentSessionId('provider-worker', 'secretary');

    sessionsDb.assignProviderSessionId('app-worker', 'provider-worker');

    assert.equal(sessionsDb.getAllSessions().length, 2);
    assert.equal(sessionsDb.getSessionById('app-worker')?.parent_session_id, 'secretary');
  });
});

test('parent refs resolve by app id and by provider id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-parent', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-parent', 'provider-parent');
    sessionsDb.updateSessionCustomName('app-parent', 'Secretary');

    const refs = sessionsDb.getParentSessionRefs(['app-parent', 'provider-parent']);

    // An external writer that only knows the provider id still produces a ref
    // pointing at the canonical app id.
    assert.deepEqual(refs.get('app-parent'), {
      sessionId: 'app-parent',
      summary: 'Secretary',
      projectPath: '/workspace/demo',
    });
    assert.deepEqual(refs.get('provider-parent'), {
      sessionId: 'app-parent',
      summary: 'Secretary',
      projectPath: '/workspace/demo',
    });
  });
});

test('parent refs skip archived and deleted parents', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('archived-parent', 'claude', '/workspace/demo', 'Archived');
    sessionsDb.updateSessionIsArchived('archived-parent', true);

    const refs = sessionsDb.getParentSessionRefs(['archived-parent', 'never-existed']);

    assert.equal(refs.size, 0);
  });
});

test('parent refs tolerate an empty request', async () => {
  await withIsolatedDatabase(() => {
    assert.equal(sessionsDb.getParentSessionRefs([]).size, 0);
  });
});
