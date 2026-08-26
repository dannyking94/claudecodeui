import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { getProjectSessionsPage } from '@/modules/projects/services/projects-with-sessions-fetch.service.js';

const SECRETARY_PROJECT_PATH = '/workspace/cloudcli';
const WORKER_PROJECT_PATH = '/workspace/worker-repo';

async function withIsolatedDatabase(runTest: () => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'project-session-nesting-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
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

/** Reads the worker project's session page, which is what the sidebar renders. */
async function readWorkerSessions() {
  const workerProject = projectsDb.getProjectPath(WORKER_PROJECT_PATH);
  assert.ok(workerProject);
  const page = await getProjectSessionsPage(workerProject.project_id);
  return page.sessions;
}

test('a session page reports the parent that spawned each session', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('secretary', 'claude', SECRETARY_PROJECT_PATH, 'Secretary');
    sessionsDb.createSession('worker', 'claude', WORKER_PROJECT_PATH, 'Worker');
    sessionsDb.updateSessionParentSessionId('worker', 'secretary');

    const [worker] = await readWorkerSessions();

    // The worker stays in its own repository's page and carries enough about
    // the parent for the sidebar to label the relationship.
    assert.equal(worker.id, 'worker');
    assert.equal(worker.parentSessionId, 'secretary');
    assert.equal(worker.parentSummary, 'Secretary');
    assert.equal(worker.parentProjectPath, SECRETARY_PROJECT_PATH);
  });
});

test('a parent recorded by its provider id still resolves to the app session id', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('app-secretary', 'claude', SECRETARY_PROJECT_PATH);
    sessionsDb.assignProviderSessionId('app-secretary', 'provider-secretary');
    sessionsDb.updateSessionCustomName('app-secretary', 'Secretary');
    sessionsDb.createSession('worker', 'claude', WORKER_PROJECT_PATH, 'Worker');

    // An outside spawner may only hold the provider-native id of the parent.
    sessionsDb.updateSessionParentSessionId('worker', 'provider-secretary');

    const [worker] = await readWorkerSessions();

    assert.equal(worker.parentSessionId, 'app-secretary');
    assert.equal(worker.parentSummary, 'Secretary');
  });
});

test('an archived parent is reported as no parent at all', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('secretary', 'claude', SECRETARY_PROJECT_PATH, 'Secretary');
    sessionsDb.createSession('worker', 'claude', WORKER_PROJECT_PATH, 'Worker');
    sessionsDb.updateSessionParentSessionId('worker', 'secretary');
    sessionsDb.updateSessionIsArchived('secretary', true);

    const [worker] = await readWorkerSessions();

    // The row is still listed; it just stops claiming a parent nobody can open.
    assert.equal(worker.id, 'worker');
    assert.equal(worker.parentSessionId, null);
    assert.equal(worker.parentSummary, null);
    assert.equal(worker.parentProjectPath, null);
  });
});

test('a deleted parent leaves the child listed with no parent', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('secretary', 'claude', SECRETARY_PROJECT_PATH, 'Secretary');
    sessionsDb.createSession('worker', 'claude', WORKER_PROJECT_PATH, 'Worker');
    sessionsDb.updateSessionParentSessionId('worker', 'secretary');
    sessionsDb.deleteSessionById('secretary');

    const [worker] = await readWorkerSessions();

    assert.equal(worker.id, 'worker');
    assert.equal(worker.parentSessionId, null);
    // The dangling id stays in the column, so restoring the parent restores the
    // nesting; only the payload collapses it.
    assert.equal(sessionsDb.getSessionById('worker')?.parent_session_id, 'secretary');
  });
});

test('a top-level session reports no parent', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createSession('worker', 'claude', WORKER_PROJECT_PATH, 'Worker');

    const [worker] = await readWorkerSessions();

    assert.equal(worker.parentSessionId, null);
    assert.equal(worker.parentSummary, null);
    assert.equal(worker.parentProjectPath, null);
  });
});
