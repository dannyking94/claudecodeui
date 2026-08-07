import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** Where Claude Code stores the OAuth token this service borrows to read usage. */
const CREDENTIALS_RELATIVE_PATH = path.join('.claude', '.credentials.json');

/**
 * The endpoint Claude Code's own `/usage` command calls. It belongs to the
 * OAuth surface rather than the public Messages API, so it is undocumented and
 * carries no stability guarantee — every failure path here degrades to
 * `unavailable` instead of surfacing an error.
 */
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

/** The OAuth surface rejects bearer-token requests that omit this beta opt-in. */
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

/** Advisory telemetry must never hold a chat request open on a slow upstream. */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Every open tab polls independently and the upstream is unofficial, so one
 * call per window is shared by all of them rather than multiplied by tab count.
 */
const CACHE_TTL_MS = 30_000;

type UsageWindow = {
  /** Percent of the window's allowance already consumed, 0-100. */
  utilization: number;
  /** Epoch ms when the window rolls over, or null when upstream omits it. */
  resetsAt: number | null;
  /** Upstream's own pressure grading, used for the client's colour treatment. */
  severity: 'normal' | 'warning' | 'critical';
};

/**
 * One entry from upstream's `limits` array — the complete per-window
 * breakdown behind the two headline figures.
 *
 * This is deliberately passed through by `kind` rather than mapped onto a
 * fixed set of fields. Accounts expose different windows (per-model weekly
 * caps, surface-scoped caps), and upstream adds new ones over time; keying on
 * the reported kind means a window this build has never heard of still
 * reaches the client instead of being silently dropped.
 */
type ClaudeUsageLimit = {
  kind: string;
  utilization: number;
  resetsAt: number | null;
  severity: 'normal' | 'warning' | 'critical';
  /** Model or surface the window applies to, e.g. `Fable`. Null when account-wide. */
  scopeLabel: string | null;
  /** True for the window currently governing throughput. */
  isActive: boolean;
};

type ClaudeUsageResult =
  | {
      status: 'ok';
      /** The rolling session window that gates work moment to moment. */
      fiveHour: UsageWindow | null;
      /** The longer window that gates work across the week. */
      sevenDay: UsageWindow | null;
      /** Every window upstream reports, for the detail view behind the pill. */
      limits: ClaudeUsageLimit[];
      /** Plan label from the local credentials, e.g. `max`. Null when absent. */
      plan: string | null;
      fetchedAt: number;
    }
  | {
      status: 'unavailable';
      /**
       * - `not_signed_in` — no readable Claude Code credentials on this host
       * - `disabled`      — platform mode; see `createClaudeUsageService`
       * - `upstream_error`— endpoint refused, timed out, or changed shape
       */
      reason: 'not_signed_in' | 'disabled' | 'upstream_error';
    };

type ClaudeUsageServiceOptions = {
  homeDirectory: string;
  /**
   * Platform deployments serve many users from one host, where the credentials
   * file belongs to the operator rather than the visitor. Reporting that
   * account's remaining quota to every client would leak the operator's
   * billing state, so the service reports `disabled` instead of reading it.
   */
  isPlatform: boolean;
  fetchImpl?: typeof fetch;
  readCredentials?: (credentialsPath: string) => Promise<string>;
  now?: () => number;
  logError?: (message: string, detail?: unknown) => void;
};

function readOptionalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readSeverity(value: unknown): UsageWindow['severity'] {
  return value === 'warning' || value === 'critical' ? value : 'normal';
}

/**
 * Upstream reports `resets_at` as an ISO timestamp. Anything unparseable
 * becomes null so the client simply omits the countdown rather than rendering
 * `Invalid Date`.
 */
function readResetTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readUsageWindow(
  windowValue: unknown,
  severity: UsageWindow['severity'],
): UsageWindow | null {
  const record = readOptionalRecord(windowValue);
  if (!record) {
    return null;
  }

  const utilization = Number(record.utilization);
  if (!Number.isFinite(utilization)) {
    return null;
  }

  return {
    // Upstream can exceed 100 once a window is overdrawn; the bar clamps, but
    // the reported number stays truthful.
    utilization: Math.max(0, utilization),
    resetsAt: readResetTimestamp(record.resets_at),
    severity,
  };
}

/**
 * A window can be scoped to a model or a surface. Upstream nests the label two
 * levels down and leaves the sibling null, so this reaches for whichever is
 * present rather than assuming the model form.
 */
function readScopeLabel(scopeValue: unknown): string | null {
  const scope = readOptionalRecord(scopeValue);
  if (!scope) {
    return null;
  }

  for (const key of ['model', 'surface']) {
    const displayName = readOptionalRecord(scope[key])?.display_name;
    if (typeof displayName === 'string' && displayName.length > 0) {
      return displayName;
    }
  }

  return null;
}

