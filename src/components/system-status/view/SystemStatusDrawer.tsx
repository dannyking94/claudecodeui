import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useSystemStats } from '../hooks/useSystemStats';
import {
  formatGigabytesFromBytes,
  movingAverage,
  toPercentage,
} from '../utils/utils';

import GpuCard from './subcomponents/GpuCard';
import MetricMeter from './subcomponents/MetricMeter';
import TimeSeriesMetric from './subcomponents/TimeSeriesMetric';

type SystemStatusDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  isMobile: boolean;
};

export default function SystemStatusDrawer({ isOpen, onClose, isMobile }: SystemStatusDrawerProps) {
  const { t } = useTranslation();
  const { samples, latest, gpuAvailable, support } = useSystemStats(isOpen);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  const cpuHistory = samples.map((sample) => ({
    timestamp: sample.timestamp,
    value: sample.cpuUtilization,
  }));
  const smoothedCpu = movingAverage(cpuHistory.map((point) => point.value));
  const memoryPercentage = latest
    ? toPercentage(latest.memoryUsedBytes, latest.memoryTotalBytes)
    : 0;

  const body = (
    <>
      <header className="flex flex-shrink-0 items-center justify-between border-b border-border/60 px-4 py-2.5">
        <h2 className="text-sm font-medium text-foreground">{t('systemStatus.title')}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('systemStatus.close')}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {support === 'unsupported' ? (
          <p className="text-xs text-muted-foreground">{t('systemStatus.serverOutdated')}</p>
        ) : support === 'disabled' ? (
          <p className="text-xs text-muted-foreground">{t('systemStatus.unavailable')}</p>
        ) : (
          <>
            {gpuAvailable && latest
              ? latest.gpus.map((gpu) => (
                  <GpuCard
                    key={gpu.index}
                    gpu={gpu}
                    // Each GPU's line is built by index across the sample
                    // window, so a card only ever plots its own history.
                    history={samples
                      .map((sample) => {
                        const entry = sample.gpus.find((candidate) => candidate.index === gpu.index);
                        return entry
                          ? { timestamp: sample.timestamp, value: entry.utilization }
                          : null;
                      })
                      .filter((point): point is NonNullable<typeof point> => point !== null)}
                    t={t}
                  />
                ))
              : latest && <p className="text-xs text-muted-foreground">{t('systemStatus.noGpu')}</p>}

            {latest && <div className="h-px bg-border/60" />}

            {latest ? (
              <section className="space-y-3">
                <TimeSeriesMetric
                  label={t('systemStatus.cpu')}
                  value={`${smoothedCpu ?? 0}%`}
                  history={cpuHistory}
                  t={t}
                />

                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs text-muted-foreground">{t('systemStatus.memory')}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {t('systemStatus.gigabytesOfTotal', {
                        used: formatGigabytesFromBytes(latest.memoryUsedBytes),
                        total: formatGigabytesFromBytes(latest.memoryTotalBytes),
                      })}
                    </span>
                  </div>
                  <MetricMeter percentage={memoryPercentage} />
                </div>
              </section>
            ) : (
              <p className="text-xs text-muted-foreground">{t('systemStatus.waiting')}</p>
            )}
          </>
        )}
      </div>
    </>
  );

  if (isMobile) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col">
        <button
          type="button"
          aria-label={t('systemStatus.close')}
          onClick={onClose}
          className="absolute inset-0 bg-background/70 backdrop-blur-sm"
        />
        <div className="relative mt-auto flex max-h-[80vh] flex-col rounded-t-2xl border-t border-border bg-background pb-[env(safe-area-inset-bottom,0)] shadow-lg">
          {body}
        </div>
      </div>
    );
  }

  return (
    <aside className="flex w-80 flex-shrink-0 flex-col border-l border-border/60 bg-background">
      {body}
    </aside>
  );
}
