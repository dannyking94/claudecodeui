/**
 * Codex app-server transport — interactive tool approvals for Codex.
 * =================================================================
 *
 * The default Codex transport (`codex-runtime.provider.js`) drives
 * `@openai/codex-sdk`, which shells out to `codex exec --experimental-json`.
 * That is the CLI's *non-interactive* entry point: its event stream carries no
 * approval requests, its options object has no `canUseTool` equivalent, and its
 * stdin carries the prompt rather than replies. An approval that would be asked
 * for interactively is therefore resolved inside the CLI from the policy fixed
 * at spawn time, and never reaches the UI.
 *
 * `codex app-server` speaks the same engine over newline-delimited JSON-RPC on
 * stdio, and there the server issues *requests to the client* when it needs an
 * approval (`item/commandExecution/requestApproval` and friends). That is the
 * shape CloudCLI's permission banner already expects, so this module bridges
 * those requests onto the same `permission_request` / `chat.permission-response`
 * round trip the Claude runtime uses.
 *
 * Prototype, gated on `CODEX_APP_SERVER=true`: `app-server` is marked
 * experimental by the CLI, so the default transport stays untouched.
 *
 * Two further wins over `codex exec`, both structural:
 * - `thread/resume` and `turn/start` take `approvalPolicy`/`sandbox` as protocol
 *   fields, so a mode selected in the composer applies to every turn. Under the
 *   SDK the same settings are CLI flags placed before an `exec resume`
 *   subcommand that redeclares several of them.
 * - An approval can be *answered*, so `default` mode stops being "deny anything
 *   that needs escalation".
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';

import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled,
} from '@/modules/notifications/index.js';
import { createCompleteMessage, createNormalizedMessage, extractCodexTokenBudget } from '@/shared/utils.js';
import type {
  AnyRecord,
  ProviderPermissionDecision,
  ProviderRuntimeContext,
  ProviderRuntimePermissionGateway,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

/**
 * Consumed by `codex-runtime.provider.js` to pick a transport, and by
 * `provider-capabilities.service.ts` to report `supportsPermissionRequests`
 * for Codex — the UI must not offer a mode the active transport cannot honor.
 */
export function isCodexAppServerEnabled(): boolean {
  return process.env.CODEX_APP_SERVER === 'true';
}

/** Approval methods carrying the legacy `ReviewDecision` vocabulary. */
const LEGACY_APPROVAL_METHODS = new Set(['execCommandApproval', 'applyPatchApproval']);

/** Approval methods carrying the `accept | decline | cancel` vocabulary. */
const ITEM_APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
]);

/**
 * Approval requests this prototype cannot answer faithfully yet.
 *
 * `item/permissions/requestApproval` must reply with a `GrantedPermissionProfile`
 * and `item/tool/requestUserInput` with a structured `answers` array; guessing
 * either shape risks granting more than the user chose, so they are refused at
 * the JSON-RPC layer and logged instead.
 */
const UNSUPPORTED_APPROVAL_METHODS = new Set([
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
]);

type PendingApproval = {
  resolve(decision: ProviderPermissionDecision): void;
  sessionId: string | null;
  toolName: string;
  input: unknown;
  receivedAt: Date;
};

const pendingApprovals = new Map<string, PendingApproval>();

/** Sessions with a turn in flight, keyed by the app session id. */
const activeConnections = new Map<string, CodexAppServerConnection>();

let requestCounter = 0;
const nextRequestId = (): number => (requestCounter += 1);

let approvalCounter = 0;
const nextApprovalId = (): string => `codex-approval-${(approvalCounter += 1)}-${nextRequestId()}`;

/**
 * Resolves the `codex` launcher shipped with `@openai/codex`.
 *
 * `CODEX_CLI_PATH` wins so a user on a system-wide install is not forced onto
 * the bundled copy. The launcher is a Node script that re-execs the platform
 * binary, so it is spawned through the current interpreter rather than directly.
 */
function resolveCodexCommand(): { command: string; leadingArgs: string[] } {
  const override = process.env.CODEX_CLI_PATH?.trim();
  if (override) {
    return override.endsWith('.js')
      ? { command: process.execPath, leadingArgs: [override] }
      : { command: override, leadingArgs: [] };
  }

  const require = createRequire(import.meta.url);
  const launcher = require.resolve('@openai/codex/bin/codex.js');
  return { command: process.execPath, leadingArgs: [launcher] };
}

