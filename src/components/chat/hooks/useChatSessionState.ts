import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { MarkSessionIdle, SessionActivityMap } from '../../../hooks/useSessionProtection';
import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import type { ChatMessage } from '../types/types';
import { createCachedDiffCalculator, type DiffCalculator } from '../utils/messageTransforms';
import {
  captureMotionBaseline,
  captureScrollAnchor,
  distanceFromBottom,
  isNearBottom as isNearBottomOf,
  motionShiftAboveViewport,
  restoreScrollAnchor,
  DETACH_BELOW_PX,
  REATTACH_WITHIN_PX,
  type MotionBaseline,
  type ScrollAnchor,
} from '../utils/scrollAnchor';

import { createChatMessageConverter } from './useChatMessages';

const MESSAGES_PER_PAGE = 20;
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

interface UseChatSessionStateArgs {
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
}

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
  if (msg.isInteractivePrompt) {
    return { ...base, kind: 'interactive_prompt', content: msg.content || '' } as NormalizedMessage;
  }
  if ((msg as any).isTaskNotification) {
    return {
      ...base,
      kind: 'task_notification',
      status: (msg as any).taskStatus || 'completed',
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
  } as NormalizedMessage;
}

/* ------------------------------------------------------------------ */
/*  Hook                                                              */
/* ------------------------------------------------------------------ */

