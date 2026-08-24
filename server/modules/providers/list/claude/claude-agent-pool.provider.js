/**
 * Persistent Claude agent pool.
 *
 * Why this exists: the scheduling primitives behind `/loop` — `CronCreate` and
 * `ScheduleWakeup` — are session-scoped and in-memory. A cron job is "gone when
 * Claude exits" and only fires while the agent sits idle between turns. A
 * runtime that spawns a fresh `query()` per turn therefore destroys every
 * scheduled job the instant the turn that created it finishes, so `/loop` can
 * never fire even once, and `/goal` loses its cross-turn enforcement state.
 *
 * The pool keeps one SDK `query()` alive per app session, driven by an
 * open-ended input stream. Each turn is pushed into that stream and ends at the
 * SDK's `result` message, but the query itself stays open — so scheduled work
 * survives, and when it fires the resulting turn arrives on the same stream
 * with no `chat.send` behind it. Those "unsolicited" turns are handed to the
 * spontaneous-run opener, which registers them with the chat layer so the UI
 * renders them like any other run.
 *
 * Keeping the process alive is necessary but not sufficient for a dynamic
 * `/loop`, which also needs every tick to arm the next one and needs the armed
 * wakeup to actually fire. Neither is guaranteed under this transport, so the
 * pool delivers the tick itself in both cases — see `LOOP_KEEPALIVE_BUDGET` and
 * `DEFAULT_WAKEUP_GRACE_MS`.
 *
 * The pool owns transport and lifetime only. Session identity and per-turn
 * settings live in the runtime-owned `state` object it is handed, because the
 * runtime's `canUseTool` and hook closures are baked into the SDK options
 * before the agent exists and must keep seeing current values.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';

/** Tools whose use means the session has work scheduled beyond the current turn. */
const SCHEDULING_TOOLS = new Set(['CronCreate', 'ScheduleWakeup']);

/** A `/loop` invocation. Slash commands are always the leading text of a turn. */
const LOOP_COMMAND = /^\s*\/loop\b/i;

/** The CLI clamps a wakeup delay to this range and never fires before it. */
const WAKEUP_MIN_SECONDS = 60;
const WAKEUP_MAX_SECONDS = 3600;

/**
 * Message types that can legitimately open a turn.
 *
 * Every turn — user-sent or scheduled — starts with a `system`/`init` frame,
 * which is the marker relied on here. The content types are a fallback so a
 * turn is never missed if that frame is ever absent. Anything else arriving
 * while the session is idle is between-turn bookkeeping (rate-limit notices and
 * similar) and must not be mistaken for scheduled work: opening a run for one
 * would leave a session wedged in "processing" with no `result` ever to end it.
 */
const TURN_OPENING_TYPES = new Set(['assistant', 'user', 'stream_event']);

function opensTurn(message) {
  // A replayed frame is the CLI restating something rather than working:
  // `setModel` echoes `<local-command-stdout>Set model to …` as a *user* frame
  // with `isReplay`, and a resume replays history the same way. Neither is
  // followed by a `result`, so opening a turn for one wedges the session until
  // the stalled-turn sweeper reclaims it — which is what a mid-session model
  // switch used to do, since the echo lands while `applyTurnSettings` is still
  // awaiting and the turn it belongs to has not been claimed yet.
  if (message?.isReplay) {
    return false;
  }
  if (message?.type === 'system') {
    return message.subtype === 'init';
  }
  return TURN_OPENING_TYPES.has(message?.type);
}

const readPositiveInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * A live claude subprocess is expensive, so the pool is bounded. Sessions
 * holding scheduled work are evicted last, and only once nothing else is free.
 */
