/**
 * Claude SDK Integration
 *
 * This module provides SDK-based integration with Claude using the @anthropic-ai/claude-agent-sdk.
 * It mirrors the interface of claude-cli.js but uses the SDK internally for better performance
 * and maintainability.
 *
 * Key features:
 * - Direct SDK integration without child processes
 * - Session management with abort capability
 * - Options mapping between CLI and SDK formats
 * - WebSocket message streaming
 */

import crypto from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  appendFilesInputTag,
  buildClaudeUserContent,
  normalizeImageDescriptors
} from '@/shared/image-attachments.js';
import { claudeAgentPool } from '@/modules/providers/list/claude/claude-agent-pool.provider.js';
import { CLAUDE_FALLBACK_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { restampClaudeTranscriptEntrypoint } from '@/modules/providers/list/claude/claude-transcript-entrypoint.provider.js';
import { resolveClaudeCodeExecutablePath } from '@/shared/claude-cli-path.js';
import {
  createNotificationEvent,
  notifyRunFailed,
  notifyRunStopped,
  notifyUserIfEnabled
} from '@/modules/notifications/index.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

const activeSessions = new Map();
const pendingToolApprovals = new Map();
// Sessions cancelled via abort-session. The abort handler already sent the
// terminal `complete` (aborted: true) to the client, so the run loop must not
// emit a second one when its generator winds down.
const abortedSessionIds = new Set();

const TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000;

const TOOLS_REQUIRING_INTERACTION = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * Opens a chat run for a turn that no `chat.send` asked for.
 *
 * Scheduled work (`/loop`'s cron jobs, `/goal`'s wake-ups) produces turns while
 * the session sits idle. Those need a run registered with the chat layer or
 * their output has nowhere to go, so the websocket module installs an opener
 * here at startup. Left unset — SSE and agent-route callers, and tests — the
 * pool simply drops unsolicited output.
 */
let spontaneousRunOpener = null;

/**
 * Registers the chat-layer hook used to surface unsolicited turns.
 * @param {import('@/shared/types.js').SpontaneousRunOpener | null} opener
 */
function setSpontaneousRunOpener(opener) {
  spontaneousRunOpener = typeof opener === 'function' ? opener : null;
}

function resolveClaudeEffort(model, effort, modelsDefinition = CLAUDE_FALLBACK_MODELS) {
  const selectedModel = modelsDefinition?.OPTIONS?.find((option) => option.value === model) || null;
  const allowedEfforts = selectedModel?.effort?.values
    ?.map((value) => value.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowedEfforts.includes(effort)
    ? effort
    : undefined;
}

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function waitForToolApproval(requestId, options = {}) {
  const { timeoutMs = TOOL_APPROVAL_TIMEOUT_MS, signal, onCancel, metadata } = options;

  return new Promise(resolve => {
    let settled = false;

    const finalize = (decision) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(decision);
    };

    let timeout;

    const cleanup = () => {
      pendingToolApprovals.delete(requestId);
      if (timeout) clearTimeout(timeout);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    // timeoutMs 0 = wait indefinitely (interactive tools)
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onCancel?.('timeout');
        finalize(null);
      }, timeoutMs);
    }

    const abortHandler = () => {
      onCancel?.('cancelled');
      finalize({ cancelled: true });
    };

    if (signal) {
      if (signal.aborted) {
        onCancel?.('cancelled');
        finalize({ cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const resolver = (decision) => {
      finalize(decision);
    };
    // Attach metadata for getPendingApprovalsForSession lookup
    if (metadata) {
      Object.assign(resolver, metadata);
    }
    pendingToolApprovals.set(requestId, resolver);
  });
}

function resolveToolApproval(requestId, decision) {
  const resolver = pendingToolApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

// Match stored permission entries against a tool + input combo.
// This only supports exact tool names and the Bash(command:*) shorthand
// used by the UI; it intentionally does not implement full glob semantics,
// introduced to stay consistent with the UI's "Allow rule" format.
function matchesToolPermission(entry, toolName, input) {
  if (!entry || !toolName) {
    return false;
  }

  if (entry === toolName) {
    return true;
  }

  const bashMatch = entry.match(/^Bash\((.+):\*\)$/);
  if (toolName === 'Bash' && bashMatch) {
    const allowedPrefix = bashMatch[1];
    let command = '';

    if (typeof input === 'string') {
      command = input.trim();
    } else if (input && typeof input === 'object' && typeof input.command === 'string') {
      command = input.command.trim();
    }

    if (!command) {
      return false;
    }

    return command.startsWith(allowedPrefix);
  }

  return false;
}

function mapCliOptionsToSDK(options = {}) {
  const { providerSessionId, cwd, toolsSettings, permissionMode, effort } = options;

  const sdkOptions = {};

  // Forward all host env vars (e.g. ANTHROPIC_BASE_URL) to the subprocess.
  // Since SDK 0.2.113, options.env replaces process.env instead of overlaying it.
  sdkOptions.env = { ...process.env };

  // Left unset, the SDK marks the subprocess "sdk-ts". This keeps the value
  // honest for anything that reads the env before the CLI boots, but it does
  // NOT reach the transcript: the CLI overwrites CLAUDE_CODE_ENTRYPOINT with
  // "sdk-cli" whenever it is driven over --input-format stream-json, and that
  // is what it stamps into every record. Transcript visibility in Claude
  // Code's VS Code extension is handled by claude-transcript-entrypoint.provider.
  sdkOptions.env.CLAUDE_CODE_ENTRYPOINT ??= 'cli';

  // Resolve the executable eagerly on Windows because the SDK uses raw child_process.spawn,
  // which does not reliably follow npm's shell wrappers like cross-spawn does.
  sdkOptions.pathToClaudeCodeExecutable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);

  if (cwd) {
    sdkOptions.cwd = cwd;
  }

  if (permissionMode && permissionMode !== 'default') {
    sdkOptions.permissionMode = permissionMode;
  }

  const settings = toolsSettings || {
    allowedTools: [],
    disallowedTools: [],
    skipPermissions: false
  };

  if (settings.skipPermissions && permissionMode !== 'plan') {
    sdkOptions.permissionMode = 'bypassPermissions';
  }

  let allowedTools = [...(settings.allowedTools || [])];

  if (permissionMode === 'plan') {
    const planModeTools = ['Read', 'Task', 'exit_plan_mode', 'TodoRead', 'TodoWrite', 'WebFetch', 'WebSearch'];
    for (const tool of planModeTools) {
      if (!allowedTools.includes(tool)) {
        allowedTools.push(tool);
      }
    }
  }

  sdkOptions.allowedTools = allowedTools;

  // Use the tools preset to make all default built-in tools available (including AskUserQuestion).
  // This was introduced in SDK 0.1.57. Omitting this preserves existing behavior (all tools available),
  // but being explicit ensures forward compatibility and clarity.
  sdkOptions.tools = { type: 'preset', preset: 'claude_code' };

  sdkOptions.disallowedTools = settings.disallowedTools || [];

  sdkOptions.model = options.model || CLAUDE_FALLBACK_MODELS.DEFAULT;

  const resolvedEffort = resolveClaudeEffort(
    sdkOptions.model,
    effort,
    options.effortModels || CLAUDE_FALLBACK_MODELS,
  );
  if (resolvedEffort) {
    sdkOptions.effort = resolvedEffort;
  }

  sdkOptions.systemPrompt = {
    type: 'preset',
    preset: 'claude_code'
  };

  sdkOptions.settingSources = ['project', 'user', 'local'];

  // The SDK resumes with the provider-native session id, never the app id.
  if (providerSessionId) {
    sdkOptions.resume = providerSessionId;
  }

  return sdkOptions;
}

/**
 * Adds a session to the active sessions map
 * @param {string} sessionId - Session identifier
 * @param {Object} queryInstance - SDK query instance
 * @param {Object} writer - WebSocket writer for reconnect support
 */
function addSession(sessionId, queryInstance, writer = null) {
  activeSessions.set(sessionId, {
    instance: queryInstance,
    startTime: Date.now(),
    status: 'active',
    writer
  });
}

/**
 * Removes a session from the active sessions map
 * @param {string} sessionId - Session identifier
 */
function removeSession(sessionId) {
  activeSessions.delete(sessionId);
}

/**
 * Gets a session from the active sessions map
 * @param {string} sessionId - Session identifier
 * @returns {Object|undefined} Session data or undefined
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Gets all active session IDs
 * @returns {Array<string>} Array of active session IDs
 */
function getAllSessions() {
  return Array.from(activeSessions.keys());
}

/**
 * Transforms SDK messages to WebSocket format expected by frontend
 * @param {Object} sdkMessage - SDK message object
 * @returns {Object} Transformed message ready for WebSocket
 */
function transformMessage(sdkMessage) {
  // Extract parent_tool_use_id for subagent tool grouping
  if (sdkMessage.parent_tool_use_id) {
    return {
      ...sdkMessage,
      parentToolUseId: sdkMessage.parent_tool_use_id
    };
  }
  return sdkMessage;
}

function readNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Extracts token usage from SDK messages.
 * Prefers per-step `message.usage` (Claude message payload), then falls back
 * to result-level usage/modelUsage for compatibility across SDK versions.
 * @param {Object} sdkMessage - SDK stream message
 * @returns {Object|null} Token budget object or null
 */
function extractTokenBudget(sdkMessage) {
  if (!sdkMessage || typeof sdkMessage !== 'object') {
    return null;
  }

  const messageUsage = sdkMessage.message?.usage || sdkMessage.usage;
  if (messageUsage && typeof messageUsage === 'object') {
    const directInputTokens = readNumber(messageUsage.input_tokens ?? messageUsage.inputTokens);
    const cacheCreationTokens = readNumber(messageUsage.cache_creation_input_tokens ?? messageUsage.cacheCreationInputTokens ?? messageUsage.cacheCreationTokens);
    const cacheReadTokens = readNumber(messageUsage.cache_read_input_tokens ?? messageUsage.cacheReadInputTokens ?? messageUsage.cacheReadTokens);
    const cacheTokens = cacheCreationTokens + cacheReadTokens;
    const inputTokens = directInputTokens + cacheTokens;
    const outputTokens = readNumber(messageUsage.output_tokens ?? messageUsage.outputTokens);
    const totalUsed = inputTokens + outputTokens;
    const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

    return {
      used: totalUsed,
      total: contextWindow,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      cacheTokens,
      breakdown: {
        input: inputTokens,
        output: outputTokens,
      },
    };
  }

  if (!sdkMessage.modelUsage || typeof sdkMessage.modelUsage !== 'object') {
    return null;
  }

  // Fallback for older SDK messages with only modelUsage
  const modelKey = Object.keys(sdkMessage.modelUsage)[0];
  const modelData = sdkMessage.modelUsage[modelKey];

  if (!modelData || typeof modelData !== 'object') {
    return null;
  }

  const inputTokens = readNumber(modelData.cumulativeInputTokens ?? modelData.inputTokens);
  const outputTokens = readNumber(modelData.cumulativeOutputTokens ?? modelData.outputTokens);
  const totalUsed = inputTokens + outputTokens;
  const contextWindow = parseInt(process.env.CONTEXT_WINDOW, 10) || 160000;

  return {
    used: totalUsed,
    total: contextWindow,
    inputTokens,
    outputTokens,
    breakdown: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

/**
 * Builds the SDK `prompt` payload for one turn.
 *
 * Plain text turns pass the string through unchanged. Turns with image
 * attachments use the SDK's streaming-input mode: a single SDKUserMessage
 * whose content carries the prompt text plus one base64 `image` block per
 * attachment (read from the global `~/.cloudcli/assets` folder).
 *
 * @param {string} command - User prompt
 * @param {Array} images - Image descriptors ({ path, name?, mimeType? })
 * @param {Array} files - Non-image attachment descriptors
 * @param {string} cwd - Project working directory attachment paths resolve against
 * @returns {Promise<string|AsyncIterable>} SDK prompt payload
 */
async function buildPromptPayload(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  if (normalizeImageDescriptors(images).length === 0) {
    return promptWithFiles;
  }

  const content = await buildClaudeUserContent(promptWithFiles, images, cwd);
  return (async function* () {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content
      },
      parent_tool_use_id: null,
      timestamp: new Date().toISOString()
    };
  })();
}

/**
 * Loads MCP server configurations from ~/.claude.json
 * @param {string} cwd - Current working directory for project-specific configs
 * @returns {Object|null} MCP servers object or null if none found
 */
async function loadMcpConfig(cwd) {
  try {
    const claudeConfigPath = path.join(os.homedir(), '.claude.json');

    // Check if config file exists
    try {
      await fs.access(claudeConfigPath);
    } catch (error) {
      // File doesn't exist, return null
      // No config file
      return null;
    }

    // Read and parse config file
    let claudeConfig;
    try {
      const configContent = await fs.readFile(claudeConfigPath, 'utf8');
      claudeConfig = JSON.parse(configContent);
    } catch (error) {
      console.error('Failed to parse ~/.claude.json:', error.message);
      return null;
    }

    // Extract MCP servers (merge global and project-specific)
    let mcpServers = {};

    // Add global MCP servers
    if (claudeConfig.mcpServers && typeof claudeConfig.mcpServers === 'object') {
      mcpServers = { ...claudeConfig.mcpServers };
      // Global MCP servers loaded
    }

    // Add/override with project-specific MCP servers
    if (claudeConfig.claudeProjects && cwd) {
      const projectConfig = claudeConfig.claudeProjects[cwd];
      if (projectConfig && projectConfig.mcpServers && typeof projectConfig.mcpServers === 'object') {
        mcpServers = { ...mcpServers, ...projectConfig.mcpServers };
        // Project MCP servers merged
      }
    }

    // Return null if no servers found
    if (Object.keys(mcpServers).length === 0) {
      return null;
    }
    return mcpServers;
  } catch (error) {
    console.error('Error loading MCP config:', error.message);
    return null;
  }
}

/**
 * Session identity and per-turn settings shared between the runtime's SDK
 * closures and the persistent agent that outlives any single turn.
 *
 * `canUseTool` and the notification hooks are baked into the SDK options once,
 * when the agent's subprocess starts, but must keep seeing the *current* turn's
 * writer and tool settings — so they read everything through this object
 * instead of capturing per-run values.
 */
function createSessionState({ appSessionId, sessionSummary, providerSessionId, writer }) {
  return {
    appSessionId: appSessionId ?? null,
    sessionSummary,
    /** Set when resuming, which suppresses the `session_created` announcement. */
    resumedSessionId: providerSessionId ?? null,
    capturedSessionId: providerSessionId ?? null,
    announcedSessionId: Boolean(providerSessionId),
    toolSettings: { allowedTools: [], disallowedTools: [] },
    permissionMode: undefined,
    model: undefined,
    /** Replaced by the pool so interactive prompts address the turn in flight. */
    currentWriter: () => writer,
  };
}

/** Routes notifications to whichever client owns the current turn. */
function createNotifier(state) {
  return (event) => {
    const writer = state.currentWriter();
    notifyUserIfEnabled({ userId: writer?.userId || null, writer, event });
  };
}

/**
 * Builds the emitter that turns one SDK stream message into normalized client
 * events. Shared by both execution paths, so a scheduled turn renders exactly
 * like a user-initiated one.
 */
function createMessageRouter(context) {
  return (message, writer, state) => {
    if (message.session_id && !state.capturedSessionId) {
      state.capturedSessionId = message.session_id;
      writer.setSessionId?.(state.capturedSessionId);
    }

    // Brand-new sessions announce their provider id once so the gateway can
    // persist the app-id mapping; resumed sessions already have one.
    if (state.capturedSessionId && !state.resumedSessionId && !state.announcedSessionId) {
      state.announcedSessionId = true;
      writer.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: state.capturedSessionId,
        sessionId: state.capturedSessionId,
        provider: 'claude',
      }));
    }

    const transformedMessage = transformMessage(message);
    const sid = state.capturedSessionId || state.appSessionId || null;

    for (const msg of context.normalizeMessage(transformedMessage, sid)) {
      // Preserve parentToolUseId from SDK wrapper for subagent tool grouping
      if (transformedMessage.parentToolUseId && !msg.parentToolUseId) {
        msg.parentToolUseId = transformedMessage.parentToolUseId;
      }
      writer.send(msg);
    }

    const tokenBudget = extractTokenBudget(message);
    if (tokenBudget) {
      writer.send(createNormalizedMessage({
        kind: 'status',
        text: 'token_budget',
        tokenBudget,
        sessionId: sid,
        provider: 'claude',
      }));
    }
  };
}

