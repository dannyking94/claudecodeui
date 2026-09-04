import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import {
  AUTH_ERROR_REASONS,
  AUTH_SESSION_EXPIRED_EVENT,
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
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
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
