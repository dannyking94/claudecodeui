import type { CodexUsage, ClaudeUsageLimit, ClaudeUsageWindow } from '../types/types';

function readWindow(value: unknown): ClaudeUsageWindow | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const utilization = Number(record.utilization);
  if (!Number.isFinite(utilization)) {
    return null;
  }

  const resetsAt = Number(record.resetsAt);
  const severity = record.severity;
  return {
    utilization,
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
    severity: severity === 'warning' || severity === 'critical' ? severity : 'normal',
  };
}

function readLimits(value: unknown): ClaudeUsageLimit[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const window = readWindow(entry);
    const record = entry && typeof entry === 'object' ? entry as Record<string, unknown> : null;
    if (!window || typeof record?.kind !== 'string') {
      return [];
    }

    return [{
      kind: record.kind,
      ...window,
      scopeLabel: typeof record.scopeLabel === 'string' ? record.scopeLabel : null,
      isActive: record.isActive === true,
    }];
  });
}

/** Reads the normalized Codex account percentage bundled with session token usage. */
export function readCodexUsage(tokenBudget: Record<string, unknown> | null): CodexUsage | null {
  const value = tokenBudget?.accountUsage;
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const fiveHour = readWindow(record.fiveHour);
  const sevenDay = readWindow(record.sevenDay);
  const limits = readLimits(record.limits);

  if (!fiveHour && !sevenDay && limits.length === 0) {
    return null;
  }

  return {
    fiveHour,
    sevenDay,
    limits,
    plan: typeof record.plan === 'string' ? record.plan : null,
  };
}
