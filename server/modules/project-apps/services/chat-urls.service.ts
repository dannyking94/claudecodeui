import { open, stat } from 'node:fs/promises';

import type { ProjectChatLink } from '@/shared/types.js';

/**
 * Finds the web addresses agents wrote in a project's chats.
 *
 * Only what an agent said counts — assistant text and the text of its chat
 * replies (a secretary answers through a reply tool) — never tool output or
 * shell commands, which are full of probe URLs nobody is meant to open.
 */

/** A transcript to scan, as the view service reads it from the sessions table. */
export type ChatTranscript = {
  sessionId: string;
  sessionName: string | null;
  provider: string;
  jsonlPath: string;
};

type UrlMention = { url: string; timestamp: string | null };

const URL_PATTERN = /https?:\/\/[^\s<>"'`()[\]{}|\\^]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?*_~]+$/;
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;
// Transcripts can run to hundreds of MB; the newest part is what matters.
const MAX_TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;
// Fields of an assistant tool call that carry prose meant for a person.
const REPLY_TEXT_FIELDS = ['text', 'message'];

/**
 * Pulls web-app URLs out of free text: a URL qualifies when it names a port
 * or its host is an IPv4 address or `localhost` (public sites on default
 * ports are not apps the fleet runs). Trailing markdown/sentence punctuation
 * is dropped and the hash is removed. Used by `collectChatLinks` and tests.
 */
export function extractAppUrls(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION, '');
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    const host = parsed.hostname;
    if (!parsed.port && !IPV4_PATTERN.test(host) && host !== 'localhost') continue;
    // Placeholders such as http://<host>:8000 fail URL parsing above; this
    // catches template remnants that survive it.
    if (host.includes('$') || host.includes('%')) continue;
    parsed.hash = '';
    found.push(parsed.toString());
  }
  return found;
}

function collectReplyText(input: unknown, out: string[]): void {
  if (!input || typeof input !== 'object') return;
  for (const field of REPLY_TEXT_FIELDS) {
    const value = (input as Record<string, unknown>)[field];
    if (typeof value === 'string') out.push(value);
  }
}

/**
 * Returns what the agent said on one transcript line (Claude or Codex JSONL),
 * or null when the line is not agent prose. Used by `collectChatLinks` and tests.
 */
export function readAgentText(line: string): { text: string; timestamp: string | null } | null {
  if (!line.includes('http')) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : null;
  const texts: string[] = [];

  // Claude Code: {"type":"assistant","message":{"content":[{type:"text"}|{type:"tool_use",input}]}}
  if (entry.type === 'assistant') {
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        if (block?.type === 'tool_use') collectReplyText(block.input, texts);
      }
    }
  }

  // Codex: {"type":"response_item","payload":{"type":"message","role":"assistant","content":[{text}]}}
  if (entry.type === 'response_item') {
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (payload?.type === 'message' && payload.role === 'assistant' && Array.isArray(payload.content)) {
      for (const block of payload.content as Array<Record<string, unknown>>) {
        if (typeof block?.text === 'string') texts.push(block.text);
      }
    }
  }

  return texts.length > 0 ? { text: texts.join('\n'), timestamp } : null;
}

async function readTail(filePath: string, size: number): Promise<string> {
  const start = Math.max(0, size - MAX_TRANSCRIPT_TAIL_BYTES);
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    // A tail read starts mid-line; drop the partial first line.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  } finally {
    await handle.close();
  }
}

/**
 * Builds a transcript scanner with a per-file cache keyed by size and mtime,
 * so a refresh only re-reads transcripts that grew. Used by the module
 * composition to back the view service's chat links.
 */
export function createChatLinkCollector() {
  const cache = new Map<string, { size: number; mtimeMs: number; mentions: UrlMention[] }>();

  async function mentionsIn(filePath: string): Promise<UrlMention[]> {
    let info;
    try {
      info = await stat(filePath);
    } catch {
      return [];
    }
    const cached = cache.get(filePath);
    if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.mentions;
    const mentions: UrlMention[] = [];
    for (const line of (await readTail(filePath, info.size)).split('\n')) {
      const said = readAgentText(line);
      if (!said) continue;
      for (const url of extractAppUrls(said.text)) mentions.push({ url, timestamp: said.timestamp });
    }
    cache.set(filePath, { size: info.size, mtimeMs: info.mtimeMs, mentions });
    return mentions;
  }

  /**
   * Scans the given transcripts and groups their URLs by origin. Origins whose
   * port belongs to a registered app are dropped — those already have a card.
   * Newest mention first.
   */
  async function collectChatLinks(transcripts: ChatTranscript[], registeredPorts: Set<number>): Promise<ProjectChatLink[]> {
    const byOrigin = new Map<string, ProjectChatLink & { pathTimes: Map<string, string> }>();
    for (const transcript of transcripts) {
      for (const mention of await mentionsIn(transcript.jsonlPath)) {
        const parsed = new URL(mention.url);
        const port = parsed.port ? Number(parsed.port) : null;
        if (port !== null && registeredPorts.has(port)) continue;
        const pathAndQuery = `${parsed.pathname}${parsed.search}`;
        const stamp = mention.timestamp ?? '';
        const existing = byOrigin.get(parsed.origin);
        if (!existing) {
          byOrigin.set(parsed.origin, {
            origin: parsed.origin,
            url: mention.url,
            port,
            paths: [],
            sessionId: transcript.sessionId,
            sessionName: transcript.sessionName,
            provider: transcript.provider,
            mentionedAt: mention.timestamp,
            mentions: 1,
            pathTimes: new Map([[pathAndQuery, stamp]]),
          });
          continue;
        }
        existing.mentions += 1;
        if ((existing.pathTimes.get(pathAndQuery) ?? '') <= stamp) existing.pathTimes.set(pathAndQuery, stamp);
        if ((existing.mentionedAt ?? '') <= stamp) {
          Object.assign(existing, {
            url: mention.url,
            sessionId: transcript.sessionId,
            sessionName: transcript.sessionName,
            provider: transcript.provider,
            mentionedAt: mention.timestamp,
          });
        }
      }
    }
    return [...byOrigin.values()]
      .map(({ pathTimes, ...link }) => ({
        ...link,
        paths: [...pathTimes.entries()].sort((a, b) => b[1].localeCompare(a[1])).map(([p]) => p).slice(0, 6),
      }))
      .sort((a, b) => (b.mentionedAt ?? '').localeCompare(a.mentionedAt ?? ''));
  }

  return { collectChatLinks };
}
