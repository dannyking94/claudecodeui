import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

/**
 * First wait after a rate-limited poll, doubled for each consecutive 429 up to
 * the ceiling below.
 *
 * Without this the service re-polled on the ordinary cache cadence and simply
 * collected another 429, so a rate limit that should have lasted one window
 * sustained itself for as long as tabs stayed open.
 */
const RATE_LIMIT_BACKOFF_BASE_MS = 60_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 15 * 60_000;

/**
 * How long a retained reading may still be shown once upstream stops
 * answering. Past this the windows it describes have almost certainly rolled
 * over, so a stale percentage would mislead rather than reassure.
 */
const MAX_RETAINED_AGE_MS = 12 * 60 * 60_000;

/** Where the last good reading survives a server restart. */
const SNAPSHOT_RELATIVE_PATH = path.join('.cloudcli', 'claude-usage.json');

/** Guards against reading a snapshot written by an incompatible build. */
const SNAPSHOT_VERSION = 1;

/**
 * How often an unchanged reading is rewritten purely to refresh its recorded
 * age. Long enough that the file is not churned by the poll cadence, short
 * enough that `MAX_RETAINED_AGE_MS` still measures something close to reality.
 */
const SNAPSHOT_REFRESH_MS = 5 * 60_000;

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

type ClaudeUsageReading = {
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
  /**
   * True when upstream could not be reached and this is an earlier reading
   * being retained rather than a fresh one.
   *
   * The pill exists to answer "how much is left", and a percentage from a
   * minute ago answers that far better than an empty space does. The client
   * marks it visually instead of hiding it.
   */
  stale?: boolean;
};

type ClaudeUsageResult =
  | ClaudeUsageReading
  | {
      status: 'unavailable';
      /**
       * - `not_signed_in` — no readable Claude Code credentials on this host
       * - `disabled`      — platform mode; see `createClaudeUsageService`
       * - `upstream_error`— endpoint refused, timed out, or changed shape,
       *   and no reading recent enough to retain was available
       */
      reason: 'not_signed_in' | 'disabled' | 'upstream_error';
    };

/**
 * What one upstream attempt concluded, before it is reconciled with any
 * retained reading.
 *
 * `stable` states describe this host and will not change on a retry, so they
 * are reported as-is. A `transient` state says nothing about the account's
 * actual usage, so the caller prefers a retained reading over it.
 */
type UsageFetchOutcome =
  | { kind: 'ok'; reading: ClaudeUsageReading }
  | { kind: 'stable'; reason: 'not_signed_in' | 'disabled' }
  | {
      kind: 'transient';
      /** True only for an explicit 429; other failures must not trigger backoff. */
      rateLimited: boolean;
      /** Upstream's own requested wait, when it sent one. */
      retryAfterMs: number | null;
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
  /** Overridden in tests so no suite touches a developer's real snapshot. */
  snapshotPath?: string;
  readSnapshot?: (snapshotPath: string) => Promise<string>;
  writeSnapshot?: (snapshotPath: string, contents: string) => Promise<void>;
  now?: () => number;
  logError?: (message: string, detail?: unknown) => void;
};

/**
 * Milliseconds to wait per a `retry-after` header, which upstream may send as
 * a delay in seconds or as an absolute HTTP date. Null when absent or
 * unparseable, leaving the caller on its own exponential schedule.
 */
function readRetryAfter(headerValue: string | null, currentTime: number): number | null {
  if (!headerValue) {
    return null;
  }

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const resumeAt = Date.parse(headerValue);
  return Number.isFinite(resumeAt) ? Math.max(0, resumeAt - currentTime) : null;
}

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
 * Restores a persisted reading, or null if the file is absent, was written by
 * another build, or does not describe a successful read.
 *
 * Nothing here trusts the file's shape: it is ordinary user-writable JSON on
 * disk, so a malformed one must degrade to "no snapshot" rather than reach the
 * client as a usage figure.
 */
