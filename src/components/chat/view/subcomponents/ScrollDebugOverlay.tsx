import { useSyncExternalStore } from 'react';

import { getScrollDebugSnapshot, subscribeScrollDebug } from '../../utils/scrollDebug';

/**
 * Renders the scroll-debug trace over the chat. Mounted only when
 * `SCROLL_DEBUG_ENABLED` (see utils/scrollDebug.ts); sits above the composer
 * and ignores pointer events so it never interferes with the gesture under test.
 */
export default function ScrollDebugOverlay() {
  const lines = useSyncExternalStore(subscribeScrollDebug, getScrollDebugSnapshot, getScrollDebugSnapshot);

  return (
    <pre
      aria-hidden
      className="pointer-events-none fixed bottom-28 left-1 z-[200] max-h-[45vh] max-w-[96vw] overflow-hidden whitespace-pre-wrap break-all rounded bg-black/75 px-1.5 py-1 font-mono text-[9px] leading-[11px] text-green-200"
    >
      {lines.length > 0 ? lines.join('\n') : 'scroll debug on — waiting for events'}
    </pre>
  );
}
