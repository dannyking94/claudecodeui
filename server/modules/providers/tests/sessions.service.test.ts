import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { codexCliLiveness } from '@/modules/providers/services/codex-cli-liveness.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { BackgroundTaskSummary } from '@/shared/types.js';

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

test('app session names use at most four whole words from the initial message', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsService.createAppSession(
      'codex',
      '/tmp/session-name-project',
      '  supercalifragilisticexpialidocious\nsecond   third fourth fifth  ',
    );

    assert.equal(result.sessionName, 'supercalifragilisticexpialidocious second third fourth');
    assert.equal(
      sessionsDb.getSessionById(result.sessionId)?.custom_name,
      'supercalifragilisticexpialidocious second third fourth',
    );
  });
});

test('app sessions without message text receive a stable fallback name', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    const result = sessionsService.createAppSession('claude', '/tmp/attachment-only-project', '  \n ');

    assert.equal(result.sessionName, 'Untitled Session');
    assert.equal(sessionsDb.getSessionById(result.sessionId)?.custom_name, 'Untitled Session');
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

test('recent sessions map project metadata and preserve database pagination', { concurrency: false }, async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession(
      'older-session',
      'claude',
      '/tmp/recent-project',
      'Older conversation',
      '2026-08-01T08:00:00.000Z',
      '2026-08-01T09:00:00.000Z',
    );
    sessionsDb.createSession(
      'newer-session',
      'codex',
      '/tmp/recent-project',
      'Newer conversation',
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T11:00:00.000Z',
    );
    projectsDb.updateCustomProjectName('/tmp/recent-project', 'Recent Project');

    const project = projectsDb.getProjectPath('/tmp/recent-project');
    const page = sessionsService.listRecentSessions(1, 0);

    assert.deepEqual(page, {
      conversations: [{
        sessionId: 'newer-session',
        provider: 'codex',
        projectId: project?.project_id ?? null,
        projectDisplayName: 'Recent Project',
        sessionTitle: 'Newer conversation',
        lastActivity: '2026-08-01T11:00:00.000Z',
      }],
      total: 2,
      hasMore: true,
    });
  });
});

