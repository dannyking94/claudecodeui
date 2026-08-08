/**
 * Liveness guarantees for the persistent agent pool.
 *
 * These cover the failure that is invisible from inside the pool: the
 * subprocess is alive and its stream is open, but nothing consumes input any
 * more. The turn is queued forever, `runTurn` never settles, and the chat layer
 * holds its run open — which refuses every later `chat.send` for that session
 * and leaves the user with a chat that answers nothing.
 *
 * The timeouts are read from the environment when the pool module loads, so
 * they are set here before the dynamic import.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CLOUDCLI_CLAUDE_TURN_START_TIMEOUT_MS = '150';
process.env.CLOUDCLI_CLAUDE_INTERRUPT_TIMEOUT_MS = '150';

const { claudeAgentPool } = await import('@/modules/providers/list/claude/claude-agent-pool.provider.js');

/** A query that never delivers anything — the shape of a wedged agent. */
function createSilentQuery({ interruptHangs = false } = {}) {
  let ended = false;
  let deliver = null;
  const pending = [];

  return {
    closed: false,
    interrupts: 0,
    emit(message) {
      if (deliver) {
        const resolve = deliver;
        deliver = null;
        resolve({ value: message, done: false });
        return;
      }
      pending.push(message);
    },
    async interrupt() {
      this.interrupts += 1;
      if (interruptHangs) {
        await new Promise(() => {});
      }
    },
    async setModel() {},
    async setPermissionMode() {},
    close() {
      this.closed = true;
      ended = true;
      if (deliver) {
        const resolve = deliver;
        deliver = null;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (pending.length > 0) return Promise.resolve({ value: pending.shift(), done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { deliver = resolve; });
        },
      };
    },
  };
}

function setup(key, query) {
  const agent = claudeAgentPool.acquire({
    key,
    fingerprint: 'fp',
    sdkOptions: {},
    state: {
      appSessionId: key,
      capturedSessionId: null,
      toolSettings: { allowedTools: [], disallowedTools: [] },
      permissionMode: undefined,
      model: 'model-a',
      currentWriter: () => null,
    },
    route: () => {},
    openSpontaneousRun: null,
    createQuery: () => query,
  });
  return agent;
}

test.afterEach(() => {
  claudeAgentPool.closeAll();
});

/**
 * The pool's timers are `unref`'d so a watchdog can never hold the server
 * process open. That also means they cannot keep the *test* runner's event loop
 * alive, so each test anchors it explicitly while it waits.
 */
function anchorEventLoop() {
  const timer = setInterval(() => {}, 20);
  return () => clearInterval(timer);
}

test('a turn that never produces output is failed instead of hanging forever', async () => {
  const release = anchorEventLoop();
  const query = createSilentQuery();
  const agent = setup('wedged', query);

  const settled = await agent.runTurn({ type: 'user' }, { id: 'writer' });
  release();

  // The caller gets an answer, so the chat layer can complete its run and the
  // session accepts the user's next message.
  assert.ok(settled.error, 'expected the stalled turn to settle with an error');
  assert.equal(agent.hasActiveTurn(), false);

  // The agent is dropped, so the next send builds a fresh subprocess rather
  // than pushing into the same dead stream.
  assert.equal(query.closed, true);
  assert.equal(claudeAgentPool.get('wedged'), undefined);
});

test('a turn that starts talking is not cut off by the start watchdog', async () => {
  const release = anchorEventLoop();
  const query = createSilentQuery();
  const agent = setup('healthy', query);

  const turn = agent.runTurn({ type: 'user' }, { id: 'writer' });
  query.emit({ type: 'system', subtype: 'init', session_id: 'p' });

  // Well past the start timeout: once the agent has proven it is listening, a
  // turn may take as long as it needs.
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(agent.hasActiveTurn(), true, 'a live turn must not be killed for being slow');

  query.emit({ type: 'result', subtype: 'success' });
  const settled = await turn;
  release();
  assert.equal(settled.error, null);
  assert.equal(query.closed, false);
});

test('an agent that will not acknowledge an interrupt is dropped', async () => {
  const release = anchorEventLoop();
  const query = createSilentQuery({ interruptHangs: true });
  const agent = setup('stubborn', query);

  const turn = agent.runTurn({ type: 'user' }, { id: 'writer' });
  query.emit({ type: 'system', subtype: 'init', session_id: 'p' });

  // Stop must never leave the user with a button that does nothing.
  assert.equal(await agent.interrupt(), true);
  assert.equal(query.closed, true);
  assert.equal(claudeAgentPool.get('stubborn'), undefined);

  const settled = await turn;
  release();
  assert.ok(settled.error, 'closing the agent must settle the turn it was holding');
});
