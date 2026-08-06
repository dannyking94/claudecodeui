import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createSystemRouter } from '../system.routes.js';
import type { createSystemUpdateService } from '../system.service.js';

type SystemUpdateService = ReturnType<typeof createSystemUpdateService>;

const updateServiceStub = {
  updateSystem: async () => {
    throw new Error('updateSystem should not run in these tests');
  },
} as unknown as SystemUpdateService;

async function withRouter(
  isPlatform: boolean,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use('/api/system', createSystemRouter(updateServiceStub, { isPlatform }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test('the capability probe identifies itself so an SPA fallback cannot pass for support', async () => {
  await withRouter(false, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/system/stats/capability`);

    assert.equal(response.status, 200);
    assert.ok(response.headers.get('content-type')?.includes('application/json'));

    // The marker is the whole point: an older server answers this path with
    // index.html at status 200, so the client trusts the body, not the status.
    assert.deepEqual(await response.json(), {
      capability: 'system-stats',
      supported: true,
      disabled: false,
    });
  });
});

test('platform deployments report the capability as disabled', async () => {
  await withRouter(true, async (baseUrl) => {
    const payload = await (await fetch(`${baseUrl}/api/system/stats/capability`)).json() as {
      supported: boolean;
      disabled: boolean;
    };

    assert.equal(payload.supported, true);
    assert.equal(payload.disabled, true);
  });
});
