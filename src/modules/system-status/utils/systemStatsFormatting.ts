const BYTES_PER_GIB = 1024 ** 3;
const MIB_PER_GIB = 1024;

/** Renders a byte count as gigabytes, e.g. `8.2`. */
export function formatGigabytesFromBytes(bytes: number): string {
  return (bytes / BYTES_PER_GIB).toFixed(1);
}

/** Renders an nvidia-smi mebibyte count as gigabytes, e.g. `1.4`. */
export function formatGigabytesFromMib(mebibytes: number): string {
  return (mebibytes / MIB_PER_GIB).toFixed(1);
}

/** Percentage of `total`, clamped to 0–100 and safe against a zero total. */
export function toPercentage(used: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/**
 * Smooths the instantaneous utilization readings used for the headline number.
 *
 * GPU and CPU utilization are point samples, so at 1 Hz the raw value jitters
 * by tens of percent between frames and is unreadable. The plotted line keeps
 * the raw samples — only the number people try to read is averaged.
 */
export function movingAverage(values: number[], window = 3): number | null {
  if (values.length === 0) {
    return null;
  }

  const recent = values.slice(-window);
  const sum = recent.reduce((total, value) => total + value, 0);
  return Math.round(sum / recent.length);
}