/** Normalizes upstream's `limits` array, dropping only entries with no usable percent. */
function readLimits(payload: Record<string, unknown>): ClaudeUsageLimit[] {
  if (!Array.isArray(payload.limits)) {
    return [];
  }

  const limits: ClaudeUsageLimit[] = [];

  for (const entry of payload.limits) {
    const record = readOptionalRecord(entry);
    const kind = record?.kind;
    if (!record || typeof kind !== 'string') {
      continue;
    }

    const utilization = Number(record.percent);
    if (!Number.isFinite(utilization)) {
      continue;
    }

    limits.push({
      kind,
      utilization: Math.max(0, utilization),
      resetsAt: readResetTimestamp(record.resets_at),
      severity: readSeverity(record.severity),
      scopeLabel: readScopeLabel(record.scope),
      isActive: record.is_active === true,
    });
  }

  return limits;
}

/**
 * Severity lives in the `limits` array rather than on the window objects
 * themselves. A window with no matching entry is normal pressure.
 */
function readSeverityByKind(limits: ClaudeUsageLimit[], kind: string): UsageWindow['severity'] {
  return limits.find((limit) => limit.kind === kind)?.severity ?? 'normal';
}

/**
 * Creates the Claude usage reader consumed by `createSystemModule`.
 *
 * The access token never leaves this service: callers receive percentages and
 * reset times only.
 */
export function createClaudeUsageService(options: ClaudeUsageServiceOptions) {
  const {
    homeDirectory,
    isPlatform,
    fetchImpl = fetch,
    readCredentials = (credentialsPath: string) => readFile(credentialsPath, 'utf8'),
    now = Date.now,
    logError = () => {},
  } = options;

  let cached: { result: ClaudeUsageResult; expiresAt: number } | null = null;
  let inFlight: Promise<ClaudeUsageResult> | null = null;

  /**
   * Read on every poll rather than cached: Claude Code rotates this token in
   * place, so a value held in memory goes stale while the file stays correct.
   */
  async function readAccessToken(): Promise<{ token: string; plan: string | null } | null> {
    try {
      const raw = await readCredentials(path.join(homeDirectory, CREDENTIALS_RELATIVE_PATH));
      const oauth = readOptionalRecord(readOptionalRecord(JSON.parse(raw))?.claudeAiOauth);
      const token = oauth?.accessToken;

      if (typeof token !== 'string' || token.length === 0) {
        return null;
      }

      return {
        token,
        plan: typeof oauth?.subscriptionType === 'string' ? oauth.subscriptionType : null,
      };
    } catch {
      // A missing or malformed file means "not signed in on this host", which
      // is an ordinary state for a fresh install rather than an error.
      return null;
    }
  }

  async function fetchUsage(): Promise<ClaudeUsageResult> {
    if (isPlatform) {
      return { status: 'unavailable', reason: 'disabled' };
    }

    const credentials = await readAccessToken();
    if (!credentials) {
      return { status: 'unavailable', reason: 'not_signed_in' };
    }

    try {
      const response = await fetchImpl(USAGE_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        logError('Claude usage endpoint returned a non-OK status', response.status);
        return { status: 'unavailable', reason: 'upstream_error' };
      }

      const payload = readOptionalRecord(await response.json());
      if (!payload) {
        return { status: 'unavailable', reason: 'upstream_error' };
      }

      const limits = readLimits(payload);
      const fiveHour = readUsageWindow(payload.five_hour, readSeverityByKind(limits, 'session'));
      const sevenDay = readUsageWindow(payload.seven_day, readSeverityByKind(limits, 'weekly_all'));

      // Both windows absent means the payload shape moved out from under us;
      // reporting 0% would be a confident lie, so report nothing instead.
      if (!fiveHour && !sevenDay) {
        return { status: 'unavailable', reason: 'upstream_error' };
      }

      return { status: 'ok', fiveHour, sevenDay, limits, plan: credentials.plan, fetchedAt: now() };
    } catch (error) {
      logError('Claude usage lookup failed', error);
      return { status: 'unavailable', reason: 'upstream_error' };
    }
  }

  return {
    /**
     * Returns the current usage snapshot, served from a short-lived cache.
     * Concurrent callers share one upstream request.
     */
    async getUsage(): Promise<ClaudeUsageResult> {
      const currentTime = now();
      if (cached && cached.expiresAt > currentTime) {
        return cached.result;
      }

      inFlight ??= fetchUsage()
        .then((result) => {
          // Failures are cached too, so a signed-out host does not re-read the
          // filesystem on every poll from every tab.
          cached = { result, expiresAt: now() + CACHE_TTL_MS };
          return result;
        })
        .finally(() => {
          inFlight = null;
        });

      return inFlight;
    },
  };
}
