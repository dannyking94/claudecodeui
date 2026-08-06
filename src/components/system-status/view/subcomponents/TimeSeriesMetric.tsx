import type { TFunction } from 'i18next';

import Sparkline, { type SparklinePoint } from './Sparkline';

type TimeSeriesMetricProps = {
  label: string;
  /** Formatted headline reading, e.g. `47%`. */
  value: string;
  /** Timestamped percentages over the window, oldest first. */
  history: SparklinePoint[];
  t: TFunction;
};

/**
 * A labelled 60-second utilization plot.
 *
 * The plot area is tinted because the y-axis is pinned to 0–100: on an idle
 * machine the line sits at the very bottom, and without a visible frame the
 * empty space above reads as a rendering gap rather than as headroom.
 */
export default function TimeSeriesMetric({ label, value, history, t }: TimeSeriesMetricProps) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-sm tabular-nums text-foreground">{value}</span>
      </div>

      <div className="mt-1.5 overflow-hidden rounded bg-muted/40">
        <Sparkline points={history} className="h-12 w-full text-primary" />
      </div>

      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground/60">
        <span>{t('systemStatus.windowStart')}</span>
        <span>{t('systemStatus.windowEnd')}</span>
      </div>
    </div>
  );
}
