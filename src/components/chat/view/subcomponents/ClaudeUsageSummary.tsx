import { GaugeIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ClaudeUsage } from '../../types/types';
import { SEVERITY_ACCENT, formatResetDistance, worstSeverity } from '../../utils/claudeUsage';

type ClaudeUsageSummaryProps = {
  usage: ClaudeUsage | null;
  onClick?: () => void;
};

export default function ClaudeUsageSummary({ usage, onClick }: ClaudeUsageSummaryProps) {
  const { t } = useTranslation('chat');

  // Nothing to show covers every ordinary miss: an older server, a platform
  // deployment, a signed-out host, or an upstream hiccup.
  if (!usage) {
    return null;
  }

  // The five-hour window is what actually gates work minute to minute, so it is
  // the headline. The weekly window still drives the tint through the severity
  // comparison below, and the dialog explains a colour the number alone cannot.
  const headline = usage.fiveHour ?? usage.sevenDay;
  if (!headline) {
    return null;
  }

  const severity = worstSeverity([usage.fiveHour, usage.sevenDay]);
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
      t(`input.claudeUsage.${key}`, { percent: Math.round(window.utilization) }) +
        (resetsIn ? ` · ${t('input.claudeUsage.resetsIn', { duration: resetsIn })}` : ''),
    );
  }

  if (usage.plan) {
    tooltipLines.push(t('input.claudeUsage.plan', { plan: usage.plan }));
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm transition-colors hover:border-primary/25 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:gap-2 sm:px-2.5"
      title={tooltipLines.join('\n')}
      aria-label={t('input.claudeUsage.ariaLabel')}
    >
      <span className={`grid h-5 w-5 place-items-center rounded-md ${SEVERITY_ACCENT[severity]}`}>
        <GaugeIcon className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-foreground">{Math.round(headline.utilization)}%</span>
      <span className="hidden text-muted-foreground/70 sm:inline">
        {t('input.claudeUsage.label')}
      </span>
    </button>
  );
}
