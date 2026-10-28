/**
 * Delivers a message typed in a registered secretary's cloudcli row into that
 * secretary's chat bridge, instead of resuming a second claude on its session.
 *
 * The bridge (cc-chat) listens on a Unix socket published as the registry
 * entry's `inbox`. Wire: newline-delimited JSON, one request per line, answered
 * with one line — `{"ok":true,"id":…,"room":"local/owner"}` or
 * `{"ok":false,"error":…}`. Author `owner` lands in the secretary's
 * `local/owner` room and wakes it like a Discord DM.
 *
 * The reply is not read back here. The secretary's answer is written to the
 * same transcript jsonl this row already renders (the session watcher re-syncs
 * it), so the transcript is the view. The bridge's `local-outbox.jsonl` is a
 * receipt for senders without that view; tailing it too would show each reply
 * twice.
 */

import net from 'node:net';

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
  | { ok: true; id: string | null; room: string | null }
  | { ok: false; reason: string };

/**
 * Sends `text` as an owner message to the bridge listening on `socketPath`.
 *
 * Consumed by the Claude runtime when a chat turn targets a registered
 * secretary's session. Never throws: a missing socket, a refused connection, a
 * timeout, a malformed answer and `{"ok":false}` all resolve to `ok: false`
 * with the reason, so the caller can fall back to its refusal.
 */
export function deliverToSecretaryInbox(
  socketPath: string,
  text: string,
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
    };
  }
  const error = typeof fields.error === 'string' && fields.error ? fields.error : 'no reason given';
  return { ok: false, reason: `the inbox refused it (${error})` };
}
