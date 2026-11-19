import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

/**
 * Document-scroll mode is the default in an iPhone/iPad browser tab and nowhere
 * else. `?docScroll=0` is the escape hatch: it is remembered for the browser
 * and beats the default until `?docScroll=1` re-enables the mode.
 */

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const STORAGE_KEY = 'cloudcli:doc-scroll';

type Device = { userAgent: string; standalone?: boolean };

/** Loads a fresh copy of the module, which decides the mode once at import time. */
async function loadWith(device: Device, search = '') {
  vi.resetModules();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(device.userAgent);
  Object.defineProperty(navigator, 'standalone', { configurable: true, value: device.standalone });
  window.history.replaceState(null, '', `/session/abc${search}`);
  return import('@/shared/documentScroll');
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'standalone');
  document.documentElement.className = '';
  window.history.replaceState(null, '', '/');
});

test('is on by default in an iPhone browser tab, with nothing stored', async () => {
  const documentScroll = await loadWith({ userAgent: IPHONE_UA });

  assert.equal(documentScroll.DOCUMENT_SCROLL_ENABLED, true);
  assert.equal(window.localStorage.getItem(STORAGE_KEY), null);

  documentScroll.markDocumentScrollEnabled();
  documentScroll.setDocumentScrollActive(true);
  assert.equal(document.documentElement.className, 'doc-scroll doc-scroll-active');
  assert.equal(documentScroll.isDocumentScrollActive(), true);
});

test('stays off on desktop, Android and a Home Screen web app, even when asked for', async () => {
  for (const device of [
    { userAgent: DESKTOP_UA },
    { userAgent: ANDROID_UA },
    { userAgent: IPHONE_UA, standalone: true },
  ]) {
    const documentScroll = await loadWith(device, '?docScroll=1');

    assert.equal(documentScroll.DOCUMENT_SCROLL_ENABLED, false, device.userAgent);
    documentScroll.markDocumentScrollEnabled();
    documentScroll.setDocumentScrollActive(true);
    assert.equal(document.documentElement.className, '');
    vi.restoreAllMocks();
  }
});

test('?docScroll=0 turns it off and keeps it off on later visits without the parameter', async () => {
  const optedOut = await loadWith({ userAgent: IPHONE_UA }, '?docScroll=0');
  assert.equal(optedOut.DOCUMENT_SCROLL_ENABLED, false);
  assert.equal(window.localStorage.getItem(STORAGE_KEY), '0');

  vi.restoreAllMocks();
  const nextVisit = await loadWith({ userAgent: IPHONE_UA });
  assert.equal(nextVisit.DOCUMENT_SCROLL_ENABLED, false);
});

test('?docScroll=1 re-enables it after an opt-out', async () => {
  window.localStorage.setItem(STORAGE_KEY, '0');

  const reEnabled = await loadWith({ userAgent: IPHONE_UA }, '?docScroll=1');
  assert.equal(reEnabled.DOCUMENT_SCROLL_ENABLED, true);

  vi.restoreAllMocks();
  const nextVisit = await loadWith({ userAgent: IPHONE_UA });
  assert.equal(nextVisit.DOCUMENT_SCROLL_ENABLED, true);
});
