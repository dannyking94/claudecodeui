export type GpuSample = {
  index: number;
  name: string;
  utilization: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  temperatureC: number | null;
  powerDrawW: number | null;
  powerLimitW: number | null;
};

/**
 * One configured remote host's reading, carried by every sample.
 *
 * The server polls remote hosts independently of its 1 Hz local tick, so a
 * frame repeats the last cached reading. `online` is false when that reading is
 * missing or too old to be current: the metrics are then null and `error` says
 * why, rather than the panel drawing stale numbers as if they were live.
 */
export type RemoteHostSample = {
  id: string;
  label: string;
  online: boolean;
  timestamp: number;
  cpuUtilization: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  gpus: GpuSample[];
  error: string | null;
};

export type SystemStatsSample = {
  timestamp: number;
  cpuUtilization: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  gpus: GpuSample[];
  /** Absent from servers predating remote monitoring, and empty when none are configured. */
  remotes?: RemoteHostSample[];
};

export type SystemStatsFrame = {
  kind: 'system_stats';
  gpuAvailable: boolean;
  /** Set when the deployment does not expose host telemetry (platform mode). */
  disabled?: boolean;
  samples: SystemStatsSample[];
};
