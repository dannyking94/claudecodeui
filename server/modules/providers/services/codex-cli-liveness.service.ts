/**
 * Finds Codex CLI processes that are still alive and the codex threads they
 * hold, so a codex worker running outside CloudCLI (a secretary's
 * `codex exec` in tmux) lights its sidebar row the way a claude worker does.
 *
 * Codex keeps no registry of running sessions like claude's
 * `~/.claude/sessions/<pid>.json`. What a live codex process does keep is its
 * rollout file open for writing for as long as it runs:
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread id>.jsonl`. So the
 * thread id is read off `/proc/<pid>/fd`, and the process exiting is what
 * makes it disappear — there is no stale file to outlive a crash.
 *
 * Linux only (procfs); elsewhere nothing is reported and rows behave as before.
 *
 * Cost: the running-sessions endpoint is polled every 5 s per open tab. One
 * scan is shared by every caller within `MIN_SCAN_INTERVAL_MS`, and a pid
 * already known not to be codex is not re-read until `NOT_CODEX_RECHECK_MS`
 * has passed (a process can exec into codex later, e.g. bwrap's child), so a
 * steady-state scan is one `readdir /proc` plus a few reads per codex process.
 */

import fsp from 'node:fs/promises';

/**
 * One live codex thread. Same shape as a live claude CLI session, so the
 * sessions service treats both alike: `providerSessionId` is the codex thread
 * id, `isBusy` is true for `codex exec` (it runs its task the whole time it is
 * alive, and returns when done) and false for the interactive TUI, which may
 * be sitting at its prompt.
 */
type LiveCodexCliSession = {
  providerSessionId: string;
  startedAt: number;
  isBusy: boolean;
};

type ProcScanDependencies = {
  procRoot: string;
  now: () => number;
  platform: NodeJS.Platform;
};

/** Callers within this window share one scan. */
const MIN_SCAN_INTERVAL_MS = 2_000;

/** How long a pid classified as "not codex" is trusted before it is re-read. */
const NOT_CODEX_RECHECK_MS = 30_000;

/** Upper bound on fds inspected per codex process. */
const MAX_FDS_PER_PROCESS = 1_024;

/** Linux's USER_HZ, the unit of `/proc/<pid>/stat` starttime; 100 on every mainstream build. */
const CLOCK_TICKS_PER_SECOND = 100;

const ROLLOUT_PATTERN =
  /\/rollout-[^/]*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Codex subcommands that are not a conversation of their own (servers, auth, tooling). */
const NON_CONVERSATION_SUBCOMMANDS = new Set([
  'app-server', 'mcp-server', 'mcp', 'login', 'logout', 'completion', 'debug', 'apply', 'a',
  'cloud', 'sandbox', 'proto', 'features', 'help',
]);

/** `/proc/<pid>/stat` → command name and starttime (clock ticks since boot), or null. */
function parseStat(stat: string): { comm: string; startTicks: string } | null {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 0 || close < open) {
    return null;
  }
  // starttime is field 22 overall, the 20th after the parenthesised comm.
  const fields = stat.slice(close + 2).split(' ');
  return { comm: stat.slice(open + 1, close), startTicks: fields[19] ?? '' };
}

/**
 * What a codex process is, from its argv: `exec` (busy for its whole life),
 * the interactive TUI (open, maybe idle), or something that holds no
 * conversation of its own (null). The prompt is a single argv element, so a
 * whole-token match on a subcommand name cannot come from prompt text.
 */
function classifyCodexArgv(argv: string[]): 'exec' | 'tui' | null {
  const args = argv.slice(1);
  if (args.includes('exec') || args.includes('e')) {
    return 'exec';
  }
  if (args.some((arg) => NON_CONVERSATION_SUBCOMMANDS.has(arg))) {
    return null;
  }
  return 'tui';
}

