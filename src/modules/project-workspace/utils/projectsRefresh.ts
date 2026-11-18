type RefreshScheduler = (
  callback: () => void,
  delayMs: number,
) => ReturnType<typeof setTimeout>;

/**
 * Used by useProjectsState to fold a burst of "the list may be stale" signals
 * (the tab becoming visible, the browser coming back online) into one silent
 * project refresh. The websocket's own `websocket_reconnected` event refreshes
 * directly; these cover a gap the socket never noticed.
 */
export const createProjectsRefreshCoalescer = (
  refresh: () => void,
  delayMs = 250,
  schedule: RefreshScheduler = setTimeout,
  cancel: (handle: ReturnType<typeof setTimeout>) => void = clearTimeout,
) => {
  let pending: ReturnType<typeof setTimeout> | null = null;

  return {
    request() {
      if (pending !== null) {
        cancel(pending);
      }
      pending = schedule(() => {
        pending = null;
        refresh();
      }, delayMs);
    },
    dispose() {
      if (pending !== null) {
        cancel(pending);
        pending = null;
      }
    },
  };
};