/** Maps a CloudCLI permission mode onto the app-server's thread-level fields. */
function resolveThreadPolicy(permissionMode: string): { sandbox: string; approvalPolicy: string } {
  switch (permissionMode) {
    case 'acceptEdits':
      return { sandbox: 'workspace-write', approvalPolicy: 'never' };
    case 'bypassPermissions':
      return { sandbox: 'danger-full-access', approvalPolicy: 'never' };
    case 'default':
    default:
      // `on-request` is the interactive policy: Codex asks only when a command
      // needs to escape the sandbox. `untrusted` (what the exec transport uses)
      // asks about nearly everything, which is unusable over a chat round trip.
      return { sandbox: 'workspace-write', approvalPolicy: 'on-request' };
  }
}

/**
 * Renders one approval request as the `{ toolName, input }` pair the existing
 * permission banner renders. Codex has no tool names in Claude's sense, so
 * command approvals borrow `Bash` and patch approvals `Edit` to reuse the
 * banner's per-tool panels and its `Bash(prefix:*)` allow-rule shorthand.
 */
function describeApproval(method: string, params: AnyRecord): { toolName: string; input: unknown } {
  const command = params.command;
  if (Array.isArray(command)) {
    return {
      toolName: 'Bash',
      input: { command: command.join(' '), cwd: params.cwd, reason: params.reason },
    };
  }

  if (typeof params.changes === 'object' || typeof params.fileChange === 'object') {
    return {
      toolName: 'Edit',
      input: { changes: params.changes ?? params.fileChange, cwd: params.cwd, reason: params.reason },
    };
  }

  return { toolName: method, input: params };
}

/** Translates a UI decision into the vocabulary the requesting method expects. */
function toCodexDecision(method: string, decision: ProviderPermissionDecision): AnyRecord {
  if (LEGACY_APPROVAL_METHODS.has(method)) {
    return { decision: decision.allow ? 'approved' : 'denied' };
  }
  return { decision: decision.allow ? 'accept' : 'decline' };
}

type CodexAppServerOptions = {
  sessionId: string;
  sessionSummary?: string;
  providerSessionId: string | null;
  cwd: string;
  model?: string;
  effort?: string;
  permissionMode: string;
  prompt: string;
};

/**
 * Reshapes a Codex event into the wire form `normalizeMessage` expects.
 *
 * Injected rather than imported: the only implementation lives in
 * `codex-runtime.provider.js`, which owns this transport's entry point, and
 * importing it back here would close a module cycle.
 */
type CodexEventTransformer = (event: AnyRecord) => unknown;

/**
 * Spawns the `codex app-server` child process.
 *
 * Overridable so tests can drive the transport against a fake server over the
 * same stdio framing; production always uses `spawnCodexAppServer`.
 */
type CodexAppServerSpawner = (cwd: string) => ChildProcess;

