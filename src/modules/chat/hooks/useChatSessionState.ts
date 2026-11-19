import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '@/shared/api';
import type { MarkSessionIdle, SessionActivityMap,Project,ProjectSession,LLMProvider,NormalizedMessage,ChatMessage,DiffCalculator } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import { SESSION_MESSAGES_PAGE_SIZE } from '@/modules/chat/utils/sessionMessagePagination';
import { createMessageHistoryRefreshCoordinator } from '@/modules/chat/utils/messageHistoryRefreshCoordinator';
import { createCachedDiffCalculator } from '@/modules/chat/utils/messageTransforms';
import { normalizedToChatMessages } from '@/modules/chat/hooks/useChatMessages';
import { findSearchTargetIndex, resolveSearchWindowSize } from '@/modules/chat/utils/searchTargetLocator';
import { readSelectedProvider } from '@/shared/selectedProvider';
import type { SearchTarget } from '@/modules/chat/utils/searchTargetLocator';
import { sideQuestionStore, useSideQuestions } from '@/modules/chat/hooks/useSideQuestions';
import { mergeSideQuestions } from '@/modules/chat/utils/sideQuestions';
import {
  captureMotionBaseline,
  captureScrollAnchor,
  distanceFromBottom,
  motionShiftAboveViewport,
  restoreScrollAnchor,
  DETACH_BELOW_PX,
  REATTACH_WITHIN_PX,
} from '@/modules/chat/utils/scrollAnchor';
import type { MotionBaseline, ScrollAnchor } from '@/modules/chat/utils/scrollAnchor';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/messageKeys';
import { DOCUMENT_SCROLL_ENABLED, isDocumentScrollActive, isDocumentScroller } from '@/shared/documentScroll';
import { SCROLL_DEBUG_ENABLED, scrollDebug } from '@/modules/chat/utils/scrollDebug';

const INITIAL_VISIBLE_MESSAGES = 100;
/**
 * Browsers with native CSS scroll anchoring (Chrome/Firefox) already hold the
 * reading line through mid-scroll reflows in-engine; layering the manual
 * motion-baseline correction on top would compensate the same shift twice.
 * WebKit reports false and gets the manual pass.
 */
const HAS_NATIVE_SCROLL_ANCHORING =
  typeof CSS !== 'undefined' &&
  typeof CSS.supports === 'function' &&
  CSS.supports('overflow-anchor: auto');
/**
 * Quiet period after the last scroll event before the viewport counts as
 * settled. Long enough to bridge the gaps between coalesced scroll events
 * during iOS momentum, short enough to feel immediate when you stop to read.
 */
const SCROLL_SETTLE_MS = 150;

/**
 * Locate a previously rendered message in the current list.
 *
 * Identity first; on a miss, by intrinsic key. `refreshFromServer` — run after
 * every `complete` and on every reconnect — replaces every server-backed
 * NormalizedMessage, so the converter (keyed on identity) hands back fresh
 * ChatMessage objects and an identity-only lookup fails precisely when the
 * list changed most.
 */
function indexOfMessage(list: ChatMessage[], message: ChatMessage | null, key: string | null): number {
  if (!message) return -1;
  const byIdentity = list.indexOf(message);
  if (byIdentity >= 0 || !key) return byIdentity;
  return list.findIndex((candidate) => getIntrinsicMessageKey(candidate) === key);
}

/** Messages kept below a search hit so it lands mid-viewport rather than at the edge. */
const SEARCH_TARGET_CONTEXT_MESSAGES = 20;

/**
 * Widening the window can commit thousands of rows on an old hit, each running
 * the markdown pipeline, so the scroll waits about three seconds for that render
 * — the same budget the previous DOM scan used.
 */
const SEARCH_SCROLL_RETRIES = 20;
const SEARCH_SCROLL_RETRY_DELAY_MS = 150;

/**
 * Finds the rendered row for a resolved search target.
 *
 * Only an exact timestamp match counts while retries remain: the widened window
 * may not be committed yet, and accepting the nearest row then would scroll to
 * an arbitrary message and flash the highlight on it — the silent wrong answer
 * this rewrite exists to remove. `allowNearest` is used on the final attempt
 * because a hit on the second or later call of a collapsed tool group has no row
 * of its own; groupConsecutiveTools stamps the group with the run's FIRST
 * timestamp, so the group row is the nearest, not an exact, match.
 */
function findRenderedMessageElement(
  container: HTMLElement,
  timestamp: unknown,
  allowNearest: boolean,
): HTMLElement | null {
  const targetTimestamp = String(timestamp);
  const targetTime = new Date(targetTimestamp).getTime();
  const candidates = container.querySelectorAll<HTMLElement>('[data-message-timestamp]');

  let nearest: HTMLElement | null = null;
  let nearestDistance = Infinity;

  for (const candidate of candidates) {
    const candidateTimestamp = candidate.getAttribute('data-message-timestamp');
    if (!candidateTimestamp) {
      continue;
    }
    if (candidateTimestamp === targetTimestamp) {
      return candidate;
    }

    if (!allowNearest) {
      continue;
    }

    const candidateTime = new Date(candidateTimestamp).getTime();
    if (!Number.isFinite(candidateTime) || !Number.isFinite(targetTime)) {
      continue;
    }

    const distance = Math.abs(candidateTime - targetTime);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = candidate;
    }
  }

  return nearest;
}
/** Stable empty list so `chatMessages` keeps its identity while no session is selected. */
const NO_MESSAGES: NormalizedMessage[] = [];

/**
 * The visible-window size that shows the row at `index` of `total` rows, with
 * a page of context above it; the current size when the row already shows.
 * The window is a tail slice, so a row is visible when at most `count` rows
 * follow it, itself included.
 */
export function visibleCountToReveal(total: number, index: number, current: number): number {
  const needed = total - index;
  return needed <= current ? current : needed + SESSION_MESSAGES_PAGE_SIZE;
}

type UseChatSessionStateArgs = {
  isActive: boolean;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  processingSessions?: SessionActivityMap;
  onSessionIdle?: MarkSessionIdle;
  resetStreamingState: () => void;
  /** When each session's `chat.subscribe` was last sent; guards stale idle acks. */
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  /** Highest live seq observed per session; sent as `lastSeq` on subscribe. */
  lastSeqRef: MutableRefObject<Map<string, number>>;
  sessionStore: SessionStore;
};

/* ------------------------------------------------------------------ */
/*  Helper: Convert a ChatMessage to a NormalizedMessage for the store */
/* ------------------------------------------------------------------ */

