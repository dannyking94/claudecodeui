import assert from 'node:assert/strict';
import test from 'node:test';

import { createClaudeUsageService } from '../claude-usage.service.js';

const CREDENTIALS_JSON = JSON.stringify({
  claudeAiOauth: { accessToken: 'oauth-token', subscriptionType: 'max' },
});

/** Mirrors the live endpoint's shape, trimmed to the fields the service reads. */
const USAGE_PAYLOAD = {
  five_hour: { utilization: 21, resets_at: '2026-08-06T16:39:59.829872+00:00' },
  seven_day: { utilization: 6, resets_at: '2026-08-12T21:00:00.829895+00:00' },
  limits: [
    { kind: 'session', percent: 21, severity: 'warning', is_active: true },
    { kind: 'weekly_all', percent: 6, severity: 'normal', is_active: false },
    {
      kind: 'weekly_scoped',
      percent: 6,
      severity: 'normal',
      is_active: false,
      resets_at: '2026-08-12T20:59:59.830144+00:00',
      scope: { model: { id: null, display_name: 'Fable' }, surface: null },
    },
  ],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type ServiceOverrides = Parameters<typeof createClaudeUsageService>[0];

function createService(overrides: Partial<ServiceOverrides> = {}) {
  return createClaudeUsageService({
    homeDirectory: '/home/tester',
    isPlatform: false,
    readCredentials: async () => CREDENTIALS_JSON,
    fetchImpl: (async () => jsonResponse(USAGE_PAYLOAD)) as unknown as typeof fetch,
    now: () => 1_000,
    ...overrides,
  });
}

test('platform mode reports disabled without touching the host credentials', async () => {
  let credentialReads = 0;
  let upstreamCalls = 0;

  const service = createService({
    isPlatform: true,
    readCredentials: async () => {
      credentialReads += 1;
      return CREDENTIALS_JSON;
    },
    fetchImpl: (async () => {
      upstreamCalls += 1;
      return jsonResponse(USAGE_PAYLOAD);
    }) as unknown as typeof fetch,
  });

  assert.deepEqual(await service.getUsage(), { status: 'unavailable', reason: 'disabled' });

  // The operator's account must not be read at all in a multi-tenant deployment,
  // not merely withheld after being fetched.
  assert.equal(credentialReads, 0);
  assert.equal(upstreamCalls, 0);
});

test('a host without Claude Code credentials reports not_signed_in rather than an error', async () => {
  const service = createService({
    readCredentials: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
  });

  assert.deepEqual(await service.getUsage(), { status: 'unavailable', reason: 'not_signed_in' });
});

test('malformed credentials are treated as signed out, not as a crash', async () => {
  const service = createService({ readCredentials: async () => '{ not json' });

  assert.deepEqual(await service.getUsage(), { status: 'unavailable', reason: 'not_signed_in' });
});

test('both windows are parsed, with severity taken from the parallel limits array', async () => {
  const service = createService();
  const result = await service.getUsage();

  assert.equal(result.status, 'ok');
  assert.equal(result.plan, 'max');
  assert.equal(result.fetchedAt, 1_000);
  assert.deepEqual(result.fiveHour, {
    utilization: 21,
    resetsAt: Date.parse('2026-08-06T16:39:59.829872+00:00'),
    severity: 'warning',
  });
  assert.deepEqual(result.sevenDay, {
    utilization: 6,
    resetsAt: Date.parse('2026-08-12T21:00:00.829895+00:00'),
    severity: 'normal',
  });
});

test('every reported window is normalized for the detail view, including scoped ones', async () => {
  const service = createService();
  const result = await service.getUsage();

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.limits, [
    {
      kind: 'session',
      utilization: 21,
      resetsAt: null,
      severity: 'warning',
      scopeLabel: null,
      isActive: true,
    },
    {
      kind: 'weekly_all',
      utilization: 6,
      resetsAt: null,
      severity: 'normal',
      scopeLabel: null,
      isActive: false,
    },
    {
      kind: 'weekly_scoped',
      utilization: 6,
      resetsAt: Date.parse('2026-08-12T20:59:59.830144+00:00'),
      severity: 'normal',
      scopeLabel: 'Fable',
      isActive: false,
    },
  ]);
});

test('an unfamiliar window kind still reaches the client rather than being dropped', async () => {
  const service = createService({
    fetchImpl: (async () =>
      jsonResponse({
        ...USAGE_PAYLOAD,
        limits: [
          { kind: 'monthly_experimental', percent: 12, severity: 'critical', is_active: false },
          // Surface-scoped windows nest their label beside a null `model`.
          {
            kind: 'weekly_scoped',
            percent: 3,
            scope: { model: null, surface: { display_name: 'Cowork' } },
          },
        ],
      })) as unknown as typeof fetch,
  });

  const result = await service.getUsage();

  assert.equal(result.status, 'ok');
  assert.deepEqual(
    result.limits.map((limit) => [limit.kind, limit.utilization, limit.scopeLabel]),
    [
      ['monthly_experimental', 12, null],
      ['weekly_scoped', 3, 'Cowork'],
    ],
  );
});

