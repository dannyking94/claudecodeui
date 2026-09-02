export type RefreshScheduler = (
  callback: () => void,
  delayMs: number,
) => ReturnType<typeof setTimeout>;

export const shouldRefreshProjectsAfterWebSocketEvent = (kind?: string): boolean =>
  kind === 'websocket_reconnected';

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
