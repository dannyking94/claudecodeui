import { useEffect } from 'react';
import type { RefObject } from 'react';

const OVERLAP_PROPERTY = '--browser-toolbar-overlap';

/**
 * Measures how far the workspace shell reaches behind the browser's own
 * bottom toolbar and publishes it on the shell as `--browser-toolbar-overlap`,
 * which keeps the composer above the toolbar (`.ios-browser-tab` in index.css).
 *
 * Only active in an iPhone/iPad browser tab, where the shell runs to the bottom
 * of the screen behind iOS 26 Safari's floating toolbar. Safari does not
 * expose the toolbar's height, so it is measured from two things it does
 * honour: a `position: fixed; bottom: 0` probe ends where a fixed element would
 * (the top of the toolbar), and the visual viewport ends where visible content
 * ends. Whichever is higher above the shell's bottom is the overlap.
 * Everywhere else the property stays unset and resolves to 0.
 *
 * The measurement is skipped while the keyboard is open: the shell is then
 * sized to the visual viewport, and the composer pads nothing.
 */
export function useBrowserToolbarOverlap<T extends HTMLElement>(containerRef: RefObject<T | null>) {
  useEffect(() => {
    if (!document.documentElement.classList.contains('ios-browser-tab')) {
      return undefined;
    }

    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;pointer-events:none';
    document.body.appendChild(probe);

    let lastOverlap = '';
    let frame = 0;
    const measure = () => {
      frame = 0;
      const container = containerRef.current;
      if (!container || container.hasAttribute('data-keyboard-open')) {
        return;
      }
      const shellBottom = container.getBoundingClientRect().bottom;
      const fixedBottom = probe.getBoundingClientRect().top;
      const visualViewport = window.visualViewport;
      const visibleBottom = visualViewport
        ? visualViewport.offsetTop + visualViewport.height
        : window.innerHeight;
      const overlapPx = Math.max(0, Math.round(shellBottom - Math.min(fixedBottom, visibleBottom)));
      const overlap = `${overlapPx}px`;
      if (overlap !== lastOverlap) {
        lastOverlap = overlap;
        container.style.setProperty(OVERLAP_PROPERTY, overlap);
      }
    };
    // Coalesced to one read per frame: visualViewport resize fires per frame
    // while the toolbar or keyboard animates.
    const scheduleMeasure = () => {
      if (!frame) {
        frame = window.requestAnimationFrame(measure);
      }
    };

    scheduleMeasure();
    window.addEventListener('resize', scheduleMeasure);
    window.addEventListener('orientationchange', scheduleMeasure);
    window.visualViewport?.addEventListener('resize', scheduleMeasure);

    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('orientationchange', scheduleMeasure);
      window.visualViewport?.removeEventListener('resize', scheduleMeasure);
      probe.remove();
      containerRef.current?.style.removeProperty(OVERLAP_PROPERTY);
    };
  }, [containerRef]);
}
