import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, test } from 'vitest';

import { useVisualViewportKeyboardOffset } from '@/modules/project-workspace/hooks/useVisualViewportKeyboardOffset';

/**
 * The workspace shell runs edge to edge on iPhone, and the composer pads itself
 * above the home indicator. When the keyboard opens the shell is lifted above
 * it, and that padding would only leave a gap between the composer and the
 * keys, so the shell carries `data-keyboard-open` exactly while it is lifted.
 */

class FakeVisualViewport extends EventTarget {
  height = 912;
}

let fakeViewport: FakeVisualViewport;
let originalViewport: PropertyDescriptor | undefined;

beforeEach(() => {
  fakeViewport = new FakeVisualViewport();
  originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: fakeViewport });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 912 });
});

afterEach(() => {
  if (originalViewport) {
    Object.defineProperty(window, 'visualViewport', originalViewport);
  } else {
    delete (window as { visualViewport?: unknown }).visualViewport;
  }
});

function Shell() {
  const shellRef = useVisualViewportKeyboardOffset<HTMLDivElement>();
  return <div ref={shellRef} data-testid="shell" />;
}

test('marks the shell while the keyboard lifts it and clears the mark when it closes', () => {
  const { getByTestId } = render(<Shell />);
  const shell = getByTestId('shell');
  assert.equal(shell.hasAttribute('data-keyboard-open'), false);

  act(() => {
    fakeViewport.height = 560;
    fakeViewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(shell.style.bottom, '352px');
  assert.equal(shell.hasAttribute('data-keyboard-open'), true);

  act(() => {
    fakeViewport.height = 912;
    fakeViewport.dispatchEvent(new Event('resize'));
  });
  assert.equal(shell.style.bottom, '0px');
  assert.equal(shell.hasAttribute('data-keyboard-open'), false);
});
