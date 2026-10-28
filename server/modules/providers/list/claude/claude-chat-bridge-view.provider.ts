/**
 * Presents a secretary's chat-bridge plumbing as an ordinary conversation.
 *
 * A registered secretary is woken by its chat bridge (cc-chat), not prompted:
 * its transcript holds a `<channel source="chat">` wake notice that carries no
 * message text, then `mcp__chat__read` (whose result lists the messages),
 * `mcp__chat__reply_dry_run` (the draft), `mcp__chat__reply` (sends a draft by
 * its `dry_run_id`) and sometimes `mcp__chat__mark_read`. Rendered literally,
 * the owner's cloudcli row shows that machinery instead of "my message → the
 * answer". This rewrites it:
 *
 * - each wake notice becomes user bubble(s) holding the text of the messages
 *   that woke it, recovered from the `read` results that follow it;
 * - each successful `reply` becomes an assistant message holding the text of
 *   the draft it sent (a draft that was never sent shows nothing);
 * - the four bridge tool calls are hidden, with their tool_result rows.
 *
 * Everything else — other tool calls, the assistant's own text, thinking —
 * passes through untouched, so the work stays visible. A bridge call that
 * failed also stays visible, so a reply that did not go out is not hidden.
 *
 * Runs over the whole normalized transcript before pagination, so the same
 * view comes back on a reload and on every watcher-driven re-sync.
 */

import type { AnyRecord, NormalizedMessage } from '@/shared/types.js';
import { createNormalizedMessage } from '@/shared/utils.js';

const CHAT_TOOL_PREFIX = 'mcp__chat__';
const READ_TOOL = 'mcp__chat__read';
const DRY_RUN_TOOL = 'mcp__chat__reply_dry_run';
const REPLY_TOOL = 'mcp__chat__reply';
const MARK_READ_TOOL = 'mcp__chat__mark_read';
const BRIDGE_TOOLS = new Set([READ_TOOL, DRY_RUN_TOOL, REPLY_TOOL, MARK_READ_TOOL]);

/** The room cloudcli's secretary row delivers to; its messages are the owner's own words. */
const OWNER_ROOM = 'local/owner';

const CHAT_NOTICE_PATTERN = /<channel source="chat"[^>]*>[\s\S]*?<\/channel>/g;
/** One room per line inside a wake notice: `[local/owner] +2 new · latest 15:44`. */
const WAKE_ROOM_PATTERN = /^\[([^\]\n]+)\] \+(\d+) new/gm;
/** `#5 msg=179… [wake: dm] 15:48:21 uid=local.owner "owner via cloudcli": "<JSON string>"` */
const READ_LINE_PATTERN = /^#\d+ msg=(\S+) \[[^\]]*\] \S+ uid=\S+ "((?:[^"\\]|\\.)*)": (".*)$/;
const DRY_RUN_ID_PATTERN = /^dry_run_id: (\S+)$/m;

type ChatLine = { messageId: string; author: string; text: string };

type Wake = {
  /** Unconsumed message count per room label, from the notice's `+N new`. */
  pending: Map<string, number>;
  recovered: Array<ChatLine & { room: string }>;
};

/**
 * Tool results reach here as text, or as the JSON of a content-block array
 * (see `splitToolResultContent`); both read as the joined block text.
 */
function readToolResultText(message: NormalizedMessage): string | null {
  const content = message.toolResult?.content;
  if (typeof content !== 'string') {
    return null;
  }
  if (content.startsWith('[{')) {
    try {
      const blocks = JSON.parse(content) as unknown;
      if (Array.isArray(blocks)) {
        return blocks
          .map((block) => (block && typeof block.text === 'string' ? block.text : ''))
          .join('\n');
      }
    } catch {
      // Plain text that happens to start like JSON.
    }
  }
  return content;
}

function readStringField(input: unknown, field: string): string | null {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>)[field] : undefined;
  return typeof value === 'string' ? value : null;
}

function decodeQuotedText(quoted: string): string {
  try {
    const decoded = JSON.parse(quoted) as unknown;
    if (typeof decoded === 'string') {
      return decoded;
    }
  } catch {
    // A truncated line has no closing quote; show what is there.
  }
  return quoted.replace(/^"/, '').replace(/"$/, '');
}

