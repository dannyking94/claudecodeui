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

export type SystemStatsSample = {
  timestamp: number;
  cpuUtilization: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  gpus: GpuSample[];
};

export type SystemStatsFrame = {
  kind: 'system_stats';
  gpuAvailable: boolean;
  /** Set when the deployment does not expose host telemetry (platform mode). */
  disabled?: boolean;
  samples: SystemStatsSample[];
};
