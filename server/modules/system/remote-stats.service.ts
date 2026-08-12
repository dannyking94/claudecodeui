import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { GpuSample, RemoteHostSample } from '@/shared/types.js';
import { NVIDIA_SMI_QUERY_ARGUMENTS, parseNvidiaSmiOutput } from '@/shared/utils.js';

/** Environment variable holding the hosts to sample; empty means the feature is off. */
const REMOTE_HOSTS_ENVIRONMENT_VARIABLE = 'CLOUDCLI_REMOTE_HOSTS';
/** Seconds `ssh` waits for the TCP connect before giving up on an unreachable host. */
const SSH_CONNECT_TIMEOUT_SECONDS = 5;
/** Hard ceiling on one sample, covering a connection that opens but then stalls. */
const SSH_COMMAND_TIMEOUT_MS = 8_000;
/** How long the multiplexed SSH connection is kept open between samples. */
const SSH_CONTROL_PERSIST_SECONDS = 60;
/**
 * A reading older than this is not presented as current. Remote polling is
 * decoupled from the 1 Hz local tick, so without this a host that stopped
 * answering would keep re-broadcasting its last numbers as a live flat line.
 */
const SAMPLE_MAX_AGE_MS = 5_000;
/** Backoff step after each consecutive failure, so a down host is not hammered. */
const RETRY_BACKOFF_STEP_MS = 5_000;
const RETRY_BACKOFF_CEILING_MS = 30_000;
/** Truncation for a remote error surfaced in the UI. */
const ERROR_MESSAGE_MAX_LENGTH = 120;

/** Delimiters separating the sections of one remote sampling command's output. */
const CPU_SECTION_MARKER = '@@cloudcli-cpu@@';
const MEMORY_SECTION_MARKER = '@@cloudcli-mem@@';

type RemoteHostConfig = {
  /** Stable across restarts: the client matches hosts across samples by this. */
  id: string;
  label: string;
  sshTarget: string;
  port: number | null;
};

type CpuTimesSnapshot = {
  idle: number;
  total: number;
  timestamp: number;
};

type RemoteHostState = {
  config: RemoteHostConfig;
  /** Last successful reading, kept until it ages past `SAMPLE_MAX_AGE_MS`. */
  latest: RemoteHostSample | null;
  previousCpuTimes: CpuTimesSnapshot | null;
  sampleInFlight: boolean;
  /** Epoch milliseconds; a failed host is not retried before this. */
  nextAttemptAt: number;
  consecutiveFailures: number;
  lastError: string | null;
  /** Drives the one-line log written only when reachability actually changes. */
  wasOnline: boolean | null;
};

let hostStates: RemoteHostState[] | null = null;
/**
 * Incremented when collection stops, so a sample still awaiting SSH cannot
 * write a reading into the cache after collection was supposed to have ceased.
 */
let pollGeneration = 0;

/**
 * Parses the `CLOUDCLI_REMOTE_HOSTS` value into host configurations.
 *
 * Format is a comma-separated list of `Label=[user@]host[:port]` entries, with
 * the label optional (`dk@192.168.0.100` alone labels itself). `host` may be an
 * `~/.ssh/config` alias, which is the intended way to express a non-default
 * key, jump host or user. A `:port` suffix is recognized only when everything
 * after the last colon is digits, so IPv6 literals are left untouched.
 *
 * Exported for the module's tests; the collector is otherwise self-configuring.
 */
export function parseRemoteHostSpecs(raw: string | undefined): RemoteHostConfig[] {
  if (!raw) {
    return [];
  }

  const configs: RemoteHostConfig[] = [];
  const seenIds = new Set<string>();

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    const label = separatorIndex === -1 ? '' : trimmed.slice(0, separatorIndex).trim();
    const target = (separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1)).trim();
    if (target.length === 0) {
      continue;
    }

    const portMatch = /^(.*):(\d+)$/.exec(target);
    const sshTarget = portMatch ? portMatch[1] : target;
    const port = portMatch ? Number.parseInt(portMatch[2], 10) : null;
    if (sshTarget.length === 0) {
      continue;
    }

    const id = port === null ? sshTarget : `${sshTarget}:${port}`;
    // A repeated target would render as two identical cards fed by one poller.
    if (seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);

    configs.push({
      id,
      label: label.length > 0 ? label : sshTarget,
      sshTarget,
      port,
    });
  }

  return configs;
}

