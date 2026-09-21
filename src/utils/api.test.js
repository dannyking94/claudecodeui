import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import {
  AUTH_TOKEN_REFRESHED_EVENT,
  AUTH_ERROR_REASONS,
  AUTH_SESSION_EXPIRED_EVENT,
  authenticatedFetch,
  clearStoredAuthToken,
  expireAuthSession,
  getStoredAuthToken,
  isAuthTokenExpired,
  TOKEN_EXPIRY_SKEW_MS,
} from './api.js';

// Builds a JWT-shaped string (header.payload.signature, base64url segments) without
// needing a real signing library — isAuthTokenExpired() never verifies the signature,
// it only decodes the payload, so the header/signature segments are placeholders.
const makeToken = (payload) => {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
};

test('isAuthTokenExpired: a token well before its exp is not expired', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = makeToken({ iat: now - 60, exp: now + 600 }); // 10 min from now
  assert.equal(isAuthTokenExpired(token), false);
});

test('isAuthTokenExpired: a token expired within the clock-skew tolerance is not treated as expired', () => {
  const now = Math.floor(Date.now() / 1000);
  const skewSeconds = TOKEN_EXPIRY_SKEW_MS / 1000;
  const token = makeToken({ iat: now - 600, exp: now - Math.floor(skewSeconds / 2) });
  assert.equal(isAuthTokenExpired(token), false);
});

test('isAuthTokenExpired: a token expired just past the clock-skew tolerance is expired', () => {
  const now = Math.floor(Date.now() / 1000);
  const skewSeconds = TOKEN_EXPIRY_SKEW_MS / 1000;
  const token = makeToken({ iat: now - 600, exp: now - skewSeconds - 5 });
  assert.equal(isAuthTokenExpired(token), true);
});

test('isAuthTokenExpired: a token expired well past the skew tolerance is expired', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = makeToken({ iat: now - 600, exp: now - 600 }); // 10 min ago
  assert.equal(isAuthTokenExpired(token), true);
});

test('isAuthTokenExpired: a malformed/unreadable token is unaffected by the skew change', () => {
  // readTokenClaims() returns null for these, so isAuthTokenExpired() short-circuits
  // to false regardless of TOKEN_EXPIRY_SKEW_MS — behaviour unchanged by this fix.
  assert.equal(isAuthTokenExpired('not-a-jwt'), false);
  assert.equal(isAuthTokenExpired('only.two-segments'), false);
  assert.equal(isAuthTokenExpired(null), false);
});

// --- getStoredAuthToken / expireAuthSession -------------------------------
// These need browser globals; api.js only touches them at call time, so
// installing the stubs here (before any test body runs) is enough.
const storage = new Map();
// Every removeItem call, including ones on an already-absent key: a redundant
// removal leaves storage looking untouched, so the value alone can't prove a
// code path was a no-op.
let removeItemCalls = [];
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { removeItemCalls.push(key); storage.delete(key); },
  clear: () => storage.clear(),
};
globalThis.window = new EventTarget();

// Runs `run()` and returns the reasons carried by every session-expired event
// it dispatched.
const captureExpiryReasons = (run) => {
  const reasons = [];
  const listener = (event) => reasons.push(event.detail?.reason);
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, listener);
  try {
    run();
  } finally {
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, listener);
  }
  return reasons;
};

beforeEach(() => {
  storage.clear();
  removeItemCalls = [];
});

test('getStoredAuthToken: a malformed stored value is dropped instead of re-sent', () => {
  // The reported failure: a corrupted localStorage value went out as
  // `Authorization: Bearer <garbage>` on every request, forever.
  localStorage.setItem('auth-token', 'not-a-jwt');

  const reasons = captureExpiryReasons(() => {
    assert.equal(getStoredAuthToken(), null);
  });

  assert.equal(localStorage.getItem('auth-token'), null);
  assert.deepEqual(reasons, [AUTH_ERROR_REASONS.INVALID_TOKEN]);
});

test('getStoredAuthToken: a valid, unexpired token is returned untouched', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = makeToken({ iat: now - 60, exp: now + 3600 });
  localStorage.setItem('auth-token', token);

  const reasons = captureExpiryReasons(() => {
    assert.equal(getStoredAuthToken(), token);
  });

  assert.equal(localStorage.getItem('auth-token'), token);
  assert.deepEqual(reasons, []);
});

test('getStoredAuthToken: an expired token is dropped as an expiry, not as a bad token', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = makeToken({ iat: now - 7200, exp: now - 3600 });
  localStorage.setItem('auth-token', token);

  const reasons = captureExpiryReasons(() => {
    assert.equal(getStoredAuthToken(), null);
  });

  assert.equal(localStorage.getItem('auth-token'), null);
  assert.deepEqual(reasons, [AUTH_ERROR_REASONS.SESSION_EXPIRED]);
});

test('getStoredAuthToken: an empty store returns null without announcing an expiry', () => {
  const reasons = captureExpiryReasons(() => {
    assert.equal(getStoredAuthToken(), null);
  });

  assert.deepEqual(reasons, []);
});

