import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SOCKET_OPEN,
  TAB_WAKE_RECONNECT_THRESHOLD_MS,
  shouldForceWebSocketReconnect,
} from './webSocketReconnect';

test('forces an open socket to reconnect after a long tab suspension', () => {
  const hiddenSince = 1_000;

  assert.equal(shouldForceWebSocketReconnect(
    hiddenSince,
    SOCKET_OPEN,
    hiddenSince + TAB_WAKE_RECONNECT_THRESHOLD_MS,
  ), true);
});

test('keeps a recently hidden open socket', () => {
  const hiddenSince = 1_000;

  assert.equal(shouldForceWebSocketReconnect(
    hiddenSince,
    SOCKET_OPEN,
    hiddenSince + TAB_WAKE_RECONNECT_THRESHOLD_MS - 1,
  ), false);
});

test('does not force a socket that is already reconnecting', () => {
  assert.equal(shouldForceWebSocketReconnect(1_000, 2, 60_000), false); // WebSocket.CLOSING
  assert.equal(shouldForceWebSocketReconnect(null, SOCKET_OPEN, 60_000), false);
});
