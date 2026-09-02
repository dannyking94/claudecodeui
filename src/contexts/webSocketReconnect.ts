export const SOCKET_OPEN = 1;

export const TAB_WAKE_RECONNECT_THRESHOLD_MS = 30_000;

export const shouldForceWebSocketReconnect = (
  hiddenSince: number | null,
  readyState: number,
  now: number,
): boolean =>
  readyState === SOCKET_OPEN
  && hiddenSince !== null
  && now - hiddenSince >= TAB_WAKE_RECONNECT_THRESHOLD_MS;