/**
 * Identifies the SDK options a running subprocess cannot be re-configured for.
 * A change here restarts the session's agent; anything absent must not.
 *
 * Three deliberate omissions:
 * - `resume`, which is the load-bearing one. It is empty on a session's first
 *   turn and holds the captured provider id on every turn after, so including
 *   it would restart the agent after turn one — every time, defeating the pool
 *   entirely. The pool is keyed by app session id, so a live agent already *is*
 *   that session; `resume` only matters when one is built from scratch.
 * - `model` and `permissionMode`, which the SDK changes in place.
 * - the tool allow/deny lists, enforced by `canUseTool` against live state, so
 *   remembering an allow-rule mid-session must not restart anything.
 */
function buildAgentFingerprint(sdkOptions) {
  return JSON.stringify({
    cwd: sdkOptions.cwd ?? null,
    effort: sdkOptions.effort ?? null,
    settingSources: sdkOptions.settingSources ?? null,
    mcpServers: sdkOptions.mcpServers ?? null,
    executable: sdkOptions.pathToClaudeCodeExecutable ?? null,
  });
}

/** Wraps the chat-layer opener so the pool stays free of transport concerns. */
function openSpontaneousRun(input) {
  if (!spontaneousRunOpener) {
    return null;
  }

  try {
    return spontaneousRunOpener({ ...input, provider: 'claude' }) ?? null;
  } catch (error) {
    console.error('[Claude SDK] Failed to open a run for scheduled work:', error?.message || error);
    return null;
  }
}

