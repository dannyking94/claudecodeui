import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

import { mountLayoutDebugOverlay } from '@/shared/layoutDebug';

/**
 * The `?layoutDebug=1` panel has to name the fixed elements Safari could take
 * its bar colour from, including ones that are invisible, and must not be such
 * an element itself.
 */

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) } as DOMRect;
}

test('lists a hidden full-screen fixed layer as a tint candidate on both edges', () => {
  vi.useFakeTimers();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 420 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 746 });
  document.body.innerHTML =
    '<div class="workspace-shell" style="position:absolute"><div class="dim" style="position:fixed;background-color:rgba(0, 0, 0, 0.4)"></div></div>';
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => rect(0, 0, 420, 746));

  mountLayoutDebugOverlay();

  const panel = document.querySelector<HTMLElement>('[data-layout-debug]');
  assert.ok(panel);
  const text = panel.textContent ?? '';
  assert.match(text, /top edge tint candidates: \n {2}div\.dim fixed bg=rgba\(0, 0, 0, 0\.4\)/);
  assert.match(text, /bottom edge tint candidates: \n {2}div\.dim fixed/);
  assert.match(text, /shell absolute/);
  // Narrower than Safari's 80% width threshold and clear of the edges.
  assert.equal(panel.style.width, '76%');
  assert.equal(panel.style.pointerEvents, 'none');
});

test('reports that the body colour is used when nothing fixed touches an edge', () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<div class="workspace-shell" style="position:absolute"></div>';

  mountLayoutDebugOverlay();

  const text = document.querySelector('[data-layout-debug]')?.textContent ?? '';
  assert.match(text, /top edge tint candidates: none \(body colour is used\)/);
  assert.match(text, /bottom edge tint candidates: none \(body colour is used\)/);
});
