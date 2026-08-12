import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  codexAppServerPermissions,
  isCodexAppServerEnabled,
  queryCodexViaAppServer,
} from '@/modules/providers/list/codex/codex-app-server.provider.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';

/**
 * A fake `codex app-server`: speaks the same newline-delimited JSON-RPC over
 * stdio, issues one command-approval request per turn, and records the params it
 * was given so the test can assert what the transport sent.
 *
 * In-memory pipes keep newline framing and request correlation under test
 * without depending on the host sandbox allowing nested child processes.
 */
function spawnFakeAppServer(): ChildProcess {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let buffer = '';
  let killed = false;

  const send = (message: AnyRecord) => stdout.write(`${JSON.stringify(message)}\n`);
  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;

      const message = JSON.parse(line) as AnyRecord;
      if (message.method === 'initialize') {
        send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (message.method === 'account/rateLimits/read') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: 42, windowDurationMins: 10_080, resetsAt: 1_900_000_000 },
              secondary: null,
              planType: 'pro',
            },
          },
        });
      } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
        const params = message.params as AnyRecord;
        send({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: {
            item: {
              id: 'policy',
              type: 'agent_message',
              text: `sandbox:${params.sandbox} approval:${params.approvalPolicy}`,
            },
          },
        });
        send({ jsonrpc: '2.0', id: message.id, result: { threadId: 'thread-1' } });
      } else if (message.method === 'turn/start') {
        send({
          jsonrpc: '2.0',
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thread-1',
            turnId: 't1',
            tokenUsage: {
              total: {
                totalTokens: 81,
                inputTokens: 70,
                cachedInputTokens: 0,
                outputTokens: 11,
                reasoningOutputTokens: 0,
              },
              last: {
                totalTokens: 81,
                inputTokens: 70,
                cachedInputTokens: 0,
                outputTokens: 11,
                reasoningOutputTokens: 0,
              },
              modelContextWindow: 258_400,
            },
          },
        });
        send({
          jsonrpc: '2.0',
          id: 9001,
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 't1',
            itemId: 'i1',
            cwd: '/tmp',
            command: ['/bin/bash', '-lc', 'echo hello'],
            reason: 'needs escalation',
          },
        });
        send({ jsonrpc: '2.0', id: message.id, result: {} });
      } else if (message.id === 9001) {
        const result = message.result as AnyRecord;
        send({
          jsonrpc: '2.0',
          method: 'item/completed',
          params: {
            item: { id: 'decision', type: 'agent_message', text: `decision:${result.decision}` },
          },
        });
        send({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { threadId: 'thread-1', turn: { id: 't1', status: 'completed', items: [] } },
        });
      }
    }
  });

  return Object.assign(events, {
    stdin,
    stdout,
    stderr,
    kill() {
      if (killed) return true;
      killed = true;
      stdin.end();
      stdout.end();
      stderr.end();
      queueMicrotask(() => events.emit('exit', 0, null));
      return true;
    },
  }) as unknown as ChildProcess;
}

type Captured = { kind?: string; [key: string]: unknown };

function createWriter(captured: Captured[]): ProviderRuntimeWriter {
  return {
    send(data) {
      captured.push(data as Captured);
    },
    setSessionId() {},
  };
}

function createContext(providerSessionId: string | null): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => providerSessionId,
    resolveResumeModel: async () => 'gpt-5-codex',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: '' }) as never,
    // Pass the transformed event straight through as one text message so the
    // test can read what the transport streamed.
    normalizeMessage: (raw, sessionId) => [
      { kind: 'text', content: JSON.stringify(raw), sessionId: sessionId ?? '', provider: 'codex' } as never,
    ],
    isProviderInstalled: async () => true,
  };
}

test('isCodexAppServerEnabled is opt-in', () => {
  const previous = process.env.CODEX_APP_SERVER;
  delete process.env.CODEX_APP_SERVER;
  assert.equal(isCodexAppServerEnabled(), false);
  process.env.CODEX_APP_SERVER = 'true';
  assert.equal(isCodexAppServerEnabled(), true);
  process.env.CODEX_APP_SERVER = '1';
  assert.equal(isCodexAppServerEnabled(), false, 'only the literal "true" enables it');
  if (previous === undefined) delete process.env.CODEX_APP_SERVER;
  else process.env.CODEX_APP_SERVER = previous;
});