function spawnCodexAppServer(cwd: string): ChildProcess {
  const { command, leadingArgs } = resolveCodexCommand();
  return spawn(command, [...leadingArgs, 'app-server'], {
    cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * One `codex app-server` process driving one turn.
 *
 * The process is short-lived on purpose: this prototype keeps the exec
 * transport's turn-scoped lifetime so nothing else about session handling
 * changes. Holding the connection open across turns (as the Claude agent pool
 * does) is the natural follow-up once the approval path is proven.
 */
class CodexAppServerConnection {
  private child: ChildProcess | null = null;
  private stdoutBuffer = '';
  private readonly inflight = new Map<number, { resolve(value: AnyRecord): void; reject(error: Error): void }>();
  private threadId: string | null = null;
  private latestTokenUsage: AnyRecord | null = null;
  private latestRateLimits: AnyRecord | null = null;
  private turnCompletionStarted = false;
  private turnSettled = false;
  private aborted = false;

  constructor(
    private readonly options: CodexAppServerOptions,
    private readonly writer: ProviderRuntimeWriter,
    private readonly context: ProviderRuntimeContext,
    private readonly transformEvent: CodexEventTransformer,
    private readonly spawnServer: CodexAppServerSpawner,
  ) {}

  /** Runs the turn and resolves once the server reports it complete or failed. */
  async runTurn(): Promise<void> {
    this.child = this.spawnServer(this.options.cwd);

    const turnFinished = new Promise<void>((resolve, reject) => {
      this.settleTurn = (error) => {
        if (this.turnSettled) return;
        this.turnSettled = true;
        error ? reject(error) : resolve();
      };
    });

    this.child.stdout?.on('data', (chunk: Buffer) => this.consumeStdout(chunk.toString('utf8')));
    this.child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.error('[CodexAppServer] stderr:', text.slice(0, 500));
    });
    this.child.on('error', (error) => this.settleTurn?.(error instanceof Error ? error : new Error(String(error))));
    this.child.on('exit', (code) => {
      // A clean exit before turn/completed still has to settle the promise, or
      // the chat run would hang in "processing" forever.
      this.settleTurn?.(this.aborted ? undefined : code === 0 ? undefined : new Error(`codex app-server exited with code ${code}`));
    });

    await this.request('initialize', {
      clientInfo: { name: 'cloudcli', title: 'CloudCLI', version: 'prototype' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
    await this.refreshAccountRateLimits();
    this.emitTokenBudget();

    const policy = resolveThreadPolicy(this.options.permissionMode);
    const threadParams: AnyRecord = {
      cwd: this.options.cwd,
      model: this.options.model,
      sandbox: policy.sandbox,
      approvalPolicy: policy.approvalPolicy,
    };

    // Unlike the exec transport's CLI flags, these are protocol fields on both
    // start and resume, so the selected mode survives every turn.
    const thread = this.options.providerSessionId
      ? await this.request('thread/resume', { ...threadParams, threadId: this.options.providerSessionId })
      : await this.request('thread/start', threadParams);

    this.threadId = (thread.threadId as string) ?? (thread.thread?.id as string) ?? this.options.providerSessionId;
    if (!this.threadId) {
      throw new Error('codex app-server returned no thread id');
    }

    if (!this.options.providerSessionId) {
      this.writer.setSessionId?.(this.threadId);
      this.writer.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: this.threadId,
        sessionId: this.threadId,
        provider: 'codex',
      }));
    }

    await this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: this.options.prompt }],
      model: this.options.model,
      effort: this.options.effort,
      approvalPolicy: policy.approvalPolicy,
    });

    await turnFinished;
  }

  /** Set by `runTurn`; settles the promise the run awaits. */
  private settleTurn?: (error?: Error) => void;

  /** Interrupts the turn in flight. */
  async abort(): Promise<void> {
    this.aborted = true;
    if (this.threadId) {
      this.notify('turn/interrupt', { threadId: this.threadId });
    }
    // Give the server a moment to unwind its own turn before the process goes.
    setTimeout(() => this.dispose(), 1_000).unref?.();
  }

  dispose(): void {
    for (const [approvalId, pending] of pendingApprovals.entries()) {
      if (pending.sessionId === this.options.sessionId) {
        pending.resolve({ allow: false, message: 'Codex session ended' });
        pendingApprovals.delete(approvalId);
      }
    }
    this.child?.kill();
    this.child = null;
    this.settleTurn?.();
  }

  private send(payload: AnyRecord): void {
    this.child?.stdin?.write(`${JSON.stringify(payload)}\n`);
  }

  private notify(method: string, params: AnyRecord): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private request(method: string, params?: AnyRecord): Promise<AnyRecord> {
    const id = nextRequestId();
    return new Promise<AnyRecord>((resolve, reject) => {
      this.inflight.set(id, { resolve, reject });
      this.send({
        jsonrpc: '2.0',
        id,
        method,
        ...(params === undefined ? {} : { params }),
      });
    });
  }

  private consumeStdout(text: string): void {
    this.stdoutBuffer += text;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) {
        try {
          this.handleMessage(JSON.parse(line) as AnyRecord);
        } catch {
          // app-server writes only JSON-RPC on stdout; anything else is noise
          // from a wrapper script and is safe to drop.
        }
      }
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private handleMessage(message: AnyRecord): void {
    // A response to something we asked for.
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.inflight.get(message.id as number);
      if (!pending) return;
      this.inflight.delete(message.id as number);
      if (message.error) {
        const error = message.error as AnyRecord;
        pending.reject(new Error(`${message.id}: ${error.message ?? 'app-server error'}`));
        return;
      }
      pending.resolve((message.result as AnyRecord) ?? {});
      return;
    }

    // A request *from* the server — the approval path this module exists for.
    if (message.id !== undefined && typeof message.method === 'string') {
      void this.handleServerRequest(message);
      return;
    }

    if (typeof message.method === 'string') {
      this.handleNotification(message.method, (message.params as AnyRecord) ?? {});
    }
  }

  private async handleServerRequest(message: AnyRecord): Promise<void> {
    const method = message.method as string;
    const params = (message.params as AnyRecord) ?? {};

    if (UNSUPPORTED_APPROVAL_METHODS.has(method)) {
      console.warn(`[CodexAppServer] refusing unsupported approval request "${method}"`);
      this.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `CloudCLI cannot answer ${method} yet` },
      });
      return;
    }

    if (!LEGACY_APPROVAL_METHODS.has(method) && !ITEM_APPROVAL_METHODS.has(method)) {
      this.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unhandled server request ${method}` },
      });
      return;
    }

    const decision = await this.askUser(method, params);
    this.send({ jsonrpc: '2.0', id: message.id, result: toCodexDecision(method, decision) });
  }

  /** Sends the approval to the UI and waits for the user's answer. */
  private askUser(method: string, params: AnyRecord): Promise<ProviderPermissionDecision> {
    const { toolName, input } = describeApproval(method, params);
    const approvalId = nextApprovalId();

    return new Promise<ProviderPermissionDecision>((resolve) => {
      pendingApprovals.set(approvalId, {
        resolve: (decision) => {
          pendingApprovals.delete(approvalId);
          resolve(decision);
        },
        sessionId: this.options.sessionId,
        toolName,
        input,
        receivedAt: new Date(),
      });

      this.writer.send(createNormalizedMessage({
        kind: 'permission_request',
        requestId: approvalId,
        toolName,
        input,
        sessionId: this.threadId ?? this.options.sessionId,
        provider: 'codex',
      }));

      // A turn blocked on approval makes no further progress, so the user has to
      // be told even when the tab is in the background.
      notifyUserIfEnabled({
        userId: this.writer.userId ?? null,
        event: createNotificationEvent({
          provider: 'codex',
          sessionId: this.options.sessionId || null,
          kind: 'action_required',
          code: 'permission.required',
          meta: { toolName, sessionName: this.options.sessionSummary },
          severity: 'warning',
          requiresUserAction: true,
          dedupeKey: `codex:permission:${this.options.sessionId || 'none'}:${approvalId}`,
        }),
      });
    });
  }

  /**
   * Bridges app-server notifications onto the exec transport's event shapes so
   * they pass through the same `transformCodexEvent` + `normalizeMessage`
   * pipeline. The UI therefore renders an app-server turn identically to an
   * exec turn, and no new message kind is introduced.
   *
   * `item/started` is dropped for the same reason the exec path skips
   * `item.started`: only completed items become transcript entries. Streaming
   * deltas (`item/agentMessage/delta`) are dropped for now — wiring them to
   * `stream_delta` is a follow-up, not part of proving the approval path.
   */
  private handleNotification(method: string, params: AnyRecord): void {
    switch (method) {
      case 'thread/started': {
        const startedId = (params.threadId as string) ?? null;
        if (startedId && !this.threadId) this.threadId = startedId;
        return;
      }
      case 'item/completed': {
        this.emitProviderEvent({ type: 'item.completed', item: params.item });
        return;
      }
      case 'thread/tokenUsage/updated': {
        this.latestTokenUsage = (params.tokenUsage as AnyRecord) ?? null;
        return;
      }
      case 'account/rateLimits/updated': {
        this.latestRateLimits = {
          ...(this.latestRateLimits ?? {}),
          ...((params.rateLimits as AnyRecord) ?? {}),
        };
        return;
      }
      case 'turn/completed': {
        this.finishTurn(params);
        return;
      }
      case 'turn/failed': {
        this.settleTurn?.(new Error(String((params.error as AnyRecord)?.message ?? 'Codex turn failed')));
        return;
      }
      default:
        return;
    }
  }

  /** Reads the signed-in GPT account snapshot used by the composer percentage pill. */
  private async refreshAccountRateLimits(): Promise<void> {
    try {
      const response = await this.request('account/rateLimits/read');
      this.latestRateLimits = (response.rateLimits as AnyRecord) ?? this.latestRateLimits;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[CodexAppServer] failed to read account rate limits: ${message}`);
    }
  }

  /** Emits the latest app-server token and account snapshots through the normal status event. */
  private emitTokenBudget(tokenUsage: AnyRecord | null = this.latestTokenUsage): void {
    const tokenBudget = extractCodexTokenBudget({
      tokenUsage,
      rateLimits: this.latestRateLimits,
    });

    if (!tokenBudget) return;
    this.writer.send(createNormalizedMessage({
      kind: 'status',
      text: 'token_budget',
      tokenBudget,
      sessionId: this.options.sessionId || this.threadId,
      provider: 'codex',
    }));
  }

  /** Flushes the final token snapshot before the transport reports completion. */
  private finishTurn(params: AnyRecord): void {
    if (this.turnCompletionStarted) return;
    this.turnCompletionStarted = true;

    const tokenUsage = (params.usage as AnyRecord)
      ?? (params.tokenUsage as AnyRecord)
      ?? this.latestTokenUsage;
    this.emitTokenBudget(tokenUsage);

    this.emitProviderEvent({ type: 'turn.completed', usage: tokenUsage });
    this.settleTurn?.();
  }

  private emitProviderEvent(event: AnyRecord): void {
    const sessionId = this.threadId ?? this.options.sessionId ?? null;
    for (const message of this.context.normalizeMessage(this.transformEvent(event), sessionId)) {
      this.writer.send(message);
    }
  }
}

