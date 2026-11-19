/**
 * Delivers a message typed in a registered secretary's cloudcli row into that
 * secretary's chat bridge, instead of resuming a second claude on its session.
 *
 * The bridge (cc-chat) listens on a Unix socket published as the registry
 * entry's `inbox`. Wire: newline-delimited JSON, one request per line, answered
 * with one line — `{"ok":true,"id":…,"room":"local/owner","files":N}` or
 * `{"ok":false,"error":…}`. Author `owner` lands in the secretary's
 * `local/owner` room and wakes it like a Discord DM.
 *
 * Attachments travel as `files: [{path, name, mime}]` — absolute paths on this
 * machine (cloudcli and the bridge run as the same user on the same host). The
 * paths point at private copies staged by {@link stageInboxUploads} under
 * `~/.cloudcli/inbox-uploads/<date>/` (dirs 0700, files 0600), which is the
 * bridge's default allowed root. The bridge copies each file into its own store
 * before it answers, so the staged copies are removed once it has answered.
 * The answer's `files` is how many it took: a bridge older than attachments
 * ignores the field and answers without it.
 *
 * The reply is not read back here. The secretary's answer is written to the
 * same transcript jsonl this row already renders (the session watcher re-syncs
 * it), so the transcript is the view. The bridge's `local-outbox.jsonl` is a
 * receipt for senders without that view; tailing it too would show each reply
 * twice.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  isAllowedImageSourcePath,
  resolveImageAbsolutePath,
  resolveImageMediaType,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';

/** Covers connect plus the bridge's one-line answer; a live bridge answers in milliseconds. */
const INBOX_ANSWER_TIMEOUT_MS = 5_000;

/** Bounds a misbehaving peer that streams without ever sending a newline. */
const MAX_ANSWER_BYTES = 64 * 1024;

/**
 * Outcome of one delivery attempt, as reported to the row.
 *
 * `reason` is a short human sentence fragment, shown after "could not deliver".
 */
type SecretaryInboxDelivery =
  | { ok: true; id: string | null; room: string | null; files: number }
  | { ok: false; reason: string };

/** One entry of a request's `files`: an absolute path the bridge copies from. */
export type SecretaryInboxFile = { path: string; name: string; mime: string };

/** The bridge's limits (cc-chat internal/inbox: MaxFiles, MaxFileBytes). */
export const INBOX_MAX_FILES = 10;
export const INBOX_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Where attachments are staged for the bridge; the bridge's default file root. */
export function getInboxUploadsDir(): string {
  return path.join(os.homedir(), '.cloudcli', 'inbox-uploads');
}

/** Attachments staged for one delivery, and what could not be. */
export type StagedInboxUploads = {
  files: SecretaryInboxFile[];
  /** One short reason per attachment that was not staged. */
  skipped: string[];
  /** Removes the staged copies; safe to call more than once. */
  cleanup: () => Promise<void>;
};

/**
 * Copies chat attachments into a private per-day directory under
 * {@link getInboxUploadsDir}, for the bridge to copy from.
 *
 * Only descriptors that pass the same trust boundary the provider builders use
 * (the global upload store or the run's cwd) are staged; a missing, non-regular,
 * oversized or surplus file is skipped with a reason rather than failing the
 * message. Never throws.
 */
export async function stageInboxUploads(
  descriptors: ChatAttachmentDescriptor[],
  cwd?: string,
): Promise<StagedInboxUploads> {
  const files: SecretaryInboxFile[] = [];
  const skipped: string[] = [];
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(getInboxUploadsDir(), day);
  const cleanup = async () => {
    await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
  };

  for (const descriptor of descriptors) {
    const label = descriptor.name || path.basename(descriptor.path);
    if (files.length >= INBOX_MAX_FILES) {
      skipped.push(`${label}: more than ${INBOX_MAX_FILES} attachments`);
      continue;
    }
    const source = resolveImageAbsolutePath(cwd, descriptor.path);
    if (!isAllowedImageSourcePath(source, cwd)) {
      skipped.push(`${label}: not in the upload store`);
      continue;
    }
    try {
      const stat = await fs.stat(source);
      if (!stat.isFile()) {
        skipped.push(`${label}: not a regular file`);
        continue;
      }
      if (stat.size > INBOX_MAX_FILE_BYTES) {
        skipped.push(`${label}: larger than ${INBOX_MAX_FILE_BYTES / 1024 / 1024} MB`);
        continue;
      }
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(getInboxUploadsDir(), 0o700);
      await fs.chmod(dir, 0o700);
      const target = path.join(dir, `${randomBytes(8).toString('hex')}-${safeUploadName(label)}`);
      const bytes = await fs.readFile(source);
      await fs.writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
      files.push({
        path: target,
        name: label,
        mime: descriptor.mimeType || resolveImageMediaType(descriptor) || '',
      });
    } catch (error) {
      skipped.push(`${label}: ${(error as NodeJS.ErrnoException).code ?? 'could not be copied'}`);
    }
  }
  return { files, skipped, cleanup };
}

/** Reduces a name to [A-Za-z0-9._-] for the staged copy; the original rides in `name`. */
function safeUploadName(name: string): string {
  const cleaned = path.basename(name).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned.slice(-100) || 'file';
}

/**
 * Sends `text` (and `files`, when any) as an owner message to the bridge
 * listening on `socketPath`.
 *
 * Consumed by the Claude runtime when a chat turn targets a registered
 * secretary's session. Never throws: a missing socket, a refused connection, a
 * timeout, a malformed answer and `{"ok":false}` all resolve to `ok: false`
 * with the reason, so the caller can fall back to its refusal.
 */
export function deliverToSecretaryInbox(
  socketPath: string,
  text: string,
  files: SecretaryInboxFile[] = [],
  timeoutMs: number = INBOX_ANSWER_TIMEOUT_MS,
): Promise<SecretaryInboxDelivery> {
  return new Promise((resolve) => {
    let settled = false;
    let buffered = '';
    const socket = net.createConnection({ path: socketPath });

    const finish = (result: SecretaryInboxDelivery) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, reason: `the inbox did not answer within ${timeoutMs} ms` });
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      const request = {
        source: 'cloudcli',
        author: 'owner',
        text,
        ts: Math.floor(Date.now() / 1000),
        ...(files.length > 0 ? { files } : {}),
      };
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      const newline = buffered.indexOf('\n');
      if (newline === -1) {
        if (buffered.length > MAX_ANSWER_BYTES) {
          finish({ ok: false, reason: 'the inbox answered with an oversized line' });
        }
        return;
      }
      finish(parseInboxAnswer(buffered.slice(0, newline)));
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish({ ok: false, reason: `the inbox socket is unreachable (${error.code ?? error.message})` });
    });
    socket.on('close', () => {
      finish({ ok: false, reason: 'the inbox closed the connection without answering' });
    });
  });
}

function parseInboxAnswer(line: string): SecretaryInboxDelivery {
  let answer: unknown;
  try {
    answer = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'the inbox answered with something that is not JSON' };
  }
  const fields = (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>;
  if (fields.ok === true) {
    return {
      ok: true,
      id: typeof fields.id === 'string' || typeof fields.id === 'number' ? String(fields.id) : null,
      room: typeof fields.room === 'string' ? fields.room : null,
      files: typeof fields.files === 'number' && Number.isInteger(fields.files) && fields.files > 0 ? fields.files : 0,
    };
  }
  const error = typeof fields.error === 'string' && fields.error ? fields.error : 'no reason given';
  return { ok: false, reason: `the inbox refused it (${error})` };
}