/**
 * Utilization from two `/proc/stat` readings, as a percentage of the interval.
 *
 * The counters are cumulative, so a single reading says nothing about current
 * load. `idle` here includes iowait, matching what `top` reports as idle.
 */
function parseCpuTimes(line: string, timestamp: number): CpuTimesSnapshot | null {
  const fields = line.trim().split(/\s+/);
  if (fields[0] !== 'cpu' || fields.length < 5) {
    return null;
  }

  let total = 0;
  for (const field of fields.slice(1)) {
    const value = Number.parseInt(field, 10);
    if (!Number.isFinite(value)) {
      return null;
    }
    total += value;
  }

  const idle = Number.parseInt(fields[4], 10) + Number.parseInt(fields[5] ?? '0', 10);
  return { idle, total, timestamp };
}

/**
 * Used and total bytes from `/proc/meminfo`'s `MemTotal` and `MemFree`.
 *
 * `MemFree` rather than `MemAvailable` on purpose: the local card reports
 * `os.totalmem() - os.freemem()`, which also counts page cache as used. Two
 * cards side by side have to mean the same thing.
 */
function parseMemoryInfo(section: string): { usedBytes: number; totalBytes: number } | null {
  let totalKb: number | null = null;
  let freeKb: number | null = null;

  for (const line of section.split('\n')) {
    const match = /^(MemTotal|MemFree):\s+(\d+)\s*kB/.exec(line.trim());
    if (!match) {
      continue;
    }
    if (match[1] === 'MemTotal') {
      totalKb = Number.parseInt(match[2], 10);
    } else {
      freeKb = Number.parseInt(match[2], 10);
    }
  }

  if (totalKb === null || freeKb === null || totalKb <= 0) {
    return null;
  }

  return { usedBytes: (totalKb - freeKb) * 1024, totalBytes: totalKb * 1024 };
}

type RemoteReading = {
  gpus: GpuSample[];
  cpuTimes: CpuTimesSnapshot | null;
  memory: { usedBytes: number; totalBytes: number } | null;
};

/**
 * Splits one sampling command's stdout into its GPU, CPU and memory sections.
 *
 * Exported for the module's tests, which cover the section markers and the
 * degraded case of a host without `nvidia-smi` installed.
 */
export function parseRemoteSampleOutput(output: string, timestamp: number): RemoteReading {
  const cpuIndex = output.indexOf(CPU_SECTION_MARKER);
  const memoryIndex = output.indexOf(MEMORY_SECTION_MARKER);

  // Missing markers mean the command did not run to completion (a shell that
  // died mid-way, say). Whatever arrived is not a usable sample.
  if (cpuIndex === -1 || memoryIndex === -1 || memoryIndex < cpuIndex) {
    return { gpus: [], cpuTimes: null, memory: null };
  }

  const gpuSection = output.slice(0, cpuIndex);
  const cpuSection = output.slice(cpuIndex + CPU_SECTION_MARKER.length, memoryIndex);
  const memorySection = output.slice(memoryIndex + MEMORY_SECTION_MARKER.length);

  return {
    gpus: parseNvidiaSmiOutput(gpuSection),
    cpuTimes: parseCpuTimes(cpuSection.trim().split('\n')[0] ?? '', timestamp),
    memory: parseMemoryInfo(memorySection),
  };
}

/**
 * The command run on the remote host.
 *
 * One SSH round trip collects everything: `nvidia-smi` failures are swallowed
 * so a host without a GPU still reports CPU and memory, and the markers let the
 * reply be split without depending on line counts, which vary with GPU count.
 */
function buildRemoteCommand(): string {
  return [
    `nvidia-smi ${NVIDIA_SMI_QUERY_ARGUMENTS.join(' ')} 2>/dev/null;`,
    `echo '${CPU_SECTION_MARKER}';`,
    'head -n 1 /proc/stat;',
    `echo '${MEMORY_SECTION_MARKER}';`,
    "grep -E '^(MemTotal|MemFree):' /proc/meminfo",
  ].join(' ');
}

