import { useCallback, useEffect, useRef, useState } from 'react';

import { useWebSocket, type ServerEvent } from '../../../contexts/WebSocketContext';
import { authenticatedFetch } from '../../../utils/api';
import type { SystemStatsFrame, SystemStatsSample } from '../types/types';

/** Matches the server's retention: one sample per second over one minute. */
export const HISTORY_LENGTH = 60;

function isSystemStatsFrame(event: ServerEvent): event is ServerEvent & SystemStatsFrame {
  return event.kind === 'system_stats' && Array.isArray((event as SystemStatsFrame).samples);
}

/**
 * - `probing`     — capability request in flight
 * - `supported`   — safe to open the stream
 * - `disabled`    — server has telemetry but withholds it (platform mode)
 * - `unsupported` — server predates the feature; the stream must not be opened
 */
export type SystemStatsSupport = 'probing' | 'supported' | 'disabled' | 'unsupported';

type UseSystemStatsResult = {
  samples: SystemStatsSample[];
  latest: SystemStatsSample | null;
  gpuAvailable: boolean;
  support: SystemStatsSupport;
};

/**
 * Asks the server whether it can stream host telemetry.
 *
 * An older server answers unknown `/api` paths with the SPA's index.html at
 * status 200, so neither `response.ok` nor a bare JSON parse is proof of
 * support — only the echoed `capability` marker is.
 */
async function probeSupport(): Promise<SystemStatsSupport> {
  try {
    const response = await authenticatedFetch('/api/system/stats/capability');
    if (!response.ok) {
      return 'unsupported';
    }

    if (!response.headers.get('content-type')?.includes('application/json')) {
      return 'unsupported';
    }

    const payload = await response.json();
    if (payload?.capability !== 'system-stats' || payload?.supported !== true) {
      return 'unsupported';
    }

    return payload.disabled === true ? 'disabled' : 'supported';
  } catch {
    return 'unsupported';
  }
}

/**
 * Streams host telemetry while `enabled` is true.
 *
 * The server collects continuously for as long as any browser is connected, so
 * the panel opens onto a full 60-second window. This subscription controls only
 * whether those samples are *delivered* — a closed panel or a backgrounded tab
 * receives nothing, while the window it will show keeps filling.
 */
export function useSystemStats(enabled: boolean): UseSystemStatsResult {
  const { sendMessage, subscribe, isConnected } = useWebSocket();
  const [samples, setSamples] = useState<SystemStatsSample[]>([]);
  const [gpuAvailable, setGpuAvailable] = useState(false);
  const [support, setSupport] = useState<SystemStatsSupport>('probing');

  // Tracks whether a subscribe was actually sent, so the paired unsubscribe is
  // never sent for a subscription that never started.
  const isSubscribedRef = useRef(false);

  const stop = useCallback(() => {
    if (!isSubscribedRef.current) {
      return;
    }
    isSubscribedRef.current = false;
    sendMessage({ type: 'system.unsubscribe' });
  }, [sendMessage]);

  const start = useCallback(() => {
    if (isSubscribedRef.current) {
      return;
    }
    isSubscribedRef.current = true;
    sendMessage({ type: 'system.subscribe' });
  }, [sendMessage]);

  // Probed once per mount, before any websocket message is sent.
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let cancelled = false;
    void probeSupport().then((result) => {
      if (!cancelled) {
        setSupport(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    return subscribe((event) => {
      if (!isSystemStatsFrame(event)) {
        // A reconnect drops the server-side subscription with the old socket,
        // so it has to be re-established on the new one.
        if (event.kind === 'websocket_reconnected' && isSubscribedRef.current) {
          isSubscribedRef.current = false;
          start();
        }
        return;
      }

      setGpuAvailable(event.gpuAvailable);
      if (event.disabled) {
        setSupport('disabled');
      }
      setSamples((previous) => [...previous, ...event.samples].slice(-HISTORY_LENGTH));
    });
  }, [enabled, start, subscribe]);

  useEffect(() => {
    // Only a server that confirmed the capability may be sent `system.subscribe`;
    // an older one would reject it into the user's chat transcript.
    if (!enabled || !isConnected || support !== 'supported') {
      return undefined;
    }

    const syncToVisibility = () => {
      if (document.visibilityState === 'visible') {
        start();
      } else {
        stop();
      }
    };

    syncToVisibility();
    document.addEventListener('visibilitychange', syncToVisibility);

    return () => {
      document.removeEventListener('visibilitychange', syncToVisibility);
      stop();
    };
  }, [enabled, isConnected, support, start, stop]);

  // History older than the panel's last opening would draw as a flat segment
  // spliced onto live data, so each opening starts from whatever the server
  // still considers fresh.
  useEffect(() => {
    if (!enabled) {
      setSamples([]);
      setSupport('probing');
    }
  }, [enabled]);

  return {
    samples,
    latest: samples.length > 0 ? samples[samples.length - 1] : null,
    gpuAvailable,
    support,
  };
}
