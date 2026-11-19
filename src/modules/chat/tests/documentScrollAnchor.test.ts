import assert from 'node:assert/strict';

import { afterEach, test, vi } from 'vitest';

import { captureScrollAnchor, restoreScrollAnchor } from '@/modules/chat/utils/scrollAnchor';

/**
 * In document-scroll mode (iPhone/iPad browser tab) the chat's scroller is <html>,
 * whose own rect moves with the scroll offset. Anchoring must then measure
 * from the top of the screen, not from that rect, or it would always pick the
 * first message and never see the one at the reading line.
 */

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function rect(top: number, height: number): DOMRect {
  return { top, bottom: top + height, left: 0, right: 400, width: 400, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

/** Three 500px messages in a document scrolled by `scrollY`; <html>'s rect starts at -scrollY. */
function mountDocument(scrollY: number, shiftAbove = 0) {
  if (!document.querySelector('.chat-message')) {
    document.body.innerHTML = '<div class="chat-message" data-i="0"></div><div class="chat-message" data-i="1"></div><div class="chat-message" data-i="2"></div>';
  }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === document.documentElement) return rect(-scrollY, 1500 + shiftAbove);
    return rect(Number(this.dataset.i) * 500 + shiftAbove - scrollY, 500);
  });
}

test('anchors on the message at the top of the screen when the document is the scroller', () => {
  mountDocument(700);

  const anchor = captureScrollAnchor(document.documentElement);

  assert.equal(anchor?.element.dataset.i, '1');
  assert.equal(anchor?.offset, -200);
});

test('restoring moves the document by exactly what grew above the anchor', () => {
  mountDocument(700);
  const anchor = captureScrollAnchor(document.documentElement);
  assert.ok(anchor);
  vi.restoreAllMocks();

  // 300px appear above the reading line; the scroll offset has not moved yet.
  mountDocument(700, 300);
  document.documentElement.scrollTop = 0;
  const restored = restoreScrollAnchor(document.documentElement, anchor);

  assert.equal(restored, true);
  assert.equal(document.documentElement.scrollTop, 300);
});