/**
 * Socket for SSH connection multiplexing.
 *
 * Without it every sample pays a full TCP and key exchange, once per second per
 * host. `%C` is a hash of the connection parameters, which keeps the path well
 * inside the ~108-byte limit on unix socket paths; the uid keeps hosts sampled
 * by different users on one machine from colliding in a shared temp directory.
 */
function controlSocketPath(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `cloudcli-ssh-${uid}-%C`);
}

function buildSshArguments(config: RemoteHostConfig): string[] {
  return [
    // A password or passphrase prompt would hang the sampler forever, so key
    // based auth is required and anything interactive fails fast instead.
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlSocketPath()}`,
    '-o', `ControlPersist=${SSH_CONTROL_PERSIST_SECONDS}`,
    ...(config.port === null ? [] : ['-p', String(config.port)]),
    config.sshTarget,
    buildRemoteCommand(),
  ];
}

type SshResult = {
  output: string;
  error: string | null;
};

/** Runs one sampling command, resolving with an error string instead of throwing. */
function runSshSample(config: RemoteHostConfig): Promise<SshResult> {
  return new Promise((resolve) => {
    let settled = false;
    let output = '';
    let errorOutput = '';

    const finish = (result: SshResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    const child = spawn('ssh', buildSshArguments(config));

    const timeoutHandle = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ output: '', error: 'Timed out' });
    }, SSH_COMMAND_TIMEOUT_MS);

    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });
    child.stderr?.on('data', (data: Buffer) => {
      errorOutput += data.toString();
    });

    // ENOENT when no ssh client is installed on this machine.
    child.once('error', (error: Error) => finish({ output: '', error: error.message }));

    child.once('close', (exitCode) => {
      if (exitCode !== 0) {
        finish({ output: '', error: summarizeSshError(errorOutput, exitCode) });
        return;
      }
      finish({ output, error: null });
    });
  });
}

/** First meaningful stderr line, trimmed to something a card can display. */
function summarizeSshError(errorOutput: string, exitCode: number | null): string {
  const firstLine = errorOutput
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  const message = firstLine ?? `ssh exited with code ${exitCode ?? 'unknown'}`;
  return message.length > ERROR_MESSAGE_MAX_LENGTH
    ? `${message.slice(0, ERROR_MESSAGE_MAX_LENGTH - 1)}…`
    : message;
}

function offlineSample(state: RemoteHostState, timestamp: number): RemoteHostSample {
  return {
    id: state.config.id,
    label: state.config.label,
    online: false,
    timestamp,
    cpuUtilization: null,
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    gpus: [],
    error: state.lastError,
  };
}

function logReachabilityChange(state: RemoteHostState, isOnline: boolean): void {
  if (state.wasOnline === isOnline) {
    return;
  }
  state.wasOnline = isOnline;

  if (isOnline) {
    console.log(`[INFO] Remote stats: ${state.config.label} is reachable`);
    return;
  }
  console.log(`[WARN] Remote stats: ${state.config.label} is unreachable (${state.lastError ?? 'unknown error'})`);
}

async function sampleHost(state: RemoteHostState): Promise<void> {
  state.sampleInFlight = true;
  const generation = pollGeneration;

  try {
    const result = await runSshSample(state.config);
    // Collection stopped, or the collector was reconfigured, while this sample
    // was in flight — its reading no longer belongs to anything.
    if (generation !== pollGeneration) {
      return;
    }

    const timestamp = Date.now();
    const reading = result.error === null ? parseRemoteSampleOutput(result.output, timestamp) : null;

    // Memory is the one field every Linux host must produce; without it the
    // command answered with something other than a sample.
    if (!reading || !reading.memory) {
      state.consecutiveFailures += 1;
      state.lastError = result.error ?? 'Unexpected response from host';
      state.nextAttemptAt =
        timestamp + Math.min(RETRY_BACKOFF_CEILING_MS, RETRY_BACKOFF_STEP_MS * state.consecutiveFailures);
      state.previousCpuTimes = null;
      logReachabilityChange(state, false);
      return;
    }

    state.consecutiveFailures = 0;
    state.lastError = null;
    state.nextAttemptAt = 0;

    const previousCpuTimes = state.previousCpuTimes;
    state.previousCpuTimes = reading.cpuTimes;

    state.latest = {
      id: state.config.id,
      label: state.config.label,
      online: true,
      timestamp,
      cpuUtilization: calculateCpuUtilization(previousCpuTimes, reading.cpuTimes),
      memoryUsedBytes: reading.memory.usedBytes,
      memoryTotalBytes: reading.memory.totalBytes,
      gpus: reading.gpus,
      error: null,
    };
    logReachabilityChange(state, true);
  } finally {
    state.sampleInFlight = false;
  }
}

/**
 * Load between two `/proc/stat` readings, or null when there is no usable pair.
 *
 * A baseline older than the freshness window spans a gap in which the host was
 * not being watched, so averaging across it would report load that was never
 * observed; such a pair is discarded rather than averaged.
 */
function calculateCpuUtilization(
  previous: CpuTimesSnapshot | null,
  current: CpuTimesSnapshot | null,
): number | null {
  if (!previous || !current || current.timestamp - previous.timestamp > SAMPLE_MAX_AGE_MS) {
    return null;
  }

  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  if (totalDelta <= 0) {
    return null;
  }

  const utilization = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.min(100, Math.max(0, Math.round(utilization)));
}

function getHostStates(): RemoteHostState[] {
  if (!hostStates) {
    hostStates = parseRemoteHostSpecs(process.env[REMOTE_HOSTS_ENVIRONMENT_VARIABLE]).map((config) => ({
      config,
      latest: null,
      previousCpuTimes: null,
      sampleInFlight: false,
      nextAttemptAt: 0,
      consecutiveFailures: 0,
      lastError: null,
      wasOnline: null,
    }));

    if (hostStates.length > 0) {
      console.log(
        `[INFO] Remote stats: monitoring ${hostStates.map((state) => state.config.label).join(', ')}`,
      );
    }
  }

  return hostStates;
}

/**
 * Starts a sample on every host that is due for one.
 *
 * Called from the local 1 Hz tick and deliberately not awaited: a slow or dead
 * remote host must never delay, or skip, the local sample it rides along with.
 * Used by the system stats service.
 */
export function refreshRemoteHostSamples(): void {
  const now = Date.now();

  for (const state of getHostStates()) {
    if (state.sampleInFlight || now < state.nextAttemptAt) {
      continue;
    }

    void sampleHost(state).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ERROR] Remote stats sampling failed for ${state.config.label}:`, message);
    });
  }
}

