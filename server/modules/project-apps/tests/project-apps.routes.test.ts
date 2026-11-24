import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { createProjectAppsRouter } from '@/modules/project-apps/project-apps.routes.js';
import type { ProjectAppsServices } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

function fakeServices(overrides: Partial<ProjectAppsServices> = {}): ProjectAppsServices {
  return {
    resolveProjectPath: (id) => {
      if (id !== 'p1') throw new AppError('nope', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
      return '/work/robot-repo';
    },
    getView: async (projectPath) => ({ projectPath, source: 'dashboard', checkedAt: 1, error: null, apps: [], chatLinks: [] }),
    runAction: async (app, action) => ({ app, action, refused: null, exit: 0, steps: [], outputTail: '', upAfter: true }),
    getLog: async () => [],
    ...overrides,
  };
}

async function withServer(services: ProjectAppsServices, run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use('/api/project-apps', createProjectAppsRouter(services));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.code });
      return;
    }
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
}

const postJson = (url: string, body: unknown) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('GET / resolves the project id and returns its view', async () => {
  await withServer(fakeServices(), async (base) => {
    const response = await fetch(`${base}/api/project-apps?project=p1`);
    assert.equal(response.status, 200);
    const body = await response.json() as { data: { projectPath: string } };
    assert.equal(body.data.projectPath, '/work/robot-repo');
    assert.equal((await fetch(`${base}/api/project-apps`)).status, 400);
    assert.equal((await fetch(`${base}/api/project-apps?project=zz`)).status, 404);
  });
});

test('POST /action validates the app id and action before calling the service', async () => {
  const calls: string[] = [];
  const services = fakeServices({
    runAction: async (app, action) => {
      calls.push(`${action}:${app}`);
      return { app, action, refused: null, exit: 0, steps: [], outputTail: '', upAfter: true };
    },
  });
  await withServer(services, async (base) => {
    assert.equal((await postJson(`${base}/api/project-apps/action`, { app: 'viewer', action: 'restart' })).status, 200);
    assert.equal((await postJson(`${base}/api/project-apps/action`, { app: 'viewer', action: 'kill' })).status, 400);
    assert.equal((await postJson(`${base}/api/project-apps/action`, { app: '../etc', action: 'stop' })).status, 400);
    assert.equal((await postJson(`${base}/api/project-apps/action`, { action: 'stop' })).status, 400);
  });
  assert.deepEqual(calls, ['restart:viewer']);
});

test('GET /log requires an app id', async () => {
  await withServer(fakeServices(), async (base) => {
    assert.equal((await fetch(`${base}/api/project-apps/log?app=viewer`)).status, 200);
    assert.equal((await fetch(`${base}/api/project-apps/log`)).status, 400);
  });
});