const MAX_LIVE_AGENTS = readPositiveInt(process.env.CLOUDCLI_CLAUDE_MAX_LIVE_AGENTS, 8);
const IDLE_TTL_MS = readPositiveInt(process.env.CLOUDCLI_CLAUDE_AGENT_IDLE_MS, 30 * 60 * 1000);
const SCHEDULED_TTL_MS = readPositiveInt(
  process.env.CLOUDCLI_CLAUDE_SCHEDULED_AGENT_MAX_MS,
  8 * 60 * 60 * 1000,
);
const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * How long a pushed turn may produce *nothing at all* before its agent is
 * declared dead and replaced.
 *
 * This guards the one failure the pool cannot otherwise see: the subprocess is
 * alive and the stream is open, but nothing is consuming input any more, so the
 * turn sits in the queue forever and `runTurn` never settles. The chat layer
 * then holds its run open indefinitely and every later `chat.send` for that
 * session is refused — a session wedged with no way back from the UI.
 *
 * Only the *first* message of a turn is timed. Once the agent has shown it is
 * listening, the turn may take as long as it needs.
 */
const TURN_START_TIMEOUT_MS = readPositiveInt(
  process.env.CLOUDCLI_CLAUDE_TURN_START_TIMEOUT_MS,
  2 * 60 * 1000,
);

/**
 * How long a turn already in progress may go without a single stream message
 * before the sweeper gives up on it.
 *
 * The start watchdog cannot cover a turn that began normally and then stalled —
 * including a scheduled turn, which no caller is waiting on. Expiring the agent
 * settles that turn, which releases the chat layer's run and makes the session
 * usable again instead of leaving it "processing" forever.
 */
const STALLED_TURN_TIMEOUT_MS = readPositiveInt(
  process.env.CLOUDCLI_CLAUDE_STALLED_TURN_MS,
  30 * 60 * 1000,
);

/** How long to wait for an agent to acknowledge an interrupt before dropping it. */
const INTERRUPT_TIMEOUT_MS = readPositiveInt(
  process.env.CLOUDCLI_CLAUDE_INTERRUPT_TIMEOUT_MS,
  10 * 1000,
);

/**
 * How long after a loop tick that armed no wakeup to deliver the next tick anyway.
 *
 * A dynamic `/loop` only survives because each tick arms the next one. The CLI
 * has its own guard for a tick that forgets — it arms one fallback wakeup on the
 * model's behalf — but the only call site is inside the interactive REPL's
 * render tree. Nothing in the SDK transport the pool drives reaches it, so under
 * cloudcli a single skipped call ends the loop permanently, with no error on
 * either side. The pool owns the input stream, so it can deliver that fallback
 * tick itself.
 *
 * The delay and the budget of one consecutive keepalive both match the CLI's:
 * a loop that declines to re-arm even when handed a free tick is over, and
 * pushing further turns at it is just noise.
 */
const LOOP_KEEPALIVE_BUDGET = 1;
const DEFAULT_LOOP_KEEPALIVE_MS = 20 * 60 * 1000;
const LOOP_KEEPALIVE_RETRY_MS = 60 * 1000;

/**
 * How long past a wakeup's due time to wait for the CLI before delivering the
 * tick from here instead.
 *
 * A tick doing its part is still not enough: an armed wakeup is a session cron
 * job held in the subprocess's memory, and its scheduler only runs in the idle
 * window between turns. Observed under this transport, a short delay fires and
 * a long one routinely does not — the loop then stops dead with a wakeup that
 * the CLI still considers pending, so nothing reports an error on either side.
 *
 * The pool records when each armed wakeup is due, so it can wait out the CLI
 * and deliver the tick itself once that time has clearly passed. The grace
 * window absorbs the CLI's own rounding (it rounds a delay up to the next
 * minute boundary) plus scheduler lag, so a wakeup that does fire is not raced.
 * A tick delivered this way is the loop working, not a free tick, so it does
 * not spend the keepalive budget above.
 */
const DEFAULT_WAKEUP_GRACE_MS = 90 * 1000;

// Read per use rather than at load, so the delays can be retuned without a restart.
const loopKeepaliveDelayMs = () =>
  readPositiveInt(process.env.CLOUDCLI_CLAUDE_LOOP_KEEPALIVE_MS, DEFAULT_LOOP_KEEPALIVE_MS);