/** Splits a `read` result into its `[room]` sections and their message lines. */
function parseReadResult(text: string): Map<string, ChatLine[]> {
  const rooms = new Map<string, ChatLine[]>();
  let current: ChatLine[] | null = null;
  for (const line of text.split('\n')) {
    const header = /^\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      current = rooms.get(header[1]) ?? [];
      rooms.set(header[1], current);
      continue;
    }
    const match = READ_LINE_PATTERN.exec(line);
    if (match && current) {
      current.push({ messageId: match[1], author: match[2], text: decodeQuotedText(match[3]) });
    }
  }
  return rooms;
}

/**
 * Turns a transcript row carrying a chat-bridge wake notice into a user text
 * message, or returns null for any other row.
 *
 * Consumed by `ClaudeSessionsProvider.fetchHistory` ahead of `normalizeMessage`.
 * Claude persists channel notices as `isMeta` rows, which the normalizer hides
 * as internal; this one is needed so `presentChatBridgeTurns` has a place to
 * put the owner's message. History only — the live stream never sees a
 * secretary's wakes, because the secretary is not a cloudcli-run process.
 */
export function normalizeChatWakeRow(raw: AnyRecord, sessionId: string): NormalizedMessage | null {
  if (raw.type !== 'user' || raw.message?.role !== 'user') {
    return null;
  }
  const content = raw.message.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.filter((part: AnyRecord) => part?.type === 'text').map((part: AnyRecord) => part.text ?? '').join('\n')
      : '';
  if (!text.trimStart().startsWith('<channel source="chat"')) {
    return null;
  }
  return createNormalizedMessage({
    id: raw.uuid,
    sessionId,
    timestamp: raw.timestamp,
    provider: 'claude',
    kind: 'text',
    role: 'user',
    content: text,
  });
}

function isWakeNotice(message: NormalizedMessage): boolean {
  return message.kind === 'text'
    && message.role === 'user'
    && typeof message.content === 'string'
    && message.content.includes('<channel source="chat"');
}

function isSuccessfulBridgeCall(message: NormalizedMessage): boolean {
  return Boolean(message.toolResult) && !message.toolResult?.isError;
}

function formatInboundText(room: string, line: ChatLine): string {
  return room === OWNER_ROOM ? line.text : `[${room}] ${line.author}:\n${line.text}`;
}

function formatFallbackText(room: string | null, count: number): string {
  if (room === OWNER_ROOM) {
    return count > 1 ? `📬 ${count} messages from owner` : '📬 Message from owner';
  }
  return room ? `📬 ${count} new in ${room}` : '📬 Chat wake';
}

/**
 * Rewrites a Claude transcript's chat-bridge turns into user and assistant
 * messages, as described at the top of this file.
 *
 * Consumed by `ClaudeSessionsProvider.fetchHistory`, after tool results are
 * attached to their tool_use rows. A transcript with neither a chat wake nor an
 * `mcp__chat__` tool call is returned as is — only a session running the
 * bridge produces them.
 *
 * Wake → text matching: a wake's `+N new` per room is filled by the newest
 * not-yet-shown lines of that room in the `read` results after it, oldest
 * wake first. Lines are deduped by `msg=` id, because `read` re-lists older
 * messages. A wake left (partly) unfilled — no read yet, or an unparseable
 * one — shows a compact "message from owner" bubble instead of the notice.
 */
