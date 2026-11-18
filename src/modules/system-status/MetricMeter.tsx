type MetricMeterProps = {
  /** 0–100. */
  percentage: number;
};

/**
 * Flat capacity bar for values that are a fraction of a fixed total (memory),
 * where the current level matters more than how it got there.
 *
 * Deliberately untransitioned: at a one-second cadence any easing longer than
 * the update period leaves the bar permanently mid-animation, which reads as
 * lag rather than motion.
 */
export default function MetricMeter({ percentage }: MetricMeterProps) {
  const clamped = Math.min(100, Math.max(0, percentage));

  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-primary/60" style={{ width: `${clamped}%` }} />
    </div>
  );
}