const wakeupGraceMs = () =>
  readPositiveInt(process.env.CLOUDCLI_CLAUDE_WAKEUP_GRACE_MS, DEFAULT_WAKEUP_GRACE_MS);

const clampWakeupDelay = (seconds) => {
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed)) {
    return WAKEUP_MIN_SECONDS;
  }
  return Math.min(WAKEUP_MAX_SECONDS, Math.max(WAKEUP_MIN_SECONDS, Math.round(parsed)));
};

/**
 * The `/loop` invocation in a pushed turn, or null if it is not one.
 *
 * Only the leading text is examined: image attachments ride along as separate
 * content blocks, and a slash command always leads.
 */
function loopInvocation(userMessage) {
  const content = userMessage?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.find((block) => block?.type === 'text')?.text ?? ''
      : '';

  if (!LOOP_COMMAND.test(text)) {
    return null;
  }
  return { prompt: text.trim().slice('/loop'.length).trim() || null };
}

/**
 * What every pool-delivered tick must say.
 *
 * A CLI-delivered tick arrives wrapped in the reminder that the loop ends unless
 * this turn re-arms. These are delivered outside that machinery, so they have to
 * carry the same contract themselves.
 *
 * The reporting half is the pool's own addition. A tick that inspects, acts and
 * re-arms without a word renders as a row of tool calls followed by a new
 * wakeup, which reads as a loop spinning on nothing — the user cannot tell a
 * tick that found work and did it from one that did nothing at all.
 */
const TICK_CONTRACT =
  'Say where things stand in a line or two before this turn ends, even if '
  + 'nothing changed since the last tick — a tick that only runs tools reads as a '
  + 'loop doing nothing. To keep the loop running, call ScheduleWakeup at the end '
  + 'of this turn with `prompt` set to the task above. If there is nothing left to '
  + 'do, call it with `stop: true` instead.';

/** The free tick's prompt, handed to a loop whose last tick armed nothing. */
function buildKeepaliveTick(prompt) {
  return [
    '# /loop tick — delivered by cloudcli after the previous tick armed no wakeup',
    '',
    prompt,
    '',
    `${TICK_CONTRACT} This fallback is delivered once — if this turn arms `
    + 'nothing, the loop ends here.',
  ].join('\n');
}

/**
 * The prompt for a tick whose wakeup was armed but never fired.
 *
 * Unlike the free tick, this one is the loop running as intended — only the
 * delivery differs — so it says nothing about the loop being at risk.
 */
function buildMissedWakeupTick(prompt) {
  return [
    '# /loop tick — delivered by cloudcli because the wakeup this loop armed never fired',
    '',
    prompt,
    '',
    TICK_CONTRACT,
  ].join('\n');
}

/** Rejects if `promise` has not settled within `ms`. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/**
 * An async iterable the caller pushes into, which never returns on its own.
 *
 * This is what holds the SDK query open: the CLI keeps its side of the stream
 * alive for as long as more input may arrive, which is precisely the idle
 * window a cron job needs in order to fire.
 */
function createInputStream() {
  const queued = [];
  let deliverNext = null;
  let ended = false;

  return {
    push(message) {
      if (ended) {
        return;
      }
      if (deliverNext) {
        const deliver = deliverNext;
        deliverNext = null;
        deliver({ value: message, done: false });
        return;
      }
      queued.push(message);
    },
    end() {
      ended = true;
      if (deliverNext) {
        const deliver = deliverNext;
        deliverNext = null;
        deliver({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queued.length > 0) {
            return Promise.resolve({ value: queued.shift(), done: false });
          }
          if (ended) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            deliverNext = resolve;
          });
        },
      };
    },
  };
}