export function presentChatBridgeTurns(messages: NormalizedMessage[]): NormalizedMessage[] {
  if (!messages.some((message) => isWakeNotice(message)
    || (message.kind === 'tool_use' && message.toolName?.startsWith(CHAT_TOOL_PREFIX)))) {
    return messages;
  }

  const wakes = new Map<NormalizedMessage, Wake>();
  const openWakes: Wake[] = [];
  const shownMessageIds = new Set<string>();
  const drafts = new Map<string, { handle: string | null; text: string }>();

  // Pass 1: learn what each wake and each reply should show.
  for (const message of messages) {
    if (isWakeNotice(message)) {
      const wake: Wake = { pending: new Map(), recovered: [] };
      for (const notice of (message.content ?? '').match(CHAT_NOTICE_PATTERN) ?? []) {
        for (const room of notice.matchAll(WAKE_ROOM_PATTERN)) {
          wake.pending.set(room[1], (wake.pending.get(room[1]) ?? 0) + Number(room[2]));
        }
      }
      wakes.set(message, wake);
      openWakes.push(wake);
      continue;
    }
    if (message.kind !== 'tool_use' || !isSuccessfulBridgeCall(message)) {
      continue;
    }
    const resultText = readToolResultText(message) ?? '';
    if (message.toolName === DRY_RUN_TOOL) {
      const dryRunId = DRY_RUN_ID_PATTERN.exec(resultText)?.[1];
      const text = readStringField(message.toolInput, 'text');
      if (dryRunId && text !== null) {
        drafts.set(dryRunId, { handle: readStringField(message.toolInput, 'handle'), text });
      }
    } else if (message.toolName === READ_TOOL) {
      for (const [room, lines] of parseReadResult(resultText)) {
        const unseen = lines.filter((line) => !shownMessageIds.has(line.messageId));
        const waiting = openWakes.filter((wake) => (wake.pending.get(room) ?? 0) > 0);
        const wanted = waiting.reduce((sum, wake) => sum + (wake.pending.get(room) ?? 0), 0);
        const taken = wanted > 0 ? unseen.slice(-wanted) : [];
        for (const line of taken) {
          const wake = waiting.find((candidate) => (candidate.pending.get(room) ?? 0) > 0);
          if (!wake) {
            break;
          }
          wake.pending.set(room, (wake.pending.get(room) ?? 0) - 1);
          wake.recovered.push({ ...line, room });
          shownMessageIds.add(line.messageId);
        }
      }
    }
  }

  // Pass 2: emit the conversation.
  const hiddenToolIds = new Set<string>();
  const presented: NormalizedMessage[] = [];
  for (const message of messages) {
    const wake = wakes.get(message);
    if (wake) {
      const userBubble = (id: string, content: string) => createNormalizedMessage({
        id,
        sessionId: message.sessionId,
        timestamp: message.timestamp,
        provider: message.provider,
        kind: 'text',
        role: 'user',
        content,
      });
      for (const line of wake.recovered) {
        presented.push(userBubble(`${message.id}_chat_${line.messageId}`, formatInboundText(line.room, line)));
      }
      for (const [room, count] of wake.pending) {
        if (count > 0) {
          presented.push(userBubble(`${message.id}_chat_pending_${room}`, formatFallbackText(room, count)));
        }
      }
      if (wake.recovered.length === 0 && wake.pending.size === 0) {
        presented.push(userBubble(`${message.id}_chat_wake`, formatFallbackText(null, 0)));
      }
      // Anything typed alongside the notice in the same turn stays a user message.
      const remainder = (message.content ?? '').replace(CHAT_NOTICE_PATTERN, '').trim();
      if (remainder) {
        presented.push({ ...message, content: remainder });
      }
      continue;
    }

    if (message.kind === 'tool_use' && message.toolName && BRIDGE_TOOLS.has(message.toolName)) {
      // In flight (no result yet) or succeeded: hidden. Failed: left visible.
      if (message.toolResult?.isError) {
        presented.push(message);
        continue;
      }
      if (message.toolName === REPLY_TOOL && message.toolResult) {
        const resultText = readToolResultText(message) ?? '';
        const dryRunId = readStringField(message.toolInput, 'dry_run_id');
        const sent = dryRunId ? drafts.get(dryRunId) : undefined;
        if (!resultText.startsWith('sent') || !sent) {
          // Not a recognisable send: show the raw call rather than lose it.
          presented.push(message);
          continue;
        }
        const tag = sent.handle && sent.handle !== OWNER_ROOM ? `*→ ${sent.handle}*\n\n` : '';
        presented.push(createNormalizedMessage({
          id: `${message.id}_chat_reply`,
          sessionId: message.sessionId,
          timestamp: message.timestamp,
          provider: message.provider,
          kind: 'text',
          role: 'assistant',
          content: `${tag}${sent.text}`,
        }));
      }
      if (message.toolId) {
        hiddenToolIds.add(message.toolId);
      }
      continue;
    }

    if (message.kind === 'tool_result' && message.toolId && hiddenToolIds.has(message.toolId)) {
      continue;
    }
    presented.push(message);
  }
  return presented;
}
