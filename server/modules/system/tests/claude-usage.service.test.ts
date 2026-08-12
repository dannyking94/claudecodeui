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

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

type ServiceOverrides = Parameters<typeof createClaudeUsageService>[0];

/**
 * Stands in for the persisted snapshot file. Returning the same object to
 * several services is how a restart is simulated: the second service starts
 * with nothing in memory but finds this still on "disk".
 */
function createSnapshotStore(initialContents: string | null = null) {
  const store = {
    contents: initialContents,
    writes: 0,
    read: async () => {
      if (store.contents === null) {
        throw new Error('ENOENT');
      }
      return store.contents;
    },
    write: async (_path: string, contents: string) => {
      store.writes += 1;
      store.contents = contents;
    },
  };

  return store;
}

function createService(
  overrides: Partial<ServiceOverrides> = {},
  snapshot = createSnapshotStore(),
) {
  return createClaudeUsageService({
    homeDirectory: '/home/tester',
    isPlatform: false,
    readCredentials: async () => CREDENTIALS_JSON,
    fetchImpl: (async () => jsonResponse(USAGE_PAYLOAD)) as unknown as typeof fetch,
    // Kept off the real filesystem: the defaults would reach for the running
    // developer's home directory.
    snapshotPath: '/home/tester/.cloudcli/claude-usage.json',
    readSnapshot: snapshot.read,
    writeSnapshot: snapshot.write,
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

// ----------------- Retaining a reading across transient failures ------------

test('a transient failure keeps the last reading rather than reporting nothing', async () => {
  let currentTime = 1_000;
  let shouldFail = false;

  const service = createService({
    now: () => currentTime,
    fetchImpl: (async () =>
      shouldFail ? jsonResponse({ error: 'rate limited' }, 429) : jsonResponse(USAGE_PAYLOAD)
    ) as unknown as typeof fetch,
  });

  const fresh = await service.getUsage();
  assert.equal(fresh.status, 'ok');
  assert.equal(fresh.stale, undefined, 'a live reading is not marked stale');

  shouldFail = true;
  currentTime = 40_000;
  const retained = await service.getUsage();

  // The pill vanishing on a failed poll was the bug: the allowance did not
  // change just because the lookup for it did not answer.
  assert.equal(retained.status, 'ok');
  assert.equal(retained.stale, true);
  assert.equal(retained.status === 'ok' && retained.fiveHour?.utilization, 21);
});

test('a retained reading is dropped once it is too old to describe the windows', async () => {
  let currentTime = 1_000;
  let shouldFail = false;

  const service = createService({
    now: () => currentTime,
    fetchImpl: (async () =>
      shouldFail ? jsonResponse({ error: 'nope' }, 500) : jsonResponse(USAGE_PAYLOAD)
    ) as unknown as typeof fetch,
  });

  await service.getUsage();
  shouldFail = true;

  // Thirteen hours on, the five-hour window has rolled over more than twice.
  currentTime = 1_000 + 13 * 60 * 60_000;
  assert.deepEqual(await service.getUsage(), { status: 'unavailable', reason: 'upstream_error' });
});

test('signing out clears the retained reading instead of showing the old account', async () => {
  let currentTime = 1_000;
  let signedIn = true;

  const service = createService({
    now: () => currentTime,
    readCredentials: async () => {
      if (!signedIn) {
        throw new Error('ENOENT');
      }
      return CREDENTIALS_JSON;
    },
  });

  await service.getUsage();

  signedIn = false;
  currentTime = 40_000;

  // Unlike an upstream hiccup, this describes the host and will not recover on
  // a retry, so the previous account's figures must not linger.
  assert.deepEqual(await service.getUsage(), { status: 'unavailable', reason: 'not_signed_in' });
});

// ----------------- Rate-limit backoff --------------------------------------

test('a rate-limited poll stops further upstream calls until the backoff elapses', async () => {
  let currentTime = 1_000;
  let upstreamCalls = 0;

  const service = createService({
    now: () => currentTime,
    fetchImpl: (async () => {
      upstreamCalls += 1;
      return jsonResponse({ error: 'rate limited' }, 429);
    }) as unknown as typeof fetch,
  });

  await service.getUsage();
  assert.equal(upstreamCalls, 1);

  // Past the ordinary cache TTL, but inside the 60s backoff: re-polling here
  // is what kept the rate limit alive in the first place.
  currentTime = 40_000;
  await service.getUsage();
  assert.equal(upstreamCalls, 1);

  currentTime = 1_000 + 60_000 + 1;
  await service.getUsage();
  assert.equal(upstreamCalls, 2, 'the backoff expires and one retry is allowed');
});

test('consecutive rate limits back off exponentially', async () => {
  let currentTime = 1_000;
  let upstreamCalls = 0;

  const service = createService({
    now: () => currentTime,
    fetchImpl: (async () => {
      upstreamCalls += 1;
      return jsonResponse({ error: 'rate limited' }, 429);
    }) as unknown as typeof fetch,
  });

  await service.getUsage();
  currentTime += 60_001;
  await service.getUsage();
  assert.equal(upstreamCalls, 2);

  // The second 429 doubles the wait to 120s, so a poll at 61s must not call.
  currentTime += 60_001;
  await service.getUsage();
  assert.equal(upstreamCalls, 2);

  currentTime += 60_001;
  await service.getUsage();
  assert.equal(upstreamCalls, 3);
});

test('an explicit retry-after is honoured over the exponential schedule', async () => {
  let currentTime = 1_000;
  let upstreamCalls = 0;

  const service = createService({
    now: () => currentTime,
    fetchImpl: (async () => {
      upstreamCalls += 1;
      return jsonResponse({ error: 'rate limited' }, 429, { 'retry-after': '300' });
    }) as unknown as typeof fetch,
  });

  await service.getUsage();

  // The default first backoff would have allowed a retry here.
  currentTime = 1_000 + 120_000;
  await service.getUsage();
  assert.equal(upstreamCalls, 1);

  currentTime = 1_000 + 300_000 + 1;
  await service.getUsage();
  assert.equal(upstreamCalls, 2);
});

test('a non-rate-limit failure retries on the ordinary cadence', async () => {
  let currentTime = 1_000;
  let upstreamCalls = 0;

  const service = createService({
    now: () => currentTime,
    fetchImpl: (async () => {
      upstreamCalls += 1;
      return jsonResponse({ error: 'boom' }, 500);
    }) as unknown as typeof fetch,
  });

  await service.getUsage();
  currentTime = 40_000;
  await service.getUsage();

  // A one-off 500 must not mute the endpoint for a whole backoff window.
  assert.equal(upstreamCalls, 2);
});

test('a successful poll clears an earlier backoff', async () => {
  let currentTime = 1_000;
  let upstreamCalls = 0;
  let shouldRateLimit = true;

  const service = createService({
    now: () => currentTime,
    fetchImpl: (async () => {
      upstreamCalls += 1;
      return shouldRateLimit
        ? jsonResponse({ error: 'rate limited' }, 429)
        : jsonResponse(USAGE_PAYLOAD);
    }) as unknown as typeof fetch,
  });

  await service.getUsage();
  shouldRateLimit = true;
  currentTime += 60_001;
  await service.getUsage();
  assert.equal(upstreamCalls, 2);

  shouldRateLimit = false;
  currentTime += 120_001;
  await service.getUsage();
  assert.equal(upstreamCalls, 3);

  // Back to normal: the next poll after the cache TTL goes straight out.
  currentTime += 40_000;
  await service.getUsage();
  assert.equal(upstreamCalls, 4);
});

// ----------------- Surviving a restart -------------------------------------

test('a good reading is persisted and restored by a later service instance', async () => {
  const snapshot = createSnapshotStore();
  let currentTime = 1_000;

  const first = createService({ now: () => currentTime }, snapshot);
  await first.getUsage();
  assert.ok(snapshot.contents, 'the reading reached the snapshot');

  // A fresh service with no memory, standing in for a restarted server, and an
  // upstream that is rate-limiting from the very first poll.
  const second = createService(
    {
      now: () => currentTime,
      fetchImpl: (async () => jsonResponse({ error: 'rate limited' }, 429)) as unknown as typeof fetch,
    },
    snapshot,
  );

  currentTime = 100_000;
  const restored = await second.getUsage();

  assert.equal(restored.status, 'ok');
  assert.equal(restored.stale, true);
  assert.equal(restored.status === 'ok' && restored.fiveHour?.utilization, 21);
  assert.equal(
    restored.status === 'ok' && restored.fiveHour?.resetsAt,
    Date.parse(USAGE_PAYLOAD.five_hour.resets_at),
    'the reset time survives the round trip',
  );
  assert.equal(restored.status === 'ok' && restored.limits.length, 3);
  assert.equal(restored.status === 'ok' && restored.plan, 'max');
});

test('an unchanged reading is not rewritten on every poll', async () => {
  const snapshot = createSnapshotStore();
  let currentTime = 1_000;

  const service = createService({ now: () => currentTime }, snapshot);

  await service.getUsage();
  currentTime = 40_000;
  await service.getUsage();
  currentTime = 80_000;
  await service.getUsage();

  assert.equal(snapshot.writes, 1, 'identical percentages do not churn the file');

  // Past the refresh interval the same reading is rewritten once, so the
  // recorded age the staleness cutoff measures cannot drift indefinitely.
  currentTime = 1_000 + 5 * 60_000;
  await service.getUsage();
  assert.equal(snapshot.writes, 2);
});

test('a corrupt snapshot is ignored rather than surfacing as a usage figure', async () => {
  const snapshot = createSnapshotStore('{ not json at all');

  const service = createService(
    {
      fetchImpl: (async () => jsonResponse({ error: 'rate limited' }, 429)) as unknown as typeof fetch,
    },
    snapshot,
  );

  assert.deepEqual(await service.getUsage(), { status: 'unavailable', reason: 'upstream_error' });
});

test('a snapshot from an incompatible build is ignored', async () => {
  const snapshot = createSnapshotStore(
    JSON.stringify({ version: 99, reading: { status: 'ok', fiveHour: { utilization: 4 }, fetchedAt: 1 } }),
  );

  const service = createService(
    {
      fetchImpl: (async () => jsonResponse({ error: 'rate limited' }, 429)) as unknown as typeof fetch,
    },
    snapshot,
  );

  assert.deepEqual(await service.getUsage(), { status: 'unavailable', reason: 'upstream_error' });
});
