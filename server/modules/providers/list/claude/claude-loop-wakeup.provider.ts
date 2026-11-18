/**
 * Stands in for a `/loop` wakeup the CLI armed but never fired.
 *
 * `ScheduleWakeup` turns its delay into a session cron job held in the claude
 * subprocess's memory, and that scheduler only runs in the idle window between
 * turns. The Claude runtime already holds the process open after a turn that
 * scheduled work, which is necessary but not sufficient: under the SDK
 * transport a short delay fires and a long one routinely does not. The loop
 * then stops dead with a wakeup the CLI still considers pending, so nothing
 * reports an error on either side.
 *
 * The watchdog reads the run's SDK stream, records when each armed wakeup is
 * due, and once that time has clearly passed without the CLI opening a turn,
 * delivers the tick itself through the run's held input stream. A tick the CLI
 * does deliver clears the deadline as that turn opens, and a wakeup armed since
 * the deadline was set moves it out, so one wakeup never produces two ticks.
 */

type AnyRecord = Record<string, any>;

/** The CLI clamps a wakeup delay to this range and never fires before it. */
const WAKEUP_MIN_SECONDS = 60;
const WAKEUP_MAX_SECONDS = 3600;

/**
 * How long past a wakeup's due time to wait for the CLI before delivering the
 * tick from here. Absorbs the CLI's own rounding (it rounds a delay up to the
 * next minute boundary) plus scheduler lag, so a wakeup that does fire is not
 * raced.
 */
const DEFAULT_WAKEUP_GRACE_MS = 90 * 1000;

/** How long to wait before retrying a delivery the run could not take yet. */
const DELIVERY_RETRY_MS = 60 * 1000;

const readPositiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// Read per use rather than at load, so the grace can be retuned without a restart.
const wakeupGraceMs = (): number =>
  readPositiveInt(process.env.CLOUDCLI_CLAUDE_WAKEUP_GRACE_MS, DEFAULT_WAKEUP_GRACE_MS);

const clampWakeupDelaySeconds = (seconds: unknown): number => {
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed)) {
    return WAKEUP_MIN_SECONDS;
  }
  return Math.min(WAKEUP_MAX_SECONDS, Math.max(WAKEUP_MIN_SECONDS, Math.round(parsed)));
};

/**
 * The prompt for a tick whose wakeup was armed but never fired.
 *
 * A CLI-delivered tick arrives wrapped in the reminder that the loop ends
 * unless the turn re-arms; this one is delivered outside that machinery, so it
 * carries the same contract itself. The reporting half is an addition: a tick
 * that inspects, acts and re-arms without a word renders as tool calls followed
 * by a new wakeup, which reads as a loop spinning on nothing.
 */
export function buildMissedWakeupTick(prompt: string): string {
  return [
    '# /loop tick — delivered by cloudcli because the wakeup this loop armed never fired',
    '',
    prompt,
    '',
    'Say where things stand in a line or two before this turn ends, even if '
    + 'nothing changed since the last tick — a tick that only runs tools reads as a '
    + 'loop doing nothing. To keep the loop running, call ScheduleWakeup at the end '
    + 'of this turn with `prompt` set to the task above. If there is nothing left to '
    + 'do, call it with `stop: true` instead.',
  ].join('\n');
}

/** A wakeup a loop tick armed: what to re-tick with, and when it is due. */
type ArmedLoopWakeup = { prompt: string; dueAt: number };

type LoopWakeupWatchdogOptions = {
  /** Label for log lines; the run's session key. */
  sessionLabel: () => string | null;
  /**
   * Pushes the tick into the run. Returns false when the run cannot take it
   * right now (a turn is in flight); the delivery is then retried. A run whose
   * input has been released for good should `dispose()` the watchdog instead.
   */
  deliver: (tickPrompt: string) => boolean | Promise<boolean>;
};

/**
 * Creates the watchdog for one Claude run. Used by the Claude runtime only,
 * which feeds it every SDK message and consults `msUntilDeadline` so its idle
 * ceiling never releases the process ahead of an armed wakeup.
 */