test('expireAuthSession: a 401 for a superseded token leaves the newer session alone', () => {
  // A request issued before a login can land after it; expiring on that stale
  // 401 would wipe the session the login just created.
  localStorage.setItem('auth-token', 'fresh.login.token');

  const reasons = captureExpiryReasons(() => {
    assert.equal(
      expireAuthSession(AUTH_ERROR_REASONS.INVALID_TOKEN, 'stale.request.token'),
      false,
    );
  });

  assert.equal(localStorage.getItem('auth-token'), 'fresh.login.token');
  assert.deepEqual(reasons, []);
});

test('expireAuthSession: a 401 for the token still in storage expires the session', () => {
  localStorage.setItem('auth-token', 'current.request.token');

  const reasons = captureExpiryReasons(() => {
    assert.equal(
      expireAuthSession(AUTH_ERROR_REASONS.SESSION_EXPIRED, 'current.request.token'),
      true,
    );
  });

  assert.equal(localStorage.getItem('auth-token'), null);
  assert.deepEqual(reasons, [AUTH_ERROR_REASONS.SESSION_EXPIRED]);
});

test('expireAuthSession: a no-token 401 with nothing sent and nothing stored is a no-op', () => {
  // The reported self-sign-out: providers mounted above the login screen poll
  // authenticated endpoints with nobody logged in. There is no session to
  // expire, so nothing may be removed and nothing may be announced.
  const reasons = captureExpiryReasons(() => {
    assert.equal(expireAuthSession(AUTH_ERROR_REASONS.MISSING_TOKEN, null), false);
  });

  assert.deepEqual(removeItemCalls, []);
  assert.deepEqual(reasons, []);
});

test('expireAuthSession: a credential-less 401 landing after a login leaves that login alone', () => {
  localStorage.setItem('auth-token', 'fresh.login.token');

  const reasons = captureExpiryReasons(() => {
    assert.equal(expireAuthSession(AUTH_ERROR_REASONS.MISSING_TOKEN, null), false);
  });

  assert.equal(localStorage.getItem('auth-token'), 'fresh.login.token');
  assert.deepEqual(removeItemCalls, []);
  assert.deepEqual(reasons, []);
});

// --- authenticatedFetch ---------------------------------------------------
// Replaces global fetch for one call. `onRequest` runs while the request is
// "in flight", which is where a concurrent login gets simulated.
const withStubbedFetch = async ({ status, authError, refreshedToken, onRequest }, run) => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, headers: init.headers });
    onRequest?.();
    return new Response('{}', {
      status,
      headers: {
        ...(authError ? { 'X-Auth-Error': authError } : {}),
        ...(refreshedToken ? { 'X-Refreshed-Token': refreshedToken } : {}),
      },
    });
  };
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
  return requests;
};

const captureExpiryReasonsAsync = async (run) => {
  const reasons = [];
  const listener = (event) => reasons.push(event.detail?.reason);
  window.addEventListener(AUTH_SESSION_EXPIRED_EVENT, listener);
  try {
    await run();
  } finally {
    window.removeEventListener(AUTH_SESSION_EXPIRED_EVENT, listener);
  }
  return reasons;
};

test('authenticatedFetch: a signed-out request answered 401 no-token neither clears nor announces', async () => {
  let requests;
  const reasons = await captureExpiryReasonsAsync(async () => {
    requests = await withStubbedFetch(
      { status: 401, authError: AUTH_ERROR_REASONS.MISSING_TOKEN },
      async () => {
        const response = await authenticatedFetch('/api/plugins');
        assert.equal(response.status, 401);
      },
    );
  });

  assert.equal(requests.length, 1);
  assert.equal('Authorization' in requests[0].headers, false);
  assert.deepEqual(removeItemCalls, []);
  assert.deepEqual(reasons, []);
});

test('authenticatedFetch: a signed-out 401 that lands after a login keeps the new token', async () => {
  const now = Math.floor(Date.now() / 1000);
  const loginToken = makeToken({ iat: now, exp: now + 3600 });

  const reasons = await captureExpiryReasonsAsync(async () => {
    await withStubbedFetch(
      {
        status: 401,
        authError: AUTH_ERROR_REASONS.MISSING_TOKEN,
        // The login completes while the credential-less request is in flight.
        onRequest: () => localStorage.setItem('auth-token', loginToken),
      },
      () => authenticatedFetch('/api/taskmaster/installation-status'),
    );
  });

  assert.equal(localStorage.getItem('auth-token'), loginToken);
  assert.deepEqual(removeItemCalls, []);
  assert.deepEqual(reasons, []);
});