/**
 * Consumed by `codex-runtime.provider.js` when `CODEX_APP_SERVER=true`.
 *
 * Mirrors the exec transport's contract: emits `session_created` for a brand-new
 * thread, streams provider events, and ends with exactly one `complete`.
 */
export async function queryCodexViaAppServer(
  command: string,
  options: AnyRecord,
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
  transformEvent: CodexEventTransformer,
  // Tests substitute a fake app-server; production callers omit it.
  spawnServer: CodexAppServerSpawner = spawnCodexAppServer,
): Promise<void> {
  const sessionId = (options.sessionId as string) ?? '';
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  const model = await context.resolveResumeModel(sessionId, options.model as string | undefined);
  const cwd = (options.cwd as string) ?? (options.projectPath as string) ?? process.cwd();

  const connection = new CodexAppServerConnection(
    {
      sessionId,
      sessionSummary: options.sessionSummary as string | undefined,
      providerSessionId,
      cwd,
      model,
      effort: typeof options.effort === 'string' && options.effort !== 'default' ? options.effort : undefined,
      permissionMode: (options.permissionMode as string) ?? 'default',
      prompt: command,
    },
    writer,
    context,
    transformEvent,
    spawnServer,
  );

  if (sessionId) activeConnections.set(sessionId, connection);

  let failure: Error | null = null;
  try {
    await connection.runTurn();
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    console.error('[CodexAppServer] turn failed:', failure.message);
    writer.send(createNormalizedMessage({
      kind: 'error',
      content: failure.message,
      sessionId,
      provider: 'codex',
    }));
  } finally {
    connection.dispose();
    if (sessionId) activeConnections.delete(sessionId);
    writer.send(createCompleteMessage({
      sessionId,
      provider: 'codex',
      exitCode: failure ? 1 : 0,
    }));

    const notification = {
      userId: writer.userId ?? null,
      provider: 'codex' as const,
      sessionId: sessionId || null,
      sessionName: options.sessionSummary as string | undefined,
    };
    if (failure) notifyRunFailed({ ...notification, error: failure });
    else notifyRunStopped({ ...notification, stopReason: 'completed' });
  }
}

/** Consumed by `codex-runtime.provider.js` to route aborts to this transport. */
export function abortCodexAppServerSession(sessionId: string): boolean {
  const connection = activeConnections.get(sessionId);
  if (!connection) return false;
  void connection.abort();
  return true;
}

/**
 * Consumed by `codex-runtime.provider.js`, which exposes it as the Codex
 * runtime's `permissions` gateway. `provider-runtime.service.ts` broadcasts
 * `chat.permission-response` to every runtime's gateway, so no websocket
 * changes are needed for Codex approvals to resolve.
 */
export const codexAppServerPermissions: ProviderRuntimePermissionGateway = {
  resolve(requestId, decision) {
    pendingApprovals.get(requestId)?.resolve(decision);
  },
  listPending(sessionId) {
    const pending = [];
    for (const [requestId, approval] of pendingApprovals.entries()) {
      if (approval.sessionId === sessionId) {
        pending.push({
          requestId,
          toolName: approval.toolName,
          input: approval.input,
          sessionId,
          receivedAt: approval.receivedAt,
        });
      }
    }
    return pending;
  },
};