function createDeferred() {
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * One long-lived Claude session.
 *
 * Turn bookkeeping is the only subtle part: `activeTurn` is set when a user
 * message is pushed and cleared by the SDK's `result` message. A message that
 * arrives with no `activeTurn` is scheduled work waking up, which opens a
 * spontaneous run so the output has somewhere to go.
 */
class PersistentClaudeAgent {
  constructor({ key, fingerprint, sdkOptions, state, route, openSpontaneousRun, onClosed, createQuery }) {
    this.key = key;
    this.fingerprint = fingerprint;
    this.state = state;
    this.route = route;
    this.openSpontaneousRun = openSpontaneousRun;
    this.onClosed = onClosed;

    this.writer = null;
    this.activeTurn = null;
    this.spontaneousRun = null;
    this.startWatchdog = null;
    this.hasScheduledWork = false;
    // The dynamic `/loop` this session is running, if any: the prompt to re-tick
    // with, when its armed wakeup is due, and how many free ticks it has had.
    this.loop = null;
    // The pool's pending tick delivery for that loop — either the wakeup the CLI
    // has yet to fire, or the free tick after one that armed nothing. The two are
    // mutually exclusive, so one timer covers both.
    this.loopTimer = null;
    this.closed = false;
    this.lastActivityAt = Date.now();
    this.createdAt = Date.now();

    // The permission gate and hooks resolve the destination for interactive
    // prompts through this, so they always address the turn in flight.
    state.currentWriter = () => this.activeTurn?.writer ?? this.writer;

    this.inputStream = createInputStream();
    this.query = (createQuery ?? query)({ prompt: this.inputStream, options: sdkOptions });
    this.readerDone = this.#readStream();
  }

  /**
   * Drains the SDK stream for the agent's whole lifetime.
   *
   * Unlike the per-turn runtime this replaces, the loop does not end at a
   * `result` — it parks until the next turn, whether that turn comes from the
   * user or from a cron job firing.
   */
  async #readStream() {
    try {
      for await (const message of this.query) {
        this.lastActivityAt = Date.now();

        if (!this.activeTurn) {
          if (!opensTurn(message)) {
            // Idle-window bookkeeping with no run to attribute it to.
            continue;
          }
          this.#beginSpontaneousTurn();
        }

        // After the turn exists, so a turn opened by its own first assistant
        // frame still has that frame's tool calls attributed to it.
        this.#noteSchedulingToolUse(message);

        // The agent is demonstrably listening, so the turn is free to take as
        // long as it needs from here on.
        if (this.activeTurn && !this.activeTurn.sawOutput) {
          this.activeTurn.sawOutput = true;
          this.#clearStartWatchdog();
        }

        const writer = this.activeTurn?.writer ?? null;
        if (writer) {
          this.route(message, writer, this.state);
        }

        if (message.type === 'result') {
          this.#endTurn(message, null);
        }
      }
    } catch (error) {
      if (!this.closed) {
        console.error(`[Claude pool] Session ${this.key} stream failed:`, error?.message || error);
        this.#endTurn(null, error);
      }
    } finally {
      this.#markClosed();
    }
  }

  /**
   * Watches a turn's tool calls for the two things the pool must know: that the
   * session owes the user work after this turn, and where its `/loop` stands.
   */
  #noteSchedulingToolUse(message) {
    if (message?.type !== 'assistant') {
      return;
    }
    const blocks = message.message?.content;
    if (!Array.isArray(blocks)) {
      return;
    }

    for (const block of blocks) {
      if (block?.type !== 'tool_use' || !SCHEDULING_TOOLS.has(block.name)) {
        continue;
      }

      if (!this.hasScheduledWork) {
        this.hasScheduledWork = true;
        console.log(`[Claude pool] Session ${this.key} scheduled work; keeping its agent alive.`);
      }

      const turn = this.activeTurn;
      if (!turn) {
        continue;
      }
      if (block.name === 'CronCreate') {
        turn.scheduledCron = true;
      } else if (block.input?.stop === true) {
        turn.stoppedLoop = true;
      } else {
        turn.armedWakeup = true;
        turn.wakeupDelaySeconds = block.input?.delaySeconds;
        turn.wakeupPrompt = typeof block.input?.prompt === 'string' ? block.input.prompt : null;
      }
    }
  }

  /**
   * Opens a run for a turn nobody asked for — a cron job or wake-up firing.
   *
   * Without a registered opener the output has no home, so it is dropped
   * rather than leaked onto whichever writer happened to be attached last.
   */
  #beginSpontaneousTurn() {
    const opened = this.openSpontaneousRun?.({
      sessionId: this.key,
      providerSessionId: this.state.capturedSessionId ?? null,
      // Whoever last drove this session owns its notifications.
      userId: this.writer?.userId ?? null,
    }) ?? null;

    this.spontaneousRun = opened;
    const isLoopTick = this.#isLoopWakeupDue();
    if (isLoopTick) {
      // The CLI fired the wakeup after all, so the pool's stand-in delivery for
      // it is off; this turn's own re-arm decides what comes next.
      this.#clearLoopTimer();
    }
    // Begun by a message that already arrived, and no caller is waiting on it,
    // so the start watchdog does not apply — the sweeper covers it stalling.
    this.activeTurn = {
      writer: opened?.writer ?? null,
      spontaneous: true,
      sawOutput: true,
      isLoopTick,
      loopPrompt: this.loop?.prompt ?? null,
    };

    if (!opened) {
      console.warn(
        `[Claude pool] Session ${this.key} produced a scheduled turn with nowhere to deliver it.`,
      );
    }
  }

  /**
   * Fails the turn if the agent never answers it.
   *
   * Closing is deliberate rather than just settling: an agent that swallowed
   * one turn will swallow the next one too, so it is dropped from the pool and
   * the user's next message starts a fresh subprocess.
   */
  #armStartWatchdog() {
    this.#clearStartWatchdog();
    this.startWatchdog = setTimeout(() => {
      this.startWatchdog = null;
      if (!this.activeTurn || this.activeTurn.sawOutput) {
        return;
      }
      console.error(
        `[Claude pool] Session ${this.key} produced no output within ${TURN_START_TIMEOUT_MS}ms; ` +
        'replacing its agent.',
      );
      this.close();
    }, TURN_START_TIMEOUT_MS);
    this.startWatchdog.unref?.();
  }

  #clearStartWatchdog() {
    if (this.startWatchdog) {
      clearTimeout(this.startWatchdog);
      this.startWatchdog = null;
    }
  }

  #endTurn(resultMessage, error) {
    const turn = this.activeTurn;
    this.activeTurn = null;
    this.#clearStartWatchdog();
    if (!turn) {
      return;
    }

    this.#reviewLoop(turn, error);

    if (turn.spontaneous) {
      const run = this.spontaneousRun;
      this.spontaneousRun = null;
      run?.complete({ exitCode: error ? 1 : 0 });
      return;
    }

    turn.settle({ result: resultMessage ?? null, error: error ?? null });
  }

  /**
   * Whether an unsolicited turn arriving now is this session's loop wakeup.
   *
   * A session can hold a dynamic loop and ordinary cron jobs at the same time,
   * and the fired prompt is not echoed back on the stream, so the arming time is
   * what separates them: the CLI rounds a wakeup up to the next minute boundary
   * and never fires before it, so anything arriving earlier belongs to some
   * other job and must not spend the loop's keepalive budget.
   */
  #isLoopWakeupDue() {
    return this.loop !== null && Date.now() >= this.loop.dueAt;
  }

  /**
   * Keeps the dynamic `/loop` alive across the two ways it silently stops.
   *
   * A tick that armed its own wakeup is covered until that wakeup is due, after
   * which the pool delivers it if the CLI has not. A tick that stopped the loop
   * outright needs nothing. A tick that armed nothing has ended the loop as far
   * as the CLI is concerned, so the pool delivers one more tick itself and lets
   * that tick decide whether the loop goes on.
   */
  #reviewLoop(turn, error) {
    if (turn.armedWakeup) {
      this.loop = {
        prompt: turn.wakeupPrompt ?? turn.loopPrompt ?? this.loop?.prompt ?? null,
        dueAt: Date.now() + clampWakeupDelay(turn.wakeupDelaySeconds) * 1000,
        keepalives: 0,
      };
      this.#armWakeupDeadline();
      return;
    }
    if (turn.stoppedLoop) {
      this.#cancelLoop('the model ended it');
      return;
    }
    if (!turn.isLoopTick || turn.interrupted || error || this.closed) {
      // An ordinary turn says nothing about the loop: a wakeup armed earlier is
      // still pending in the CLI and will fire on its own.
      return;
    }
    if (turn.scheduledCron) {
      // A fixed-interval `/loop` is a recurring cron, which re-fires by itself.
      this.loop = null;
      return;
    }

    const prompt = turn.loopPrompt ?? this.loop?.prompt ?? null;
    const keepalives = (this.loop?.keepalives ?? 0) + 1;
    if (!prompt) {
      this.#cancelLoop('its prompt is unknown, so there is nothing to re-tick with');
      return;
    }
    if (keepalives > LOOP_KEEPALIVE_BUDGET) {
      this.#cancelLoop('it declined to re-arm even on a free tick');
      return;
    }

    this.loop = { prompt, dueAt: Infinity, keepalives };
    this.#armLoopKeepalive();
  }

  #armLoopKeepalive() {
    const delay = loopKeepaliveDelayMs();
    console.log(
      `[Claude pool] Session ${this.key} ran a loop tick without arming a wakeup; ` +
      `delivering one more tick in ${Math.round(delay / 1000)}s.`,
    );
    // The tick is work the session still owes, so it has to outlive idle eviction.
    this.hasScheduledWork = true;
    this.#scheduleTick(delay, () => this.#deliverLoopKeepalive());
  }

  /**
   * Stands in for a wakeup the CLI has not fired by the time it is due.
   *
   * Armed after every tick that schedules one, and cleared the moment the CLI
   * delivers that tick itself, so the pool only acts on a wakeup that has gone
   * missing. A loop with no known prompt is left to the CLI: there is nothing to
   * re-tick with.
   */
  #armWakeupDeadline() {
    this.#clearLoopTimer();
    if (!this.loop?.prompt || !Number.isFinite(this.loop.dueAt)) {
      return;
    }
    this.#scheduleTick(
      Math.max(0, this.loop.dueAt - Date.now()) + wakeupGraceMs(),
      () => this.#deliverMissedWakeup(),
    );
  }

  /** Replaces the pending tick delivery with one that runs `deliver` after `delay`. */
  #scheduleTick(delay, deliver) {
    this.#clearLoopTimer();
    this.loopTimer = setTimeout(() => {
      this.loopTimer = null;
      deliver();
    }, delay);
    this.loopTimer.unref?.();
  }

  /**
   * Pushes the fallback tick once the session is quiet.
   *
   * A busy session is retried rather than skipped: the loop is only over when a
   * tick actually declines to re-arm, and dropping the delivery because the user
   * happened to be mid-turn would end it for the wrong reason.
   */
  #deliverLoopKeepalive() {
    if (this.closed || !this.loop) {
      return;
    }
    if (this.activeTurn) {
      this.#scheduleTick(LOOP_KEEPALIVE_RETRY_MS, () => this.#deliverLoopKeepalive());
      return;
    }

    this.#pushTick(buildKeepaliveTick(this.loop.prompt));
  }

  /**
   * Pushes the tick the CLI's wakeup owed this loop.
   *
   * A wakeup armed since this delivery was scheduled — by a tick the CLI did
   * fire, or by a later turn — moves the deadline out instead of firing now, so
   * a loop never gets two ticks for one wakeup.
   */
  #deliverMissedWakeup() {
    if (this.closed || !this.loop?.prompt) {
      return;
    }
    if (Date.now() < this.loop.dueAt + wakeupGraceMs()) {
      this.#armWakeupDeadline();
      return;
    }
    if (this.activeTurn) {
      this.#scheduleTick(LOOP_KEEPALIVE_RETRY_MS, () => this.#deliverMissedWakeup());
      return;
    }

    console.log(
      `[Claude pool] Session ${this.key} armed a wakeup the CLI never fired; ` +
      'delivering that loop tick from the pool.',
    );
    this.#pushTick(buildMissedWakeupTick(this.loop.prompt));
  }

  /** Sends a pool-authored loop tick into the session's input stream. */
  #pushTick(content) {
    // The turn this push produces is this loop's tick, not a stray cron fire.
    this.loop.dueAt = 0;
    this.inputStream.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
    });
  }

  #clearLoopTimer() {
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
  }

  #cancelLoop(reason) {
    this.#clearLoopTimer();
    if (this.loop) {
      console.log(`[Claude pool] Session ${this.key} loop ended — ${reason}.`);
      this.loop = null;
    }
  }

  /** Points the agent's output at the writer for the run that is about to start. */
  attachWriter(writer) {
    this.writer = writer;
  }

  /**
   * Applies the per-turn options the SDK can change in place.
   *
   * `cwd`, MCP servers and setting sources are baked into the subprocess and
   * are covered by the pool's fingerprint instead — a change there recreates
   * the agent rather than mutating it.
   */
  async applyTurnSettings({ model, permissionMode, allowedTools, disallowedTools }) {
    this.state.toolSettings = {
      allowedTools: allowedTools ?? [],
      disallowedTools: disallowedTools ?? [],
    };

    if (model && model !== this.state.model) {
      await this.query.setModel(model);
      this.state.model = model;
    }

    const nextMode = permissionMode ?? 'default';
    if (nextMode !== (this.state.permissionMode ?? 'default')) {
      await this.query.setPermissionMode(nextMode);
      this.state.permissionMode = nextMode;
    }
  }

  /** Pushes one user turn and resolves when the SDK reports its result. */
  runTurn(userMessage, writer) {
    if (this.closed) {
      return Promise.reject(new Error('Claude session is no longer running'));
    }
    // The chat layer refuses a second concurrent send per session, so this only
    // trips if a caller bypasses it — overwriting would strand the other turn.
    if (this.activeTurn) {
      return Promise.reject(new Error('Claude session already has a turn in flight'));
    }

    const loop = loopInvocation(userMessage);
    const deferred = createDeferred();
    this.activeTurn = {
      writer,
      settle: deferred.settle,
      spontaneous: false,
      sawOutput: false,
      isLoopTick: loop !== null,
      loopPrompt: loop?.prompt ?? null,
    };
    this.lastActivityAt = Date.now();
    this.#armStartWatchdog();
    this.inputStream.push(userMessage);

    return deferred.promise;
  }

  hasActiveTurn() {
    return this.activeTurn !== null;
  }

  /**
   * Stops the in-flight turn without ending the session.
   *
   * This is the behavioural difference that makes `/loop` survivable: aborting
   * a turn must not take the session's scheduled jobs down with it.
   */
  async interrupt() {
    if (this.closed || !this.activeTurn) {
      return false;
    }

    // The CLI drops a session's pending loop wakeups on user abort, so stopping
    // a reply must not leave the pool re-ticking a loop the CLI has let go. The
    // turn is flagged too: an interrupt surfaces as an ordinary `result`, which
    // would otherwise read as a tick that simply chose not to re-arm.
    this.activeTurn.interrupted = true;
    this.#cancelLoop('the turn was interrupted');

    try {
      await withTimeout(this.query.interrupt(), INTERRUPT_TIMEOUT_MS, 'interrupt');
    } catch (error) {
      // An agent that will not acknowledge an interrupt is not going to deliver
      // this turn either. Dropping it settles the turn and frees the session,
      // where waiting would leave the user with a Stop button that does nothing.
      console.warn(
        `[Claude pool] Session ${this.key} did not acknowledge interrupt (${error?.message || error}); ` +
        'closing its agent.',
      );
      this.close();
    }
    return true;
  }

  /** True once the agent has outlived its usefulness and may be evicted. */
  isExpired(now) {
    if (this.hasActiveTurn()) {
      // A turn this quiet for this long is not coming back, and it is holding
      // the chat layer's run open. Expiring the agent settles it.
      return now - this.lastActivityAt > STALLED_TURN_TIMEOUT_MS;
    }
    return this.hasScheduledWork
      ? now - this.createdAt > SCHEDULED_TTL_MS
      : now - this.lastActivityAt > IDLE_TTL_MS;
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.#clearStartWatchdog();
    this.#clearLoopTimer();
    this.#endTurn(null, new Error('Claude session closed'));
    try {
      this.inputStream.end();
      this.query.close();
    } catch (error) {
      console.error(`[Claude pool] Error closing session ${this.key}:`, error?.message || error);
    }
    this.onClosed?.(this);
  }

  #markClosed() {
    if (!this.closed) {
      this.closed = true;
      this.#clearLoopTimer();
      this.#endTurn(null, new Error('Claude session ended'));
    }
    this.onClosed?.(this);
  }
}

