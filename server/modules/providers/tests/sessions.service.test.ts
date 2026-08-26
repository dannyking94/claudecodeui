import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-db-'));

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

test('provider session id returns the mapped native id', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-id', 'codex', '/tmp/session-id-copy-project');
    sessionsDb.assignProviderSessionId('app-session-id', 'codex-native-session-id');

    assert.equal(sessionsService.getProviderSessionId('app-session-id'), 'codex-native-session-id');
  });
});

test('provider session id is unavailable until the provider assigns one', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('pending-app-session', 'claude', '/tmp/session-id-copy-project');

    assert.throws(
      () => sessionsService.getProviderSessionId('pending-app-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'PROVIDER_SESSION_ID_NOT_AVAILABLE' && typedError.statusCode === 409;
      },
    );
  });
});

test('provider session id reports a missing app session', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () => sessionsService.getProviderSessionId('missing-session'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'SESSION_NOT_FOUND' && typedError.statusCode === 404;
      },
    );
  });
});

test('a session is nested under a parent in another project', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('secretary', 'claude', '/tmp/cloudcli', 'Secretary');
    sessionsDb.createSession('worker', 'claude', '/tmp/worker-repo', 'Worker');

    // Parent and child in different repositories is the normal shape here, not
    // an edge case, so it must not be rejected.
    const result = sessionsService.setSessionParentById('worker', 'secretary');

    assert.deepEqual(result, { sessionId: 'worker', parentSessionId: 'secretary' });
    assert.equal(sessionsDb.getSessionById('worker')?.parent_session_id, 'secretary');
  });
});

test('nesting normalizes provider-native ids to app session ids', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-secretary', 'claude', '/tmp/cloudcli');
    sessionsDb.assignProviderSessionId('app-secretary', 'provider-secretary');
    sessionsDb.createAppSession('app-worker', 'claude', '/tmp/worker-repo');
    sessionsDb.assignProviderSessionId('app-worker', 'provider-worker');

    const result = sessionsService.setSessionParentById('provider-worker', 'provider-secretary');

    assert.deepEqual(result, { sessionId: 'app-worker', parentSessionId: 'app-secretary' });
  });
});

test('a null parent unnests a session', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('secretary', 'claude', '/tmp/cloudcli');
    sessionsDb.createSession('worker', 'claude', '/tmp/worker-repo');
    sessionsService.setSessionParentById('worker', 'secretary');

    const result = sessionsService.setSessionParentById('worker', null);

    assert.deepEqual(result, { sessionId: 'worker', parentSessionId: null });
    assert.equal(sessionsDb.getSessionById('worker')?.parent_session_id, null);
  });
});

test('a session cannot be its own parent', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('worker', 'claude', '/tmp/worker-repo');

    assert.throws(
      () => sessionsService.setSessionParentById('worker', 'worker'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'SESSION_PARENT_CYCLE' && typedError.statusCode === 400;
      },
    );
  });
});

test('nesting a session under its own descendant is rejected', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('grandparent', 'claude', '/tmp/cloudcli');
    sessionsDb.createSession('parent', 'claude', '/tmp/cloudcli');
    sessionsDb.createSession('child', 'claude', '/tmp/worker-repo');
    sessionsService.setSessionParentById('parent', 'grandparent');
    sessionsService.setSessionParentById('child', 'parent');

    assert.throws(
      () => sessionsService.setSessionParentById('grandparent', 'child'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'SESSION_PARENT_CYCLE' && typedError.statusCode === 400;
      },
    );

    assert.equal(sessionsDb.getSessionById('grandparent')?.parent_session_id, null);
  });
});

test('nesting stops rather than hangs on a cycle already in the database', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('a', 'claude', '/tmp/cloudcli');
    sessionsDb.createSession('b', 'claude', '/tmp/cloudcli');
    sessionsDb.createSession('orphan', 'claude', '/tmp/worker-repo');

    // Direct column writes bypass the service's cycle check entirely.
    sessionsDb.updateSessionParentSessionId('a', 'b');
    sessionsDb.updateSessionParentSessionId('b', 'a');

    assert.throws(
      () => sessionsService.setSessionParentById('orphan', 'a'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'SESSION_PARENT_CYCLE' && typedError.statusCode === 400;
      },
    );
  });
});

test('nesting under an unknown parent reports a missing session', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('worker', 'claude', '/tmp/worker-repo');

    assert.throws(
      () => sessionsService.setSessionParentById('worker', 'never-existed'),
      (error: unknown) => {
        const typedError = error as { code?: string; statusCode?: number };
        return typedError.code === 'SESSION_NOT_FOUND' && typedError.statusCode === 404;
      },
    );
  });
});
