import { AUTH_ERROR_MESSAGES, AUTH_SESSION_ERROR_MESSAGES } from './constants';
import type { ApiErrorPayload } from './types';

export async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function resolveApiErrorMessage(payload: ApiErrorPayload | null, fallback: string): string {
  if (!payload) {
    return fallback;
  }

  return payload.error ?? payload.message ?? fallback;
}

/**
 * Message for a dropped session, given the `X-Auth-Error` reason that dropped
 * it. An unrecognised reason falls back to the neutral "sign-in is no longer
 * valid" wording rather than claiming an expiry we did not observe.
 */
export function resolveAuthSessionErrorMessage(reason: unknown): string | null {
  if (typeof reason === 'string' && reason in AUTH_SESSION_ERROR_MESSAGES) {
    return AUTH_SESSION_ERROR_MESSAGES[reason];
  }

  return AUTH_ERROR_MESSAGES.invalidSession;
}