const agents = new Map();
let sweepTimer = null;

function startSweeping() {
  if (sweepTimer) {
    return;
  }
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const agent of [...agents.values()]) {
      if (agent.isExpired(now)) {
        console.log(`[Claude pool] Evicting idle session ${agent.key}`);
        agent.close();
      }
    }
    if (agents.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }, SWEEP_INTERVAL_MS);
  // Never hold the process open just to sweep.
  sweepTimer.unref?.();
}

/**
 * Frees a slot when the pool is full.
 *
 * Sessions with scheduled work are protected until they are the only thing
 * left to evict — dropping one silently kills a `/loop` the user set up, so
 * that case is logged loudly rather than passing unnoticed.
 */
function evictForCapacity() {
  if (agents.size < MAX_LIVE_AGENTS) {
    return;
  }

  const idle = [...agents.values()].filter((agent) => !agent.hasActiveTurn());
  if (idle.length === 0) {
    return;
  }

  const unscheduled = idle.filter((agent) => !agent.hasScheduledWork);
  const candidates = unscheduled.length > 0 ? unscheduled : idle;
  const victim = candidates.reduce((oldest, agent) =>
    agent.lastActivityAt < oldest.lastActivityAt ? agent : oldest,
  );

  if (victim.hasScheduledWork) {
    console.warn(
      `[Claude pool] At capacity (${MAX_LIVE_AGENTS}); closing session ${victim.key}, which has ` +
      'scheduled work. Its /loop or wake-up will not fire again. Raise ' +
      'CLOUDCLI_CLAUDE_MAX_LIVE_AGENTS to keep more sessions live.',
    );
  }
  victim.close();
}