/** One Claude transcript row of user or assistant text, linked by uuid chain. */
function claudeTextRow(
  sessionId: string,
  role: 'user' | 'assistant',
  text: string,
  ordinal: number,
): Record<string, unknown> {
  return {
    type: role,
    uuid: `row-${ordinal}`,
    parentUuid: ordinal === 0 ? null : `row-${ordinal - 1}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ordinal)).toISOString(),
    sessionId,
    message: { role, content: [{ type: 'text', text }] },
  };
}

test('history pages are sliced from the cached full transcript and see appended rows', { concurrency: false }, async () => {
  const transcriptDirectory = await mkdtemp(path.join(os.tmpdir(), 'sessions-service-history-'));
  const sessionId = 'claude-history-cache-session';
  const transcriptPath = path.join(transcriptDirectory, `${sessionId}.jsonl`);

  try {
    await withIsolatedDatabase(async () => {
      const rows = [
        claudeTextRow(sessionId, 'user', 'one', 0),
        claudeTextRow(sessionId, 'assistant', 'reply one', 1),
        claudeTextRow(sessionId, 'user', 'two', 2),
        claudeTextRow(sessionId, 'assistant', 'reply two', 3),
      ];
      await writeFile(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
      sessionsDb.createSession(
        sessionId,
        'claude',
        '/tmp/history-cache-project',
        'History cache conversation',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:10.000Z',
        transcriptPath,
      );

      const page = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 0 });
      assert.equal(page.total, 4);
      assert.equal(page.hasMore, true);
      assert.deepEqual(page.messages.map((message) => message.content), ['two', 'reply two']);

      // A row appended after the page was cached must appear on the next read.
      await appendFile(
        transcriptPath,
        `${JSON.stringify(claudeTextRow(sessionId, 'user', 'three', 4))}\n`,
        'utf8',
      );
      const refreshed = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 0 });
      assert.equal(refreshed.total, 5);
      assert.deepEqual(refreshed.messages.map((message) => message.content), ['reply two', 'three']);

      // An older page keeps the tail-offset contract while served from cache.
      const older = await sessionsService.fetchHistory(sessionId, { limit: 2, offset: 2 });
      assert.deepEqual(older.messages.map((message) => message.content), ['reply one', 'two']);
      assert.equal(older.hasMore, true);
    });
  } finally {
    await rm(transcriptDirectory, { recursive: true, force: true });
  }
});

/**
 * Stands in for the provider registry with one provider per id, each with the
 * runtime given — the seam through which a runtime's background work reaches
 * the running-sessions list without an SDK run behind it.
 */
async function withProviders(
  runtimes: Partial<Record<'claude' | 'codex', IProvider['runtime']>>,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const realListProviders = providerRegistry.listProviders;
  providerRegistry.listProviders = () =>
    Object.entries(runtimes).map(([id, runtime]) => ({ id, runtime }) as IProvider);
  try {
    await runTest();
  } finally {
    providerRegistry.listProviders = realListProviders;
    chatRunRegistry.clearAll();
  }
}

/**
 * Runs `runTest` against a Claude CLI process registry containing exactly
 * `records`, so the running-sessions tests never read the developer's real
 * `~/.claude/sessions`.
 */
async function withClaudeCliRegistry(
  records: Array<Record<string, unknown>>,
  runTest: () => void | Promise<void>,
): Promise<void> {
  const homeDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-cli-registry-'));
  await mkdir(path.join(homeDirectory, '.claude', 'sessions'), { recursive: true });
  for (const record of records) {
    await writeFile(
      path.join(homeDirectory, '.claude', 'sessions', `${record.pid}.json`),
      JSON.stringify(record),
      'utf8',
    );
  }

  const realHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => homeDirectory;
  // The host's real codex processes must not leak into a claude-only snapshot.
  const realListCodex = codexCliLiveness.listLiveSessions;
  codexCliLiveness.listLiveSessions = async () => [];
  try {
    await runTest();
  } finally {
    codexCliLiveness.listLiveSessions = realListCodex;
    (os as unknown as { homedir: () => string }).homedir = realHomedir;
    await rm(homeDirectory, { recursive: true, force: true });
  }
}

const task = (taskId: string, startedAt: number): BackgroundTaskSummary => ({
  taskId,
  toolUseId: `toolu_${taskId}`,
  taskType: 'local_agent',
  description: `Task ${taskId}`,
  startedAt,
});

test('running sessions list a session whose background work outlived its turn', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('held-session', 'claude', '/tmp/running-project');
    // The turn ran and completed: the registry still holds the finished run.
    const run = chatRunRegistry.startRun({
      appSessionId: 'held-session', provider: 'claude', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);
    run.writer.send({ kind: 'text', content: 'launched', sessionId: 'held-session', provider: 'claude' });
    run.writer.sendComplete({ exitCode: 0 });
    assert.equal(run.status, 'completed');

    const tasks = [task('late', 2_000), task('early', 1_000)];
    await withClaudeCliRegistry([], async () => await withProviders(
      { claude: { run: async () => undefined, abort: () => false, listBackgroundWork: () => [{ sessionId: 'held-session', tasks }] } },
      async () => {
        assert.deepEqual(await sessionsService.listRunningSessions(), [{
          sessionId: 'held-session',
          provider: 'claude',
          startedAt: 1_000,
          lastSeq: run.lastSeq,
          background: true,
          canInterrupt: false,
          tasks,
        }]);
        assert.ok(run.lastSeq > 0, 'the finished run still reports its sequence for replay');
      },
    ));
  });
});

test('running sessions carry their tasks on a chat run that is still going', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('busy-session', 'claude', '/tmp/running-project');
    sessionsDb.createAppSession('idle-session', 'codex', '/tmp/running-project');
    const run = chatRunRegistry.startRun({
      appSessionId: 'busy-session', provider: 'claude', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    const tasks = [task('agent', 5_000)];
    await withClaudeCliRegistry([], async () => await withProviders(
      {
        claude: { run: async () => undefined, abort: () => false, listBackgroundWork: () => [{ sessionId: 'busy-session', tasks }] },
        // A runtime without background work contributes chat runs alone.
        codex: { run: async () => undefined, abort: () => false },
      },
      async () => {
        const sessions = await sessionsService.listRunningSessions();
        assert.equal(sessions.length, 1, 'a session with a running chat run is listed once');
        assert.deepEqual(sessions[0], {
          sessionId: 'busy-session',
          provider: 'claude',
          startedAt: run.startedAt,
          lastSeq: 0,
          tasks,
        });
      },
    ));
  });
});

test('running sessions with no background work are the chat runs alone', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('plain-session', 'codex', '/tmp/running-project');
    const run = chatRunRegistry.startRun({
      appSessionId: 'plain-session', provider: 'codex', providerSessionId: null, connection: null, userId: null,
    });
    assert.ok(run);

    await withClaudeCliRegistry([], async () => await withProviders(
      { codex: { run: async () => undefined, abort: () => false } },
      async () => {
        assert.deepEqual(await sessionsService.listRunningSessions(), [{
          sessionId: 'plain-session', provider: 'codex', startedAt: run.startedAt, lastSeq: 0,
        }]);
      },
    ));
  });
});

test('running sessions report a turn driven by the Claude CLI', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('cli-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('cli-session', 'claude-native-1');

    // `process.pid` is the one pid guaranteed to be alive; omitting procStart
    // keeps the fixture portable, since the start-time cross-check is Linux-only.
    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-1', status: 'busy', entrypoint: 'cli', startedAt: 4_000 }],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          assert.deepEqual(await sessionsService.listRunningSessions(), [{
            sessionId: 'cli-session',
            provider: 'claude',
            startedAt: 4_000,
            lastSeq: 0,
            canInterrupt: false,
            statusText: 'Running in the Claude CLI',
          }]);
        },
      ),
    );
  });
});

test('running sessions ignore registry files a crash left behind', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('stale-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('stale-session', 'claude-native-stale');

    await withClaudeCliRegistry(
      [
        // The process is gone: signal 0 cannot find this pid.
        { pid: 4_194_302, sessionId: 'claude-native-stale', status: 'busy', startedAt: 1_000 },
        // Alive, but waiting for input rather than producing a response.
        { pid: process.pid, sessionId: 'claude-native-idle', status: 'idle', startedAt: 2_000 },
      ],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          assert.deepEqual(await sessionsService.listRunningSessions(), []);
        },
      ),
    );
  });
});

test('a CLI turn does not duplicate a session already running a chat run', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('both-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('both-session', 'claude-native-both');
    const run = chatRunRegistry.startRun({
      appSessionId: 'both-session', provider: 'claude', providerSessionId: 'claude-native-both', connection: null, userId: null,
    });
    assert.ok(run);

    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-both', status: 'busy', startedAt: 3_000 }],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          const sessions = await sessionsService.listRunningSessions();
          assert.equal(sessions.length, 1, 'the chat run already covers this session');
          assert.equal(sessions[0].canInterrupt, undefined, 'the interruptible chat run entry wins');
        },
      ),
    );
  });
});

test('an unreadable registry never fails the running-sessions poll', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('safe-session', 'claude', '/tmp/running-project');
    sessionsDb.assignProviderSessionId('safe-session', 'claude-native-safe');

    await withClaudeCliRegistry(
      [{ pid: process.pid, sessionId: 'claude-native-safe', status: 'busy', startedAt: 5_000 }],
      async () => {
        // A half-written file sits alongside the good one; it must be skipped
        // rather than abort the whole poll.
        await writeFile(path.join(os.homedir(), '.claude', 'sessions', 'broken.json'), '{"pid":', 'utf8');
        await withProviders(
          { claude: { run: async () => undefined, abort: () => false } },
          async () => {
            const sessions = await sessionsService.listRunningSessions();
            assert.deepEqual(sessions.map((session) => session.sessionId), ['safe-session']);
          },
        );
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

test('the liveness snapshot tells an idle process from an exited one, from one registry scan', { concurrency: false }, async () => {
  // The sidebar folds a worker the moment its process is gone. An idle one at
  // its prompt is reported apart from the running ones; an exited one nowhere.
  await withIsolatedDatabase(async () => {
    for (const [appId, nativeId] of [['idle-app', 'native-idle'], ['gone-app', 'native-gone'], ['busy-app', 'native-busy']]) {
      sessionsDb.createAppSession(appId, 'claude', '/tmp/running-project');
      sessionsDb.assignProviderSessionId(appId, nativeId);
    }

    await withClaudeCliRegistry(
      [
        { pid: process.pid, sessionId: 'native-idle', status: 'idle', startedAt: 1_000 },
        { pid: 4_194_302, sessionId: 'native-gone', status: 'idle', startedAt: 2_000 },
        { pid: process.ppid, sessionId: 'native-busy', status: 'busy', startedAt: 3_000 },
      ],
      async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          const snapshot = await sessionsService.readSessionLiveness();
          assert.deepEqual(snapshot.sessions.map((session) => session.sessionId), ['busy-app']);
          assert.deepEqual(snapshot.idleProcessSessionIds, ['idle-app']);
          assert.equal(snapshot.includesExternalActivity, true);
        },
      ),
    );
  });
});

test('the liveness snapshot lists a mid-turn secretary as external activity', { concurrency: false }, async () => {
  const { claudeSecretaryActivity } = await import('@/modules/providers/list/claude/claude-secretary-activity.provider.js');
  const realList = claudeSecretaryActivity.listWorkingSessions;
  claudeSecretaryActivity.listWorkingSessions = () => [{ appSessionId: 'secretary-app', since: 7_000 }];
  try {
    await withIsolatedDatabase(async () => {
      await withClaudeCliRegistry([], async () => await withProviders(
        { claude: { run: async () => undefined, abort: () => false } },
        async () => {
          const snapshot = await sessionsService.readSessionLiveness();
          assert.deepEqual(snapshot.sessions, [{
            sessionId: 'secretary-app', provider: 'claude', startedAt: 7_000, lastSeq: 0, canInterrupt: false, external: true,
          }]);
        },
      ));
    });
  } finally {
    claudeSecretaryActivity.listWorkingSessions = realList;
  }
});

test('the liveness snapshot maps deathwatch workers to their app sessions', { concurrency: false }, async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('worker-app', 'claude', '/tmp/deathwatch-project');
    sessionsDb.assignProviderSessionId('worker-app', 'worker-provider');
    await withClaudeCliRegistry([], async () => {
      const home = os.homedir();
      const checkout = path.join(home, 'secretary');
      await mkdir(path.join(checkout, 'states'), { recursive: true });
      await mkdir(path.join(home, '.config', 'dk-secretaries'), { recursive: true });
      await writeFile(
        path.join(home, '.config', 'dk-secretaries', 'registry.json'),
        JSON.stringify({ instances: { 'dk-ai-0': { cwd: checkout } } }),
        'utf8',
      );
      await writeFile(path.join(checkout, 'states', 'deathwatch-state.json'), JSON.stringify({
        version: 1,
        instance: 'dk-ai-0',
        generated_epoch: Math.floor(Date.now() / 1000),
        workers: [
          { name: 'sidebar', session_id: 'worker-provider', state: 'died', cause: 'OOM-killed 11:10', since: '2026-11-24 11:10:12' },
          { name: 'unknown', session_id: 'not-in-cloudcli', state: 'died', cause: '' },
        ],
      }), 'utf8');

      await withProviders({ claude: { run: async () => undefined, abort: () => false } }, async () => {
        const snapshot = await sessionsService.readSessionLiveness();
        assert.deepEqual(snapshot.workerStates.map((entry) => [entry.sessionId, entry.state, entry.cause]), [
          ['worker-app', 'died', 'OOM-killed 11:10'],
        ]);
      });
    });
  });
});

test('the liveness snapshot lists a live codex worker by its thread id, and drops it once it exits', { concurrency: false }, async () => {
  // A secretary's `codex exec` worker runs outside CloudCLI; its row must read
  // as live (and so never fold) exactly while the process holds the thread.
  await withIsolatedDatabase(async () => {
    // How a spawned worker's row looks: app id = provider id = thread id.
    sessionsDb.createSession('thread-exec', 'codex', '/tmp/codex-worker');
    sessionsDb.createAppSession('app-tui', 'codex', '/tmp/codex-worker');
    sessionsDb.assignProviderSessionId('app-tui', 'thread-tui');
    // A legacy row: app id is the thread id, no provider id recorded.
    sessionsDb.createAppSession('thread-legacy', 'codex', '/tmp/codex-worker');

    await withClaudeCliRegistry([], async () => {
      let live = [
        { providerSessionId: 'thread-exec', startedAt: 5_000, isBusy: true },
        { providerSessionId: 'thread-tui', startedAt: 6_000, isBusy: false },
        { providerSessionId: 'thread-legacy', startedAt: 7_000, isBusy: true },
        { providerSessionId: 'thread-without-row', startedAt: 8_000, isBusy: true },
      ];
      codexCliLiveness.listLiveSessions = async () => live;
      await withProviders({ codex: { run: async () => undefined, abort: () => false } }, async () => {
        const snapshot = await sessionsService.readSessionLiveness();
        assert.deepEqual(snapshot.sessions, [
          {
            sessionId: 'thread-exec', provider: 'codex', startedAt: 5_000, lastSeq: 0,
            canInterrupt: false, statusText: 'Running in the Codex CLI',
          },
          {
            sessionId: 'thread-legacy', provider: 'codex', startedAt: 7_000, lastSeq: 0,
            canInterrupt: false, statusText: 'Running in the Codex CLI',
          },
        ]);
        assert.deepEqual(snapshot.idleProcessSessionIds, ['app-tui']);

        live = [];
        const after = await sessionsService.readSessionLiveness();
        assert.deepEqual(after.sessions, []);
        assert.deepEqual(after.idleProcessSessionIds, []);
      });
    });
  });
});
