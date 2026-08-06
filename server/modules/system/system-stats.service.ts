import os from 'node:os';

import spawn from 'cross-spawn';

import { WS_OPEN_STATE } from '@/modules/websocket/index.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

/** How often a sample is taken while at least one client is watching. */
const SAMPLE_INTERVAL_MS = 1_000;
/** Samples retained for the 60-second sparkline window. */
const HISTORY_LENGTH = 60;
/**
 * A reconnecting client gets the retained history only while it still covers
 * the window it is about to draw. Older buffers would render as a flat line
 * glued to a live one, which reads as real data but is not.
 */
const HISTORY_MAX_AGE_MS = 60_000;
/** A wedged driver must not accumulate child processes across ticks. */
const NVIDIA_SMI_TIMEOUT_MS = 2_000;

const NVIDIA_SMI_FIELDS = [
  'index',
  'name',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'temperature.gpu',
  'power.draw',
  'power.limit',
] as const;

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

type CpuTimesSnapshot = {
  idle: number;
  total: number;
};

const subscribers = new Set<RealtimeClientConnection>();
const history: SystemStatsSample[] = [];

let pollTimer: NodeJS.Timeout | null = null;
let sampleInFlight = false;
/**
 * Incremented whenever polling stops. A sample already awaiting `nvidia-smi`
 * when that happens would otherwise land in the buffer afterwards, recording a
 * reading from after collection was supposed to have ceased.
 */
let pollGeneration = 0;
let previousCpuTimes: CpuTimesSnapshot | null = null;
/**
 * Tri-state on purpose: `null` means "not probed yet". Once nvidia-smi is
 * known to be missing we stop spawning it entirely rather than paying a failed
 * process launch every second on machines without an NVIDIA GPU.
 */
let gpuAvailable: boolean | null = null;

function readCpuTimes(): CpuTimesSnapshot {
  let idle = 0;
  let total = 0;

  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }

  return { idle, total };
}

/**
 * CPU load as a percentage of the interval since the previous sample.
 *
 * `os.cpus()` reports cumulative counters, so a single reading says nothing
 * about current load — only the delta between two readings does. The first
 * sample after a subscribe therefore has no baseline and reports 0.
 */
function readCpuUtilization(): number {
  const current = readCpuTimes();
  const previous = previousCpuTimes;
  previousCpuTimes = current;

  if (!previous) {
    return 0;
  }

  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;

  if (totalDelta <= 0) {
    return 0;
  }

  const utilization = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.min(100, Math.max(0, Math.round(utilization)));
}

/** Parses one nvidia-smi CSV field, mapping `[N/A]` and junk to null. */
function parseNumericField(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }

  const value = Number.parseFloat(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/** Turns `--format=csv,noheader,nounits` output into one sample per GPU. */
export function parseNvidiaSmiOutput(output: string): GpuSample[] {
  const gpus: GpuSample[] = [];

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const columns = trimmed.split(',');
    if (columns.length < NVIDIA_SMI_FIELDS.length) {
      continue;
    }

    const index = parseNumericField(columns[0]);
    const utilization = parseNumericField(columns[2]);
    const memoryUsedMb = parseNumericField(columns[3]);
    const memoryTotalMb = parseNumericField(columns[4]);

    // Index, utilization and memory drive the whole panel; a row missing any of
    // them cannot be rendered meaningfully, so it is dropped rather than shown
    // as zeroes. Temperature and power are optional and may legitimately be N/A.
    if (index === null || utilization === null || memoryUsedMb === null || memoryTotalMb === null) {
      continue;
    }

    gpus.push({
      index,
      name: columns[1].trim(),
      utilization,
      memoryUsedMb,
      memoryTotalMb,
      temperatureC: parseNumericField(columns[5]),
      powerDrawW: parseNumericField(columns[6]),
      powerLimitW: parseNumericField(columns[7]),
    });
  }

  return gpus;
}

/**
 * Runs one nvidia-smi query, resolving to null when the tool is absent, fails,
 * or does not answer within the timeout.
 */
function queryGpus(): Promise<GpuSample[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';

    const finish = (result: GpuSample[] | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    const child = spawn('nvidia-smi', [
      `--query-gpu=${NVIDIA_SMI_FIELDS.join(',')}`,
      '--format=csv,noheader,nounits',
    ]);

    const timeoutHandle = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, NVIDIA_SMI_TIMEOUT_MS);

    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    // ENOENT on machines without the driver installed. Not an error worth
    // logging every second — the caller disables GPU sampling after the first.
    child.once('error', () => finish(null));

    child.once('close', (exitCode) => {
      if (exitCode !== 0) {
        finish(null);
        return;
      }
      finish(parseNvidiaSmiOutput(output));
    });
  });
}