export const claudeAgentPool = {
  /**
   * Returns the live agent for a session, creating it when absent and
   * recreating it when an option the subprocess cannot change has moved.
   */
  acquire({ key, fingerprint, sdkOptions, state, route, openSpontaneousRun, createQuery }) {
    const existing = agents.get(key);
    if (existing && !existing.closed) {
      if (existing.fingerprint === fingerprint) {
        return existing;
      }
      // cwd/MCP/setting-source changes cannot be applied to a running
      // subprocess, so the session restarts against the same transcript.
      console.log(`[Claude pool] Session ${key} options changed; restarting its agent.`);
      existing.close();
    }

    evictForCapacity();

    const agent = new PersistentClaudeAgent({
      key,
      fingerprint,
      sdkOptions,
      state,
      route,
      openSpontaneousRun,
      createQuery,
      onClosed: (closedAgent) => {
        if (agents.get(key) === closedAgent) {
          agents.delete(key);
        }
      },
    });

    agents.set(key, agent);
    startSweeping();
    return agent;
  },

  get(key) {
    const agent = agents.get(key);
    return agent && !agent.closed ? agent : undefined;
  },

  /** App session ids whose agent is mid-turn. */
  listBusyKeys() {
    return [...agents.values()].filter((agent) => agent.hasActiveTurn()).map((agent) => agent.key);
  },

  close(key) {
    agents.get(key)?.close();
  },

  closeAll() {
    for (const agent of [...agents.values()]) {
      agent.close();
    }
  },
};
