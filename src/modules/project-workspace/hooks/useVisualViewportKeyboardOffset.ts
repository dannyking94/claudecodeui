import { useEffect, useRef } from 'react';

import { isDocumentScrollActive } from '@/shared/documentScroll';

/**
 * Keeps the fixed workspace shell above the virtual keyboard in iOS Safari.
 * Returns the ref to attach to the shell container.
 *
 * The offset is written straight onto the container's `bottom` rather than as
 * a custom property on <html>: resize fires on every frame of the keyboard
 * animation, and changing a variable on the root re-resolves style for the
 * whole document each time (~40 ms per event on a long chat, against ~0.1 ms).
 *
 * While lifted it also carries `data-keyboard-open`, which zeroes the
 * home-indicator padding under the composer (`--keyboard-aware-safe-bottom`):
 * the keyboard covers that band, so the inset would only open a gap. The
 * attribute changes only when the keyboard opens or closes, not per frame.
 *
 * It also writes `height` while lifted: in an iPhone browser tab the shell is
 * not fixed but absolutely positioned at the large-viewport height
 * (`.ios-browser-tab` in index.css), where `bottom` alone would be ignored.
 * For the fixed shell the height equals what `bottom` already gives.
 */
export function useVisualViewportKeyboardOffset<T extends HTMLElement>() {
  const containerRef = useRef<T>(null);

  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return undefined;
    }

    let lastBottom = '';
    // Only resize matters: scrolling moves `offsetTop`, which would make the
    // container bounce if it were tracked too.
    const updateKeyboardHeight = () => {
      // Document-scroll mode (src/shared/documentScroll.ts): the shell is as
      // tall as the transcript and Safari itself brings the focused composer
      // above the keyboard, so sizing the shell here would cut the page short.
      if (isDocumentScrollActive()) {
        if (lastBottom !== '' && containerRef.current) {
          lastBottom = '';
          containerRef.current.style.bottom = '';
          containerRef.current.style.height = '';
          containerRef.current.removeAttribute('data-keyboard-open');
        }
        return;
      }
      const bottom = `${Math.max(0, window.innerHeight - visualViewport.height)}px`;
      if (bottom === lastBottom || !containerRef.current) {
        return;
      }
      lastBottom = bottom;
      const isKeyboardOpen = bottom !== '0px';
      containerRef.current.style.bottom = bottom;
      containerRef.current.style.height = isKeyboardOpen ? `${visualViewport.height}px` : '';
      containerRef.current.toggleAttribute('data-keyboard-open', isKeyboardOpen);
    };

    visualViewport.addEventListener('resize', updateKeyboardHeight);
    return () => visualViewport.removeEventListener('resize', updateKeyboardHeight);
  }, []);

  return containerRef;
}