/**
 * Builds the SDK user message for one turn.
 *
 * Always an `SDKUserMessage` rather than a bare string: the persistent agent
 * feeds a single open input stream, and image attachments ride along as real
 * content blocks on the same shape.
 */
async function buildUserMessage(command, images, files, cwd) {
  const promptWithFiles = appendFilesInputTag(command, files);
  const content = normalizeImageDescriptors(images).length === 0
    ? promptWithFiles
    : await buildClaudeUserContent(promptWithFiles, images, cwd);

  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
}

/**
 * Executes a Claude query using the SDK
 * @param {string} command - User prompt/command
 * @param {Object} options - Query options
 * @param {Object} ws - WebSocket connection
 * @param {Object} context - Provider-scoped model, session, and auth lookups
 * @returns {Promise<void>}
 */
async function queryClaudeSDK(command, options = {}, ws, context) {
  const { sessionId, sessionSummary } = options;
  // Callers pass the stable app session id; the SDK only understands the
  // provider-native id recorded on the session row.
  const providerSessionId = context.resolveProviderSessionId(sessionId);

  // Only chat runs get a persistent agent: they have a stable app session id to
  // key it by, and a websocket the chat layer can deliver scheduled turns to
  // later. SSE/agent-route callers are one-shot by nature and keep the old path.
  const usePersistentAgent = Boolean(sessionId) && Boolean(ws?.isWebSocketWriter);

  let state = createSessionState({
    appSessionId: sessionId,
    sessionSummary,
    providerSessionId,
    writer: ws,
  });
  // Process-map key: the app session id when the caller supplied one, else
  // the provider-native id once captured (legacy/direct API callers).
  const sessionKey = () => sessionId || state.capturedSessionId || null;
  const emitNotification = createNotifier(state);

  try {
    const resolvedModel = await context.resolveResumeModel(sessionId, options.model);
    let effortModels = CLAUDE_FALLBACK_MODELS;
    try {
      effortModels = await context.getProviderModels();
    } catch (error) {
      console.warn('[Claude SDK] Unable to load provider models for effort validation:', error);
    }

    const sdkOptions = mapCliOptionsToSDK({
      ...options,
      providerSessionId,
      model: resolvedModel || options.model,
      effortModels,
    });

    const mcpServers = await loadMcpConfig(options.cwd);
    if (mcpServers) {
      sdkOptions.mcpServers = mcpServers;
    }

    state.toolSettings = {
      allowedTools: sdkOptions.allowedTools,
      disallowedTools: sdkOptions.disallowedTools,
    };
    state.permissionMode = sdkOptions.permissionMode;
    state.model = sdkOptions.model;

    const userMessage = await buildUserMessage(command, options.images, options.files, options.cwd);
    const createPrompt = () => (async function* () { yield userMessage; })();

    sdkOptions.hooks = {
      Notification: [{
        matcher: '',
        hooks: [async (input) => {
          const message = typeof input?.message === 'string' ? input.message : 'Claude requires your attention.';
          // Notifications are app-facing, so they carry the app session id.
          const notifiedSessionId = state.appSessionId || state.capturedSessionId || null;
          emitNotification(createNotificationEvent({
            provider: 'claude',
            sessionId: notifiedSessionId,
            kind: 'action_required',
            code: 'agent.notification',
            meta: { message, sessionName: state.sessionSummary },
            severity: 'warning',
            requiresUserAction: true,
            dedupeKey: `claude:hook:notification:${notifiedSessionId || 'none'}:${message}`
          }));
          return {};
        }]
      }]
    };

    // Caveat: in 'auto' and 'bypassPermissions' modes the SDK resolves approval
    // at the permission-mode step and skips this callback, so interactive tools
    // (AskUserQuestion, ExitPlanMode) won't reach the UI — the classifier/bypass
    // auto-approves them and the model acts on a generated answer. Move these
    // tools to a PreToolUse hook (runs before the mode check) if we need them
    // to work in those modes.
    sdkOptions.canUseTool = async (toolName, input, context) => {
      const requiresInteraction = TOOLS_REQUIRING_INTERACTION.has(toolName);
      const { allowedTools, disallowedTools } = state.toolSettings;

      if (!requiresInteraction) {
        if (state.permissionMode === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }

        const isDisallowed = (disallowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isDisallowed) {
          return { behavior: 'deny', message: 'Tool disallowed by settings' };
        }

        const isAllowed = (allowedTools || []).some(entry =>
          matchesToolPermission(entry, toolName, input)
        );
        if (isAllowed) {
          return { behavior: 'allow', updatedInput: input };
        }
      }

      // Scheduled turns run whether or not anyone is watching. Denying is the
      // only safe answer when there is no client that could approve.
      const writer = state.currentWriter();
      if (!writer) {
        return { behavior: 'deny', message: 'No client attached to approve this tool use' };
      }

      const approvalSessionId = state.appSessionId || state.capturedSessionId || null;
      const requestId = createRequestId();
      writer.send(createNormalizedMessage({ kind: 'permission_request', requestId, toolName, input, sessionId: state.capturedSessionId || state.appSessionId || null, provider: 'claude' }));
      emitNotification(createNotificationEvent({
        provider: 'claude',
        sessionId: approvalSessionId,
        kind: 'action_required',
        code: 'permission.required',
        meta: { toolName, sessionName: state.sessionSummary },
        severity: 'warning',
        requiresUserAction: true,
        dedupeKey: `claude:permission:${approvalSessionId || 'none'}:${requestId}`
      }));

      const decision = await waitForToolApproval(requestId, {
        timeoutMs: requiresInteraction ? 0 : undefined,
        signal: context?.signal,
        metadata: {
          // Keyed by the app session id so `chat.subscribe` can look pending
          // approvals up directly; provider id only for legacy callers.
          _sessionId: approvalSessionId,
          _toolName: toolName,
          _input: input,
          _receivedAt: new Date(),
        },
        onCancel: (reason) => {
          writer.send(createNormalizedMessage({ kind: 'permission_cancelled', requestId, reason, sessionId: state.capturedSessionId || state.appSessionId || null, provider: 'claude' }));
        }
      });
      if (!decision) {
        return { behavior: 'deny', message: 'Permission request timed out' };
      }

      if (decision.cancelled) {
        return { behavior: 'deny', message: 'Permission request cancelled' };
      }

      if (decision.allow) {
        if (decision.rememberEntry && typeof decision.rememberEntry === 'string') {
          if (!state.toolSettings.allowedTools.includes(decision.rememberEntry)) {
            state.toolSettings.allowedTools.push(decision.rememberEntry);
          }
          state.toolSettings.disallowedTools = (state.toolSettings.disallowedTools || [])
            .filter(entry => entry !== decision.rememberEntry);
        }
        return { behavior: 'allow', updatedInput: decision.updatedInput ?? input };
      }

      return { behavior: 'deny', message: decision.message ?? 'User denied tool use' };
    };

    const route = createMessageRouter(context);

    // Query constructors read this synchronously, so it has to be in place
    // around construction and restored right after.
    const prevStreamTimeout = process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
    process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000';
    const restoreStreamTimeout = () => {
      if (prevStreamTimeout !== undefined) {
        process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = prevStreamTimeout;
      } else {
        delete process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT;
      }
    };

    if (usePersistentAgent) {
      const acquire = () => claudeAgentPool.acquire({
        key: sessionId,
        fingerprint: buildAgentFingerprint(sdkOptions),
        sdkOptions,
        state,
        route,
        openSpontaneousRun,
      });

      let agent;
      try {
        try {
          agent = acquire();
        } catch (hookError) {
          // Older/newer SDK versions may not accept hook shapes yet. Keep
          // notification behavior operational via runtime events regardless.
          console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
          delete sdkOptions.hooks;
          agent = acquire();
        }
      } finally {
        restoreStreamTimeout();
      }

      // A reused agent kept the state object its SDK closures were built
      // around; adopt it so this turn reads and writes the same identity.
      state = agent.state;
      state.sessionSummary = sessionSummary;
      agent.attachWriter(ws);
      await agent.applyTurnSettings({
        model: sdkOptions.model,
        permissionMode: sdkOptions.permissionMode,
        allowedTools: sdkOptions.allowedTools,
        disallowedTools: sdkOptions.disallowedTools,
      });

      const { error: turnError } = await agent.runTurn(userMessage, ws);
      if (turnError) {
        throw turnError;
      }
    } else {
      let queryInstance;
      try {
        try {
          queryInstance = query({
            prompt: createPrompt(),
            options: sdkOptions
          });
        } catch (hookError) {
          // Older/newer SDK versions may not accept hook shapes yet.
          // Keep notification behavior operational via runtime events even if hook registration fails.
          console.warn('Failed to initialize Claude query with hooks, retrying without hooks:', hookError?.message || hookError);
          delete sdkOptions.hooks;
          queryInstance = query({
            prompt: createPrompt(),
            options: sdkOptions
          });
        }
      } finally {
        restoreStreamTimeout();
      }

      // Track the query instance for abort capability
      if (sessionKey()) {
        addSession(sessionKey(), queryInstance, ws);
      }

      // Process streaming messages
      console.log('Starting async generator loop for session:', state.capturedSessionId || 'NEW');
      for await (const message of queryInstance) {
        const hadSessionId = Boolean(state.capturedSessionId);
        route(message, ws, state);
        // Re-key the process map under the provider id the stream just revealed,
        // so aborts from legacy callers (no app session id) can still find it.
        if (!hadSessionId && state.capturedSessionId) {
          addSession(sessionKey(), queryInstance, ws);
        }
      }

      // Clean up session on completion
      if (sessionKey()) {
        removeSession(sessionKey());
      }
    }

    // The CLI has finished writing this turn's records, each stamped with the
    // "sdk-cli" entrypoint that hides the session from Claude Code's VS Code
    // extension. Rewrite them now; it never blocks the turn's completion.
    restampClaudeTranscriptEntrypoint({
      providerSessionId: state.capturedSessionId,
      cwd: options.cwd,
    }).catch((error) => {
      console.warn('[Claude SDK] Could not restamp transcript entrypoint:', error?.message || error);
    });

    // Send the terminal completion event — skipped for aborted runs, whose
    // terminal `complete` (aborted: true) was already sent by abort-session.
    const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (!wasAborted) {
      ws.send(createCompleteMessage({ provider: 'claude', sessionId: state.capturedSessionId || sessionId || null, exitCode: 0 }));
    }
    notifyRunStopped({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || state.capturedSessionId || null,
      sessionName: sessionSummary,
      stopReason: wasAborted ? 'aborted' : 'completed'
    });
    // Complete

  } catch (error) {
    console.error('SDK query error:', error);

    // Clean up session on error
    if (sessionKey()) {
      removeSession(sessionKey());
    }

    const wasAborted = sessionKey() ? abortedSessionIds.delete(sessionKey()) : false;
    if (wasAborted) {
      // The abort already produced the terminal complete; a generator throw
      // caused by interrupt() is expected noise, not a user-facing error.
      return;
    }

    // Check if Claude CLI is installed for a clearer error message
    const installed = await context.isProviderInstalled();
    const errorContent = !installed
      ? 'Claude Code is not installed. Please install it first: https://docs.anthropic.com/en/docs/claude-code'
      : error.message;

    // Send error to WebSocket, then the terminal complete
    ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: state.capturedSessionId || sessionId || null, provider: 'claude' }));
    ws.send(createCompleteMessage({ provider: 'claude', sessionId: state.capturedSessionId || sessionId || null, exitCode: 1 }));
    notifyRunFailed({
      userId: ws?.userId || null,
      provider: 'claude',
      sessionId: sessionId || state.capturedSessionId || null,
      sessionName: sessionSummary,
      error
    });
  }
}

