// createSystemModule: used by the server entrypoint to mount protected system update routes.
export { createSystemModule } from './system.module.js';
// Demand-driven host telemetry, streamed over the chat websocket while a client watches.
export {
  startSystemStatsCollection,
  stopSystemStatsCollectionIfIdle,
  subscribeToSystemStats,
  unsubscribeFromSystemStats,
  type SystemStatsSample,
} from './system-stats.service.js';
