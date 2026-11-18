/**
 * The client's half of the JWT session: parsing, expiry, storage and the two
 * events the auth context listens to.
 *
 * Extracted from api.ts, which is meant to be the endpoint map plus its request
 * helpers. This is the security-sensitive part and it is what WebSocketContext,
 * AuthContext, the shell socket and the file-tree uploader actually import.
 */

export const AUTH_TOKEN_REFRESHED_EVENT = 'auth-token-refreshed';
export const AUTH_SESSION_EXPIRED_EVENT = 'auth-session-expired';

// Only accept a refreshed token that has this app's issued JWT shape
// (three base64url segments). An attacker-injected/malformed header value
// must never overwrite the stored auth token.
export const isValidRefreshedToken = (token: unknown): token is string =>
  typeof token === 'string' &&
  /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);

type TokenClaims = {
  issuedAt: number;
  expiresAt: number;
};

/** Used by authenticatedFetch to compare a refreshed token's age with the stored one. */
export const readTokenClaims = (token: unknown): TokenClaims | null => {
  if (!isValidRefreshedToken(token)) {
    return null;
  }

  try {
    const encodedPayload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const paddedPayload = encodedPayload.padEnd(
      encodedPayload.length + ((4 - (encodedPayload.length % 4)) % 4),
      '=',
    );
    const payload = JSON.parse(atob(paddedPayload)) as { iat?: unknown; exp?: unknown };

    if (
      typeof payload.iat !== 'number' ||
      !Number.isFinite(payload.iat) ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp)
    ) {
      return null;
    }

    return { issuedAt: payload.iat * 1000, expiresAt: payload.exp * 1000 };
  } catch {
    return null;
  }
};

// Tolerance for client/server clock skew. The server's own jwt.verify is the
// real authority; this check only decides whether the client should discard a
// token locally. Without an allowance, a browser clock running slightly ahead
// reads a still-server-valid token as expired and drops the session.
export const TOKEN_EXPIRY_SKEW_MS = 60_000;

export const isAuthTokenExpired = (token: unknown): boolean => {
  const claims = readTokenClaims(token);
  return claims ? Date.now() >= claims.expiresAt + TOKEN_EXPIRY_SKEW_MS : false;
};

export const getAuthTokenRefreshDelay = (token: unknown): number | null => {
  const claims = readTokenClaims(token);
  if (!claims) {
    return null;
  }

  const refreshAt = claims.issuedAt + ((claims.expiresAt - claims.issuedAt) / 2);
  return Math.max(0, refreshAt - Date.now());
};

// Reasons a stored token stops being usable. These mirror the `X-Auth-Error`
// values set by server/modules/auth/auth.middleware.ts (AUTH_ERROR_CODES), and
// they ride along on the session-expired event so the UI can say something
// true: only SESSION_EXPIRED is a session that actually ran out.
export const AUTH_ERROR_HEADER = 'X-Auth-Error';
export const AUTH_ERROR_REASONS = {
  MISSING_TOKEN: 'no-token',
  INVALID_TOKEN: 'invalid-token',
  UNKNOWN_USER: 'unknown-user',
  SESSION_EXPIRED: 'session-expired',
} as const;

/** Payload of AUTH_SESSION_EXPIRED_EVENT; AuthContext picks its message from `reason`. */
export type AuthSessionExpiredDetail = { reason?: string };

/**
 * Drops the stored token and announces why.
 *
 * `sentWithToken` closes a stale-401 race: a request issued before a login can
 * land after it, and clearing unconditionally would wipe the *newer* session.
 * Callers that know which token the request actually carried pass it here, and
 * the session is only expired while that value is still the stored one.
 *
 * `sentWithToken === null` means the request carried no credential at all. Its
 * 401 says nothing about any session: there was never one to expire, so it is a
 * no-op — no removal, no event. Treating it as an expiry let the app's own
 * logged-out requests sign out the session a login was about to create.
 *
 * Returns whether the session was expired.
 */
export const expireAuthSession = (
  reason: string = AUTH_ERROR_REASONS.INVALID_TOKEN,
  sentWithToken?: string | null,
): boolean => {
  if (sentWithToken === null) {
    return false;
  }

  if (sentWithToken !== undefined && localStorage.getItem('auth-token') !== sentWithToken) {
    return false;
  }

  localStorage.removeItem('auth-token');
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<AuthSessionExpiredDetail>(AUTH_SESSION_EXPIRED_EVENT, { detail: { reason } }),
    );
  }
  return true;
};

/**
 * Removes the stored token on behalf of a session teardown.
 *
 * Mirrors the `sentWithToken` guard above: a teardown only knows about the
 * token its own session held, and by the time it runs another login (this tab
 * or another one) may have stored a newer one. Pass the held token and the
 * removal only happens while it is still the stored value. Omit it for an
 * explicit sign-out, which must always clear.
 *
 * Returns whether a stored token was removed.
 */
export const clearStoredAuthToken = (knownToken?: string | null): boolean => {
  const storedToken = localStorage.getItem('auth-token');
  if (storedToken === null) {
    return false;
  }

  if (knownToken !== undefined && storedToken !== knownToken) {
    return false;
  }

  localStorage.removeItem('auth-token');
  return true;
};

export const getStoredAuthToken = (): string | null => {
  const token = localStorage.getItem('auth-token');
  if (!token) {
    return null;
  }

  // A value that isn't even shaped like one of our JWTs can never authenticate.
  // Without this it would be re-sent on every request forever — the server
  // answers `jwt malformed`, and nothing ever heals the stored value.
  // isAuthTokenExpired() can't cover it: it reads unparseable as "not expired"
  // on purpose, because getAuthTokenRefreshDelay() needs that same null-claims
  // path to mean "no refresh schedule".
  if (!isValidRefreshedToken(token)) {
    expireAuthSession(AUTH_ERROR_REASONS.INVALID_TOKEN, token);
    return null;
  }

  if (isAuthTokenExpired(token)) {
    expireAuthSession(AUTH_ERROR_REASONS.SESSION_EXPIRED, token);
    return null;
  }

  return token;
};

export const storeAuthToken = (token: unknown): boolean => {
  if (!isValidRefreshedToken(token)) {
    return false;
  }

  // Never let an expired token replace the stored one. A 304 replays the
  // headers of the cached response, so a stale X-Refreshed-Token from an
  // earlier session arrives again on every start; overwriting with it makes
  // the next getStoredAuthToken() discard a sign-in that was seconds old.
  if (isAuthTokenExpired(token)) {
    return false;
  }

  // Already current — skip the write and, more importantly, the refresh
  // event. Several in-flight responses can carry the same refreshed token,
  // and re-announcing it just churns auth state downstream.
  if (localStorage.getItem('auth-token') === token) {
    return true;
  }

  localStorage.setItem('auth-token', token);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_TOKEN_REFRESHED_EVENT, { detail: token }));
  }
  return true;
};