function chatMessageToNormalized(
  msg: ChatMessage,
  sessionId: string,
  provider: LLMProvider,
): NormalizedMessage | null {
  const id = `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ts = msg.timestamp instanceof Date
    ? msg.timestamp.toISOString()
    : typeof msg.timestamp === 'number'
      ? new Date(msg.timestamp).toISOString()
      : String(msg.timestamp);
  const base = { id, sessionId, timestamp: ts, provider };

  if (msg.isToolUse) {
    return {
      ...base,
      kind: 'tool_use',
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      toolId: msg.toolId || id,
    } as NormalizedMessage;
  }
  if (msg.isThinking) {
    return { ...base, kind: 'thinking', content: msg.content || '' } as NormalizedMessage;
  }
  if (msg.isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: msg.taskNotificationStatus || 'completed',
      summary: msg.content || '',
    } as NormalizedMessage;
  }
  if (msg.type === 'error') {
    return { ...base, kind: 'error', content: msg.content || '' } as NormalizedMessage;
  }
  return {
    ...base,
    kind: 'text',
    role: msg.type === 'user' ? 'user' : 'assistant',
    content: msg.content || '',
    // Keep attachment references on the local echo so the user bubble shows
    // its files immediately, before the server-backed copy replaces it.
    images: Array.isArray(msg.images) && msg.images.length > 0 ? msg.images : undefined,
    files: Array.isArray(msg.files) && msg.files.length > 0 ? msg.files : undefined,
    // Survives the truncation that follows an edit, which clears every other
    // live row.
    replacesAnchorId: msg.replacesAnchorId,
  } as NormalizedMessage;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
  isActive,
  selectedProject,
  selectedSession,
  ws,
  sendMessage,
  externalMessageUpdate,
  newSessionTrigger,
  processingSessions,
  onSessionIdle,
  resetStreamingState,
  statusCheckSentAtRef,
  lastSeqRef,
  sessionStore,
}: UseChatSessionStateArgs) {
  const { t } = useTranslation('chat');
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  // Never set: a loading row at the top would shift the page being read.
  const [isLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);

  // Normally the transcript pane, attached by ChatMessagesPane. In
  // document-scroll mode (iPhone/iPad browser tab) the page itself scrolls, so
  // the ref is pinned to <html> for the life of the hook and the pane leaves it
  // alone (src/shared/documentScroll.ts).
  const scrollContainerRef = useRef<HTMLDivElement>(
    DOCUMENT_SCROLL_ENABLED ? (document.documentElement as HTMLDivElement) : null,
  );
  /** Wraps the rendered messages; observed for height changes so lazy reflow can be absorbed. */
  const messagesContentRef = useRef<HTMLDivElement>(null);
  /**
   * Hard latch: the user has taken manual control of the viewport and no
   * automatic scroll may move it until they return to the bottom themselves.
   *
   * This is a ref, not state, because it has to flip *synchronously* inside a
   * touch/wheel handler. `isUserScrolledUp` is the same signal as React state
   * for rendering the scroll-to-bottom button, but state updates land a render
   * later — long enough for an in-flight auto-scroll to yank the view away.
   */
  const userDetachedRef = useRef(false);
  /**
   * True between touchstart and touchend.
   *
   * The detach latch only trips once the user has moved past the near-bottom
   * threshold, which leaves a window at the very start of a drag where they are
   * pulling the list down while auto-follow is still allowed to snap it back.
   * Suppressing follow for the whole gesture closes that window.
   */
  const isTouchingRef = useRef(false);
  /**
   * True while the viewport is still moving — finger down, or momentum still
   * producing scroll events.
   *
   * Nothing may write `scrollTop` while this is set. Correcting the offset
   * mid-flick fights the gesture, and on WebKit writing `scrollTop` during
   * momentum disturbs the momentum itself. Both read as jitter.
   */
  const isScrollingRef = useRef(false);
  const scrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Set immediately before we assign `scrollTop` ourselves, so the `scroll`
   * event it provokes is not mistaken for the user moving the viewport.
   *
   * Without this, following a live stream would suppress itself: each
   * auto-scroll would look like user motion, restart the settle timer, and
   * block the next one.
   */
  const programmaticScrollRef = useRef(false);
  const programmaticResetRafRef = useRef(0);
  /** The element currently pinned while the user reads back through history. */
  const scrollAnchorRef = useRef<ScrollAnchor | null>(null);
  /** Session the one-time initial scroll-to-bottom has already run for. */
  const initialScrollKeyRef = useRef<string | null>(null);
  const wasNearTopRef = useRef(false);
  // The sidebar-search hit this transcript still owes the user a scroll to.
  // State rather than a ref because resolving it widens the render window,
  // and it is cleared once the row is on screen or the retries run out.
  const [searchTarget, setSearchTarget] = useState<SearchTarget | null>(null);
  const searchScrollActiveRef = useRef(false);
  /**
   * The pending step of the search-jump retry chain, so a session change can
   * cancel a jump that belongs to the transcript the user just left.
   */
  const searchScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const pendingScrollRestoreRef = useRef<ScrollAnchor | null>(null);
  /** Last scroll offset seen while the Chat tab was showing; restored when it shows again. */
  const scrollPositionRef = useRef({ height: 0, top: 0 });
  /**
   * A fetched page of older messages whose reveal is waiting for the viewport
   * to stop moving. Revealing mid-momentum computes the compensating
   * scrollTop from main-thread scroll values that lag the compositor while it
   * coasts — the write lands on a stale base and reads as a jump.
   */
  const pendingPrependCommitRef = useRef<(() => void) | null>(null);
  /**
   * scrollTop as of the last real scroll event. iOS delivers scroll events
   * sparsely during momentum (worse while the main thread is busy committing
   * new messages), so event silence alone cannot prove the viewport stopped;
   * the settle timer re-checks this against the live position.
   */
  const lastScrollEventPosRef = useRef(0);
  /** Layout snapshot from the start of the current scroll gesture (WebKit only). */
  const motionBaselineRef = useRef<MotionBaseline | null>(null);
  /**
   * First message currently rendered (the window start), tracked by identity
   * rather than index: prepending a page shifts every index by the page size,
   * so an index can't distinguish "same window" from "reveal 20 more".
   */
  const renderedFirstMessageRef = useRef<ChatMessage | null>(null);
  /** Intrinsic key of `renderedFirstMessageRef`; survives the object being replaced by a refresh. */
  const renderedFirstMessageKeyRef = useRef<string | null>(null);
  /** Index of the rendered first message in `chatMessagesRef`, as of the last render. */
  const renderWindowStartRef = useRef(0);
  /** The derived list as of the last render, for callbacks that size the window against it. */
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const renderWindowSessionRef = useRef<string | null>(null);
  /**
   * While a fetched older page waits for scroll-settle, the render window may
   * not extend above this message. The store prepends the page as soon as the
   * fetch resolves — possibly mid-gesture — and without this gate the slice
   * would paint it immediately: a full page of content inserted above the
   * viewport, uncompensated because no scrollTop write is allowed during
   * motion, which reads as being thrown to the top of the chat.
   */
  const pendingPrependGateRef = useRef<ChatMessage | null>(null);
  /** Intrinsic key of `pendingPrependGateRef`, for the same reason as `renderedFirstMessageKeyRef`. */
  const pendingPrependGateKeyRef = useRef<string | null>(null);
  /**
   * True only while the per-session initial pin loop is actually running.
   *
   * Starts false on purpose: a brand-new session has no `selectedSession` until
   * the backend creates one, so the loop never starts, and a ref that defaulted
   * to true would suppress every auto-scroll for the whole first exchange.
   */
  const pendingInitialScrollRef = useRef(false);
  const messagesOffsetRef = useRef(0);
  const loadAllFinishedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadAllOverlayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastLoadedSessionKeyRef = useRef<string | null>(null);
  /**
   * Tracks the last processed value from `useProjectsState.newSessionTrigger`.
   *
   * The trigger itself is intentionally increment-only and routed via:
   * useProjectsState -> ProjectWorkspaceRoute -> WorkspaceMain -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);
  /** Last `externalMessageUpdate` value acted on; the effect's other deps churn far more often. */
  const lastExternalMessageUpdateRef = useRef(0);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

  useEffect(() => {
    if (!SCROLL_DEBUG_ENABLED) return;
    const engine = navigator.userAgent.match(/(?:Version|CriOS|Chrome|Firefox|FxiOS)\/[\d.]+/)?.[0] ?? '?';
    const os = navigator.userAgent.match(/OS (\d+_\d+)/)?.[1] ?? '';
    scrollDebug('init', { native: HAS_NATIVE_SCROLL_ANCHORING, engine, os });
  }, []);

  useEffect(() => {
    const trigger = newSessionTrigger ?? 0;
    if (trigger === previousNewSessionTriggerRef.current) {
      return;
    }
    previousNewSessionTriggerRef.current = trigger;

    /**
     * Consumer-side reset for explicit New Session intent.
     *
     * Why this is essential:
     * - Chat keeps local state that is not fully derived from `selectedSession`:
     *   `currentSessionId`, `pendingUserMessage`, streaming/status flags, message
     *   pagination/scroll bookkeeping, and provider-specific sessionStorage keys.
     * - If the user clicks New Session while already on the same route with no
     *   selected session, parent state updates can be idempotent and this local
     *   state would otherwise persist, making the click appear to "do nothing".
     *
     * What this reset guarantees:
     * - A deterministic clean draft state on every New Session click.
     * - No dependence on route/tab/session-object identity changes.
     * - No coupling to unrelated external update signals.
     */
    resetStreamingState();
    setCurrentSessionId(null);
    setPendingUserMessage(null);
    // A history load still in flight for the session being left would
    // otherwise keep the draft behind a "Loading session messages" spinner
    // until that request settles — forever, if it never does.
    setIsLoadingSessionMessages(false);
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    
    setTokenBudget(null);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    setSearchTarget(null);
    wasNearTopRef.current = false;
    searchScrollActiveRef.current = false;
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    pendingPrependCommitRef.current = null;
    pendingPrependGateRef.current = null;
    pendingPrependGateKeyRef.current = null;
    motionBaselineRef.current = null;
    // Clearing the key is what re-arms the initial scroll; the loop owns the
    // pending flag itself, so forcing it true here would only strand it set.
    pendingInitialScrollRef.current = false;
    initialScrollKeyRef.current = null;
    userDetachedRef.current = false;
    scrollAnchorRef.current = null;
    lastLoadedSessionKeyRef.current = null;

    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }
    if (loadAllFinishedTimerRef.current) {
      clearTimeout(loadAllFinishedTimerRef.current);
      loadAllFinishedTimerRef.current = null;
    }
  }, [newSessionTrigger, onSessionIdle, resetStreamingState]);

  /* ---------------------------------------------------------------- */
  /*  Derive processing state for the viewed session                  */
  /* ---------------------------------------------------------------- */

  const activeSessionId = selectedSession?.id || currentSessionId || null;

  // The activity indicator always reflects the latest status of the session
  // being viewed — never stale local UI state from the last time it was
  // open. Session ids are concrete before any send, so no pending
  // placeholder entry exists anymore. Background-only work shows in the
  // indicator but is not a response in flight: the composer can send.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  // Background-only work shows in the indicator but is not a response in
  // flight. Neither is external activity (a secretary working in its own tmux
  // claude): there is no run here to stop, queue behind, or protect from
  // transcript refreshes — the refreshes are how its work shows up.
  const isProcessing = sessionActivity !== null && !sessionActivity.background && !sessionActivity.external;
  const canAbortSession = isProcessing && sessionActivity.canInterrupt;

  // Ref mirror so effects can read the latest map without re-running on
  // every activity transition.
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  const isActiveRef = useRef(isActive);
  const activeSessionIdRef = useRef(activeSessionId);
  isActiveRef.current = isActive;
  activeSessionIdRef.current = activeSessionId;

  const latestRefreshExecutorRef = useRef<(sessionId: string) => Promise<boolean | void>>(
    async () => true,
  );
  latestRefreshExecutorRef.current = async (sessionId: string) => {
    const result = await sessionStore.refreshLatestFromServer(sessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      canRequest: () => (
        isActiveRef.current
        && activeSessionIdRef.current === sessionId
      ),
    });
    const slot = result.slot;
    if (slot && activeSessionIdRef.current === sessionId) {
      setHasMoreMessages(slot.hasMore);
      setTotalMessages(slot.total);
      messagesOffsetRef.current = slot.offset;
      if (slot.tokenUsage !== undefined) {
        setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
      }
    }
    return !result.deferred;
  };

  const refreshCoordinatorRef = useRef<ReturnType<typeof createMessageHistoryRefreshCoordinator> | null>(null);
  if (!refreshCoordinatorRef.current) {
    refreshCoordinatorRef.current = createMessageHistoryRefreshCoordinator(
      (sessionId) => latestRefreshExecutorRef.current(sessionId),
      (sessionId) => isActiveRef.current && activeSessionIdRef.current === sessionId,
    );
  }

  const requestLatestMessages = useCallback((sessionId: string, allowNetwork = isActiveRef.current) => (
    refreshCoordinatorRef.current?.request(sessionId, allowNetwork) ?? Promise.resolve()
  ), []);

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  // Hidden Chat tabs keep collecting realtime rows without re-rendering the
  // CSS-hidden tree. Activation itself renders once and reads the latest cache.
  const activeSessionForStore = isActive ? activeSessionId : null;
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionForStore !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionForStore;
    sessionStore.setActiveSession(activeSessionForStore);
  }

  useEffect(() => {
    if (!pendingUserMessage) {
      flushedPendingUserMessageRef.current = null;
      return;
    }

    if (!activeSessionId) {
      return;
    }

    if (flushedPendingUserMessageRef.current === pendingUserMessage) {
      return;
    }

    const prov = readSelectedProvider();
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, sessionStore]);

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : NO_MESSAGES;
  const sideQuestions = useSideQuestions(activeSessionId);

  const chatMessages = useMemo(() => {
    const all = normalizedToChatMessages(storeMessages);
    // Show pending user message when no session data exists yet (new session, pre-backend-response)
    if (pendingUserMessage && all.length === 0) {
      return [pendingUserMessage];
    }
    // Older pages not loaded yet (`hasMoreMessages`) means a pair older than
    // the oldest loaded row is left out, so it does not jump to the top of
    // the window and move again once those older pages arrive.
    return mergeSideQuestions(all, sideQuestions, {
      hasOlder: hasMoreMessages,
      failedText: t('sideQuestion.failed'),
    });
  }, [storeMessages, pendingUserMessage, sideQuestions, hasMoreMessages, t]);

  /* ---------------------------------------------------------------- */
  /*  addMessage                                                       */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage) => {
    if (!activeSessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const prov = readSelectedProvider();
    const normalized = chatMessageToNormalized(msg, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }
  }, [activeSessionId, sessionStore]);

  /**
   * Assign `scrollTop` and tag the resulting `scroll` event as ours.
   *
   * The flag is cleared on the next animation frame. Scroll events are
   * dispatched before rAF callbacks within a frame, so `handleScroll` always
   * observes it; the rAF is the fallback for a write that lands on the current
   * offset and therefore fires no event at all.
   */
  const setScrollTop = useCallback((container: HTMLDivElement, value: number, reason = 'scroll') => {
    // 'follow' fires per streaming chunk and would drown the trace.
    if (SCROLL_DEBUG_ENABLED && reason !== 'follow') {
      scrollDebug(`write:${reason}`, {
        from: container.scrollTop,
        to: value,
        max: container.scrollHeight - container.clientHeight,
      });
    }
    programmaticScrollRef.current = true;
    if (programmaticResetRafRef.current) cancelAnimationFrame(programmaticResetRafRef.current);
    programmaticResetRafRef.current = requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
      programmaticResetRafRef.current = 0;
    });
    container.scrollTop = value;
  }, []);

  /** True when nothing is moving the viewport and it is safe to adjust it. */
  const isScrollSettled = useCallback(
    () => !isTouchingRef.current && !isScrollingRef.current,
    [],
  );

  /**
   * Scroll to the newest message.
   *
   * Auto-scroll callers must leave `force` unset so the user's detach latch is
   * respected; only an explicit user gesture (the scroll-to-bottom button, or
   * sending a message) may force it.
   */
  const scrollToBottom = useCallback((force = false) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (!force && userDetachedRef.current) return;
    // A flick away from the newest message can still be coasting when this
    // runs; landing a write then yanks the viewport back to the bottom. The
    // settle pass re-pins it anyway if the user is in fact following.
    if (!force && !isScrollSettled()) return;
    if (force) {
      userDetachedRef.current = false;
      scrollAnchorRef.current = null;
    }
    setScrollTop(container, container.scrollHeight, force ? 'bottom-forced' : 'bottom');
  }, [isScrollSettled, setScrollTop]);

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom(true);
    setIsUserScrolledUp(false);
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  /**
   * Grow the render window by one page above what is currently rendered.
   *
   * Sized against the rendered window, not `visibleMessageCount`: while the
   * user reads history the window start is held (see visibleMessages), so the
   * count no longer describes what is on screen, and a count-relative reveal
   * would uncover everything between the held start and the cap in one
   * commit. Older history is fetched only once everything already loaded is
   * on screen — the store can hold more than the window (load-all, or rows
   * a `refreshFromServer` tail merge kept), and those are revealed from it.
   */
  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!isActive) return false;
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      // A reveal is still waiting for the viewport to settle; starting another
      // would advance the store past the un-revealed one.
      if (pendingPrependCommitRef.current) return false;
      if (!selectedSession || !selectedProject) return false;

      const hasHiddenHistory = renderWindowStartRef.current > 0;
      if (!hasHiddenHistory && (!hasMoreMessages || allMessagesLoadedRef.current)) return false;

      isLoadingMoreRef.current = true;

      try {
        let fetched: { hasMore: boolean; total: number; prependedCount: number } | null = null;
        if (!hasHiddenHistory) {
          const { slot, prependedCount } = await sessionStore.fetchMore(selectedSession.id, {
            limit: SESSION_MESSAGES_PAGE_SIZE,
            canRequest: () => (
              isActiveRef.current
              && activeSessionIdRef.current === selectedSession.id
            ),
          });
          messagesOffsetRef.current = slot.offset;
          if (slot.tokenUsage !== undefined) {
            setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
          }
          if (prependedCount === 0) {
            setHasMoreMessages(slot.hasMore);
            setTotalMessages(slot.total);
            if (!slot.hasMore) {
              allMessagesLoadedRef.current = true;
              setAllMessagesLoaded(true);
              if (loadAllOverlayTimerRef.current) {
                clearTimeout(loadAllOverlayTimerRef.current);
                loadAllOverlayTimerRef.current = null;
              }
              setShowLoadAllOverlay(false);
            }
            return false;
          }
          fetched = { hasMore: slot.hasMore, total: slot.total, prependedCount };
        }

        const commitPrepend = () => {
          // Lift the render gate in the same update that captures the anchor,
          // so the page paints and the compensation lands in one commit.
          pendingPrependGateRef.current = null;
          pendingPrependGateKeyRef.current = null;
          // Capture immediately before the state updates that reveal the page,
          // so the anchor reflects the viewport the user is actually looking at
          // rather than wherever it was when the fetch started.
          pendingScrollRestoreRef.current = captureScrollAnchor(container);
          // The refs describe the latest render. A page fetched mid-gesture is
          // already in the store and gated, so the rendered start accounts for
          // it; a page committed synchronously has not rendered yet, so it does
          // not. Either way this is exactly one page above the rendered first
          // message.
          const revealedCount =
            chatMessagesRef.current.length - renderWindowStartRef.current + SESSION_MESSAGES_PAGE_SIZE;
          if (SCROLL_DEBUG_ENABLED) {
            scrollDebug('reveal-commit', {
              count: revealedCount,
              fetched: fetched?.prependedCount ?? 0,
              start: renderWindowStartRef.current,
            });
          }
          setVisibleMessageCount(revealedCount);
          if (fetched) {
            setHasMoreMessages(fetched.hasMore);
            setTotalMessages(fetched.total);
            if (!fetched.hasMore) {
              allMessagesLoadedRef.current = true;
              setAllMessagesLoaded(true);
              if (loadAllOverlayTimerRef.current) {
                clearTimeout(loadAllOverlayTimerRef.current);
                loadAllOverlayTimerRef.current = null;
              }
              setShowLoadAllOverlay(false);
            }
          }
        };

        // While the viewport is still rubber-banding or coasting at the top,
        // hold the reveal for handleScrollSettled: the anchor capture and the
        // compensating scrollTop write are only exact on a stationary
        // viewport. The store has already prepended the page, so the render
        // window must be gated at the currently-visible first message until
        // then — the slice alone does not hide it.
        if (isScrollSettled()) {
          commitPrepend();
        } else {
          pendingPrependGateRef.current = renderedFirstMessageRef.current;
          pendingPrependGateKeyRef.current = renderedFirstMessageKeyRef.current;
          pendingPrependCommitRef.current = commitPrepend;
          if (SCROLL_DEBUG_ENABLED) scrollDebug('reveal-deferred');
        }
        return true;
      } finally {
        isLoadingMoreRef.current = false;
      }
    },
    [
      hasMoreMessages,
      isActive,
      isLoadingMoreMessages,
      isScrollSettled,
      selectedProject,
      selectedSession,
      sessionStore,
    ],
  );

  /**
   * Synchronous reaction to a real user gesture (touch or wheel).
   *
   * Runs before any React state update, so an auto-scroll queued by an
   * arriving message cannot fire between the user's finger moving and
   * `isUserScrolledUp` catching up. Also cancels the initial scroll-to-bottom
   * pass, which otherwise re-pins the viewport every animation frame.
   */
  const handleUserScrollIntent = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    pendingInitialScrollRef.current = false;

    // Deliberately does not capture an anchor. Capturing here ran a binary
    // search of getBoundingClientRect() calls on every touchmove and wheel
    // tick — a forced layout flush per event — and produced an offset that was
    // already stale by the time the observer used it, because iOS delivers
    // scroll positions behind the real ones during momentum. The anchor is
    // taken once on settle instead.
    const distance = distanceFromBottom(container);
    if (distance > DETACH_BELOW_PX) {
      userDetachedRef.current = true;
    } else if (distance < REATTACH_WITHIN_PX) {
      // Back at the newest message — resume following the conversation.
      userDetachedRef.current = false;
      scrollAnchorRef.current = null;
    }
  }, []);

  /**
   * Runs once the viewport has stopped moving.
   *
   * This is the only place a fresh anchor is taken during normal scrolling, so
   * it always reflects a position that is actually final.
   */
  const handleScrollSettled = useCallback(() => {
    isScrollingRef.current = false;
    const container = scrollContainerRef.current;
    if (!container) return;
    if (pendingInitialScrollRef.current || searchScrollActiveRef.current) {
      motionBaselineRef.current = null;
      return;
    }

    // First: undo whatever reading-line shift accumulated while the viewport
    // was in motion. Content reflowing above the viewport mid-gesture (images
    // decoding, code highlighting) drags the line with no correction allowed
    // at the time; comparing the now-topmost message against its
    // gesture-start layout position recovers the exact delta.
    const baseline = motionBaselineRef.current;
    motionBaselineRef.current = null;
    if (baseline) {
      const shift = motionShiftAboveViewport(container, baseline);
      if (Math.abs(shift) >= 1) {
        setScrollTop(container, container.scrollTop + shift, 'settle-shift');
      }
    }

    // Reveal a page of older messages that finished fetching while the
    // viewport was still moving. The commit captures its own anchor and the
    // layout effect restores it before paint, both on a now-stationary
    // viewport, so the reveal is invisible.
    const commitPrepend = pendingPrependCommitRef.current;
    if (commitPrepend) {
      pendingPrependCommitRef.current = null;
      commitPrepend();
    }

    // Settling resolves the hysteresis band to a definite state. The band
    // exists to stop the latch flapping *while* the viewport moves; carrying it
    // past the stop would mean a deliberate 100px scroll up still counted as
    // "following" and got snapped back to the newest message.
    const following = distanceFromBottom(container) < REATTACH_WITHIN_PX;
    userDetachedRef.current = !following;
    setIsUserScrolledUp(!following);
    if (SCROLL_DEBUG_ENABLED) {
      scrollDebug('settle', { top: container.scrollTop, dist: distanceFromBottom(container), following });
    }

    if (following) {
      // Absorb any growth that arrived while adjustments were suppressed.
      scrollAnchorRef.current = null;
      setScrollTop(container, container.scrollHeight, 'settle-follow');
    } else {
      scrollAnchorRef.current = captureScrollAnchor(container);
    }
  }, [setScrollTop]);

  const handleScroll = useCallback(async () => {
    if (!isActive) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    // Our own writes must not be read back as user motion, or following a live
    // stream would continuously re-arm the settle timer and stall itself.
    const wasProgrammatic = programmaticScrollRef.current;
    programmaticScrollRef.current = false;

    if (!wasProgrammatic) {
      const entering = !isScrollingRef.current;
      // Entering motion: snapshot message layout so the shift that content
      // reflow causes above the viewport during this gesture can be undone at
      // settle. Skipped where the engine anchors natively.
      if (entering && !HAS_NATIVE_SCROLL_ANCHORING) {
        motionBaselineRef.current = captureMotionBaseline(container);
      }
      if (SCROLL_DEBUG_ENABLED && entering) {
        scrollDebug('gesture', {
          top: container.scrollTop,
          dist: distanceFromBottom(container),
          touching: isTouchingRef.current,
        });
      }
      isScrollingRef.current = true;
      lastScrollEventPosRef.current = container.scrollTop;
      // Every write of ours is tagged, so an untagged event this far from the
      // newest message is the user moving away — including the momentum
      // phase of a flick, which touchmove never sees. Without this the latch
      // stays clear until settle, and anything that appends past the render
      // cap meanwhile drops the topmost rendered message from under a
      // viewport that is still coasting.
      if (distanceFromBottom(container) > DETACH_BELOW_PX) {
        userDetachedRef.current = true;
      }
      if (scrollSettleTimerRef.current) clearTimeout(scrollSettleTimerRef.current);
      const settleCheck = () => {
        scrollSettleTimerRef.current = null;
        const el = scrollContainerRef.current;
        // Event silence is not proof of stillness on iOS: momentum keeps
        // moving the viewport between sparse events, and settling mid-flight
        // would capture a stale anchor and then correct against the user's
        // live scroll. If the position moved since the last event, keep
        // waiting. A finger resting on the screen after stopping a flick is
        // still a gesture — settling then writes scrollTop under it — and
        // touchend arms no timer of its own, so keep polling until it lifts.
        if (el && (el.scrollTop !== lastScrollEventPosRef.current || isTouchingRef.current)) {
          lastScrollEventPosRef.current = el.scrollTop;
          scrollSettleTimerRef.current = setTimeout(settleCheck, SCROLL_SETTLE_MS);
          return;
        }
        handleScrollSettled();
      };
      scrollSettleTimerRef.current = setTimeout(settleCheck, SCROLL_SETTLE_MS);
    }

    // The latch is set only from untagged events above; any scroll, ours
    // included, that ends within reach of the newest message clears it.
    if (distanceFromBottom(container) < REATTACH_WITHIN_PX) {
      userDetachedRef.current = false;
      scrollAnchorRef.current = null;
    }
    setIsUserScrolledUp(userDetachedRef.current);
    scrollPositionRef.current = {
      height: container.scrollHeight,
      top: container.scrollTop,
    };

    const scrolledNearTop = container.scrollTop < 100;

    // "Load all" prompt: appear (with fade-in) when the user reaches the top
    if (scrolledNearTop && hasMoreMessages && !allMessagesLoadedRef.current) {
      if (!wasNearTopRef.current) {
        wasNearTopRef.current = true;
        if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);

        setShowLoadAllOverlay(true);
        loadAllOverlayTimerRef.current = setTimeout(() => {
          setShowLoadAllOverlay(false);
          loadAllOverlayTimerRef.current = null;
        }, 2500);
      }
    } else if (!scrolledNearTop) {
      wasNearTopRef.current = false;
    }

    if (!allMessagesLoadedRef.current || renderWindowStartRef.current > 0) {
      if (!scrolledNearTop) { topLoadLockRef.current = false; return; }
      if (topLoadLockRef.current) {
        if (container.scrollTop > 20) topLoadLockRef.current = false;
        return;
      }
      const didLoad = await loadOlderMessages(container);
      if (didLoad) topLoadLockRef.current = true;
    }
  }, [handleScrollSettled, hasMoreMessages, isActive, loadOlderMessages]);

  const wasChatActiveRef = useRef(isActive);
  useLayoutEffect(() => {
    const anchor = pendingScrollRestoreRef.current;
    const container = scrollContainerRef.current;
    if (!anchor || !container || !isActive) return;

    programmaticScrollRef.current = true;
    const restored = restoreScrollAnchor(container, anchor);
    if (!restored) {
      // The anchored element was remounted by the reveal: near the top of the
      // window the topmost visible message usually sits in the first tool
      // group, and revealing older messages moves that group's boundary —
      // changing its key and replacing its DOM. Everything revealed sits
      // above the old viewport, so the scrollHeight growth since capture is
      // exactly the offset that keeps the reading position. Without this
      // fallback the viewport silently kept its old numeric scrollTop — the
      // top of the newly revealed content.
      setScrollTop(container, anchor.scrollTop + (container.scrollHeight - anchor.scrollHeight), 'reveal-fallback');
    }
    if (SCROLL_DEBUG_ENABLED) {
      scrollDebug('reveal', {
        restored,
        grew: container.scrollHeight - anchor.scrollHeight,
        top: container.scrollTop,
        len: chatMessages.length,
      });
    }
    pendingScrollRestoreRef.current = null;

    // Hand a *fresh* anchor to the resize observer — the captured one may
    // have just been replaced. A freshly prepended page keeps growing after
    // this commit as its markdown, syntax highlighting, and images lay out;
    // without continued maintenance the view would drift down by however much
    // that late content adds.
    userDetachedRef.current = true;
    scrollAnchorRef.current = captureScrollAnchor(container);
    // visibleMessageCount is a dependency because a reveal deferred to
    // scroll-settle changes only it: the store (and chatMessages.length) grew
    // when the fetch resolved, renders earlier.
  }, [chatMessages.length, isActive, visibleMessageCount, setScrollTop]);


  // The Chat tab stays mounted while another main tab is shown, but a hidden
  // pane loses its scroll offset. Put it back on return: the newest message
  // when the user was following, their reading position otherwise.
  useLayoutEffect(() => {
    const becameActive = isActive && !wasChatActiveRef.current;
    wasChatActiveRef.current = isActive;
    const container = scrollContainerRef.current;
    if (!becameActive || !container) return;
    if (pendingInitialScrollRef.current || searchScrollActiveRef.current) return;

    if (userDetachedRef.current) {
      setScrollTop(container, scrollPositionRef.current.top, 'tab-activate');
      scrollAnchorRef.current = captureScrollAnchor(container);
    } else {
      setScrollTop(container, container.scrollHeight, 'tab-activate');
    }
  }, [isActive, setScrollTop]);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    // A search jump belongs to the transcript it was requested against. Left
    // armed across a session change it did two visible things to the session
    // the user actually opened: the initial scroll bailed (it declines while a
    // jump is pending) so the transcript opened part-way up, and then, once the
    // retries ran out and started accepting the nearest row by timestamp, it
    // scrolled to an unrelated message and flashed the search highlight on it.
    //
    // Clearing it here is safe for the jump itself: the effect that reads
    // `__searchTargetSnippet` off the newly selected session runs after this
    // one, so a session opened *from* a search result re-arms immediately.
    if (searchScrollTimerRef.current) {
      clearTimeout(searchScrollTimerRef.current);
      searchScrollTimerRef.current = null;
    }
    searchScrollActiveRef.current = false;
    setSearchTarget(null);

    // Re-arm the once-per-session initial scroll. The sessionKey change would
    // do this on its own; resetting explicitly keeps the two in step when a
    // session id is reused (e.g. a resumed draft).
    initialScrollKeyRef.current = null;
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    pendingInitialScrollRef.current = false;
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    pendingPrependCommitRef.current = null;
    pendingPrependGateRef.current = null;
    pendingPrependGateKeyRef.current = null;
    motionBaselineRef.current = null;
    wasNearTopRef.current = false;
    userDetachedRef.current = false;
    scrollAnchorRef.current = null;
    isTouchingRef.current = false;
    isScrollingRef.current = false;
    if (scrollSettleTimerRef.current) {
      clearTimeout(scrollSettleTimerRef.current);
      scrollSettleTimerRef.current = null;
    }
    setIsUserScrolledUp(false);
  }, [selectedProject?.projectId, selectedSession?.id]);

  const sessionKey = selectedSession?.id
    ? `${selectedProject?.projectId ?? ''}::${selectedSession.id}`
    : null;
  const hasMessages = chatMessages.length > 0;

  // Initial scroll to bottom — robust to lazy content reflow.
  //
  // Opening a session has to survive markdown blocks, code highlighting, and
  // images laying out over the following frames: each one grows scrollHeight
  // after the fact, and a single scrollToBottom() would leave the newest
  // message off-screen. So we re-pin every animation frame while the height is
  // still moving, capped at ~1s (60 frames) or 3 consecutive stable frames.
  //
  // Two properties matter as much as the pinning itself:
  //
  //  - It runs ONCE per session. `chatMessages.length` is deliberately not a
  //    dependency. It used to be, which meant every message arriving during a
  //    live stream tore down and restarted the loop with a fresh 60-frame
  //    budget and reset counters, so the ~1s cap never actually applied and the
  //    viewport stayed welded to the bottom for as long as the model was
  //    talking. `initialScrollKeyRef` is claimed up front so a re-render cannot
  //    re-enter it.
  //  - Any real touch or wheel gesture ends it immediately, via
  //    `pendingInitialScrollRef` / `userDetachedRef`. Reassigning scrollTop 60
  //    times a second underneath a finger is what made this feel like the page
  //    was fighting back on iOS.
  useEffect(() => {
    if (!isActive) return;
    if (!sessionKey || isLoadingSessionMessages || !hasMessages) return;
    if (!scrollContainerRef.current) return;
    if (initialScrollKeyRef.current === sessionKey) return;
    if (searchScrollActiveRef.current) {
      initialScrollKeyRef.current = sessionKey;
      pendingInitialScrollRef.current = false;
      return;
    }

    initialScrollKeyRef.current = sessionKey;
    pendingInitialScrollRef.current = true;

    const container = scrollContainerRef.current;
    let frame = 0;
    let lastHeight = -1;
    let stableCount = 0;
    let rafId = 0;

    const tick = () => {
      if (!pendingInitialScrollRef.current || userDetachedRef.current) {
        pendingInitialScrollRef.current = false;
        return;
      }
      programmaticScrollRef.current = true;
      container.scrollTop = container.scrollHeight;
      if (container.scrollHeight === lastHeight) {
        stableCount++;
      } else {
        stableCount = 0;
        lastHeight = container.scrollHeight;
      }
      frame++;
      if (stableCount < 3 && frame < 60) {
        rafId = requestAnimationFrame(tick);
      } else {
        pendingInitialScrollRef.current = false;
      }
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      pendingInitialScrollRef.current = false;
    };
  }, [sessionKey, isActive, isLoadingSessionMessages, hasMessages]);

  // Session replay/subscription remains active regardless of which main tab is
  // visible. Only persisted-history HTTP traffic is visibility-gated below.
  useEffect(() => {
    if (!selectedSession || !selectedProject || !ws) return;

    statusCheckSentAtRef.current.set(selectedSession.id, Date.now());
    sendMessage({
      type: 'chat.subscribe',
      sessions: [{
        sessionId: selectedSession.id,
        lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
      }],
    });
  }, [lastSeqRef, selectedProject, selectedSession, sendMessage, statusCheckSentAtRef, ws]);

  // Main session loading effect — store-based.
  //
  // The dependency list is deliberately narrower than the values the body
  // reads. `selectedSession` is tracked by id only, so a websocket-driven list
  // refresh that hands back a new object for the same session does not reload
  // it; `currentSessionId` is read as the previously-loaded session (the body
  // itself is what advances it), so listing it would re-enter the effect right
  // after every load. Both are always current when the effect does run,
  // because React recreates the closure on each render.
  useEffect(() => {
    if (!selectedSession || !selectedProject) {
      // A freshly created session can be mid-run before the router has a
      // canonical selectedSession (the URL effect synthesizes one on the
      // next render). Keep the active view intact instead of wiping it — but
      // only for a response in flight: a session whose turn has ended with
      // background work still running has a canonical id, so a missing
      // selection there is a real navigation away.
      const activity = currentSessionId ? processingSessionsRef.current?.get(currentSessionId) : undefined;
      if (activity && !activity.background) {
        return;
      }

      resetStreamingState();
      setCurrentSessionId(null);
      setIsLoadingSessionMessages(false);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    if (!isActive) {
      setIsLoadingSessionMessages(false);
      return;
    }

    const selectedSessionId = selectedSession.id;
    const sessionKey = `${selectedSessionId}:${selectedProject.projectId}`;

    const existingSlot = sessionStore.getSessionSlot(selectedSessionId);
    const isCurrentHydratedSession =
      lastLoadedSessionKeyRef.current === sessionKey
      && Boolean(existingSlot?.fetchedAt);

    // Returning from another tab must not reset pagination or scroll. Refresh
    // a stale hydrated session through the bounded tail path instead.
    if (isCurrentHydratedSession) {
      if (sessionStore.isStale(selectedSessionId)) {
        void requestLatestMessages(selectedSessionId);
      }
      return;
    }
    if (SCROLL_DEBUG_ENABLED) scrollDebug('session-load', { session: selectedSessionId.slice(0, 8) });

    const sessionChanged = currentSessionId !== null && currentSessionId !== selectedSessionId;
    if (sessionChanged) {
      resetStreamingState();
    }

    // Reset pagination/scroll state
    messagesOffsetRef.current = 0;
    setHasMoreMessages(false);
    setTotalMessages(0);
    setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    setAllMessagesLoaded(false);
    allMessagesLoadedRef.current = false;
    setIsLoadingAllMessages(false);
    setLoadAllJustFinished(false);
    setShowLoadAllOverlay(false);
    wasNearTopRef.current = false;
    if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);

    if (sessionChanged) {
      setTokenBudget(null);
    }

    setCurrentSessionId(selectedSessionId);

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch from server → store updates → chatMessages re-derives automatically
    setIsLoadingSessionMessages(true);
    sessionStore.fetchFromServer(selectedSessionId, {
      limit: SESSION_MESSAGES_PAGE_SIZE,
      offset: 0,
      canRequest: () => (
        isActiveRef.current
        && activeSessionIdRef.current === selectedSessionId
      ),
    }).then(slot => {
      // The view moved on (New Session, another session) while this was in
      // flight; its totals and loading flag belong to whatever is shown now.
      if (lastLoadedSessionKeyRef.current !== sessionKey) return;
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        if (slot.tokenUsage !== undefined) {
          setTokenBudget((slot.tokenUsage as Record<string, unknown> | null) ?? null);
        }
      }
      setIsLoadingSessionMessages(false);
    }).catch(() => {
      if (lastLoadedSessionKeyRef.current !== sessionKey) return;
      setIsLoadingSessionMessages(false);
    });
  }, [
    isActive,
    resetStreamingState,
    requestLatestMessages,
    selectedProject,
    selectedSession?.id,
    sessionStore,
  ]);

  // Hidden refresh signals are coalesced. An initial page load supersedes a
  // pending latest refresh for an unhydrated/loading slot; otherwise activation
  // flushes exactly one request for the selected session.
  useEffect(() => {
    if (!isActive || !activeSessionId) return;

    const slot = sessionStore.getSessionSlot(activeSessionId);
    if (!slot?.fetchedAt || slot.status === 'loading') {
      refreshCoordinatorRef.current?.discardPending(activeSessionId);
      return;
    }

    void refreshCoordinatorRef.current?.flushPending(activeSessionId);
  }, [activeSessionId, isActive, sessionStore]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;
    // Once per increment. The other dependencies change identity on every
    // session_upserted and at every run boundary; re-running for those
    // replaced every server-backed message object mid-conversation (and
    // queued a scroll-to-bottom) for nothing. A refresh skipped because a run
    // is active is covered by the one `complete` triggers.
    if (lastExternalMessageUpdateRef.current === externalMessageUpdate) return;
    lastExternalMessageUpdateRef.current = externalMessageUpdate;
    if (SCROLL_DEBUG_ENABLED) scrollDebug('external-refresh', { processing: isProcessing });

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming
        if (!isProcessing) {
          await requestLatestMessages(selectedSession.id);

          // Deliberately unconditional: scrollToBottom() re-checks the detach
          // latch when the timer fires. Deciding here instead would sample the
          // user's position 200ms too early and scroll them away from whatever
          // they moved to in the meantime.
          setTimeout(() => scrollToBottom(), 200);
        }
      } catch (error) {
        console.error('Error reloading messages from external update:', error);
      }
    };

    reloadExternalMessages();
  }, [
    externalMessageUpdate,
    requestLatestMessages,
    scrollToBottom,
    selectedProject,
    selectedSession,
    isProcessing,
  ]);

  // Search navigation target
  useEffect(() => {
    const session = selectedSession as Record<string, unknown> | null;
    const targetSnippet = session?.__searchTargetSnippet;
    const targetTimestamp = session?.__searchTargetTimestamp;
    if (typeof targetSnippet === 'string' && targetSnippet) {
      searchScrollActiveRef.current = true;
      setSearchTarget({
        snippet: targetSnippet,
        timestamp: typeof targetTimestamp === 'string' ? targetTimestamp : undefined,
      });
    }
  }, [selectedSession]);

  // Scroll to search target
  useEffect(() => {
    if (!isActive || !searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    setSearchTarget(null);

    const scrollToTarget = async () => {
      // Search navigation loads the full session below; a page reveal still
      // waiting for scroll-settle would re-apply stale pagination state on
      // top of it.
      pendingPrependCommitRef.current = null;
      pendingPrependGateRef.current = null;
      pendingPrependGateKeyRef.current = null;
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
          try {
            // Load all messages into the store for search navigation
            const slot = await sessionStore.fetchFromServer(selectedSession.id, {
              limit: null,
              offset: 0,
              canRequest: () => (
                isActiveRef.current
                && activeSessionIdRef.current === selectedSession.id
              ),
            });
            if (slot) {
              // Fetch the whole transcript so an old hit can be found, but do
              // not render all of it — the window below is widened to exactly
              // what the resolved target needs.
              setHasMoreMessages(false);
              setTotalMessages(slot.total);
              messagesOffsetRef.current = slot.offset;
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
            } else if (!isActiveRef.current) {
              setSearchTarget(target);
              return;
            }
          } catch {
            // Fall through and scroll in current messages
          }
      }
      // Resolve the target against the loaded transcript rather than the DOM.
      // The store is the freshest source here: the `fetchFromServer` above has
      // landed but `chatMessages` is from the render that scheduled this effect.
      const messagesForSearch = activeSessionIdRef.current
        ? normalizedToChatMessages(sessionStore.getMessages(activeSessionIdRef.current))
        : chatMessages;
      const targetIndex = findSearchTargetIndex(messagesForSearch, target);
      if (targetIndex < 0) {
        // The target is not in the transcript at all. Scrolling somewhere
        // plausible would claim a hit that does not exist.
        searchScrollActiveRef.current = false;
        return;
      }

      // Widen the window so the target is rendered. `visibleMessages` is a tail
      // slice, so covering index N means rendering everything after it.
      const requiredVisibleCount = resolveSearchWindowSize(
        messagesForSearch.length,
        targetIndex,
        SEARCH_TARGET_CONTEXT_MESSAGES,
      );
      setVisibleMessageCount((previous) => Math.max(previous, requiredVisibleCount));

      const targetTimestamp = messagesForSearch[targetIndex].timestamp;

      const scrollToRenderedTarget = (retriesLeft: number) => {
        const container = scrollContainerRef.current;
        if (!container) return;

        // The target is inside the window by construction, so this only waits
        // for React to commit the widened list. A target collapsed inside a
        // tool group resolves to that group, which carries the same timestamp.
        const targetElement = findRenderedMessageElement(
          container,
          targetTimestamp,
          retriesLeft === 0,
        );

        if (targetElement) {
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement.classList.remove('search-highlight-flash'), 4000);
          searchScrollTimerRef.current = null;
          searchScrollActiveRef.current = false;
          return;
        }

        if (retriesLeft > 0) {
          searchScrollTimerRef.current = setTimeout(
            () => scrollToRenderedTarget(retriesLeft - 1),
            SEARCH_SCROLL_RETRY_DELAY_MS,
          );
          return;
        }

        searchScrollTimerRef.current = null;
        searchScrollActiveRef.current = false;
      };

      searchScrollTimerRef.current = setTimeout(
        () => scrollToRenderedTarget(SEARCH_SCROLL_RETRIES),
        150,
      );
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isActive, isLoadingSessionMessages, searchTarget]);

  // Initial token usage fetch for providers with file-backed usage data.
  useEffect(() => {
    if (!selectedSession?.id) {
      setTokenBudget(null);
      return;
    }
    const fetchInitialTokenUsage = async () => {
      try {
        // The provider module resolves storage and provider details from the session id.
        const response = await api.providers.sessionTokenUsage(selectedSession.id);
        if (response.ok) {
          const payload = await response.json();
          setTokenBudget(payload.data ?? null);
        } else {
          setTokenBudget(null);
        }
      } catch (error) {
        console.error('Failed to fetch initial token usage:', error);
      }
    };
    fetchInitialTokenUsage();
  }, [selectedSession?.id]);

  const visibleMessages = useMemo(() => {
    chatMessagesRef.current = chatMessages;
    let start = Math.max(0, chatMessages.length - visibleMessageCount);
    if (renderWindowSessionRef.current !== activeSessionId) {
      renderWindowSessionRef.current = activeSessionId;
    } else {
      // An older page fetched mid-gesture stays hidden until the settle-time
      // commit reveals it together with its scroll compensation.
      const gateIndex = indexOfMessage(
        chatMessages,
        pendingPrependGateRef.current,
        pendingPrependGateKeyRef.current,
      );
      if (gateIndex > start) start = gateIndex;
      // While the user reads history the window start never advances: a plain
      // slice(-count) drops the topmost rendered message each time a live
      // message appends past the cap, shifting everything above the reading
      // position — worst mid-scroll, where no compensation is allowed. The
      // cap re-applies on the first update after the user returns to the
      // bottom. (Revealing more history — a smaller start — is always
      // allowed; that's the page-reveal and load-all path.)
      if (userDetachedRef.current) {
        const held = indexOfMessage(
          chatMessages,
          renderedFirstMessageRef.current,
          renderedFirstMessageKeyRef.current,
        );
        if (held >= 0 && held < start) start = held;
      }
    }
    const first = chatMessages[start] ?? null;
    const firstKey = first ? getIntrinsicMessageKey(first) : null;
    if (SCROLL_DEBUG_ENABLED && (firstKey !== renderedFirstMessageKeyRef.current || start !== renderWindowStartRef.current)) {
      scrollDebug('window', { len: chatMessages.length, start, sameFirst: firstKey === renderedFirstMessageKeyRef.current });
    }
    renderedFirstMessageRef.current = first;
    renderedFirstMessageKeyRef.current = firstKey;
    renderWindowStartRef.current = start;
    return start > 0 ? chatMessages.slice(start) : chatMessages;
  }, [activeSessionId, chatMessages, visibleMessageCount]);

  /**
   * Hold the viewport steady across a content change — the replacement for
   * Safari's missing CSS scroll anchoring.
   *
   * Following the conversation and reading back through it are the two modes,
   * and `userDetachedRef` picks between them synchronously. The previous
   * implementation instead compared scrollHeight before and after the commit,
   * but recorded "before" in an effect with no dependency array — which runs
   * *after* React has already mutated the DOM, and was declared ahead of its
   * own consumer, so the delta it computed was always zero and the
   * compensation branch never did anything.
   */
  const maintainScrollPosition = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (pendingInitialScrollRef.current || searchScrollActiveRef.current) return;
    if (isLoadingMoreRef.current || pendingScrollRestoreRef.current) return;

    // The single most important guard here. While the viewport is in motion —
    // finger down or momentum coasting — no correction is worth making: the
    // user cannot perceive a shift they are already scrolling past, and writing
    // scrollTop underneath them is what produced the jitter. Whatever needs
    // adjusting is applied by handleScrollSettled the moment motion stops.
    if (!isScrollSettled()) return;
    // A hidden pane has no layout to anchor against.
    if (!isActiveRef.current) return;

    if (!userDetachedRef.current) {
      setScrollTop(container, container.scrollHeight, 'follow');
      return;
    }

    const anchor = scrollAnchorRef.current;
    if (!anchor) return;

    programmaticScrollRef.current = true;
    const before = container.scrollTop;
    if (!restoreScrollAnchor(container, anchor)) {
      // The anchored message was unmounted (rewind, session refresh) — take a
      // fresh anchor rather than letting the viewport drift unmanaged.
      programmaticScrollRef.current = false;
      scrollAnchorRef.current = captureScrollAnchor(container);
      if (SCROLL_DEBUG_ENABLED) {
        scrollDebug('anchor-lost', { top: container.scrollTop, height: container.scrollHeight });
      }
    } else if (SCROLL_DEBUG_ENABLED && container.scrollTop !== before) {
      scrollDebug('write:anchor', { from: before, to: container.scrollTop });
    }
  }, [isScrollSettled, setScrollTop]);

  // Synchronous pass for message arrivals: runs before paint, so a message
  // landing while the user reads history never produces a visible frame at the
  // wrong offset.
  useLayoutEffect(() => {
    maintainScrollPosition();
  }, [chatMessages.length, visibleMessageCount, maintainScrollPosition]);

  // Asynchronous pass for everything that changes height *after* commit:
  // streaming text, markdown, syntax highlighting, images decoding, tool
  // results expanding. This is the case a message-count effect cannot see.
  //
  // `selectedProject?.projectId` is a dependency because ChatInterface returns
  // a placeholder instead of the message pane until a project is picked — the
  // observed element does not exist on the first pass, and without this the
  // effect would never re-run to attach once it appears.
  useEffect(() => {
    const content = messagesContentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => maintainScrollPosition());
    observer.observe(content);
    return () => observer.disconnect();
  }, [maintainScrollPosition, selectedProject?.projectId]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // `scroll` tracks where the viewport is; touch/wheel record that the user
    // put it there. Keeping them separate is what lets a programmatic scroll
    // coexist with the detach latch. All passive — none of these preventDefault,
    // and a non-passive touch listener would stall scrolling on iOS.
    //
    // When the document is the scroller, <html> receives every touch on the
    // page and `scroll` fires on the window, not on the element. Only gestures
    // that start in the transcript count as scrolling it, and nothing counts
    // while another tab has the fixed layout (the page snaps to 0 then).
    const isRootScroller = isDocumentScroller(container);
    const scrollTarget: HTMLElement | Window = isRootScroller ? window : container;
    const concernsTranscript = (event: Event) =>
      !isRootScroller
      || (isDocumentScrollActive()
        && event.target instanceof Element
        && event.target.closest('.chat-messages-pane') !== null);
    const onScroll = () => {
      if (isRootScroller && !isDocumentScrollActive()) return;
      void handleScroll();
    };
    const onTouchStart = (event: Event) => {
      if (!concernsTranscript(event)) return;
      isTouchingRef.current = true;
      handleUserScrollIntent();
    };
    const onTouchEnd = () => {
      if (isRootScroller && !isTouchingRef.current) return;
      isTouchingRef.current = false;
      // Momentum continues after the finger lifts; `scroll` keeps the latch and
      // anchor up to date from here, and re-attaches if it coasts to the bottom.
      handleUserScrollIntent();
      // A page that finished fetching during a motionless touch-hold has no
      // scroll events to arm the settle timer, so its reveal would strand
      // gated forever; run the settle pass directly once the finger lifts.
      if (pendingPrependCommitRef.current && isScrollSettled()) {
        handleScrollSettled();
      }
    };

    // A transcript shorter than the viewport (a first page is 20 rows and tool
    // results fold into their calls) cannot scroll, so it never emits `scroll`.
    // Wheel and touch are then the only way to reach the top pager or the
    // "load all" overlay. When it can scroll, `scroll` alone drives paging.
    const onMoveIntent = (event: Event) => {
      if (!concernsTranscript(event)) return;
      handleUserScrollIntent();
      if (container.scrollHeight <= container.clientHeight + 1) void handleScroll();
    };

    const options = { passive: true } as const;
    scrollTarget.addEventListener('scroll', onScroll, options);
    container.addEventListener('touchstart', onTouchStart, options);
    container.addEventListener('touchmove', onMoveIntent, options);
    container.addEventListener('touchend', onTouchEnd, options);
    container.addEventListener('touchcancel', onTouchEnd, options);
    container.addEventListener('wheel', onMoveIntent, options);

    return () => {
      scrollTarget.removeEventListener('scroll', onScroll);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onMoveIntent);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('wheel', onMoveIntent);
      if (scrollSettleTimerRef.current) {
        clearTimeout(scrollSettleTimerRef.current);
        scrollSettleTimerRef.current = null;
      }
      if (programmaticResetRafRef.current) {
        cancelAnimationFrame(programmaticResetRafRef.current);
        programmaticResetRafRef.current = 0;
      }
    };
  }, [handleScroll, handleScrollSettled, handleUserScrollIntent, isScrollSettled]);

  // "Load all" overlay visibility is driven by scroll-to-top in handleScroll;
  // timers are cleared on session change via the reset effect above.

  const loadAllMessages = useCallback(async () => {
    if (!isActive) return;
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const requestSessionId = selectedSession.id;
    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    // Loading everything supersedes any page reveal still waiting for
    // scroll-settle.
    pendingPrependCommitRef.current = null;
    pendingPrependGateRef.current = null;
    pendingPrependGateKeyRef.current = null;
    setIsLoadingAllMessages(true);
    setShowLoadAllOverlay(true);
    if (loadAllOverlayTimerRef.current) {
      clearTimeout(loadAllOverlayTimerRef.current);
      loadAllOverlayTimerRef.current = null;
    }

    const container = scrollContainerRef.current;

    try {
      const slot = await sessionStore.fetchFromServer(requestSessionId, {
        limit: null,
        offset: 0,
        canRequest: () => (
          isActiveRef.current
          && activeSessionIdRef.current === requestSessionId
        ),
      });

      if (currentSessionId !== requestSessionId) return;

      if (slot) {
        if (container) {
          pendingScrollRestoreRef.current = captureScrollAnchor(container);
        }

        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.offset;
        setVisibleMessageCount(Infinity);
        setAllMessagesLoaded(true);

        setLoadAllJustFinished(true);
        if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);
        loadAllFinishedTimerRef.current = setTimeout(() => {
          setLoadAllJustFinished(false);
          setShowLoadAllOverlay(false);
          loadAllFinishedTimerRef.current = null;
        }, 2500);
      } else {
        allMessagesLoadedRef.current = false;
        setShowLoadAllOverlay(false);
      }
    } catch (error) {
      console.error('Error loading all messages:', error);
      allMessagesLoadedRef.current = false;
      setShowLoadAllOverlay(false);
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingAllMessages(false);
    }
  }, [isActive, selectedSession, selectedProject, isLoadingAllMessages, currentSessionId, sessionStore]);

  /**
   * Fetches the whole transcript into the store and returns it, without
   * touching the render window.
   *
   * Export needs every message; the screen does not. Keeping those separate is
   * why exporting a long conversation no longer silently produces a file
   * containing only its last page.
   */
  const loadFullTranscript = useCallback(async (): Promise<ChatMessage[]> => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) {
      return [];
    }

    await sessionStore.fetchFromServer(sessionId, {
      limit: null,
      offset: 0,
      canRequest: () => activeSessionIdRef.current === sessionId,
    });

    // The whole transcript is loaded (`limit: null`), so there is no older
    // page left to protect a pair against: `hasOlder` is false here even
    // though the live view may still have more pages pending.
    return mergeSideQuestions(
      normalizedToChatMessages(sessionStore.getMessages(sessionId)),
      sideQuestionStore.forSession(sessionId),
      { hasOlder: false, failedText: t('sideQuestion.failed') },
    );
  }, [sessionStore, t]);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((prev) => prev + 100);
  }, []);

  // Brings one row into view even when it is outside the visible window or
  // sits in a lazy row that has not mounted: widen the window to include it,
  // then scroll to the row's wrapper, which is in the DOM as soon as the row
  // is inside the window, mounted or not.
  const revealMessage = useCallback((message: ChatMessage) => {
    const index = chatMessages.indexOf(message);
    if (index >= 0) {
      setVisibleMessageCount((prev) => visibleCountToReveal(chatMessages.length, index, prev));
    }

    const attempt = (remaining: number) => {
      const container = scrollContainerRef.current;
      // The widened window commits after this frame, so the row can be absent
      // on the first attempts; only the last one may settle for the nearest
      // row (a hit collapsed inside a tool group carries the group's
      // timestamp), or the first attempt scrolls to an unrelated row and the
      // retries never run.
      const element = container ? findRenderedMessageElement(container, message.timestamp, remaining === 0) : null;
      if (element) {
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      if (remaining > 0) {
        requestAnimationFrame(() => attempt(remaining - 1));
      }
    };
    requestAnimationFrame(() => attempt(10));
  }, [chatMessages]);

  return {
    chatMessages,
    addMessage,
    sessionActivity,
    isProcessing,
    canAbortSession,
    currentSessionId,
    setCurrentSessionId,
    isLoadingSessionMessages,
    isLoadingMoreMessages,
    hasMoreMessages,
    totalMessages,
    isUserScrolledUp,
    setIsUserScrolledUp,
    tokenBudget,
    setTokenBudget,
    visibleMessageCount,
    visibleMessages,
    loadEarlierMessages,
    revealMessage,
    loadAllMessages,
    loadFullTranscript,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    messagesContentRef,
    scrollToBottom,
    scrollToBottomAndReset,
    handleScroll,
    handleUserScrollIntent,
    requestLatestMessages,
  };
}