/**
 * Stops the turn in flight for a session.
 *
 * For a pooled session this interrupts the current turn but deliberately keeps
 * the agent alive: the session's scheduled jobs (`/loop`, `/goal` wake-ups) are
 * held in that subprocess, and cancelling one reply is not a request to cancel
 * the schedule. Use `endClaudeSDKSession` to tear the session down for real.
 *
 * @param {string} sessionId - Session identifier
 * @returns {Promise<boolean>} True if a turn was interrupted
 */
async function abortClaudeSDKSession(sessionId) {
  const agent = claudeAgentPool.get(sessionId);

  if (agent) {
    if (!agent.hasActiveTurn()) {
      console.log(`Session ${sessionId} has no turn in flight`);
      return false;
    }

    try {
      console.log(`Interrupting pooled Claude session: ${sessionId}`);
      // Mark before interrupting so the run loop knows not to emit its own
      // terminal complete (the abort handler sends the aborted one).
      abortedSessionIds.add(sessionId);
      await agent.interrupt();
      return true;
    } catch (error) {
      console.error(`Error interrupting session ${sessionId}:`, error);
      // The turn keeps going; let it emit its own terminal complete.
      abortedSessionIds.delete(sessionId);
      return false;
    }
  }

  const session = getSession(sessionId);

  if (!session) {
    console.log(`Session ${sessionId} not found`);
    return false;
  }

  try {
    console.log(`Aborting SDK session: ${sessionId}`);

    abortedSessionIds.add(sessionId);

    // Call interrupt() on the query instance
    await session.instance.interrupt();

    // Update session status
    session.status = 'aborted';

    // Clean up session
    removeSession(sessionId);

    return true;
  } catch (error) {
    console.error(`Error aborting session ${sessionId}:`, error);
    // The run keeps going; let it emit its own terminal complete.
    abortedSessionIds.delete(sessionId);
    return false;
  }
}