test('limit entries without a usable percent are skipped, not emitted as zero', async () => {
  const service = createService({
    fetchImpl: (async () =>
      jsonResponse({
        ...USAGE_PAYLOAD,
        limits: [
          { kind: 'session', percent: 21, severity: 'normal' },
          { kind: 'broken' },
          { percent: 50 },
          'not-an-object',
        ],
      })) as unknown as typeof fetch,
  });

  const result = await service.getUsage();

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.limits.map((limit) => limit.kind), ['session']);
});

test('a payload with no limits array still yields the headline windows', async () => {
  const service = createService({
    fetchImpl: (async () =>
      jsonResponse({
        five_hour: { utilization: 40, resets_at: '2026-08-06T16:39:59.829872+00:00' },
        seven_day: { utilization: 9, resets_at: '2026-08-12T21:00:00.829895+00:00' },
      })) as unknown as typeof fetch,
  });

  const result = await service.getUsage();

  assert.equal(result.status, 'ok');
  assert.deepEqual(result.limits, []);
  assert.equal(result.fiveHour?.utilization, 40);
  assert.equal(result.fiveHour?.severity, 'normal');
});

test('the access token is sent as a bearer credential and never returned to the caller', async () => {
  let seenHeaders: Record<string, string> = {};

  const service = createService({
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seenHeaders = init.headers as Record<string, string>;
      return jsonResponse(USAGE_PAYLOAD);
    }) as unknown as typeof fetch,
  });

  const result = await service.getUsage();

  assert.equal(seenHeaders.Authorization, 'Bearer oauth-token');
  assert.equal(seenHeaders['anthropic-beta'], 'oauth-2025-04-20');
  assert.ok(!JSON.stringify(result).includes('oauth-token'));
});

test('a refused upstream request degrades instead of propagating', async () => {
  const service = createService({
    fetchImpl: (async () => jsonResponse({ error: 'nope' }, 401)) as unknown as typeof fetch,
  });

  assert.deepEqual(await service.getUsage(), { status: 'unavailable', reason: 'upstream_error' });
});

test('a thrown upstream request degrades instead of propagating', async () => {
  const service = createService({
    fetchImpl: (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch,
  });

  assert.deepEqual(await service.getUsage(), { status: 'unavailable', reason: 'upstream_error' });
});

test('a payload with no recognizable windows reports unavailable rather than zero usage', async () => {
  const service = createService({
    fetchImpl: (async () => jsonResponse({ something_else: true })) as unknown as typeof fetch,
  });

  // Reporting 0% here would read as "plenty of quota left", which is a
  // confident lie when the response shape has simply moved.
  assert.deepEqual(await service.getUsage(), { status: 'unavailable', reason: 'upstream_error' });
});

test('one upstream call serves repeat reads inside the cache window', async () => {
  let upstreamCalls = 0;
  let currentTime = 1_000;

  const service = createService({
    now: () => currentTime,
    fetchImpl: (async () => {
      upstreamCalls += 1;
      return jsonResponse(USAGE_PAYLOAD);
    }) as unknown as typeof fetch,
  });

  await service.getUsage();
  currentTime = 20_000;
  await service.getUsage();
  assert.equal(upstreamCalls, 1);

  currentTime = 40_000;
  await service.getUsage();
  assert.equal(upstreamCalls, 2, 'the cache expires after its TTL');
});

test('concurrent readers share a single in-flight upstream request', async () => {
  let upstreamCalls = 0;

  const service = createService({
    fetchImpl: (async () => {
      upstreamCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return jsonResponse(USAGE_PAYLOAD);
    }) as unknown as typeof fetch,
  });

  // Several browser tabs polling at once must not multiply load on an
  // undocumented endpoint.
  const results = await Promise.all([service.getUsage(), service.getUsage(), service.getUsage()]);

  assert.equal(upstreamCalls, 1);
  for (const result of results) {
    assert.equal(result.status, 'ok');
  }
});

test('a failed lookup is cached so a signed-out host is not re-read on every poll', async () => {
  let credentialReads = 0;

  const service = createService({
    readCredentials: async () => {
      credentialReads += 1;
      throw new Error('ENOENT');
    },
  });

  await service.getUsage();
  await service.getUsage();

  assert.equal(credentialReads, 1);
});
