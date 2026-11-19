import { isIOSBrowserTab } from '@/shared/browserEngine';

/**
 * Document-scroll mode: in an iPhone/iPad browser tab the chat transcript
 * scrolls the document instead of an inner container.
 *
 * iOS Safari collapses its toolbar to a small pill only when the document
 * itself scrolls; an inner `overflow: auto` box never triggers it. In this
 * mode the Chat tab lets the page grow with the transcript, keeps the header
 * and the composer `position: sticky`, and the chat's scroll logic drives
 * `document.documentElement` instead of the transcript pane
 * (`.doc-scroll-active` in index.css, `isDocumentScroller`).
 *
 * On by default in an iPhone/iPad browser tab (`isIOSBrowserTab`). Desktop,
 * Android and Home Screen web apps never use it. The escape hatch is
 * `?docScroll=0`: it is remembered in localStorage for that browser and wins
 * over the default on every later visit, until `?docScroll=1` re-enables it.
 */

const STORAGE_KEY = 'cloudcli:doc-scroll';
/** On <html> for the life of the page when the mode is enabled. */
const ENABLED_CLASS = 'doc-scroll';
/** On <html> only while the Chat tab is the visible view; every layout rule keys on it. */
const ACTIVE_CLASS = 'doc-scroll-active';

function readEnabled(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }
  if (!isIOSBrowserTab()) {
    return false;
  }
  try {
    const param = new URLSearchParams(window.location.search).get('docScroll');
    if (param !== null) {
      const isOptOut = param === '0' || param === 'false' || param === 'off';
      window.localStorage.setItem(STORAGE_KEY, isOptOut ? '0' : '1');
    }
    // Only a stored opt-out turns the default off.
    return window.localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    // Storage is unavailable (private mode): the default still applies.
    return true;
  }
}

/**
 * Whether this page runs the chat in document-scroll mode. Fixed at load: the
 * chat binds its scroll listeners once, so the scroller cannot change later.
 * Used by main.tsx, the chat scroll hooks and the workspace keyboard hook.
 */
export const DOCUMENT_SCROLL_ENABLED = readEnabled();

/** Marks <html> so CSS can tell the mode is available. Called once by main.tsx. */
export function markDocumentScrollEnabled(): void {
  if (DOCUMENT_SCROLL_ENABLED) {
    document.documentElement.classList.add(ENABLED_CLASS);
  }
}

/**
 * Switches the page between the scrolling-document layout (Chat tab visible)
 * and the fixed-height shell every other view needs. Called by ChatInterface
 * from a layout effect, so the layout is in place before the chat restores its
 * scroll position.
 */
export function setDocumentScrollActive(active: boolean): void {
  if (DOCUMENT_SCROLL_ENABLED) {
    document.documentElement.classList.toggle(ACTIVE_CLASS, active);
  }
}

/** True while the document is the chat's live scroller. Read at event time by scroll and keyboard handlers. */
export function isDocumentScrollActive(): boolean {
  return DOCUMENT_SCROLL_ENABLED && document.documentElement.classList.contains(ACTIVE_CLASS);
}

/** True when `container` is the document scroller rather than an inner scroll box. */
export function isDocumentScroller(container: Element): boolean {
  return typeof document !== 'undefined' && container === document.documentElement;
}
