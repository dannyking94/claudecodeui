/**
 * Opt-in on-screen trace of the chat scroll-anchoring system.
 *
 * The scroll jumps this traces only reproduce under a finger on iOS Safari,
 * which has no devtools without a tethered Mac. Enable with `?scrollDebug=1`
 * (persisted in localStorage; `?scrollDebug=0` clears it) and the chat renders
 * a small overlay of the last few events: every scrollTop write with its
 * reason, gesture starts, settle passes, page reveals, render-window moves and
 * lost anchors. Costs nothing when off — callers check the flag first.
 */

const STORAGE_KEY = 'cloudcli:scroll-debug';
const MAX_LINES = 16;

function readEnabled(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const param = new URLSearchParams(window.location.search).get('scrollDebug');
    if (param !== null) {
      if (param === '0' || param === 'false' || param === 'off') {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, '1');
      }
    }
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export const SCROLL_DEBUG_ENABLED = readEnabled();

type Listener = () => void;

const listeners = new Set<Listener>();
let snapshot: readonly string[] = [];
const startedAt = typeof performance !== 'undefined' ? performance.now() : 0;

function formatValue(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
  return String(value);
}

export function scrollDebug(tag: string, detail?: Record<string, unknown>): void {
  if (!SCROLL_DEBUG_ENABLED) {
    return;
  }
  const elapsed = ((performance.now() - startedAt) / 1000).toFixed(2);
  const fields = detail
    ? Object.entries(detail).map(([key, value]) => `${key}=${formatValue(value)}`).join(' ')
    : '';
  const line = fields ? `${elapsed} ${tag} ${fields}` : `${elapsed} ${tag}`;
  // Immutable snapshot so useSyncExternalStore sees a new reference per event.
  snapshot = [...snapshot.slice(-(MAX_LINES - 1)), line];
  console.debug('[scroll]', line);
  listeners.forEach((listener) => listener());
}

export function subscribeScrollDebug(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getScrollDebugSnapshot(): readonly string[] {
  return snapshot;
}
