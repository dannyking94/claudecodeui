/**
 * What to change after a provider rejected the model a turn ran with
 * (`model_not_found`, e.g. a Codex model the signed-in account cannot use).
 *
 * Only choices that actually hold the rejected model are reset, and only to the
 * provider's catalog default. When the default *is* the rejected model there is
 * nothing safe to switch to, so nothing changes and the error row alone tells
 * the user to pick another model.
 */
export type RejectedModelReset = {
  replacement: string;
  /** The per-provider choice (localStorage `<provider>-model`) holds the rejected model. */
  resetStored: boolean;
  /** The open session is recorded as running the rejected model. */
  resetSession: boolean;
};

export function decideRejectedModelReset({
  rejectedModel,
  catalogDefault,
  storedModel,
  sessionModel,
}: {
  rejectedModel: string;
  catalogDefault: string | null | undefined;
  storedModel: string | null | undefined;
  sessionModel: string | null | undefined;
}): RejectedModelReset | null {
  const replacement = catalogDefault?.trim();
  if (!replacement || replacement === rejectedModel) {
    return null;
  }

  const resetStored = storedModel === rejectedModel;
  const resetSession = sessionModel === rejectedModel;
  if (!resetStored && !resetSession) {
    return null;
  }

  return { replacement, resetStored, resetSession };
}
