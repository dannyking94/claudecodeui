import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { createClaudeUsageService } from '../claude-usage.service.js';
import { createSystemRouter } from '../system.routes.js';
import type { createSystemUpdateService } from '../system.service.js';

type SystemUpdateService = ReturnType<typeof createSystemUpdateService>;
type ClaudeUsageService = ReturnType<typeof createClaudeUsageService>;

const updateServiceStub = {
  updateSystem: async () => {
    throw new Error('updateSystem should not run in these tests');
  },
} as unknown as SystemUpdateService;

const claudeUsageServiceStub = {
  getUsage: async () => ({ status: 'unavailable', reason: 'not_signed_in' }),
} as unknown as ClaudeUsageService;

async function withRouter(
  isPlatform: boolean,
  run: (baseUrl: string) => Promise<void>,
  claudeUsageService: ClaudeUsageService = claudeUsageServiceStub,
): Promise<void> {
  const app = express();
  app.use(
    '/api/system',
    createSystemRouter(updateServiceStub, claudeUsageService, { isPlatform }),
  );

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

test('the Claude usage route echoes its capability marker alongside the snapshot', async () => {
  const usageService = {
    getUsage: async () => ({
      status: 'ok',
      fiveHour: { utilization: 21, resetsAt: 1_800_000, severity: 'normal' },
      sevenDay: { utilization: 6, resetsAt: 1_900_000, severity: 'normal' },
      plan: 'max',
      fetchedAt: 1_000,
    }),
  } as unknown as ClaudeUsageService;

  await withRouter(
    false,
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/system/claude-usage`);

      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type')?.includes('application/json'));

      const payload = await response.json() as Record<string, unknown>;

      // Same SPA-fallback hazard as the stats probe: an older server serves
      // index.html at 200 for this path, so the marker is what proves support.
      assert.equal(payload.capability, 'claude-usage');
      assert.equal(payload.status, 'ok');
      assert.equal(payload.plan, 'max');
    },
    usageService,
  );
});

test('an unavailable snapshot is still a 200 carrying the reason', async () => {
  await withRouter(false, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/system/claude-usage`);

    // The composer pill treats this as "nothing to show"; a non-2xx would make
    // an ordinary signed-out host look like a broken server.
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      capability: 'claude-usage',
      status: 'unavailable',
      reason: 'not_signed_in',
    });
  });
});
