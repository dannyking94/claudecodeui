import type { RequestHandler } from 'express';

// A handler that never answers leaves no trace: nothing is logged, the
// request simply stays open. Over plain HTTP/1.1 the browser keeps at most six
// connections per origin, so six such requests silently stall every later API
// call from that browser — which is how "New Session loads forever" and a
// vanished usage pill looked on 2026-10-28, with an empty server log. This
// names the stalled route so the next occurrence is diagnosable from the log.

/** How long an /api request may stay unanswered before it is reported. */
const STALLED_REQUEST_THRESHOLD_MS = 60_000;

type RequestWatchdogOptions = {
  thresholdMs?: number;
  log?: (message: string) => void;
};

/**
 * Builds the middleware the server entrypoint mounts on `/api`.
 *
 * Only the method and path are logged: query strings can carry the auth token
 * (EventSource cannot set headers). Event streams are exempt because staying
 * open is their job.
 */
export function createRequestWatchdog(options: RequestWatchdogOptions = {}): RequestHandler {
  const thresholdMs = options.thresholdMs ?? STALLED_REQUEST_THRESHOLD_MS;
  const log = options.log ?? ((message: string) => console.warn(message));

  return (req, res, next) => {
    if (req.headers.accept?.includes('text/event-stream')) {
      next();
      return;
    }

    const startedAt = Date.now();
    const label = `${req.method} ${req.baseUrl}${req.path}`;
    let reported = false;

    const timer = setTimeout(() => {
      reported = true;
      log(`[http] ${label} still unanswered after ${Math.round(thresholdMs / 1000)}s`);
    }, thresholdMs);
    // Never a reason on its own to keep the process alive.
    timer.unref?.();

    const settle = () => {
      clearTimeout(timer);
      res.off('finish', settle);
      res.off('close', settle);
      if (reported) {
        const outcome = res.writableFinished ? 'answered' : 'abandoned by the client';
        log(`[http] ${label} ${outcome} after ${Math.round((Date.now() - startedAt) / 1000)}s`);
      }
    };
    res.on('finish', settle);
    res.on('close', settle);
    next();
  };
}