async function collectSample(): Promise<SystemStatsSample> {
  const totalMemory = os.totalmem();
  const gpus = gpuAvailable === false ? null : await queryGpus();

  if (gpuAvailable === null) {
    gpuAvailable = gpus !== null && gpus.length > 0;
    if (!gpuAvailable) {
      console.log('[INFO] System stats: no NVIDIA GPU detected, reporting CPU and memory only');
    }
  }

  return {
    timestamp: Date.now(),
    cpuUtilization: readCpuUtilization(),
    memoryUsedBytes: totalMemory - os.freemem(),
    memoryTotalBytes: totalMemory,
    gpus: gpus ?? [],
  };
}

function buildFrame(samples: SystemStatsSample[]): string {
  return JSON.stringify({
    kind: 'system_stats',
    gpuAvailable: gpuAvailable === true,
    samples,
  });
}

function send(client: RealtimeClientConnection, frame: string): void {
  if (client.readyState === WS_OPEN_STATE) {
    client.send(frame);
  }
}

function broadcast(sample: SystemStatsSample): void {
  // Collection continues regardless of who is watching, but frames are only
  // pushed to clients with the panel open — a closed panel cannot use them.
  if (subscribers.size === 0) {
    return;
  }

  const frame = buildFrame([sample]);

  for (const client of subscribers) {
    if (client.readyState !== WS_OPEN_STATE) {
      subscribers.delete(client);
      continue;
    }
    send(client, frame);
  }
}

async function tick(): Promise<void> {
  // Skip rather than queue: a slow nvidia-smi must not build a backlog of
  // overlapping child processes.
  if (sampleInFlight) {
    return;
  }

  sampleInFlight = true;
  const generation = pollGeneration;
  try {
    const sample = await collectSample();

    // Polling stopped while this sample was being taken — discard it.
    if (generation !== pollGeneration) {
      return;
    }

    history.push(sample);
    if (history.length > HISTORY_LENGTH) {
      history.splice(0, history.length - HISTORY_LENGTH);
    }

    broadcast(sample);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ERROR] System stats sampling failed:', message);
  } finally {
    sampleInFlight = false;
  }
}

function startPolling(): void {
  if (pollTimer) {
    return;
  }

  // The cumulative CPU counters carry no meaning across an idle gap, so the
  // baseline is rebuilt from the first tick of each polling run.
  previousCpuTimes = null;
  pollTimer = setInterval(() => {
    void tick();
  }, SAMPLE_INTERVAL_MS);
  // Sampling must never be the reason the process stays alive.
  pollTimer.unref?.();

  void tick();
}

function stopPolling(): void {
  if (!pollTimer) {
    return;
  }

  clearInterval(pollTimer);
  pollTimer = null;
  pollGeneration += 1;
}

/** History still recent enough to prefill a client's 60-second window. */
function freshHistory(): SystemStatsSample[] {
  const newest = history[history.length - 1];
  if (!newest || Date.now() - newest.timestamp > HISTORY_MAX_AGE_MS) {
    return [];
  }
  return history;
}

type SubscribeOptions = {
  /** Injected by the websocket gateway; this module reads no global config. */
  isPlatform: boolean;
};

/**
 * Begins collecting samples because a browser connected.
 *
 * Collection is tied to a client being *connected* rather than to the panel
 * being open, so opening the panel shows a full 60-second window immediately
 * instead of drawing it in from empty. A server nobody is connected to still
 * samples nothing.
 */
export function startSystemStatsCollection(options: SubscribeOptions): void {
  if (options.isPlatform) {
    return;
  }

  startPolling();
}

/**
 * Stops collecting once the last browser disconnects.
 *
 * The count comes from the websocket gateway, which owns the client registry;
 * this module does not reach into it.
 */
export function stopSystemStatsCollectionIfIdle(connectedClientCount: number): void {
  if (connectedClientCount === 0) {
    stopPolling();
  }
}

/**
 * Starts streaming the collected samples to one client at 1 Hz, prefilled with
 * whatever window has already been recorded.
 */
export function subscribeToSystemStats(
  client: RealtimeClientConnection,
  options: SubscribeOptions,
): void {
  // The host machine is shared infrastructure in platform mode and its load is
  // not a tenant's business.
  if (options.isPlatform) {
    send(client, JSON.stringify({ kind: 'system_stats', gpuAvailable: false, disabled: true, samples: [] }));
    return;
  }

  subscribers.add(client);

  const backlog = freshHistory();
  if (backlog.length > 0) {
    send(client, buildFrame(backlog));
  }

  startPolling();
}

/**
 * Stops streaming to one client. Collection keeps running so the window stays
 * populated for the next time the panel is opened.
 */
export function unsubscribeFromSystemStats(client: RealtimeClientConnection): void {
  subscribers.delete(client);
}

/** Test seam: reads the retained window without starting collection. */
export function getRetainedSampleCountForTests(): number {
  return history.length;
}

/** Test seam: clears module state between cases. */
export function resetSystemStatsForTests(): void {
  stopPolling();
  // Also invalidates any sample still in flight from a run that never started
  // a timer (the immediate first tick).
  pollGeneration += 1;
  subscribers.clear();
  history.length = 0;
  previousCpuTimes = null;
  gpuAvailable = null;
  sampleInFlight = false;
}
