import { useEffect, useRef } from 'react';

/**
 * Keeps the fixed workspace shell above the virtual keyboard in iOS Safari.
 * Returns the ref to attach to the shell container.
 *
 * The offset is written straight onto the container's `bottom` rather than as
 * a custom property on <html>: resize fires on every frame of the keyboard
 * animation, and changing a variable on the root re-resolves style for the
 * whole document each time (~40 ms per event on a long chat, against ~0.1 ms).
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
      const bottom = `${Math.max(0, window.innerHeight - visualViewport.height)}px`;
      if (bottom === lastBottom || !containerRef.current) {
        return;
      }
      lastBottom = bottom;
      containerRef.current.style.bottom = bottom;
    };

    visualViewport.addEventListener('resize', updateKeyboardHeight);
    return () => visualViewport.removeEventListener('resize', updateKeyboardHeight);
  }, []);

  return containerRef;
}