test('authenticatedFetch: a genuine session-expired 401 for the stored token still clears and announces', async () => {
  const now = Math.floor(Date.now() / 1000);
  // Unexpired by the client's clock, so it is sent; the server is the one
  // that reports the expiry.
  const token = makeToken({ iat: now - 60, exp: now + 3600 });
  localStorage.setItem('auth-token', token);

  let requests;
  const reasons = await captureExpiryReasonsAsync(async () => {
    requests = await withStubbedFetch(
      { status: 401, authError: AUTH_ERROR_REASONS.SESSION_EXPIRED },
      () => authenticatedFetch('/api/projects'),
    );
  });

  assert.equal(requests[0].headers.Authorization, `Bearer ${token}`);
  assert.equal(localStorage.getItem('auth-token'), null);
  assert.deepEqual(reasons, [AUTH_ERROR_REASONS.SESSION_EXPIRED]);
});

// --- clearStoredAuthToken -------------------------------------------------

test('clearStoredAuthToken: a stale teardown does not delete a newer token', () => {
  // A bootstrap check for an old session fails after another login has
  // already stored its token; the teardown only knows the old one.
  localStorage.setItem('auth-token', 'fresh.login.token');

  assert.equal(clearStoredAuthToken('stale.session.token'), false);

  assert.equal(localStorage.getItem('auth-token'), 'fresh.login.token');
  assert.deepEqual(removeItemCalls, []);
});

test('clearStoredAuthToken: a teardown by a provider holding no session leaves a stored token alone', () => {
  localStorage.setItem('auth-token', 'fresh.login.token');

  assert.equal(clearStoredAuthToken(null), false);

  assert.equal(localStorage.getItem('auth-token'), 'fresh.login.token');
  assert.deepEqual(removeItemCalls, []);
});

test('clearStoredAuthToken: tearing down the session whose token is stored removes it', () => {
  localStorage.setItem('auth-token', 'current.session.token');

  assert.equal(clearStoredAuthToken('current.session.token'), true);

  assert.equal(localStorage.getItem('auth-token'), null);
});

test('clearStoredAuthToken: an explicit sign-out clears whatever is stored', () => {
  // Logout passes no token: even one rotated in by another tab must go.
  localStorage.setItem('auth-token', 'rotated.elsewhere.token');

  assert.equal(clearStoredAuthToken(), true);

  assert.equal(localStorage.getItem('auth-token'), null);
});


test('authenticatedFetch: refresh headers only replace the current token with a newer unexpired token', async () => {
  const now = Math.floor(Date.now() / 1000);
  const current = makeToken({ iat: now - 120, exp: now + 3600 });
  const newer = makeToken({ iat: now - 60, exp: now + 3600 });
  const cases = [
    ['older', makeToken({ iat: now - 180, exp: now + 3600 }), false],
    ['same issuance', makeToken({ iat: now - 120, exp: now + 7200 }), false],
    ['expired', makeToken({ iat: now - 60, exp: now - 1 }), false],
    ['malformed', 'not-a-token', false],
    ['unreadable payload', 'header.payload.signature', false],
    ['missing iat', makeToken({ exp: now + 3600 }), false],
    ['missing exp', makeToken({ iat: now - 60 }), false],
    ['nonnumeric claims', makeToken({ iat: String(now), exp: now + 3600 }), false],
    ['newer valid', newer, true],
  ];
  for (const [label, refreshedToken, accepted] of cases) {
    localStorage.setItem('auth-token', current);
    const events = [];
    const listener = (event) => events.push(event.detail);
    window.addEventListener(AUTH_TOKEN_REFRESHED_EVENT, listener);
    try {
      await withStubbedFetch(
        { status: 200, refreshedToken },
        () => authenticatedFetch('/api/projects'),
      );
      assert.equal(localStorage.getItem('auth-token'), accepted ? newer : current, label);
      assert.deepEqual(events, accepted ? [newer] : [], label);
    } finally {
      window.removeEventListener(AUTH_TOKEN_REFRESHED_EVENT, listener);
    }
  }
});

test('authenticatedFetch: a late refresh compares against storage after a concurrent login', async () => {
  const now = Math.floor(Date.now() / 1000);
  const original = makeToken({ iat: now - 120, exp: now + 3600 });
  const refreshedToken = makeToken({ iat: now - 60, exp: now + 3600 });
  const login = makeToken({ iat: now, exp: now + 3600 });
  localStorage.setItem('auth-token', original);
  await withStubbedFetch(
    { status: 200, refreshedToken, onRequest: () => localStorage.setItem('auth-token', login) },
    () => authenticatedFetch('/api/projects'),
  );
  assert.equal(localStorage.getItem('auth-token'), login);
});

test('authenticatedFetch: a late refresh cannot restore a signed-out session', async () => {
  const now = Math.floor(Date.now() / 1000);
  localStorage.setItem('auth-token', makeToken({ iat: now - 120, exp: now + 3600 }));
  await withStubbedFetch(
    {
      status: 200,
      refreshedToken: makeToken({ iat: now, exp: now + 3600 }),
      onRequest: () => localStorage.removeItem('auth-token'),
    },
    () => authenticatedFetch('/api/projects'),
  );
  assert.equal(localStorage.getItem('auth-token'), null);
});
