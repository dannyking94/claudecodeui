import type { TFunction } from 'i18next';

import type { RemoteHostSample, SystemStatsSample } from '../../types/types';
import { formatGigabytesFromBytes, movingAverage, toPercentage } from '../../utils/utils';

import GpuCard from './GpuCard';
import MetricMeter from './MetricMeter';
import type { SparklinePoint } from './Sparkline';
import TimeSeriesMetric from './TimeSeriesMetric';

type RemoteHostCardProps = {
  /** Newest reading for this host, used for every headline number. */
  host: RemoteHostSample;
  /** The whole sample window, from which this host's own series are derived. */
  samples: SystemStatsSample[];
  t: TFunction;
};

/**
 * Builds one series for a remote host out of the shared sample window.
 *
 * Points are stamped with the *remote* reading's own timestamp, not the frame's:
 * the server polls remote hosts independently of its 1 Hz tick, so the same
 * reading can ride along with more than one frame. Those repeats are dropped
 * here, which keeps the plot showing when the host was actually measured — and
 * lets the sparkline break the line over a stretch it was unreachable.
 */
function buildRemoteSeries(
  samples: SystemStatsSample[],
  hostId: string,
  readValue: (host: RemoteHostSample) => number | null | undefined,
): SparklinePoint[] {
  const series: SparklinePoint[] = [];

  for (const sample of samples) {
    const host = sample.remotes?.find((candidate) => candidate.id === hostId);
    if (!host || !host.online) {
      continue;
    }

    const value = readValue(host);
    if (value === null || value === undefined) {
      continue;
    }

    if (series[series.length - 1]?.timestamp === host.timestamp) {
      continue;
    }

    series.push({ timestamp: host.timestamp, value });
  }

  return series;
}

/** One remote host's panel: the same metrics as the local host, plus its reachability. */
export default function RemoteHostCard({ host, samples, t }: RemoteHostCardProps) {
  const cpuHistory = buildRemoteSeries(samples, host.id, (entry) => entry.cpuUtilization);
  const smoothedCpu = movingAverage(cpuHistory.map((point) => point.value));
  const memoryPercentage =
    host.memoryUsedBytes !== null && host.memoryTotalBytes !== null
      ? toPercentage(host.memoryUsedBytes, host.memoryTotalBytes)
      : 0;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-xs font-medium text-foreground" title={host.label}>
          {host.label}
        </h3>
        <span
          className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
            host.online ? 'bg-emerald-500' : 'bg-muted-foreground/40'
          }`}
          aria-hidden="true"
        />
      </div>

      {!host.online ? (
        <p className="text-xs text-muted-foreground" title={host.error ?? undefined}>
          {t('systemStatus.unreachable')}
        </p>
      ) : (
        <>
          {host.gpus.length > 0 ? (
            host.gpus.map((gpu) => (
              <GpuCard
                key={gpu.index}
                gpu={gpu}
                history={buildRemoteSeries(
                  samples,
                  host.id,
                  (entry) => entry.gpus.find((candidate) => candidate.index === gpu.index)?.utilization,
                )}
                t={t}
              />
            ))
          ) : (
            <p className="text-xs text-muted-foreground">{t('systemStatus.noGpu')}</p>
          )}

          <TimeSeriesMetric
            label={t('systemStatus.cpu')}
            value={`${smoothedCpu ?? 0}%`}
            history={cpuHistory}
            t={t}
          />

          {host.memoryUsedBytes !== null && host.memoryTotalBytes !== null && (
            <div className="space-y-1.5">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-muted-foreground">{t('systemStatus.memory')}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t('systemStatus.gigabytesOfTotal', {
                    used: formatGigabytesFromBytes(host.memoryUsedBytes),
                    total: formatGigabytesFromBytes(host.memoryTotalBytes),
                  })}
                </span>
              </div>
              <MetricMeter percentage={memoryPercentage} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