export function useChatSessionState({
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
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(selectedSession?.id || null);
  const [isLoadingSessionMessages, setIsLoadingSessionMessages] = useState(false);
  const [isLoadingMoreMessages, setIsLoadingMoreMessages] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [totalMessages, setTotalMessages] = useState(0);
  const [isUserScrolledUp, setIsUserScrolledUp] = useState(false);
  const [tokenBudget, setTokenBudget] = useState<Record<string, unknown> | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(INITIAL_VISIBLE_MESSAGES);
  const [allMessagesLoaded, setAllMessagesLoaded] = useState(false);
  const [isLoadingAllMessages, setIsLoadingAllMessages] = useState(false);
  const [loadAllJustFinished, setLoadAllJustFinished] = useState(false);
  const [showLoadAllOverlay, setShowLoadAllOverlay] = useState(false);
  const [viewHiddenCount, setViewHiddenCount] = useState(0);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
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
  const [searchTarget, setSearchTarget] = useState<{ timestamp?: string; uuid?: string; snippet?: string } | null>(null);
  const searchScrollActiveRef = useRef(false);
  const isLoadingSessionRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const allMessagesLoadedRef = useRef(false);
  const topLoadLockRef = useRef(false);
  const pendingScrollRestoreRef = useRef<ScrollAnchor | null>(null);
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
   * useProjectsState -> AppContent -> MainContent -> ChatInterface -> this hook.
   * We compare values to ensure each explicit New Session click runs exactly one
   * reset pass in this local chat state domain.
   */
  const previousNewSessionTriggerRef = useRef(newSessionTrigger ?? 0);

  const createDiff = useMemo<DiffCalculator>(() => createCachedDiffCalculator(), []);

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
    setViewHiddenCount(0);
    setSearchTarget(null);
    wasNearTopRef.current = false;
    searchScrollActiveRef.current = false;
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    pendingPrependCommitRef.current = null;
    pendingPrependGateRef.current = null;
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
  // placeholder entry exists anymore.
  const sessionActivity = (activeSessionId && processingSessions?.get(activeSessionId)) || null;
  const isProcessing = sessionActivity !== null;
  const canAbortSession = isProcessing && sessionActivity.canInterrupt;

  // Ref mirror so effects can read the latest map without re-running on
  // every activity transition.
  const processingSessionsRef = useRef(processingSessions);
  processingSessionsRef.current = processingSessions;

  /* ---------------------------------------------------------------- */
  /*  Derive chatMessages from the store                              */
  /* ---------------------------------------------------------------- */
  const [pendingUserMessage, setPendingUserMessage] = useState<ChatMessage | null>(null);
  const flushedPendingUserMessageRef = useRef<ChatMessage | null>(null);

  // Tell the store which session we're viewing so it only re-renders for this one
  const prevActiveForStoreRef = useRef<string | null>(null);
  if (activeSessionId !== prevActiveForStoreRef.current) {
    prevActiveForStoreRef.current = activeSessionId;
    sessionStore.setActiveSession(activeSessionId);
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

    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(pendingUserMessage, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }

    flushedPendingUserMessageRef.current = pendingUserMessage;
    setPendingUserMessage(null);
  }, [activeSessionId, pendingUserMessage, sessionStore]);

  const storeMessages = activeSessionId ? sessionStore.getMessages(activeSessionId) : [];

  // Reset viewHiddenCount when store messages change
  const prevStoreLenRef = useRef(0);
  if (storeMessages.length !== prevStoreLenRef.current) {
    prevStoreLenRef.current = storeMessages.length;
    if (viewHiddenCount > 0) setViewHiddenCount(0);
  }

  // One cache per chat surface: identity-stable ChatMessage output is what
  // lets memo(MessageComponent) skip unchanged messages during streaming.
  const convertToChatMessages = useMemo(() => createChatMessageConverter(), []);

  const chatMessages = useMemo(() => {
    const all = convertToChatMessages(storeMessages);
    // Show pending user message when no session data exists yet (new session, pre-backend-response)
    if (pendingUserMessage && all.length === 0) {
      return [pendingUserMessage];
    }
    if (viewHiddenCount > 0 && viewHiddenCount < all.length) return all.slice(0, -viewHiddenCount);
    return all;
  }, [convertToChatMessages, storeMessages, viewHiddenCount, pendingUserMessage]);

  /* ---------------------------------------------------------------- */
  /*  addMessage / clearMessages / rewindMessages                     */
  /* ---------------------------------------------------------------- */

  const addMessage = useCallback((msg: ChatMessage) => {
    if (!activeSessionId) {
      // No session yet — show as pending until the backend creates one
      setPendingUserMessage(msg);
      return;
    }
    const prov = (localStorage.getItem('selected-provider') as LLMProvider) || 'claude';
    const normalized = chatMessageToNormalized(msg, activeSessionId, prov);
    if (normalized) {
      sessionStore.appendRealtime(activeSessionId, normalized);
    }
  }, [activeSessionId, sessionStore]);

  const clearMessages = useCallback(() => {
    if (!activeSessionId) return;
    sessionStore.clearRealtime(activeSessionId);
  }, [activeSessionId, sessionStore]);

  const rewindMessages = useCallback((count: number) => setViewHiddenCount(count), []);

  /**
   * Assign `scrollTop` and tag the resulting `scroll` event as ours.
   *
   * The flag is cleared on the next animation frame. Scroll events are
   * dispatched before rAF callbacks within a frame, so `handleScroll` always
   * observes it; the rAF is the fallback for a write that lands on the current
   * offset and therefore fires no event at all.
   */
  const setScrollTop = useCallback((container: HTMLDivElement, value: number) => {
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
    if (force) {
      userDetachedRef.current = false;
      scrollAnchorRef.current = null;
    }
    setScrollTop(container, container.scrollHeight);
  }, [setScrollTop]);

  const scrollToBottomAndReset = useCallback(() => {
    scrollToBottom(true);
    setIsUserScrolledUp(false);
    if (allMessagesLoaded) {
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
      setAllMessagesLoaded(false);
      allMessagesLoadedRef.current = false;
    }
  }, [allMessagesLoaded, scrollToBottom]);

  const isNearBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return false;
    return isNearBottomOf(container);
  }, []);

  const loadOlderMessages = useCallback(
    async (container: HTMLDivElement) => {
      if (!container || isLoadingMoreRef.current || isLoadingMoreMessages) return false;
      // A fetched page is still waiting for the viewport to settle; loading
      // another would advance the store past the un-revealed one.
      if (pendingPrependCommitRef.current) return false;
      if (allMessagesLoadedRef.current) return false;
      if (!hasMoreMessages || !selectedSession || !selectedProject) return false;

      isLoadingMoreRef.current = true;

      try {
        const slot = await sessionStore.fetchMore(selectedSession.id, {
          limit: MESSAGES_PER_PAGE,
        });
        if (!slot) return false;
        if (slot.serverMessages.length === 0) {
          if (!slot.hasMore) {
            setHasMoreMessages(false);
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

        const commitPrepend = () => {
          // Lift the render gate in the same update that captures the anchor,
          // so the page paints and the compensation lands in one commit.
          pendingPrependGateRef.current = null;
          // Capture immediately before the state updates that reveal the page,
          // so the anchor reflects the viewport the user is actually looking at
          // rather than wherever it was when the fetch started.
          pendingScrollRestoreRef.current = captureScrollAnchor(container);
          setHasMoreMessages(slot.hasMore);
          setTotalMessages(slot.total);
          setVisibleMessageCount((prev) => prev + MESSAGES_PER_PAGE);
          if (!slot.hasMore) {
            allMessagesLoadedRef.current = true;
            setAllMessagesLoaded(true);
            if (loadAllOverlayTimerRef.current) {
              clearTimeout(loadAllOverlayTimerRef.current);
              loadAllOverlayTimerRef.current = null;
            }
            setShowLoadAllOverlay(false);
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
          pendingPrependCommitRef.current = commitPrepend;
        }
        return true;
      } finally {
        isLoadingMoreRef.current = false;
      }
    },
    [
      hasMoreMessages,
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
        setScrollTop(container, container.scrollTop + shift);
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

    if (following) {
      // Absorb any growth that arrived while adjustments were suppressed.
      scrollAnchorRef.current = null;
      setScrollTop(container, container.scrollHeight);
    } else {
      scrollAnchorRef.current = captureScrollAnchor(container);
    }
  }, [setScrollTop]);

  const handleScroll = useCallback(async () => {
    const container = scrollContainerRef.current;
    if (!container) return;

    // Our own writes must not be read back as user motion, or following a live
    // stream would continuously re-arm the settle timer and stall itself.
    const wasProgrammatic = programmaticScrollRef.current;
    programmaticScrollRef.current = false;

    if (!wasProgrammatic) {
      // Entering motion: snapshot message layout so the shift that content
      // reflow causes above the viewport during this gesture can be undone at
      // settle. Skipped where the engine anchors natively.
      if (!isScrollingRef.current && !HAS_NATIVE_SCROLL_ANCHORING) {
        motionBaselineRef.current = captureMotionBaseline(container);
      }
      isScrollingRef.current = true;
      lastScrollEventPosRef.current = container.scrollTop;
      if (scrollSettleTimerRef.current) clearTimeout(scrollSettleTimerRef.current);
      const settleCheck = () => {
        scrollSettleTimerRef.current = null;
        const el = scrollContainerRef.current;
        // Event silence is not proof of stillness on iOS: momentum keeps
        // moving the viewport between sparse events, and settling mid-flight
        // would capture a stale anchor and then correct against the user's
        // live scroll. If the position moved since the last event, keep
        // waiting.
        if (el && el.scrollTop !== lastScrollEventPosRef.current) {
          lastScrollEventPosRef.current = el.scrollTop;
          scrollSettleTimerRef.current = setTimeout(settleCheck, SCROLL_SETTLE_MS);
          return;
        }
        handleScrollSettled();
      };
      scrollSettleTimerRef.current = setTimeout(settleCheck, SCROLL_SETTLE_MS);
    }

    // Only ever *clears* the latch. `scroll` fires for programmatic scrolls
    // too, and latching on those would strand the user mid-history; setting it
    // is handleUserScrollIntent's job.
    if (distanceFromBottom(container) < REATTACH_WITHIN_PX) {
      userDetachedRef.current = false;
      scrollAnchorRef.current = null;
    }
    setIsUserScrolledUp(userDetachedRef.current);

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

    if (!allMessagesLoadedRef.current) {
      if (!scrolledNearTop) { topLoadLockRef.current = false; return; }
      if (topLoadLockRef.current) {
        if (container.scrollTop > 20) topLoadLockRef.current = false;
        return;
      }
      const didLoad = await loadOlderMessages(container);
      if (didLoad) topLoadLockRef.current = true;
    }
  }, [handleScrollSettled, hasMoreMessages, loadOlderMessages]);

  useLayoutEffect(() => {
    const anchor = pendingScrollRestoreRef.current;
    const container = scrollContainerRef.current;
    if (!anchor || !container) return;

    programmaticScrollRef.current = true;
    if (!restoreScrollAnchor(container, anchor)) {
      // The anchored element was remounted by the reveal: near the top of the
      // window the topmost visible message usually sits in the first tool
      // group, and revealing older messages moves that group's boundary —
      // changing its key and replacing its DOM. Everything revealed sits
      // above the old viewport, so the scrollHeight growth since capture is
      // exactly the offset that keeps the reading position. Without this
      // fallback the viewport silently kept its old numeric scrollTop — the
      // top of the newly revealed content.
      setScrollTop(container, anchor.scrollTop + (container.scrollHeight - anchor.scrollHeight));
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
  }, [chatMessages.length, visibleMessageCount, setScrollTop]);

  // Reset scroll/pagination state on session change
  useEffect(() => {
    if (!searchScrollActiveRef.current) {
      // Re-arm the once-per-session initial scroll. The sessionKey change would
      // do this on its own; resetting explicitly keeps the two in step when a
      // session id is reused (e.g. a resumed draft).
      initialScrollKeyRef.current = null;
      setVisibleMessageCount(INITIAL_VISIBLE_MESSAGES);
    }
    pendingInitialScrollRef.current = false;
    topLoadLockRef.current = false;
    pendingScrollRestoreRef.current = null;
    pendingPrependCommitRef.current = null;
    pendingPrependGateRef.current = null;
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
  }, [sessionKey, isLoadingSessionMessages, hasMessages]);

  // Main session loading effect — store-based
  useEffect(() => {
    if (!selectedSession || !selectedProject) {
      // A freshly created session can be mid-run before the router has a
      // canonical selectedSession (the URL effect synthesizes one on the
      // next render). Keep the active view intact instead of wiping it.
      if (currentSessionId && processingSessionsRef.current?.has(currentSessionId)) {
        return;
      }

      resetStreamingState();
      setCurrentSessionId(null);
      messagesOffsetRef.current = 0;
      setHasMoreMessages(false);
      setTotalMessages(0);
      setTokenBudget(null);
      lastLoadedSessionKeyRef.current = null;
      return;
    }

    const selectedSessionId = selectedSession.id;
    const sessionKey = `${selectedSessionId}:${selectedProject.projectId}`;

    const subscribeToSelectedSession = () => {
      if (!ws) {
        return;
      }

      statusCheckSentAtRef.current.set(selectedSessionId, Date.now());
      sendMessage({
        type: 'chat.subscribe',
        sessions: [{
          sessionId: selectedSessionId,
          lastSeq: lastSeqRef.current.get(selectedSessionId) ?? 0,
        }],
      });
    };

    // Skip if already loaded and fresh
    if (lastLoadedSessionKeyRef.current === sessionKey && sessionStore.has(selectedSessionId) && !sessionStore.isStale(selectedSessionId)) {
      subscribeToSelectedSession();
      return;
    }

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
    setViewHiddenCount(0);
    wasNearTopRef.current = false;
    if (loadAllOverlayTimerRef.current) clearTimeout(loadAllOverlayTimerRef.current);
    if (loadAllFinishedTimerRef.current) clearTimeout(loadAllFinishedTimerRef.current);

    if (sessionChanged) {
      setTokenBudget(null);
    }

    setCurrentSessionId(selectedSessionId);

    // Subscribe to the session's live run (if any): the ack reconciles the
    // processing indicator, re-attaches a mid-flight stream to this socket,
    // and replays any live events missed since `lastSeq`. Recording the send
    // time lets the ack handler discard idle acks that a newer request has
    // since outdated.
    subscribeToSelectedSession();

    lastLoadedSessionKeyRef.current = sessionKey;

    // Fetch from server → store updates → chatMessages re-derives automatically
    setIsLoadingSessionMessages(true);
    sessionStore.fetchFromServer(selectedSessionId, {
      limit: MESSAGES_PER_PAGE,
      offset: 0,
    }).then(slot => {
      if (slot) {
        setHasMoreMessages(slot.hasMore);
        setTotalMessages(slot.total);
        if (slot.tokenUsage) setTokenBudget(slot.tokenUsage as Record<string, unknown>);
      }
      setIsLoadingSessionMessages(false);
    }).catch(() => {
      setIsLoadingSessionMessages(false);
    });
  }, [
    resetStreamingState,
    selectedProject,
    selectedSession?.id,
    sendMessage,
    statusCheckSentAtRef,
    lastSeqRef,
    ws,
    sessionStore,
  ]);

  // External message update (e.g. WebSocket reconnect, background refresh)
  useEffect(() => {
    if (!externalMessageUpdate || !selectedSession || !selectedProject) return;

    const reloadExternalMessages = async () => {
      try {
        // Skip store refresh during active streaming
        if (!isProcessing) {
          await sessionStore.refreshFromServer(selectedSession.id);

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
    scrollToBottom,
    selectedProject,
    selectedSession,
    sessionStore,
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
    if (!searchTarget || chatMessages.length === 0 || isLoadingSessionMessages) return;

    const target = searchTarget;
    setSearchTarget(null);

    const scrollToTarget = async () => {
      // Search navigation loads the full session below; a page reveal still
      // waiting for scroll-settle would re-apply stale pagination state on
      // top of it.
      pendingPrependCommitRef.current = null;
      pendingPrependGateRef.current = null;
      if (!allMessagesLoadedRef.current && selectedSession && selectedProject) {
          try {
            // Load all messages into the store for search navigation
            const slot = await sessionStore.fetchFromServer(selectedSession.id, {
              limit: null,
              offset: 0,
            });
            if (slot) {
              setHasMoreMessages(false);
              setTotalMessages(slot.total);
              messagesOffsetRef.current = slot.total;
              setVisibleMessageCount(Infinity);
              setAllMessagesLoaded(true);
              allMessagesLoadedRef.current = true;
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch {
            // Fall through and scroll in current messages
          }
      }
      setVisibleMessageCount(Infinity);

      const findAndScroll = (retriesLeft: number) => {
        const container = scrollContainerRef.current;
        if (!container) return;

        let targetElement: Element | null = null;

        if (target.snippet) {
          const cleanSnippet = target.snippet.replace(/^\.{3}/, '').replace(/\.{3}$/, '').trim();
          const searchPhrase = cleanSnippet.slice(0, 80).toLowerCase().trim();
          if (searchPhrase.length >= 10) {
            const messageElements = container.querySelectorAll('.chat-message');
            for (const el of messageElements) {
              const text = (el.textContent || '').toLowerCase();
              if (text.includes(searchPhrase)) { targetElement = el; break; }
            }
          }
        }

        if (!targetElement && target.timestamp) {
          const targetDate = new Date(target.timestamp).getTime();
          const messageElements = container.querySelectorAll('[data-message-timestamp]');
          let closestDiff = Infinity;
          for (const el of messageElements) {
            const ts = el.getAttribute('data-message-timestamp');
            if (!ts) continue;
            const diff = Math.abs(new Date(ts).getTime() - targetDate);
            if (diff < closestDiff) { closestDiff = diff; targetElement = el; }
          }
        }

        if (targetElement) {
          targetElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
          targetElement.classList.add('search-highlight-flash');
          setTimeout(() => targetElement?.classList.remove('search-highlight-flash'), 4000);
          searchScrollActiveRef.current = false;
        } else if (retriesLeft > 0) {
          setTimeout(() => findAndScroll(retriesLeft - 1), 200);
        } else {
          searchScrollActiveRef.current = false;
        }
      };

      setTimeout(() => findAndScroll(15), 150);
    };

    scrollToTarget();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages.length, isLoadingSessionMessages, searchTarget]);

  // Initial token usage fetch for providers with file-backed usage data.
  useEffect(() => {
    if (!selectedSession?.id) {
      setTokenBudget(null);
      return;
    }
    const fetchInitialTokenUsage = async () => {
      try {
        // The provider module resolves storage and provider details from the session id.
        const url = `/api/providers/sessions/${encodeURIComponent(selectedSession.id)}/token-usage`;
        const response = await authenticatedFetch(url);
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
    let start = Math.max(0, chatMessages.length - visibleMessageCount);
    if (renderWindowSessionRef.current !== activeSessionId) {
      renderWindowSessionRef.current = activeSessionId;
    } else {
      // An older page fetched mid-gesture stays hidden until the settle-time
      // commit reveals it together with its scroll compensation.
      const gate = pendingPrependGateRef.current;
      if (gate) {
        const gateIndex = chatMessages.indexOf(gate);
        if (gateIndex > start) start = gateIndex;
      }
      // While the user reads history the window start never advances: a plain
      // slice(-count) drops the topmost rendered message each time a live
      // message appends past the cap, shifting everything above the reading
      // position — worst mid-scroll, where no compensation is allowed. The
      // cap re-applies on the first update after the user returns to the
      // bottom. (Revealing more history — a smaller start — is always
      // allowed; that's the page-reveal and load-all path.)
      if (userDetachedRef.current && renderedFirstMessageRef.current) {
        const held = chatMessages.indexOf(renderedFirstMessageRef.current);
        if (held >= 0 && held < start) start = held;
      }
    }
    renderedFirstMessageRef.current = chatMessages[start] ?? null;
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

    if (!userDetachedRef.current) {
      setScrollTop(container, container.scrollHeight);
      return;
    }

    const anchor = scrollAnchorRef.current;
    if (!anchor) return;

    programmaticScrollRef.current = true;
    if (!restoreScrollAnchor(container, anchor)) {
      // The anchored message was unmounted (rewind, session refresh) — take a
      // fresh anchor rather than letting the viewport drift unmanaged.
      programmaticScrollRef.current = false;
      scrollAnchorRef.current = captureScrollAnchor(container);
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
    const onTouchStart = () => {
      isTouchingRef.current = true;
      handleUserScrollIntent();
    };
    const onTouchEnd = () => {
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

    const options = { passive: true } as const;
    container.addEventListener('scroll', handleScroll, options);
    container.addEventListener('touchstart', onTouchStart, options);
    container.addEventListener('touchmove', handleUserScrollIntent, options);
    container.addEventListener('touchend', onTouchEnd, options);
    container.addEventListener('touchcancel', onTouchEnd, options);
    container.addEventListener('wheel', handleUserScrollIntent, options);

    return () => {
      container.removeEventListener('scroll', handleScroll);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', handleUserScrollIntent);
      container.removeEventListener('touchend', onTouchEnd);
      container.removeEventListener('touchcancel', onTouchEnd);
      container.removeEventListener('wheel', handleUserScrollIntent);
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
    if (!selectedSession || !selectedProject) return;
    if (isLoadingAllMessages) return;
    const requestSessionId = selectedSession.id;
    allMessagesLoadedRef.current = true;
    isLoadingMoreRef.current = true;
    // Loading everything supersedes any page reveal still waiting for
    // scroll-settle.
    pendingPrependCommitRef.current = null;
    pendingPrependGateRef.current = null;
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
      });

      if (currentSessionId !== requestSessionId) return;

      if (slot) {
        if (container) {
          pendingScrollRestoreRef.current = captureScrollAnchor(container);
        }

        setHasMoreMessages(false);
        setTotalMessages(slot.total);
        messagesOffsetRef.current = slot.total;
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
  }, [selectedSession, selectedProject, isLoadingAllMessages, currentSessionId, sessionStore]);

  const loadEarlierMessages = useCallback(() => {
    setVisibleMessageCount((prev) => prev + 100);
  }, []);

  return {
    chatMessages,
    addMessage,
    clearMessages,
    rewindMessages,
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
    loadAllMessages,
    allMessagesLoaded,
    isLoadingAllMessages,
    loadAllJustFinished,
    showLoadAllOverlay,
    createDiff,
    scrollContainerRef,
    messagesContentRef,
    scrollToBottom,
    scrollToBottomAndReset,
    isNearBottom,
    handleScroll,
    handleUserScrollIntent,
  };
}
