import { GaugeIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ClaudeUsage, CodexUsage } from '../../types/types';
import { SEVERITY_ACCENT, formatResetDistance, worstSeverity } from '../../utils/claudeUsage';

type ClaudeUsageSummaryProps = {
  usage: ClaudeUsage | CodexUsage | null;
  provider?: 'claude' | 'codex';
  onClick?: () => void;
};

export default function ClaudeUsageSummary({ usage, provider = 'claude', onClick }: ClaudeUsageSummaryProps) {
  const { t } = useTranslation('chat');
  const translationKey = provider === 'codex' ? 'codexUsage' : 'claudeUsage';

  // Nothing to show covers every ordinary miss: a signed-out account, a
  // session with no rate-limit snapshot yet, or an upstream hiccup.
  if (!usage) {
    return null;
  }

  // The five-hour window is what actually gates work minute to minute, so it is
  // the headline. The weekly window still drives the tint through the severity
  // comparison below, and the dialog explains a colour the number alone cannot.
  const headline = usage.fiveHour ?? usage.sevenDay ?? usage.limits[0] ?? null;
  if (!headline) {
    return null;
  }

  const severity = worstSeverity([usage.fiveHour, usage.sevenDay, ...usage.limits]);
  const tooltipLines: string[] = [];

  for (const [window, key] of [
    [usage.fiveHour, 'session'],
    [usage.sevenDay, 'weekly'],
  ] as const) {
    if (!window) {
      continue;
    }

    const resetsIn = formatResetDistance(window.resetsAt);
    tooltipLines.push(
      t(`input.${translationKey}.${key}`, { percent: Math.round(window.utilization) }) +
        (resetsIn ? ` · ${t(`input.${translationKey}.resetsIn`, { duration: resetsIn })}` : ''),
    );
  }

  if (usage.plan) {
    tooltipLines.push(t(`input.${translationKey}.plan`, { plan: usage.plan }));
  }

  // Say so rather than letting an unchanging number read as a live one.
  if (usage.stale) {
    tooltipLines.push(t(`input.${translationKey}.stale`));
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5 ${
        usage.stale ? 'opacity-60' : ''
      }`}
      title={tooltipLines.join('\n')}
      aria-label={t(`input.${translationKey}.ariaLabel`)}
    >
      <span className={`grid h-5 w-5 place-items-center rounded-md ${SEVERITY_ACCENT[severity]}`}>
        <GaugeIcon className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-foreground">{Math.round(headline.utilization)}%</span>
      <span className="hidden text-muted-foreground/70 sm:inline">
        {t(`input.${translationKey}.label`)}
      </span>
    </button>
  );
}
