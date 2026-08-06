import type { TFunction } from 'i18next';

import type { GpuSample } from '../../types/types';
import {
  formatGigabytesFromMib,
  movingAverage,
  toPercentage,
} from '../../utils/utils';

import MetricMeter from './MetricMeter';
import type { SparklinePoint } from './Sparkline';
import TimeSeriesMetric from './TimeSeriesMetric';

type GpuCardProps = {
  gpu: GpuSample;
  /** Timestamped utilization history for this GPU, oldest first. */
  history: SparklinePoint[];
  t: TFunction;
};

export default function GpuCard({ gpu, history, t }: GpuCardProps) {
  const smoothedUtilization =
    movingAverage(history.map((point) => point.value)) ?? Math.round(gpu.utilization);
  const memoryPercentage = toPercentage(gpu.memoryUsedMb, gpu.memoryTotalMb);

  return (
    <section className="space-y-3">
      <h3 className="truncate text-xs font-medium text-foreground" title={gpu.name}>
        {gpu.name}
      </h3>

      <TimeSeriesMetric
        label={t('systemStatus.gpu')}
        value={`${smoothedUtilization}%`}
        history={history}
        t={t}
      />

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">{t('systemStatus.vram')}</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {t('systemStatus.gigabytesOfTotal', {
              used: formatGigabytesFromMib(gpu.memoryUsedMb),
              total: formatGigabytesFromMib(gpu.memoryTotalMb),
            })}
          </span>
        </div>
        <MetricMeter percentage={memoryPercentage} />
      </div>

      {(gpu.temperatureC !== null || gpu.powerDrawW !== null) && (
        <div className="flex gap-3 text-[11px] tabular-nums text-muted-foreground">
          {gpu.temperatureC !== null && <span>{Math.round(gpu.temperatureC)} °C</span>}
          {gpu.temperatureC !== null && gpu.powerDrawW !== null && (
            <span className="text-muted-foreground/40">·</span>
          )}
          {gpu.powerDrawW !== null && (
            <span>
              {gpu.powerLimitW !== null
                ? t('systemStatus.wattsOfLimit', {
                    draw: Math.round(gpu.powerDrawW),
                    limit: Math.round(gpu.powerLimitW),
                  })
                : t('systemStatus.watts', { draw: Math.round(gpu.powerDrawW) })}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
