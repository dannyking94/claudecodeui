import { readFile } from 'node:fs/promises';

import type {
  ProjectAppAction,
  ProjectAppActionResult,
  ProjectAppLogEntry,
  ProjectAppRecord,
  ProjectAppsSnapshot,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Client for the fleet app dashboard (the server behind `apps.json`).
 *
 * cloudcli runs no health checks and starts no processes of its own: every
 * status comes from the dashboard's `/api/state` and every start/stop goes to
 * its `/api/action`, which keeps its own ownership checks and action log.
 * When the dashboard is unreachable the registry files are read directly and
 * every app is reported with status `unknown`.
 */
type AppsDashboardClientOptions = {
  /** Dashboard origin, e.g. `http://127.0.0.1:8790` (no trailing slash needed). */
  baseUrl: string;
  /** `apps.json` files, later ones adding apps. Used for repo/code_paths and as the fallback. */
  registryPaths: string[];
  fetchImpl?: typeof fetch;
  readText?: (filePath: string) => Promise<string>;
  stateTimeoutMs?: number;
  actionTimeoutMs?: number;
};

type RawRecord = Record<string, unknown>;

const DEFAULT_STATE_TIMEOUT_MS = 15_000;
// A dashboard restart waits up to 45 s for the port to free and again for
// health, plus the app's own command timeout; leave room for all of it.
const DEFAULT_ACTION_TIMEOUT_MS = 6 * 60_000;
const TOKEN_PATTERN = /const TOKEN = "([^"]+)"/;

const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const asNumberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const asStringArray = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const asRecord = (value: unknown): RawRecord => (value && typeof value === 'object' && !Array.isArray(value) ? value as RawRecord : {});

function readCommands(value: unknown): Record<string, string[]> {
  const commands: Record<string, string[]> = {};
  for (const [name, argv] of Object.entries(asRecord(value))) {
    commands[name] = asStringArray(argv);
  }
  return commands;
}

/** Turns one registry entry (apps.json) into a record with no runtime knowledge. */
function fromRegistryEntry(entry: RawRecord): ProjectAppRecord {
  const workdir = asString(entry.workdir);
  return {
    id: asString(entry.id),
    name: asString(entry.name, asString(entry.id)),
    purpose: asString(entry.purpose),
    host: asString(entry.host, 'local'),
    ports: Array.isArray(entry.ports) ? entry.ports.filter((p): p is number => typeof p === 'number') : [],
    links: asStringArray(entry.links),
    healthUrl: asString(entry.health_url),
    controls: entry.controls === 'full' ? 'full' : 'status-only',
    controlsReason: asString(entry.controls_reason),
    startedBy: asString(entry.started_by),
    note: asString(entry.note),
    runs: asString(entry.runs),
    repo: asString(entry.repo, workdir),
    workdir,
    codePaths: asStringArray(entry.code_paths),
    status: 'unknown',
    latencyMs: null,
    error: null,
    pids: [],
    uptimeSeconds: null,
    lastOpened: null,
    connections: null,
    ownershipDetail: null,
    git: null,
    commands: readCommands(entry.commands),
    missingScripts: [],
  };
}

/**
 * Turns one `/api/state` app into a record. The state omits `repo` and
 * `code_paths`, so those are taken from the matching registry entry when one
 * was readable; otherwise the workdir stands in for the repo.
 */
function fromStateEntry(entry: RawRecord, registryEntry: RawRecord | undefined): ProjectAppRecord {
  const base = fromRegistryEntry({ ...(registryEntry ?? {}), ...entry });
  const git = asRecord(entry.git);
  const ownership = asRecord(entry.ownership);
  return {
    ...base,
    repo: asString(registryEntry?.repo, base.workdir),
    codePaths: asStringArray(registryEntry?.code_paths),
    status: entry.up === true ? 'up' : 'down',
    latencyMs: asNumberOrNull(entry.ms),
    error: typeof entry.error === 'string' ? entry.error : null,
    pids: Array.isArray(entry.pids) ? entry.pids.filter((p): p is number => typeof p === 'number') : [],
    uptimeSeconds: asNumberOrNull(entry.uptime_s),
    lastOpened: asNumberOrNull(entry.last_opened),
    connections: asNumberOrNull(entry.connections),
    ownershipDetail: typeof ownership.detail === 'string' ? ownership.detail : null,
    git: entry.git && typeof entry.git === 'object'
      ? {
        branch: typeof git.branch === 'string' ? git.branch : null,
        head: typeof git.head === 'string' ? git.head : null,
        stale: git.stale === true,
        reasons: asStringArray(git.reasons),
      }
      : null,
    missingScripts: asStringArray(entry.missing_scripts),
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
  }
  return String(error);
}

/**
 * Builds the dashboard client used by the Project Apps module composition.
 * Every dependency is injectable so tests can stand up a fake dashboard.
 */
