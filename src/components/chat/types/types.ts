import type { Project, ProjectSession, LLMProvider } from '../../../types/app';
import type {
  MarkSessionIdle,
  MarkSessionProcessing,
  SessionActivityMap,
} from '../../../hooks/useSessionProtection';

export type Provider = LLMProvider;

export type PermissionMode = 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'plan';

/** One Claude plan rate-limit window, as reported by `/api/system/claude-usage`. */
export type ClaudeUsageWindow = {
  /** Percent of the window's allowance consumed. Can exceed 100 when overdrawn. */
  utilization: number;
  /** Epoch ms when the window rolls over, or null when upstream omits it. */
  resetsAt: number | null;
  severity: 'normal' | 'warning' | 'critical';
};

/**
 * One entry from the full per-window breakdown behind the two headline
 * figures. `kind` is passed through from upstream rather than narrowed to a
 * union: accounts expose different windows and new ones appear over time, so
 * an unrecognized kind is displayed with its raw name instead of dropped.
 */
export type ClaudeUsageLimit = {
  kind: string;
  utilization: number;
  resetsAt: number | null;
  severity: ClaudeUsageWindow['severity'];
  /** Model or surface the window applies to, e.g. `Fable`. Null when account-wide. */
  scopeLabel: string | null;
  /** True for the window currently governing throughput. */
  isActive: boolean;
};

/**
 * Remaining plan allowance for the Claude account signed in on the server host.
 *
 * `null` means "nothing to display" — the server withheld it (platform mode),
 * no account is signed in, or the endpoint could not be read. All three are
 * ordinary states, so the composer simply omits the pill.
 */
export type ClaudeUsage = {
  fiveHour: ClaudeUsageWindow | null;
  sevenDay: ClaudeUsageWindow | null;
  /** Every window upstream reports, shown in the detail dialog. */
  limits: ClaudeUsageLimit[];
  /** Plan label such as `max`, shown in the tooltip and dialog header. */
  plan: string | null;
  /**
   * True when the server could not reach upstream and is retaining an earlier
   * reading. The pill still shows the number — a percentage from a few minutes
   * ago is far more useful than a gap — but dims it and says so in the tooltip.
   */
  stale?: boolean;
};

/** GPT/Codex account allowance emitted alongside a session's token snapshot. */
export type CodexUsage = ClaudeUsage;

export interface ChatAttachment {
  /** Absolute path inside the server-managed chat attachment store. */
  path?: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

export interface ChatImage extends ChatAttachment {
  /** Inline data URL (Claude history stores image attachments as base64). */
  data?: string;
}

export interface ToolResult {
  content?: unknown;
  isError?: boolean;
  timestamp?: string | number | Date;
  toolUseResult?: unknown;
  [key: string]: unknown;
}

export interface SubagentChildTool {
  toolId: string;
  toolName: string;
  toolInput: unknown;
  toolResult?: ToolResult | null;
  timestamp: Date;
}

export interface ChatMessage {
  type: string;
  content?: string;
  displayText?: string;
  timestamp: string | number | Date;
  images?: ChatImage[];
  files?: ChatAttachment[];
  reasoning?: string;
  isThinking?: boolean;
  isStreaming?: boolean;
  isInteractivePrompt?: boolean;
  isToolUse?: boolean;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult | null;
  toolId?: string;
  toolCallId?: string;
  commandName?: string;
  commandMessage?: string;
  commandArgs?: string;
  isLocalCommand?: boolean;
  isLocalCommandStdout?: boolean;
  isCompactSummary?: boolean;
  isSubagentContainer?: boolean;
  subagentState?: {
    childTools: SubagentChildTool[];
    currentToolIndex: number;
    isComplete: boolean;
  };
  [key: string]: unknown;
}

export interface ClaudeSettings {
  allowedTools: string[];
  disallowedTools: string[];
  skipPermissions: boolean;
  projectSortOrder: string;
  lastUpdated?: string;
  [key: string]: unknown;
}

export interface ClaudePermissionSuggestion {
  toolName: string;
  entry: string;
  isAllowed: boolean;
}

export interface PermissionGrantResult {
  success: boolean;
  alreadyAllowed?: boolean;
  updatedSettings?: ClaudeSettings;
}

export interface PendingPermissionRequest {
  requestId: string;
  toolName: string;
  input?: unknown;
  context?: unknown;
  sessionId?: string | null;
  receivedAt?: Date;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export type SessionNavigationOptions = {
  replace?: boolean;
};

export type SessionEstablishedContext = {
  provider: LLMProvider;
  project: Project;
  summary?: string | null;
};

export interface ChatInterfaceProps {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  ws: WebSocket | null;
  sendMessage: (message: unknown) => void;
  onFileOpen?: (filePath: string, diffInfo?: any) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  processingSessions?: SessionActivityMap;
  onNavigateToSession?: (targetSessionId: string, options?: SessionNavigationOptions) => void;
  onSessionEstablished?: (sessionId: string, context: SessionEstablishedContext) => void;
  onShowSettings?: () => void;
  showRawParameters?: boolean;
  showThinking?: boolean;
  sendByCtrlEnter?: boolean;
  externalMessageUpdate?: number;
  newSessionTrigger?: number;
  onTaskClick?: (...args: unknown[]) => void;
  onShowAllTasks?: (() => void) | null;
}