test('an approval reaches the UI and the user\'s allow is sent back to Codex', async () => {
  const captured: Captured[] = [];
  const writer = createWriter(captured);

  const turn = queryCodexViaAppServer(
    'run echo hello',
    { sessionId: 'app-session-1', cwd: '/tmp', permissionMode: 'bypassPermissions' },
    writer,
    createContext(null),
    (event) => event,
    spawnFakeAppServer,
  );

  // Wait for the permission_request to surface, then answer it.
  const request = await new Promise<Captured>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = setInterval(() => {
      const found = captured.find((message) => message.kind === 'permission_request');
      if (found) {
        clearInterval(poll);
        resolve(found);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`no permission_request was emitted; captured=${JSON.stringify(captured)}`));
      }
    }, 20);
  });

  assert.equal(request.toolName, 'Bash', 'command approvals render through the Bash panel');
  assert.deepEqual(
    (request.input as { command: string }).command,
    '/bin/bash -lc echo hello',
    'the argv array is joined for display',
  );

  codexAppServerPermissions.resolve(String(request.requestId), { allow: true });
  await turn;

  const streamed = captured.filter((message) => message.kind === 'text').map((message) => String(message.content));
  assert.ok(
    streamed.some((text) => text.includes('decision:accept')),
    `Codex should have received accept; streamed: ${streamed.join(' | ')}`,
  );
  assert.ok(
    streamed.some((text) => text.includes('sandbox:danger-full-access approval:never')),
    `bypassPermissions must reach the protocol as a thread policy; streamed: ${streamed.join(' | ')}`,
  );

  const created = captured.find((message) => message.kind === 'session_created');
  assert.equal(created?.newSessionId, 'thread-1', 'a brand-new thread is announced to the client');

  const complete = captured.filter((message) => message.kind === 'complete');
  assert.equal(complete.length, 1, 'exactly one terminal complete');
  assert.equal(complete[0]?.exitCode, 0);

  const tokenBudget = captured
    .filter((message) => message.kind === 'status' && message.text === 'token_budget')
    .at(-1);
  assert.equal(tokenBudget?.sessionId, 'app-session-1');
  assert.equal((tokenBudget?.tokenBudget as AnyRecord)?.used, 81);
  assert.equal(
    ((tokenBudget?.tokenBudget as AnyRecord)?.accountUsage as AnyRecord)?.sevenDay?.utilization,
    42,
    'the GPT percentage is forwarded from account/rateLimits/read',
  );
});

test('a denied approval is reported to Codex as decline', async () => {
  const captured: Captured[] = [];

  const turn = queryCodexViaAppServer(
    'run echo hello',
    { sessionId: 'app-session-2', cwd: '/tmp', permissionMode: 'default' },
    createWriter(captured),
    createContext('thread-1'),
    (event) => event,
    spawnFakeAppServer,
  );

  const request = await new Promise<Captured>((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = setInterval(() => {
      const found = captured.find((message) => message.kind === 'permission_request');
      if (found) {
        clearInterval(poll);
        resolve(found);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`no permission_request was emitted; captured=${JSON.stringify(captured)}`));
      }
    }, 20);
  });

  // While the approval is outstanding it must be replayable to a reconnecting
  // client, which is what `chat.subscribe` uses.
  const pending = codexAppServerPermissions.listPending('app-session-2') as Array<{ requestId: string }>;
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.requestId, String(request.requestId));

  codexAppServerPermissions.resolve(String(request.requestId), { allow: false });
  await turn;

  const streamed = captured.filter((message) => message.kind === 'text').map((message) => String(message.content));
  assert.ok(
    streamed.some((text) => text.includes('decision:decline')),
    `Codex should have received decline; streamed: ${streamed.join(' | ')}`,
  );
  assert.ok(
    // The exec transport loses these on `exec resume`; as protocol fields on
    // thread/resume they apply to every turn, which is the point of the swap.
    streamed.some((text) => text.includes('sandbox:workspace-write approval:on-request')),
    `a resumed thread must still carry the selected policy; streamed: ${streamed.join(' | ')}`,
  );
  assert.equal(
    codexAppServerPermissions.listPending('app-session-2').length,
    0,
    'the resolved approval is no longer pending',
  );
  assert.ok(
    !captured.some((message) => message.kind === 'session_created'),
    'a resumed thread must not re-announce a session',
  );
});