export function createAppsDashboardClient(options: AppsDashboardClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const readText = options.readText ?? ((filePath: string) => readFile(filePath, 'utf8'));
  const stateTimeoutMs = options.stateTimeoutMs ?? DEFAULT_STATE_TIMEOUT_MS;
  const actionTimeoutMs = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  // The action token is minted per dashboard process and only published in its page.
  let cachedToken: string | null = null;

  /** Reads every registry file; later files add apps, an unreadable file is reported, not fatal. */
  async function readRegistry(): Promise<{ entries: RawRecord[]; errors: string[] }> {
    const entries: RawRecord[] = [];
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const registryPath of options.registryPaths) {
      try {
        const parsed = asRecord(JSON.parse(await readText(registryPath)));
        for (const app of Array.isArray(parsed.apps) ? parsed.apps : []) {
          const entry = asRecord(app);
          const id = asString(entry.id);
          if (id && !seen.has(id)) {
            seen.add(id);
            entries.push(entry);
          }
        }
      } catch (error) {
        errors.push(`registry ${registryPath}: ${describeError(error)}`);
      }
    }
    return { entries, errors };
  }

  async function fetchJson(pathname: string, timeoutMs: number, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    const response = await fetchImpl(`${baseUrl}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }

  async function getSnapshot(): Promise<ProjectAppsSnapshot> {
    const [registry, state] = await Promise.all([
      readRegistry(),
      fetchJson('/api/state', stateTimeoutMs).then(
        (result) => (result.status === 200 ? { ok: true as const, body: asRecord(result.body) } : { ok: false as const, error: `dashboard answered ${result.status}` }),
        (error: unknown) => ({ ok: false as const, error: `dashboard unreachable: ${describeError(error)}` }),
      ),
    ]);
    const checkedAt = Date.now();

    if (state.ok && Array.isArray(state.body.apps)) {
      const registryById = new Map(registry.entries.map((entry) => [asString(entry.id), entry]));
      return {
        source: 'dashboard',
        checkedAt,
        error: null,
        apps: state.body.apps.map((app) => {
          const entry = asRecord(app);
          return fromStateEntry(entry, registryById.get(asString(entry.id)));
        }),
      };
    }

    const stateError = state.ok ? 'dashboard returned no app list' : state.error;
    if (registry.entries.length > 0) {
      return {
        source: 'registry',
        checkedAt,
        error: stateError,
        apps: registry.entries.map(fromRegistryEntry),
      };
    }
    const registryNote = options.registryPaths.length === 0 ? 'no registry file configured' : registry.errors.join('; ');
    return { source: 'none', checkedAt, error: `${stateError}; ${registryNote}`, apps: [] };
  }

  async function fetchToken(): Promise<string> {
    let html: string;
    try {
      const response = await fetchImpl(`${baseUrl}/`, { signal: AbortSignal.timeout(stateTimeoutMs) });
      html = await response.text();
    } catch (error) {
      throw new AppError(`App dashboard unreachable: ${describeError(error)}`, { code: 'APPS_DASHBOARD_UNREACHABLE', statusCode: 503 });
    }
    const match = TOKEN_PATTERN.exec(html);
    if (!match) {
      throw new AppError('App dashboard page carries no action token', { code: 'APPS_DASHBOARD_NO_TOKEN', statusCode: 502 });
    }
    return match[1];
  }

  async function postAction(token: string, appId: string, action: ProjectAppAction) {
    return fetchJson('/api/action', actionTimeoutMs, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-App-Dashboard': token },
      body: JSON.stringify({ app: appId, action }),
    });
  }

  async function runAction(appId: string, action: ProjectAppAction): Promise<ProjectAppActionResult> {
    const usedCachedToken = cachedToken !== null;
    let token = cachedToken ?? await fetchToken();
    let result;
    try {
      result = await postAction(token, appId, action);
      // A dashboard restart mints a new token; fetch it once and retry.
      if (result.status === 403 && usedCachedToken) {
        token = await fetchToken();
        result = await postAction(token, appId, action);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(`App dashboard action failed: ${describeError(error)}`, { code: 'APPS_DASHBOARD_UNREACHABLE', statusCode: 503 });
    }
    cachedToken = result.status === 403 ? null : token;

    const body = asRecord(result.body);
    if (result.status === 409) {
      return { app: appId, action, refused: asString(body.error, 'refused'), exit: null, steps: [], outputTail: '', upAfter: null };
    }
    if (result.status !== 200) {
      throw new AppError(`App dashboard refused the request: ${asString(body.error, `HTTP ${result.status}`)}`, {
        code: 'APPS_DASHBOARD_ERROR',
        statusCode: 502,
      });
    }
    const health = asRecord(body.health_after);
    return {
      app: appId,
      action,
      refused: typeof body.refused === 'string' ? body.refused : null,
      exit: asNumberOrNull(body.exit),
      steps: asStringArray(body.steps),
      outputTail: asString(body.output_tail),
      upAfter: typeof health.up === 'boolean' ? health.up : null,
    };
  }

  async function getLog(appId: string): Promise<ProjectAppLogEntry[]> {
    let result;
    try {
      result = await fetchJson('/api/log', stateTimeoutMs);
    } catch (error) {
      throw new AppError(`App dashboard unreachable: ${describeError(error)}`, { code: 'APPS_DASHBOARD_UNREACHABLE', statusCode: 503 });
    }
    if (result.status !== 200 || !Array.isArray(result.body)) {
      throw new AppError(`App dashboard log unavailable (HTTP ${result.status})`, { code: 'APPS_DASHBOARD_ERROR', statusCode: 502 });
    }
    return result.body
      .map(asRecord)
      .filter((entry) => entry.app === appId)
      .map((entry) => ({
        ts: asString(entry.ts),
        app: asString(entry.app),
        action: asString(entry.action),
        who: asString(entry.who),
        refused: typeof entry.refused === 'string' ? entry.refused : null,
        exit: asNumberOrNull(entry.exit),
        steps: asStringArray(entry.steps),
        outputTail: asString(entry.output_tail),
      }));
  }

  return { getSnapshot, runAction, getLog };
}
