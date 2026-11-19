import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useBrowserToolbarOverlap } from '@/modules/project-workspace/hooks/useBrowserToolbarOverlap';

/**
 * In an iPhone browser tab the shell runs behind Safari's floating toolbar, and
 * the composer pads by `--browser-toolbar-overlap`: the distance from the
 * shell's bottom up to where a `position: fixed; bottom: 0` element ends.
 */

const SHELL_BOTTOM = 912;
const FIXED_BOTTOM = 838;

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 420, width: 420, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  // No visualViewport in jsdom: the hook falls back to innerHeight, which here
  // reaches the shell's bottom, so the fixed probe is what decides.
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: SHELL_BOTTOM });
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.style.position === 'fixed' ? rect(FIXED_BOTTOM, FIXED_BOTTOM) : rect(0, SHELL_BOTTOM);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.classList.remove('ios-browser-tab');
});

function Shell() {
  const shellRef = useRef<HTMLDivElement>(null);
  useBrowserToolbarOverlap(shellRef);
  return <div ref={shellRef} data-testid="shell" />;
}

test('publishes the toolbar overlap on the shell in a browser tab', () => {
  document.documentElement.classList.add('ios-browser-tab');
  const { getByTestId, unmount } = render(<Shell />);
  assert.equal(getByTestId('shell').style.getPropertyValue('--browser-toolbar-overlap'), '74px');

  // The probe is removed with the shell.
  unmount();
  assert.equal(document.body.querySelector('[aria-hidden="true"][style*="fixed"]'), null);
});

test('leaves the property unset outside a browser tab', () => {
  const { getByTestId } = render(<Shell />);
  act(() => {
    window.dispatchEvent(new Event('resize'));
  });
  assert.equal(getByTestId('shell').style.getPropertyValue('--browser-toolbar-overlap'), '');
});
