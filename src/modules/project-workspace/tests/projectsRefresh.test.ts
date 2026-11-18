import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProjectsRefreshCoalescer } from '@/modules/project-workspace/utils/projectsRefresh';

describe('createProjectsRefreshCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces online and tab-wake refresh requests into one refresh', () => {
    const refresh = vi.fn();
    const coalescer = createProjectsRefreshCoalescer(refresh, 250);

    coalescer.request(); // online
    coalescer.request(); // visibilitychange → visible
    coalescer.request();

    vi.advanceTimersByTime(249);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending refresh when disposed', () => {
    const refresh = vi.fn();
    const coalescer = createProjectsRefreshCoalescer(refresh, 250);

    coalescer.request();
    coalescer.dispose();
    vi.advanceTimersByTime(1000);

    expect(refresh).not.toHaveBeenCalled();
  });
});
