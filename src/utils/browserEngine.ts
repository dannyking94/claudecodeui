/**
 * Rendering-engine detection for the few places where behaviour must key on
 * the engine rather than on a feature.
 *
 * Every browser on iOS is WebKit (Chrome, Firefox and Edge there are shells
 * around it), and they all report Apple's vendor string. Feature detection is
 * still preferred wherever the feature is what matters; this exists for CSS
 * optimisations that are only safe on engines whose scroll anchoring has been
 * proven against them (see `.chat-message` in index.css).
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
