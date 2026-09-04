export const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

export const AUTH_ERROR_MESSAGES = {
  authStatusCheckFailed: 'Failed to check authentication status',
  loginFailed: 'Login failed',
  registrationFailed: 'Registration failed',
  networkError: 'Network error. Please try again.',
  sessionExpired: 'Your session expired. Please log in again.',
  invalidSession: 'Your saved sign-in is no longer valid. Please log in again.',
  accountUnavailable: 'Your account is no longer available. Please log in again.',
} as const;

/**
 * What to show for each `X-Auth-Error` value the server can send with a 401
 * (see AUTH_ERROR_CODES in server/modules/auth/auth.middleware.ts).
 *
 * Only `session-expired` is a session that really ran out. The others are a
 * request that never carried a usable token — a corrupted localStorage value,
 * or a deleted account — and saying "your session expired" for those tells the
 * user their session ran out when they may never have had one.
 *
 * `no-token` maps to null on purpose: nothing was sent, so there is nothing to
 * report. The login screen is the whole message.
 */
export const AUTH_SESSION_ERROR_MESSAGES: Record<string, string | null> = {
  'session-expired': AUTH_ERROR_MESSAGES.sessionExpired,
  'unknown-user': AUTH_ERROR_MESSAGES.accountUnavailable,
  'invalid-token': AUTH_ERROR_MESSAGES.invalidSession,
  'no-token': null,
};
