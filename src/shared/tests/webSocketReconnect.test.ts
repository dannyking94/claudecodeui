import { describe, expect, it, vi } from 'vitest';

// The provider module imports the auth barrel; the predicate under test needs
// none of it.
vi.mock('@/modules/auth', () => ({ useAuth: () => ({ user: null, token: null, isLoading: false }) }));

import {
  TAB_WAKE_RECONNECT_THRESHOLD_MS,
  shouldForceWebSocketReconnect,
} from '@/shared/context/WebSocketContext';

const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;

describe('shouldForceWebSocketReconnect', () => {
  it('forces an open socket to reconnect after a long tab suspension', () => {
    const hiddenSince = 1_000;

    expect(shouldForceWebSocketReconnect(
      hiddenSince,
      SOCKET_OPEN,
      hiddenSince + TAB_WAKE_RECONNECT_THRESHOLD_MS,
    )).toBe(true);
  });

  it('keeps a recently hidden open socket', () => {
    const hiddenSince = 1_000;

    expect(shouldForceWebSocketReconnect(
      hiddenSince,
      SOCKET_OPEN,
      hiddenSince + TAB_WAKE_RECONNECT_THRESHOLD_MS - 1,
    )).toBe(false);
  });

  it('does not force a socket that is already reconnecting', () => {
    expect(shouldForceWebSocketReconnect(1_000, SOCKET_CLOSING, 60_000)).toBe(false);
    expect(shouldForceWebSocketReconnect(null, SOCKET_OPEN, 60_000)).toBe(false);
  });
});
