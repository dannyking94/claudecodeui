/**
 * Rendering-engine detection for the few places where behaviour must key on
 * the engine rather than on a feature.
 *
 * Every browser on iOS is WebKit (Chrome, Firefox and Edge there are shells
 * around it), and they all report Apple's vendor string. Feature detection is
 * still preferred wherever the feature is what matters; this exists for CSS
 * optimisations that are only safe on engines whose scroll anchoring has been
 * proven against them (see `.chat-message` in index.css).
 *
 * Used by the app entry (main.tsx) to set the `engine-webkit` root class.
 */
export function isWebKitEngine(): boolean {
  if (typeof navigator === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent || '';
  if (navigator.vendor === 'Apple Computer, Inc.') {
    return true;
  }
  if (/\b(iPhone|iPad|iPod)\b/.test(userAgent)) {
    return true;
  }
  return /AppleWebKit/.test(userAgent) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(userAgent);
}

/**
 * True for a page open in an iPhone/iPad browser tab, false for a Home Screen
 * web app and for every desktop browser.
 *
 * iOS 26 Safari floats its toolbar over the page and will not paint a
 * `position: fixed` element below the top of that toolbar: it clips the
 * element there and fills the rest with a colour it extends from the element
 * (https://developer.apple.com/forums/thread/800798,
 * https://bugs.webkit.org/show_bug.cgi?id=301756). Only in-flow content is drawn
 * behind the glass, so in a tab the workspace shell must not be fixed
 * (`.ios-browser-tab` in index.css). A Home Screen web app has no toolbar, and
 * its fixed shell already reaches the screen edges, so it keeps the fixed shell.
 *
 * Used by the app entry (main.tsx) to set the `ios-browser-tab` root class.
 */
export function isIOSBrowserTab(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return false;
  }

  const userAgent = navigator.userAgent || '';
  // iPadOS reports a desktop Mac user agent; touch support tells them apart.
  const isIOSDevice =
    /\b(iPhone|iPad|iPod)\b/.test(userAgent) ||
    (/\bMacintosh\b/.test(userAgent) && navigator.maxTouchPoints > 1);
  if (!isIOSDevice) {
    return false;
  }

  const isStandalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches);
  return !isStandalone;
}
