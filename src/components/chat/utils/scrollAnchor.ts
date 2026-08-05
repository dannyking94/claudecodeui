/**
 * Element-based scroll anchoring for the chat message list.
 *
 * Chrome and Firefox ship CSS scroll anchoring (`overflow-anchor: auto`), which
 * silently compensates the scroll offset when content *above* the viewport
 * changes height. WebKit has never implemented it, so on iOS/macOS Safari the
 * reading position visibly jumps whenever an older page is prepended or a
 * markdown block, code highlight, or image above the viewport finishes laying
 * out. These helpers reimplement the same behaviour by hand.
 *
 * The anchor is a real DOM element rather than a scrollHeight delta on purpose:
 * a height delta cannot distinguish growth above the viewport (which must be
 * compensated) from growth below it (which must not be). Pinning a concrete
 * element handles both cases without knowing where the growth came from.
 */

/** Distance in px from the bottom of the scroll range at which we consider the user "following" the conversation. */
export const NEAR_BOTTOM_THRESHOLD_PX = 120;

/**
 * Hysteresis band for the follow/detach latch.
 *
 * A single threshold flaps: scrolling along it flips the latch (and the
 * `isUserScrolledUp` state behind the scroll-to-bottom button) on every scroll
 * event. Detaching and re-attaching at different distances means the state only
 * changes on a deliberate move away from or back to the newest message.
 */
export const DETACH_BELOW_PX = 150;
export const REATTACH_WITHIN_PX = 60;

export interface ScrollAnchor {
  element: HTMLElement;
  /** Offset of the anchor's top edge from the container's top edge, in px. */
  offset: number;
}

/**
 * Distance from the bottom of the scroll range, clamped at 0.
 *
 * The clamp matters on iOS: rubber-band overscroll drives `scrollTop` past
 * `scrollHeight - clientHeight`, which would otherwise yield a negative
 * distance and read as "far from the bottom".
 */
export function distanceFromBottom(container: HTMLElement): number {
  return Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop);
}

export function isNearBottom(
  container: HTMLElement,
  threshold: number = NEAR_BOTTOM_THRESHOLD_PX,
): boolean {
  return distanceFromBottom(container) < threshold;
}

/**
 * Pick the topmost message element that is still visible, and record where its
 * top edge sits relative to the container's top edge.
 *
 * Messages are laid out in a single block flow, so their rects are monotonic in
 * document order and a binary search finds the first visible one in ~log2(n)
 * rect reads instead of scanning every message.
 */
export function captureScrollAnchor(container: HTMLElement): ScrollAnchor | null {
  const messages = container.querySelectorAll<HTMLElement>('.chat-message');
  if (messages.length === 0) return null;

  const containerTop = container.getBoundingClientRect().top;

  let lo = 0;
  let hi = messages.length - 1;
  let found: HTMLElement | null = null;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const el = messages[mid];
    if (el.getBoundingClientRect().bottom > containerTop) {
      found = el;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }

  // Everything is scrolled past the top edge — anchor on the last message so a
  // reflow above it still holds the view steady.
  const anchor = found ?? messages[messages.length - 1];
  return { element: anchor, offset: anchor.getBoundingClientRect().top - containerTop };
}

/**
 * Put the anchored element back where it was, absorbing any height change that
 * happened above it.
 *
 * Returns false when the anchor is no longer usable (element detached or moved
 * out of this container), so the caller can drop it and re-capture.
 */
export function restoreScrollAnchor(container: HTMLElement, anchor: ScrollAnchor): boolean {
  const { element, offset } = anchor;
  if (!element.isConnected || !container.contains(element)) return false;

  const currentOffset = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const delta = currentOffset - offset;

  // Sub-pixel deltas are layout noise; correcting them would fight momentum
  // scrolling on iOS for no visible benefit.
  if (Math.abs(delta) >= 0.5) {
    container.scrollTop += delta;
  }
  return true;
}