/**
 * The cached reading for every configured host, newest first collected.
 *
 * Hosts whose reading is missing or stale are reported offline rather than
 * omitted, so a configured host keeps its card and shows why it is not
 * answering. Used by the system stats service to embed remotes in each sample.
 */
export function getRemoteHostSamples(): RemoteHostSample[] {
  const now = Date.now();

  return getHostStates().map((state) => {
    const latest = state.latest;
    if (!latest || now - latest.timestamp > SAMPLE_MAX_AGE_MS) {
      return offlineSample(state, now);
    }
    return latest;
  });
}

/**
 * Drops cached readings and in-flight samples when collection stops.
 *
 * Used by the system stats service so a panel reopened after an idle gap does
 * not start from readings taken before it.
 */
export function stopRemoteStatsCollection(): void {
  pollGeneration += 1;

  for (const state of hostStates ?? []) {
    state.latest = null;
    state.previousCpuTimes = null;
    state.nextAttemptAt = 0;
    state.consecutiveFailures = 0;
    // `sampleInFlight` is deliberately left alone: the in-flight sample clears
    // it itself, and clearing it here would let the next start run a second
    // concurrent SSH command for the same host.
  }
}

/** Test seam: clears module state, including the cached host configuration. */
export function resetRemoteStatsForTests(): void {
  stopRemoteStatsCollection();
  hostStates = null;
}
