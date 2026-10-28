/**
 * Detects a Claude session that is already held by a process this server does
 * not own, so the server never starts a second writer on it.
 *
 * Why this exists: typing into a session row makes the agent pool run
 * `claude --resume <id>`. When a tmux secretary (`claude --session-id <id>`) or
 * a terminal `claude --resume <id>` is already attached, that creates a second
 * process on one transcript — one that sees the whole history, believes it is
 * the original, and has none of its chat tools. Refusing to spawn is the only
 * fix that does not depend on the copy explaining itself.
 *
 * Two sources decide "held":
 * - the live process table (Linux `/proc`), matching the id as the VALUE of
 *   `--session-id` / `--resume` in a claude process's argv;
 * - `~/.config/dk-secretaries/registry.json`, so a registered secretary stays
 *   blocked through its restart window when no process is momentarily attached.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Flags whose value is the session a claude process is attached to. */
const SESSION_FLAGS = ['--session-id', '--resume'];

/** Bounds the best-effort tmux lookup that only decorates the message. */
const TMUX_LOOKUP_TIMEOUT_MS = 1_000;

/** Stops a malformed `/proc` from turning the ancestor walk into a loop. */
const MAX_ANCESTOR_DEPTH = 64;

/**
 * Who holds a session, as reported to the user in the blocked row.
 *
 * `pid` is null only for a registry-only hold (the registered secretary has no
 * process attached right now, e.g. mid-restart).
 */
export type ClaudeSessionHolder = {
  pid: number | null;
  tmuxSession: string | null;
  registryName: string | null;
};

type SessionHoldDependencies = {
  procRoot: string;
  registryPath: string;
  selfPid: number;
  /** Maps each tmux pane's shell pid to its session name. Empty when tmux is absent. */
  listTmuxPanes: () => Promise<Map<number, string>>;
};

const defaultDependencies: SessionHoldDependencies = {
  procRoot: '/proc',
  registryPath: path.join(os.homedir(), '.config', 'dk-secretaries', 'registry.json'),
  selfPid: process.pid,
  listTmuxPanes,
};

function listTmuxPanes(): Promise<Map<number, string>> {
  return new Promise((resolve) => {
    execFile(
      'tmux',
      ['list-panes', '-a', '-F', '#{pane_pid} #{session_name}'],
      { timeout: TMUX_LOOKUP_TIMEOUT_MS },
      (error, stdout) => {
        const panes = new Map<number, string>();
        if (!error) {
          for (const line of String(stdout).split('\n')) {
            const match = /^(\d+) (.+)$/.exec(line.trim());
            if (match) {
              panes.set(Number(match[1]), match[2]);
            }
          }
        }
        resolve(panes);
      },
    );
  });
}

/**
 * The session id an argv is attached to, or null.
 *
 * Matched as the value of a flag, never as a substring: a prompt is part of
 * argv and routinely quotes session ids (a worker's task prompt naming its
 * secretary's id was a live false positive for the idle-cache watchdog). Real
 * argv elements make this exact — a prompt containing "--resume <id>" is one
 * element, not two.
 */
function attachedSessionId(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    for (const flag of SESSION_FLAGS) {
      if (arg === flag && index + 1 < argv.length) {
        return argv[index + 1];
      }
      if (arg.startsWith(`${flag}=`)) {
        return arg.slice(flag.length + 1);
      }
    }
  }
  return null;
}

/**
 * True when argv is a claude process rather than something that merely names
 * one — a tmux server launched as `tmux new-session … claude --session-id <id>`
 * keeps that argv for its whole life, long after the claude in it has exited.
 */
function isClaudeProcess(argv: string[]): boolean {
  const [executable = '', script = ''] = argv;
  const base = path.basename(executable);
  if (base === 'claude' || executable.includes('/claude/versions/')) {
    return true;
  }
  // npm-installed Claude Code runs as `node …/@anthropic-ai/claude-code/cli.js`.
  return (base === 'node' || base === 'bun')
    && (path.basename(script) === 'claude' || script.includes('@anthropic-ai/claude-code/'));
}

/** Driven over stream-json: the shape of an Agent SDK child, ours or another server's. */
function isSdkDriven(argv: string[]): boolean {
  return argv.some((arg, index) =>
    (arg === '--input-format' && argv[index + 1] === 'stream-json') || arg === '--input-format=stream-json');
}

async function readArgv(procRoot: string, pid: number): Promise<string[] | null> {
  try {
    const raw = await readFile(path.join(procRoot, String(pid), 'cmdline'), 'utf8');
    const argv = raw.split('\0');
    if (argv.at(-1) === '') {
      argv.pop();
    }
    return argv.length > 0 ? argv : null;
  } catch {
    // The process exited between readdir and read, or is not ours to read.
    return null;
  }
}

async function readParentPid(procRoot: string, pid: number): Promise<number | null> {
  try {
    const stat = await readFile(path.join(procRoot, String(pid), 'stat'), 'utf8');
    // The command name is parenthesised and may itself contain spaces or ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const parentPid = Number(fields[1]);
    return Number.isInteger(parentPid) ? parentPid : null;
  } catch {
    return null;
  }
}