/**
 * Tears a session's persistent agent down, discarding any work it had
 * scheduled. Called when the session is deleted and on server shutdown.
 * @param {string} sessionId - Session identifier
 */
function endClaudeSDKSession(sessionId) {
  claudeAgentPool.close(sessionId);
}

/** Closes every live agent; used on server shutdown. */
function endAllClaudeSDKSessions() {
  claudeAgentPool.closeAll();
}

/**
 * Checks if a session currently has a turn in flight
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session is active
 */
function isClaudeSDKSessionActive(sessionId) {
  if (claudeAgentPool.get(sessionId)?.hasActiveTurn()) {
    return true;
  }
  const session = getSession(sessionId);
  return Boolean(session && session.status === 'active');
}

/**
 * Gets all session IDs with a turn in flight
 * @returns {Array<string>} Array of active session IDs
 */
function getActiveClaudeSDKSessions() {
  return [...new Set([...claudeAgentPool.listBusyKeys(), ...getAllSessions()])];
}

/**
 * Get pending tool approvals for a specific session.
 * @param {string} sessionId - The session ID
 * @returns {Array} Array of pending permission request objects
 */
function getPendingApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingToolApprovals.entries()) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName || 'UnknownTool',
        input: resolver._input,
        context: resolver._context,
        sessionId,
        receivedAt: resolver._receivedAt || new Date(),
      });
    }
  }
  return pending;
}

/**
 * Reconnect a session's WebSocketWriter to a new raw WebSocket.
 * Called when client reconnects (e.g. page refresh) while SDK is still running.
 * @param {string} sessionId - The session ID
 * @param {Object} newRawWs - The new raw WebSocket connection
 * @returns {boolean} True if writer was successfully reconnected
 */
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}

export const claudeRuntime = {
  run: queryClaudeSDK,
  abort: abortClaudeSDKSession,
  endSession: endClaudeSDKSession,
  shutdown: endAllClaudeSDKSessions,
  setSpontaneousRunOpener,
  permissions: {
    resolve: resolveToolApproval,
    listPending: getPendingApprovalsForSession,
  },
};

// Export public API
export {
  queryClaudeSDK,
  abortClaudeSDKSession,
  endClaudeSDKSession,
  endAllClaudeSDKSessions,
  setSpontaneousRunOpener,
  isClaudeSDKSessionActive,
  getActiveClaudeSDKSessions,
  resolveToolApproval,
  getPendingApprovalsForSession,
  reconnectSessionWriter
};
