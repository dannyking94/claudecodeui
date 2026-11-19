import assert from 'node:assert/strict';

import { afterEach, test } from 'vitest';

import { isIOSBrowserTab } from '@/shared/browserEngine';

/**
 * The in-flow shell (`.ios-browser-tab`) is only for iPhone/iPad browser tabs:
 * a Home Screen web app and desktop browsers keep the fixed shell.
 */

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';

const restorers: Array<() => void> = [];

function stub<T extends object>(target: T, key: string, value: unknown) {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, value });
  restorers.push(() => {
    if (original) {
      Object.defineProperty(target, key, original);
    } else {
      delete (target as Record<string, unknown>)[key];
    }
  });
}

function setDevice({ ua, touchPoints = 0, standalone = false }: { ua: string; touchPoints?: number; standalone?: boolean }) {
  stub(navigator, 'userAgent', ua);
  stub(navigator, 'maxTouchPoints', touchPoints);
  stub(navigator, 'standalone', standalone);
  stub(window, 'matchMedia', (query: string) => ({ matches: standalone && query.includes('standalone'), media: query }));
}

afterEach(() => {
  while (restorers.length) restorers.pop()?.();
});

test('an iPhone Safari tab is a browser tab', () => {
  setDevice({ ua: IPHONE_UA, touchPoints: 5 });
  assert.equal(isIOSBrowserTab(), true);
});

test('an iPhone Home Screen web app is not', () => {
  setDevice({ ua: IPHONE_UA, touchPoints: 5, standalone: true });
  assert.equal(isIOSBrowserTab(), false);
});

test('iPadOS (desktop user agent with touch) is a browser tab; desktop Safari is not', () => {
  setDevice({ ua: MAC_UA, touchPoints: 5 });
  assert.equal(isIOSBrowserTab(), true);
  while (restorers.length) restorers.pop()?.();
  setDevice({ ua: MAC_UA, touchPoints: 0 });
  assert.equal(isIOSBrowserTab(), false);
});