/** The pid and its ancestors, nearest first, stopping at init. */
async function ancestry(procRoot: string, pid: number): Promise<number[]> {
  const chain = [pid];
  let current = pid;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth += 1) {
    const parent = await readParentPid(procRoot, current);
    if (!parent || parent <= 1 || chain.includes(parent)) {
      break;
    }
    chain.push(parent);
    current = parent;
  }
  return chain;
}

/**
 * The registered secretary name for a session id, or null.
 *
 * A missing or unreadable registry is the ordinary state on most hosts and
 * means "rely on the process check only", never an error.
 */
async function findRegisteredName(registryPath: string, sessionId: string): Promise<string | null> {
  try {
    const registry = JSON.parse(await readFile(registryPath, 'utf8')) as unknown;
    const instances = (registry as { instances?: unknown })?.instances;
    if (!instances || typeof instances !== 'object') {
      return null;
    }
    for (const [name, entry] of Object.entries(instances as Record<string, unknown>)) {
      if ((entry as { session_id?: unknown })?.session_id === sessionId) {
        return name;
      }
    }
  } catch {
    // Absent or malformed.
  }
  return null;
}

async function findForeignProcess(
  sessionId: string,
  dependencies: SessionHoldDependencies,
): Promise<{ pid: number; ancestors: number[] } | null> {
  let entries: string[];
  try {
    entries = await readdir(dependencies.procRoot);
  } catch {
    // No /proc (macOS, Windows): the registry remains the only source.
    return null;
  }

  const pids = entries.filter((entry) => /^\d+$/.test(entry)).map(Number);
  const candidates = await Promise.all(pids.map(async (pid) => {
    const argv = await readArgv(dependencies.procRoot, pid);
    return argv && isClaudeProcess(argv) && attachedSessionId(argv) === sessionId ? { pid, argv } : null;
  }));

  // Report a terminal/tmux claude before another server's SDK copy: when both
  // are attached, the terminal one is the original the user should go to.
  const ordered = candidates
    .filter((candidate) => candidate !== null)
    .sort((left, right) => Number(isSdkDriven(left.argv)) - Number(isSdkDriven(right.argv)));

  for (const candidate of ordered) {
    if (candidate.pid === dependencies.selfPid) {
      continue;
    }
    const ancestors = await ancestry(dependencies.procRoot, candidate.pid);
    // This server's own SDK children (the agent pool, one-shot runs) are the
    // writer it is about to reuse, not a second one. A claude a user started
    // in one of this server's terminals is still foreign: it is not SDK-driven.
    if (ancestors.includes(dependencies.selfPid) && isSdkDriven(candidate.argv)) {
      continue;
    }
    return { pid: candidate.pid, ancestors };
  }
  return null;
}

/**
 * Returns who holds `sessionId` outside this server, or null when it is free.
 *
 * Consumed by the Claude runtime (before the agent pool or a one-shot query
 * resumes a session) and, through the providers barrel, by the shell websocket
 * (before a terminal runs `claude --resume`). Never throws: every probe that
 * fails degrades to "not held by that source".
 */
export async function findClaudeSessionHolder(
  sessionId: string | null | undefined,
  dependencyOverrides: Partial<SessionHoldDependencies> = {},
): Promise<ClaudeSessionHolder | null> {
  if (!sessionId) {
    return null;
  }
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  const [foreign, registryName] = await Promise.all([
    findForeignProcess(sessionId, dependencies),
    findRegisteredName(dependencies.registryPath, sessionId),
  ]);

  if (!foreign && !registryName) {
    return null;
  }

  let tmuxSession: string | null = null;
  if (foreign) {
    try {
      const panes = await dependencies.listTmuxPanes();
      tmuxSession = foreign.ancestors.map((pid) => panes.get(pid)).find(Boolean) ?? null;
    } catch {
      // Decoration only.
    }
  }

  return { pid: foreign?.pid ?? null, tmuxSession, registryName };
}

/**
 * The sentence the blocked row shows. Consumed by the Claude runtime (chat
 * error) and the shell websocket (terminal notice) so both say the same thing.
 */
export function describeClaudeSessionHold(holder: ClaudeSessionHolder): string {
  const where = holder.pid !== null
    ? [`pid ${holder.pid}`, holder.tmuxSession ? `tmux session ${holder.tmuxSession}` : null,
      holder.registryName ? `secretary ${holder.registryName}` : null]
    : [`registered secretary ${holder.registryName}, restarting or briefly stopped`];
  return `This session is running elsewhere (${where.filter(Boolean).join(', ')}). `
    + 'Messages typed here would start a second copy without its chat tools — '
    + 'send it via Discord DM instead.';
}

/** Machine-readable code on the chat error, so the UI can tell this refusal apart. */
export const CLAUDE_SESSION_HELD_ERROR_CODE = 'session_held_elsewhere';
