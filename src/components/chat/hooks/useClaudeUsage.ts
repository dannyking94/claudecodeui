import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { ClaudeUsage, ClaudeUsageLimit, ClaudeUsageWindow } from '../types/types';

/**
 * Percentages move slowly and the upstream endpoint is undocumented, so this
 * polls conservatively. The server caches on top of this, so extra tabs cost
 * nothing upstream.
 */
const POLL_INTERVAL_MS = 60_000;

/**
 * Used until the first parseable answer arrives. A poll issued while the server
 * is still starting, or while the auth token is being refreshed, fails through
 * no fault of the route; retrying in seconds keeps the pill from being absent
 * for a whole minute after a restart.
 */
const STARTUP_RETRY_INTERVAL_MS = 5_000;

function readLimits(value: unknown): ClaudeUsageLimit[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const limits: ClaudeUsageLimit[] = [];

  for (const entry of value) {
    const window = readWindow(entry);
    const kind = (entry as Record<string, unknown>)?.kind;
    if (!window || typeof kind !== 'string') {
      continue;
    }

    const scopeLabel = (entry as Record<string, unknown>).scopeLabel;
    limits.push({
      kind,
      ...window,
      scopeLabel: typeof scopeLabel === 'string' ? scopeLabel : null,
      isActive: (entry as Record<string, unknown>).isActive === true,
    });
  }

  return limits;
}

function readWindow(value: unknown): ClaudeUsageWindow | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const utilization = Number(record.utilization);
  if (!Number.isFinite(utilization)) {
    return null;
  }

  const resetsAt = Number(record.resetsAt);
  const severity = record.severity;

  return {
    utilization,
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
    severity: severity === 'warning' || severity === 'critical' ? severity : 'normal',
  };
}

/**
 * Reads the Claude plan allowance for the account signed in on the server host.
 *
 * Returns null whenever there is nothing to show — a server that predates the
 * route, a platform deployment that withholds it, a signed-out host, or an
 * upstream failure. The caller renders nothing in every one of those cases, so
 * they need no separate error state.
 */
export function useClaudeUsage(enabled = true): ClaudeUsage | null {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  /**
   * An older server answers this unknown `/api` path with the SPA's index.html.
   * Once that is detected there is no route to poll, so polling stops for the
   * lifetime of the page rather than repeating every minute.
   *
   * Only proof that the route is *absent* may latch this. A failed request is
   * not such proof: the first poll after a server restart routinely races the
   * auth token and comes back 401, and treating that as "unsupported" would
   * hide the pill until a full page reload.
   */
  const unsupportedRef = useRef(false);
  /** False until the route has answered at all; drives the fast startup retry. */
  const settledRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled || unsupportedRef.current) {
      return;
    }

    try {
      const response = await authenticatedFetch('/api/system/claude-usage');

      // The SPA fallback is the one unambiguous "no such route" signal.
      if (!response.headers.get('content-type')?.includes('application/json')) {
        unsupportedRef.current = true;
        settledRef.current = true;
        return;
      }

      // Anything else non-2xx is transient — auth warm-up, a rate limit, a
      // restart mid-poll. Keep the last reading and try again next tick.
      if (!response.ok) {
        return;
      }

      const payload = await response.json();
      if (payload?.capability !== 'claude-usage') {
        unsupportedRef.current = true;
        settledRef.current = true;
        return;
      }

      // Reaching a parseable answer — even "nothing to show" — means the route
      // is live and the fast startup retries can stop.
      settledRef.current = true;

      if (payload.status !== 'ok') {
        // `not_signed_in` and `disabled` describe the host and will not change
        // between polls, so the pill should go away. `upstream_error` says
        // only that the lookup failed — the allowance itself is unchanged, and
        // blanking on it made the pill vanish for a minute at a time whenever
        // the undocumented endpoint rate-limited us.
        if (payload.reason === 'upstream_error') {
          return;
        }

        setUsage(null);
        return;
      }

      const fiveHour = readWindow(payload.fiveHour);
      const sevenDay = readWindow(payload.sevenDay);

      setUsage(
        fiveHour || sevenDay
          ? {
              fiveHour,
              sevenDay,
              limits: readLimits(payload.limits),
              plan: typeof payload.plan === 'string' ? payload.plan : null,
              stale: payload.stale === true,
            }
          : null,
      );
    } catch {
      // A transient network failure keeps the last known reading on screen
      // rather than blanking the pill; the next tick corrects it.
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let cancelled = false;
    let timer = 0;

    /**
     * Self-scheduling rather than a fixed interval: until the first parseable
     * answer arrives the retry is short, so a poll that raced the server's
     * startup or an auth refresh recovers in seconds instead of leaving the
     * pill missing for a full minute.
     */
    const scheduleNext = () => {
      if (cancelled) {
        return;
      }
      timer = window.setTimeout(
        tick,
        settledRef.current ? POLL_INTERVAL_MS : STARTUP_RETRY_INTERVAL_MS,
      );
    };

    const tick = () => {
      if (cancelled) {
        return;
      }

      // The visibility listener calls this directly, so drop any pending timer
      // first — otherwise each tab switch would leave an extra one running.
      window.clearTimeout(timer);

      // A backgrounded tab has no viewer, so it does not poll — but it keeps
      // its place in the schedule so returning to it resumes cleanly.
      if (document.visibilityState === 'visible' && !unsupportedRef.current) {
        void refresh().finally(scheduleNext);
        return;
      }

      scheduleNext();
    };

    tick();
    // Coming back to the tab should show a current number immediately rather
    // than whatever was true when it was backgrounded.
    document.addEventListener('visibilitychange', tick);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [enabled, refresh]);

  return usage;
}
