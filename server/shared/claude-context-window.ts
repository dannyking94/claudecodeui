/**
 * Context window sizes for Claude models.
 *
 * The token-usage meter needs a denominator, and the only honest source for it
 * is the model that actually produced the transcript: the current generation
 * runs a 1M window while everything before it ran 200K, so a single hardcoded
 * number is wrong by 5x for one of them. Lives in `shared/` because both the
 * resumed-session reader (TypeScript) and the live streaming provider
 * (JavaScript) have to agree about the same session.
 */

/**
 * Denominator used when the model cannot be identified. Deliberately a round,
 * obviously-approximate number: an unknown model must never be given a precise
 * looking window that happens to be wrong.
 */
export const DEFAULT_CLAUDE_CONTEXT_WINDOW = 160_000;

const LARGE_CONTEXT_WINDOW = 1_000_000;
const STANDARD_CONTEXT_WINDOW = 200_000;

/**
 * Claude Code writes assistant records with a real `usage` object, all zeros,
 * and this in place of a model id. It is not a model and must not resolve.
 */
const SYNTHETIC_MODEL_ID = '<synthetic>';

/** Dated ids such as `claude-haiku-4-5-20251001` name the same model as their base id. */
const MODEL_DATE_SUFFIX = /-\d{8}$/;

/** Every Claude 3 model shipped a 200K window, and there are too many to enumerate. */
const CLAUDE_3_MODEL_PREFIX = 'claude-3-';

const CONTEXT_WINDOW_BY_MODEL_ID = new Map<string, number>([
  ['claude-fable-5-1', LARGE_CONTEXT_WINDOW],
  ['claude-fable-5', LARGE_CONTEXT_WINDOW],
  ['claude-mythos-5-1', LARGE_CONTEXT_WINDOW],
  ['claude-mythos-5', LARGE_CONTEXT_WINDOW],
  ['claude-opus-5', LARGE_CONTEXT_WINDOW],
  ['claude-opus-4-8', LARGE_CONTEXT_WINDOW],
  ['claude-opus-4-7', LARGE_CONTEXT_WINDOW],
  ['claude-opus-4-6', LARGE_CONTEXT_WINDOW],
  ['claude-sonnet-5', LARGE_CONTEXT_WINDOW],
  ['claude-sonnet-4-6', LARGE_CONTEXT_WINDOW],
  ['claude-haiku-4-5', STANDARD_CONTEXT_WINDOW],
  ['claude-opus-4-5', STANDARD_CONTEXT_WINDOW],
  ['claude-opus-4-1', STANDARD_CONTEXT_WINDOW],
  ['claude-opus-4-0', STANDARD_CONTEXT_WINDOW],
  ['claude-opus-4', STANDARD_CONTEXT_WINDOW],
  ['claude-sonnet-4-5', STANDARD_CONTEXT_WINDOW],
  ['claude-sonnet-4-0', STANDARD_CONTEXT_WINDOW],
  ['claude-sonnet-4', STANDARD_CONTEXT_WINDOW],
]);

/**
 * A session row's `model` column can hold a bare family name rather than a full
 * id, which is also what the UI displays. Each one means the family's current
 * member.
 */
const CONTEXT_WINDOW_BY_FAMILY_ALIAS = new Map<string, number>([
  ['opus', LARGE_CONTEXT_WINDOW],
  ['sonnet', LARGE_CONTEXT_WINDOW],
  ['haiku', STANDARD_CONTEXT_WINDOW],
]);

/**
 * Resolves the context window a specific model runs with, or `null` when the id
 * is missing, synthetic, or simply not one we know. Callers fall back rather
 * than guess.
 */
export function resolveClaudeModelContextWindow(modelId: unknown): number | null {
  if (typeof modelId !== 'string') {
    return null;
  }

  const normalizedModelId = modelId.trim().toLowerCase();
  if (!normalizedModelId || normalizedModelId === SYNTHETIC_MODEL_ID) {
    return null;
  }

  const undatedModelId = normalizedModelId.replace(MODEL_DATE_SUFFIX, '');

  return CONTEXT_WINDOW_BY_MODEL_ID.get(undatedModelId)
    ?? CONTEXT_WINDOW_BY_FAMILY_ALIAS.get(undatedModelId)
    ?? (undatedModelId.startsWith(CLAUDE_3_MODEL_PREFIX) ? STANDARD_CONTEXT_WINDOW : null);
}

/**
 * Resolves the denominator for one Claude session's token-usage meter.
 *
 * `CONTEXT_WINDOW` stays the operator override and keeps winning, so an
 * operator who has already set it sees no change. Otherwise the window belongs
 * to the model that ran, and only an unidentifiable model reaches the default.
 */
export function resolveClaudeContextWindow(
  configuredContextWindow: string | number | null | undefined,
  modelId?: unknown,
): number {
  const parsedContextWindow = Number.parseInt(String(configuredContextWindow ?? ''), 10);
  if (Number.isFinite(parsedContextWindow) && parsedContextWindow > 0) {
    return parsedContextWindow;
  }

  return resolveClaudeModelContextWindow(modelId) ?? DEFAULT_CLAUDE_CONTEXT_WINDOW;
}
