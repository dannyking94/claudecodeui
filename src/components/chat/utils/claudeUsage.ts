import type { ClaudeUsageWindow } from '../types/types';

type Severity = ClaudeUsageWindow['severity'];

/** Tint for the pill's icon chip and the dialog's window rows. */
export const SEVERITY_ACCENT: Record<Severity, string> = {
  normal: 'bg-primary/10 text-primary',
  warning: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  critical: 'bg-destructive/15 text-destructive',
};

/** Fill for the dialog's progress bars, matched to `SEVERITY_ACCENT`. */
export const SEVERITY_BAR: Record<Severity, string> = {
  normal: 'bg-primary',
  warning: 'bg-amber-500',
  critical: 'bg-destructive',
};

const SEVERITY_RANK: Record<Severity, number> = {
  normal: 0,
  warning: 1,
  critical: 2,
};

/**
 * The most severe grading among the given windows.
 *
 * The pill shows one number but must not look calm while a different window is
 * the one about to run out, so its tint comes from the worst of them.
 */
export function worstSeverity(windows: Array<{ severity: Severity } | null>): Severity {
  return windows.reduce<Severity>(
    (worst, window) =>
      window && SEVERITY_RANK[window.severity] > SEVERITY_RANK[worst] ? window.severity : worst,
    'normal',
  );
}

/**
 * Renders a coarse countdown such as `2h 14m`, or null once the window has
 * already rolled over.
 *
 * Units stay as digits plus `d`/`h`/`m` rather than translated words: it reads
 * the same across every locale the app ships and keeps the pill's tooltip
 * narrow enough to sit under the composer.
 */
export function formatResetDistance(resetsAt: number | null, from: number = Date.now()): string | null {
  if (resetsAt === null) {
    return null;
  }

  const remainingMinutes = Math.round((resetsAt - from) / 60_000);
  if (remainingMinutes <= 0) {
    return null;
  }

  const days = Math.floor(remainingMinutes / 1_440);
  const hours = Math.floor((remainingMinutes % 1_440) / 60);
  const minutes = remainingMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}