export function createLoopWakeupWatchdog(
  options: LoopWakeupWatchdogOptions,
  carried: ArmedLoopWakeup | null = null,
) {
  let armed: ArmedLoopWakeup | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (delayMs: number) => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void deliverMissedWakeup();
    }, delayMs);
    // Never a reason on its own to keep the server process alive.
    timer.unref?.();
  };

  const deliverMissedWakeup = async () => {
    if (disposed || !armed) {
      return;
    }
    // A wakeup armed since this delivery was scheduled moved the deadline out.
    const remaining = armed.dueAt + wakeupGraceMs() - Date.now();
    if (remaining > 0) {
      schedule(remaining);
      return;
    }

    const { prompt } = armed;
    let delivered = false;
    try {
      delivered = await options.deliver(buildMissedWakeupTick(prompt));
    } catch (error) {
      console.warn(
        `[Claude SDK] Could not deliver a missed loop wakeup for session ${options.sessionLabel()}:`,
        (error as Error)?.message || error,
      );
    }
    if (disposed) {
      return;
    }
    if (!delivered) {
      schedule(DELIVERY_RETRY_MS);
      return;
    }
    console.log(
      `[Claude SDK] Session ${options.sessionLabel()} armed a wakeup the CLI never fired; `
      + 'delivered that loop tick from here.',
    );
    // The turn this produced is the loop's tick. Whether the loop goes on is
    // now up to that turn arming the next wakeup.
    armed = null;
  };

  // A wakeup armed in the process this run replaced died with that process,
  // so the CLI here will never fire it: the deadline stands from the start.
  if (carried) {
    armed = { ...carried };
    schedule(Math.max(0, armed.dueAt - Date.now()) + wakeupGraceMs());
  }

  return {
    /** Feeds one raw SDK stream message through the watchdog. */
    observe(sdkMessage: AnyRecord | null | undefined): void {
      if (disposed || !sdkMessage) {
        return;
      }

      // A turn opening once the wakeup is due is the CLI firing it after all.
      // One opening earlier is unrelated work (a user turn, a background task
      // reporting in) and leaves the armed wakeup pending.
      if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init') {
        if (armed && Date.now() >= armed.dueAt) {
          armed = null;
          clearTimer();
        }
        return;
      }

      // Only the main thread's wakeups belong to this session's loop.
      if (sdkMessage.type !== 'assistant' || sdkMessage.parent_tool_use_id) {
        return;
      }
      const content = sdkMessage.message?.content;
      if (!Array.isArray(content)) {
        return;
      }
      for (const block of content) {
        if (block?.type !== 'tool_use' || block.name !== 'ScheduleWakeup') {
          continue;
        }
        if (block.input?.stop === true) {
          armed = null;
          clearTimer();
          continue;
        }
        const prompt = typeof block.input?.prompt === 'string' ? block.input.prompt.trim() : '';
        if (!prompt) {
          // Nothing to re-tick with; this wakeup is left to the CLI.
          armed = null;
          clearTimer();
          continue;
        }
        armed = {
          prompt,
          dueAt: Date.now() + clampWakeupDelaySeconds(block.input?.delaySeconds) * 1000,
        };
        schedule(Math.max(0, armed.dueAt - Date.now()) + wakeupGraceMs());
      }
    },

    /**
     * Milliseconds until the pending delivery would run, or null when no
     * wakeup is armed. The runtime holds the process at least this long.
     */
    msUntilDeadline(): number | null {
      if (disposed || !armed) {
        return null;
      }
      return Math.max(0, armed.dueAt + wakeupGraceMs() - Date.now());
    },

    /**
     * The wakeup still owed, for the run that supersedes this one to adopt.
     * Null once delivered, stopped, cancelled or disposed.
     */
    snapshot(): ArmedLoopWakeup | null {
      return disposed || !armed ? null : { ...armed };
    },

    /** Drops the armed wakeup; the user aborting a turn lets the loop go. */
    cancel(): void {
      armed = null;
      clearTimer();
    },

    /** Ends the watchdog with its run. */
    dispose(): void {
      disposed = true;
      armed = null;
      clearTimer();
    },
  };
}
