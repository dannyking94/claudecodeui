import type { NormalizedMessage } from './useSessionStore';

const LOCAL_USER_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const LOCAL_USER_DEDUPE_CLOCK_SKEW_MS = 10_000;
const LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS = 30_000;

type UserTurnFingerprint = {
  text: string;
  imageCount: number;
  fileCount: number;
};

function userTurnFingerprint(message: NormalizedMessage): UserTurnFingerprint | null {
  if (message.kind !== 'text' || message.role !== 'user') return null;

  const text = (message.content || '').trim();
  const imageCount = Array.isArray(message.images) ? message.images.length : 0;
  const fileCount = Array.isArray(message.files) ? message.files.length : 0;
  if (!text && imageCount === 0 && fileCount === 0) return null;

  return { text, imageCount, fileCount };
}

function userTurnFingerprintsMatch(
  local: UserTurnFingerprint,
  server: UserTurnFingerprint,
): boolean {
  return (
    local.text === server.text
    && local.imageCount === server.imageCount
    && local.fileCount === server.fileCount
  );
}

function readMessageTime(message: NormalizedMessage): number | null {
  const time = Date.parse(message.timestamp);
  return Number.isFinite(time) ? time : null;
}

function findServerEchoForLocalUser(
  localMessage: NormalizedMessage,
  serverMessages: NormalizedMessage[],
  claimedServerIds: Set<string>,
): NormalizedMessage | null {
  const localFingerprint = userTurnFingerprint(localMessage);
  const localTime = readMessageTime(localMessage);
  if (!localFingerprint || localTime === null) {
    return null;
  }

  const dedupeWindow = localFingerprint.text
    ? LOCAL_USER_DEDUPE_WINDOW_MS
    : LOCAL_ATTACHMENT_ONLY_DEDUPE_WINDOW_MS;
  let closestMatch: NormalizedMessage | null = null;
  let closestTimeDifference = Number.POSITIVE_INFINITY;

  for (const serverMessage of serverMessages) {
    if (claimedServerIds.has(serverMessage.id)) {
      continue;
    }

    const serverFingerprint = userTurnFingerprint(serverMessage);
    if (!serverFingerprint || !userTurnFingerprintsMatch(localFingerprint, serverFingerprint)) {
      continue;
    }

    const serverTime = readMessageTime(serverMessage);
    if (
      serverTime === null
      || serverTime < localTime - LOCAL_USER_DEDUPE_CLOCK_SKEW_MS
      || serverTime - localTime > dedupeWindow
    ) {
      continue;
    }

    const timeDifference = Math.abs(serverTime - localTime);
    if (timeDifference < closestTimeDifference) {
      closestMatch = serverMessage;
      closestTimeDifference = timeDifference;
    }
  }

  return closestMatch;
}

/**
 * Removes local optimistic user rows once a corresponding persisted turn is
 * available. Matches are one-to-one so repeated sends cannot claim one row.
 */
export function removeOptimisticUserEchoes(
  serverMessages: NormalizedMessage[],
  realtimeMessages: NormalizedMessage[],
): NormalizedMessage[] {
  const claimedServerIds = new Set<string>();

  return realtimeMessages.filter((message) => {
    if (!message.id.startsWith('local_')) {
      return true;
    }

    const serverEcho = findServerEchoForLocalUser(message, serverMessages, claimedServerIds);
    if (!serverEcho) {
      return true;
    }

    claimedServerIds.add(serverEcho.id);
    return false;
  });
}

export type RefreshedTailMerge = {
  messages: NormalizedMessage[];
  /** True when the merge kept or dropped rows older than `fetchedTail`. */
  keptOlderRows: boolean;
  droppedOlderRows: boolean;
};

/**
 * Splice a freshly fetched transcript tail onto the rows already loaded.
 *
 * Both inputs are contiguous, chronological tails of the same transcript
 * (`loaded` from an earlier fetch). The rows from the first overlap onward are
 * taken from `fetchedTail`, so new rows and late-attached tool results land,
 * while older loaded rows keep their identity (the chat converter and the
 * render-window hold key on it).
 *
 * Returns null when the tail does not reach back far enough to overlap the
 * loaded rows cleanly; the caller must fetch a longer tail.
 */
export function mergeRefreshedTail(
  loaded: NormalizedMessage[],
  fetchedTail: NormalizedMessage[],
): RefreshedTailMerge | null {
  if (loaded.length === 0) {
    return { messages: fetchedTail, keptOlderRows: false, droppedOlderRows: false };
  }

  const loadedIndexById = new Map<string, number>();
  loaded.forEach((message, index) => loadedIndexById.set(message.id, index));

  for (let fetchedIndex = 0; fetchedIndex < fetchedTail.length; fetchedIndex += 1) {
    const loadedIndex = loadedIndexById.get(fetchedTail[fetchedIndex].id);
    if (loadedIndex === undefined) continue;

    if (fetchedIndex === 0) {
      // The tail starts inside the loaded range: keep what precedes it.
      return {
        messages: loadedIndex === 0 ? fetchedTail : [...loaded.slice(0, loadedIndex), ...fetchedTail],
        keptOlderRows: loadedIndex > 0,
        droppedOlderRows: false,
      };
    }
    if (loadedIndex === 0) {
      // The tail reaches above the loaded range. Don't grow the list upward
      // under the reader; those rows stay behind pagination.
      return { messages: fetchedTail.slice(fetchedIndex), keptOlderRows: false, droppedOlderRows: true };
    }
    // Rows the loaded list never had sit between loaded rows (e.g. a reordered
    // sidechain): only a tail covering the whole loaded range can be trusted.
    return null;
  }

  return null;
}