/** Creates a scanner. Exported for this module's tests, which point it at a fake procfs. */
export function createCodexCliLivenessScanner(overrides: Partial<ProcScanDependencies> = {}) {
  const deps: ProcScanDependencies = {
    procRoot: '/proc',
    now: () => Date.now(),
    platform: process.platform,
    ...overrides,
  };

  /** pid → when it was last found not to be a codex conversation process. */
  const notCodexSince = new Map<string, number>();
  let bootTimeMs: number | null = null;
  let lastScan: { at: number; result: Promise<LiveCodexCliSession[]> } | null = null;

  async function readBootTimeMs(): Promise<number> {
    if (bootTimeMs !== null) {
      return bootTimeMs;
    }
    try {
      const stat = await fsp.readFile(`${deps.procRoot}/stat`, 'utf8');
      const match = /^btime (\d+)$/m.exec(stat);
      bootTimeMs = match ? Number(match[1]) * 1000 : 0;
    } catch {
      bootTimeMs = 0;
    }
    return bootTimeMs;
  }

  /** The codex threads `pid` holds, or null when it is not a codex conversation process. */
  async function inspectProcess(pid: string): Promise<LiveCodexCliSession[] | null> {
    const base = `${deps.procRoot}/${pid}`;
    let parsed: ReturnType<typeof parseStat>;
    try {
      parsed = parseStat(await fsp.readFile(`${base}/stat`, 'utf8'));
    } catch {
      return null;
    }
    // The native binary is named `codex`; the npm `codex.js` launcher is
    // `node`, and holds no rollout itself.
    if (!parsed || parsed.comm !== 'codex') {
      return null;
    }

    let kind: ReturnType<typeof classifyCodexArgv>;
    try {
      kind = classifyCodexArgv((await fsp.readFile(`${base}/cmdline`, 'utf8')).split('\0').filter(Boolean));
    } catch {
      return null;
    }
    if (!kind) {
      return null;
    }

    let fds: string[];
    try {
      fds = (await fsp.readdir(`${base}/fd`)).slice(0, MAX_FDS_PER_PROCESS);
    } catch {
      // Another user's process: its fds are not readable, and not ours to show.
      return null;
    }
    const links = await Promise.all(fds.map((fd) => fsp.readlink(`${base}/fd/${fd}`).catch(() => '')));
    const threadIds = new Set<string>();
    for (const link of links) {
      const match = ROLLOUT_PATTERN.exec(link);
      if (match) {
        threadIds.add(match[1].toLowerCase());
      }
    }

    const startedAt = (await readBootTimeMs()) + (Number(parsed.startTicks) * 1000) / CLOCK_TICKS_PER_SECOND;
    // A codex that has not opened its rollout yet is still a codex: an empty
    // list keeps it out of the not-codex cache so the next scan looks again.
    return [...threadIds].map((providerSessionId) => ({
      providerSessionId,
      startedAt: Number.isFinite(startedAt) && startedAt > 0 ? startedAt : deps.now(),
      isBusy: kind === 'exec',
    }));
  }

  async function scan(): Promise<LiveCodexCliSession[]> {
    let pids: string[];
    try {
      pids = (await fsp.readdir(deps.procRoot)).filter((entry) => /^\d+$/.test(entry));
    } catch {
      return [];
    }
    const now = deps.now();
    const present = new Set(pids);
    for (const pid of notCodexSince.keys()) {
      if (!present.has(pid)) {
        notCodexSince.delete(pid);
      }
    }

    const toInspect = pids.filter((pid) => {
      const since = notCodexSince.get(pid);
      return since === undefined || now - since >= NOT_CODEX_RECHECK_MS;
    });
    const results = await Promise.all(toInspect.map(async (pid) => [pid, await inspectProcess(pid)] as const));

    const byThread = new Map<string, LiveCodexCliSession>();
    for (const [pid, sessions] of results) {
      if (sessions === null) {
        notCodexSince.set(pid, now);
        continue;
      }
      notCodexSince.delete(pid);
      for (const session of sessions) {
        const existing = byThread.get(session.providerSessionId);
        // Two processes on one thread (a resume racing its predecessor): busy wins.
        if (!existing || (session.isBusy && !existing.isBusy)) {
          byThread.set(session.providerSessionId, session);
        }
      }
    }
    return [...byThread.values()];
  }

  return {
    /**
     * Every codex thread held open by a live codex process. Never throws;
     * recomputed at most every `MIN_SCAN_INTERVAL_MS`, shared by callers.
     */
    async listLiveSessions(): Promise<LiveCodexCliSession[]> {
      if (deps.platform !== 'linux') {
        return [];
      }
      const now = deps.now();
      if (lastScan && now - lastScan.at < MIN_SCAN_INTERVAL_MS) {
        return lastScan.result;
      }
      const result = scan().catch(() => []);
      lastScan = { at: now, result };
      return result;
    },
  };
}

/**
 * The process-wide scanner. Used by the providers module's sessions service
 * alongside `listLiveClaudeCliSessions`: the running-sessions poll reports the
 * busy threads as running and the idle ones as "process open", so a codex
 * worker's row shows live — and is never folded away — exactly while its
 * process runs. An object so tests can swap `listLiveSessions`.
 */
export const codexCliLiveness = createCodexCliLivenessScanner();
