import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectUnendedLife, readCrashLog, startCrashBreadcrumbs } from '@/shared/crashBreadcrumbs';

describe('crash breadcrumbs', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records nothing after a page that unloaded normally', () => {
    startCrashBreadcrumbs();
    window.dispatchEvent(new Event('pagehide'));
    expect(collectUnendedLife(Date.now())).toBeNull();
    expect(readCrashLog()).toEqual([]);
  });

  it('logs the last sample of a page that was killed without unloading', () => {
    startCrashBreadcrumbs();
    const row = document.createElement('div');
    row.className = 'chat-message';
    document.body.appendChild(row);
    vi.advanceTimersByTime(2000);

    // The process dies here: no pagehide. The next boot finds the open life.
    startCrashBreadcrumbs();

    const [entry] = readCrashLog();
    expect(entry).toBeDefined();
    expect(entry.ended).toBe(false);
    expect(entry.samples).toBe(1);
    expect(entry.last?.transcriptRows).toBe(1);
    expect(entry.last?.domNodes).toBeGreaterThan(0);
    row.remove();
  });

  it('keeps a bounded log', () => {
    for (let index = 0; index < 12; index += 1) {
      startCrashBreadcrumbs();
    }
    expect(readCrashLog().length).toBe(8);
  });
});
