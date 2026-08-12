import { GaugeIcon, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge, Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import type { ClaudeUsage, ClaudeUsageLimit, CodexUsage } from '../../types/types';
import { SEVERITY_ACCENT, SEVERITY_BAR, formatResetDistance } from '../../utils/claudeUsage';

type ClaudeUsageModalProps = {
  usage: ClaudeUsage | CodexUsage | null;
  provider?: 'claude' | 'codex';
  open: boolean;
  onClose: () => void;
};

/**
 * Rows are ordered by window length rather than by upstream's array order, so
 * the window that bites first sits at the top. An unrecognized kind sorts last
 * instead of being hidden.
 */
const KIND_ORDER: Record<string, number> = {
  session: 0,
  weekly_all: 1,
  weekly_scoped: 2,
};

function sortLimits(limits: ClaudeUsageLimit[]): ClaudeUsageLimit[] {
  return [...limits].sort(
    (left, right) => (KIND_ORDER[left.kind] ?? 99) - (KIND_ORDER[right.kind] ?? 99),
  );
}

export default function ClaudeUsageModal({ usage, provider = 'claude', open, onClose }: ClaudeUsageModalProps) {
  const { t } = useTranslation('chat');
  const translationKey = provider === 'codex' ? 'codexUsage' : 'claudeUsage';

  if (!usage) {
    return null;
  }

  /**
   * Falls back to the raw upstream kind when this build has no translation for
   * it. A window named `monthly_experimental` is more useful to a user than a
   * blank row or a missing one.
   */
  const describeLimit = (limit: ClaudeUsageLimit) => {
    const label = t(`input.${translationKey}.kinds.${limit.kind}`, { defaultValue: limit.kind });
    return limit.scopeLabel ? `${label} · ${limit.scopeLabel}` : label;
  };

  // The headline windows are always shown, even on an account whose `limits`
  // array is empty, so the dialog is never blank behind a populated pill.
  const rows = sortLimits(usage.limits);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="flex w-[calc(100vw-1rem)] max-w-lg flex-col overflow-hidden rounded-3xl border-border/80 bg-popover/95 p-0 shadow-2xl backdrop-blur-xl">
        <DialogTitle>{t(`input.${translationKey}.title`)}</DialogTitle>

        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-popover px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-muted text-foreground">
              <GaugeIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {t(`input.${translationKey}.eyebrow`)}
              </p>
              <p className="mt-0.5 text-lg font-semibold tracking-tight text-foreground">
                {t(`input.${translationKey}.title`)}
              </p>
              <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
                {t(`input.${translationKey}.subtitle`)}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {usage.plan && <Badge variant="secondary">{usage.plan}</Badge>}
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label={t(`input.${translationKey}.close`)}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-4 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {rows.length === 0 && (
            <p className="text-sm text-muted-foreground">{t(`input.${translationKey}.noBreakdown`)}</p>
          )}

          {rows.map((limit) => {
            const resetsIn = formatResetDistance(limit.resetsAt);
            const percent = Math.round(limit.utilization);

            return (
              <div key={`${limit.kind}:${limit.scopeLabel ?? ''}`} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
                    <span className="truncate">{describeLimit(limit)}</span>
                    {limit.isActive && (
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${SEVERITY_ACCENT[limit.severity]}`}
                      >
                        {t(`input.${translationKey}.active`)}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                    {t(`input.${translationKey}.percentUsed`, { percent })}
                  </span>
                </div>

                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={`h-full rounded-full ${SEVERITY_BAR[limit.severity]}`}
                    // An overdrawn window reports past 100; the bar clamps while
                    // the number beside it stays truthful.
                    style={{ width: `${Math.min(100, Math.max(0, limit.utilization))}%` }}
                  />
                </div>

                <p className="text-xs text-muted-foreground">
                  {resetsIn
                    ? t(`input.${translationKey}.resetsIn`, { duration: resetsIn })
                    : t(`input.${translationKey}.resetsSoon`)}
                </p>
              </div>
            );
          })}

          <p className="border-t border-border/60 pt-3 text-xs leading-5 text-muted-foreground">
            {t(`input.${translationKey}.footnote`)}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
