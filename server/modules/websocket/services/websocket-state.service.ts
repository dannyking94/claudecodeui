import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Numeric readyState for a closed WebSocket connection.
 *
 * Used as the placeholder connection for runs that start without a client
 * asking for them (scheduled work waking a session up): their events are
 * buffered for replay, and delivery begins when a client subscribes.
 */
export const WS_CLOSED_STATE = 3;

/**
 * Shared registry of active chat WebSocket connections.
 *
 * Project/session services publish realtime updates by iterating this set.
 */
export const connectedClients = new Set<RealtimeClientConnection>();