function readSnapshotContents(contents: string): ClaudeUsageReading | null {
  try {
    const parsed = readOptionalRecord(JSON.parse(contents));
    if (parsed?.version !== SNAPSHOT_VERSION) {
      return null;
    }

    const reading = readOptionalRecord(parsed.reading);
    const fetchedAt = Number(reading?.fetchedAt);
    if (!reading || reading.status !== 'ok' || !Number.isFinite(fetchedAt)) {
      return null;
    }

    const fiveHour = readPersistedWindow(reading.fiveHour);
    const sevenDay = readPersistedWindow(reading.sevenDay);

    // The same rule the live path applies: a reading with no window at all
    // describes nothing, so it must not resurface as 0%.
    if (!fiveHour && !sevenDay) {
      return null;
    }

    return {
      status: 'ok',
      fiveHour,
      sevenDay,
      limits: readPersistedLimits(reading.limits),
      plan: typeof reading.plan === 'string' ? reading.plan : null,
      fetchedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Reads a window back in the service's own normalized shape.
 *
 * Deliberately not `readUsageWindow`: that one parses upstream's wire format
 * (`resets_at` as an ISO string), while a snapshot holds what this service
 * already produced (`resetsAt` as epoch ms).
 */
function readPersistedWindow(value: unknown): UsageWindow | null {
  const record = readOptionalRecord(value);
  if (!record) {
    return null;
  }

  const utilization = Number(record.utilization);
  if (!Number.isFinite(utilization)) {
    return null;
  }

  const resetsAt = Number(record.resetsAt);
  return {
    utilization: Math.max(0, utilization),
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
    severity: readSeverity(record.severity),
  };
}

/** Restores the detail-view breakdown, dropping any entry that lost its shape. */
function readPersistedLimits(value: unknown): ClaudeUsageLimit[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const limits: ClaudeUsageLimit[] = [];

  for (const entry of value) {
    const record = readOptionalRecord(entry);
    const window = readPersistedWindow(record);
    if (!record || !window || typeof record.kind !== 'string') {
      continue;
    }

    limits.push({
      kind: record.kind,
      ...window,
      scopeLabel: typeof record.scopeLabel === 'string' ? record.scopeLabel : null,
      isActive: record.isActive === true,
    });
  }

  return limits;
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
    snapshotPath = path.join(homeDirectory, SNAPSHOT_RELATIVE_PATH),
    readSnapshot = (filePath: string) => readFile(filePath, 'utf8'),
    writeSnapshot = async (filePath: string, contents: string) => {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contents, 'utf8');
    },
    now = Date.now,
    logError = () => {},
  } = options;

  let cached: { result: ClaudeUsageResult; expiresAt: number } | null = null;
  let inFlight: Promise<ClaudeUsageResult> | null = null;

  /**
   * The last reading upstream actually returned, kept so a transient failure
   * shows a slightly old number instead of nothing at all. Seeded from disk on
   * first use, then updated in place.
   */
  let retained: ClaudeUsageReading | null = null;
  /** Memoizes the one-time restore so concurrent pollers share it. */
  let retainedLoad: Promise<void> | null = null;
  /** Serialized percentages of the last write, so an unchanged reading is not rewritten. */
  let lastPersistedShape: string | null = null;
  /** `fetchedAt` of the last write, driving the periodic age refresh. */
  let lastPersistedAt = 0;
  /** Epoch ms before which no upstream request may be made. */
  let rateLimitedUntil = 0;
  /** Drives the exponential schedule when upstream sends no `retry-after`. */
  let consecutiveRateLimits = 0;

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

  async function fetchUsage(): Promise<UsageFetchOutcome> {
    if (isPlatform) {
      return { kind: 'stable', reason: 'disabled' };
    }

    const credentials = await readAccessToken();
    if (!credentials) {
      return { kind: 'stable', reason: 'not_signed_in' };
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
        // Only an explicit rate limit earns a backoff. Other failures stay on
        // the ordinary cadence so a one-off 500 does not mute the pill for
        // fifteen minutes.
        const rateLimited = response.status === 429;
        return {
          kind: 'transient',
          rateLimited,
          retryAfterMs: rateLimited
            ? readRetryAfter(response.headers.get('retry-after'), now())
            : null,
        };
      }

      const payload = readOptionalRecord(await response.json());
      if (!payload) {
        return { kind: 'transient', rateLimited: false, retryAfterMs: null };
      }

      const limits = readLimits(payload);
      const fiveHour = readUsageWindow(payload.five_hour, readSeverityByKind(limits, 'session'));
      const sevenDay = readUsageWindow(payload.seven_day, readSeverityByKind(limits, 'weekly_all'));

      // Both windows absent means the payload shape moved out from under us;
      // reporting 0% would be a confident lie, so report nothing instead.
      if (!fiveHour && !sevenDay) {
        return { kind: 'transient', rateLimited: false, retryAfterMs: null };
      }

      return {
        kind: 'ok',
        reading: {
          status: 'ok',
          fiveHour,
          sevenDay,
          limits,
          plan: credentials.plan,
          fetchedAt: now(),
        },
      };
    } catch (error) {
      logError('Claude usage lookup failed', error);
      return { kind: 'transient', rateLimited: false, retryAfterMs: null };
    }
  }

  /**
   * Loads the persisted reading once, so a restart does not start blank.
   *
   * The promise rather than a boolean is what makes this safe: several tabs
   * poll at once, and a plain flag would let the second caller past while the
   * first was still reading the file.
   */
  function ensureRetainedLoaded(): Promise<void> {
    retainedLoad ??= (async () => {
      try {
        const restored = readSnapshotContents(await readSnapshot(snapshotPath));
        // A live reading arrived while the file was being read; it is newer.
        retained ??= restored;
      } catch {
        // No snapshot yet is the ordinary first-run state, not an error.
      }
    })();

    return retainedLoad;
  }

  /**
   * The retained reading, marked stale, or null once it is too old to describe
   * the current windows.
   */
  function retainedReading(currentTime: number): ClaudeUsageReading | null {
    if (!retained || currentTime - retained.fetchedAt > MAX_RETAINED_AGE_MS) {
      return null;
    }

    return { ...retained, stale: true };
  }

  /**
   * Persists the reading so it survives a restart.
   *
   * The comparison deliberately ignores `fetchedAt`: it changes on every poll,
   * so including it would mean rewriting the file every half minute for as
   * long as the server runs even though the percentages had not moved. A
   * periodic refresh still lands so the recorded age cannot drift far behind
   * reality, which is what the staleness cutoff is measured against.
   */
  async function persistReading(reading: ClaudeUsageReading): Promise<void> {
    const shape = JSON.stringify({
      fiveHour: reading.fiveHour,
      sevenDay: reading.sevenDay,
      limits: reading.limits,
      plan: reading.plan,
    });

    const dueForRefresh = reading.fetchedAt - lastPersistedAt >= SNAPSHOT_REFRESH_MS;
    if (shape === lastPersistedShape && !dueForRefresh) {
      return;
    }

    try {
      await writeSnapshot(snapshotPath, JSON.stringify({ version: SNAPSHOT_VERSION, reading }));
      lastPersistedShape = shape;
      lastPersistedAt = reading.fetchedAt;
    } catch (error) {
      // Advisory telemetry must never fail a request; the in-memory copy still
      // serves this process, it just will not outlive it.
      logError('Claude usage snapshot could not be written', error);
    }
  }

  /** Reconciles one attempt's outcome with the retained reading and backoff state. */
  function applyOutcome(outcome: UsageFetchOutcome): ClaudeUsageResult {
    const currentTime = now();

    if (outcome.kind === 'ok') {
      consecutiveRateLimits = 0;
      rateLimitedUntil = 0;
      retained = outcome.reading;
      void persistReading(outcome.reading);
      return outcome.reading;
    }

    if (outcome.kind === 'stable') {
      // This host genuinely has nothing to report, so a retained reading from
      // an earlier sign-in would be actively wrong. Drop it.
      retained = null;
      return { status: 'unavailable', reason: outcome.reason };
    }

    if (outcome.rateLimited) {
      // Upstream's own figure wins when it sends one; otherwise each further
      // 429 in a row doubles the wait, up to the ceiling.
      const backoff = outcome.retryAfterMs
        ?? RATE_LIMIT_BACKOFF_BASE_MS * 2 ** consecutiveRateLimits;
      consecutiveRateLimits += 1;
      rateLimitedUntil = currentTime + Math.min(backoff, RATE_LIMIT_BACKOFF_MAX_MS);
    }

    return retainedReading(currentTime) ?? { status: 'unavailable', reason: 'upstream_error' };
  }

  return {
    /**
     * Returns the current usage snapshot, served from a short-lived cache.
     * Concurrent callers share one upstream request.
     */
    async getUsage(): Promise<ClaudeUsageResult> {
      if (cached && cached.expiresAt > now()) {
        return cached.result;
      }

      await ensureRetainedLoaded();

      // While rate-limited, answer from the retained reading without spending
      // another request on a limit that is known to still be in force.
      const currentTime = now();
      if (rateLimitedUntil > currentTime) {
        return retainedReading(currentTime) ?? { status: 'unavailable', reason: 'upstream_error' };
      }

      inFlight ??= fetchUsage()
        .then((outcome) => {
          const result = applyOutcome(outcome);
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
