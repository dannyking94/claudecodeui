/** One Claude plan rate-limit window, as reported by `/api/system/claude-usage`. */
export type ClaudeUsageWindow = {
  /** Percent of the window's allowance consumed. Can exceed 100 when overdrawn. */
  utilization: number;
  /** Epoch ms when the window rolls over, or null when upstream omits it. */
  resetsAt: number | null;
  severity: 'normal' | 'warning' | 'critical';
};

/**
 * One entry from the full per-window breakdown behind the two headline
 * figures. `kind` is passed through from upstream rather than narrowed to a
 * union: accounts expose different windows and new ones appear over time, so
 * an unrecognized kind is displayed with its raw name instead of dropped.
 */
export type ClaudeUsageLimit = {
  kind: string;
  utilization: number;
  resetsAt: number | null;
  severity: ClaudeUsageWindow['severity'];
  /** Model or surface the window applies to, e.g. `Fable`. Null when account-wide. */
  scopeLabel: string | null;
  /** True for the window currently governing throughput. */
  isActive: boolean;
};

/**
 * Remaining plan allowance for the Claude account signed in on the server host.
 *
 * `null` means "nothing to display" — the server withheld it (platform mode),
 * no account is signed in, or the endpoint could not be read. All three are
 * ordinary states, so the composer simply omits the pill.
 */
export type ClaudeUsage = {
  fiveHour: ClaudeUsageWindow | null;
  sevenDay: ClaudeUsageWindow | null;
  /** Every window upstream reports, shown in the detail dialog. */
  limits: ClaudeUsageLimit[];
  /** Plan label such as `max`, shown in the tooltip and dialog header. */
  plan: string | null;
  /**
   * True when the server could not reach upstream and is retaining an earlier
   * reading. The pill still shows the number — a percentage from a few minutes
   * ago is far more useful than a gap — but dims it and says so in the tooltip.
   */
  stale?: boolean;
};

/** GPT/Codex account allowance emitted alongside a session's token snapshot. */
export type CodexUsage = ClaudeUsage;

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
