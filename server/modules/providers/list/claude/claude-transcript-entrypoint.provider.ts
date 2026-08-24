import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';

/**
 * Keeps CloudCLI-started Claude sessions visible in the Claude Code VS Code
 * extension's History list.
 *
 * Claude Code stamps `"entrypoint"` into every transcript record straight from
 * `process.env.CLAUDE_CODE_ENTRYPOINT`, and the CLI overwrites that variable
 * with `sdk-cli` whenever it is driven over `--input-format stream-json` —
 * which is exactly how the agent SDK runs it. No env var the server passes
 * survives that, so `sdkOptions.env.CLAUDE_CODE_ENTRYPOINT` cannot fix this.
 * The VS Code extension then hides every transcript whose first `entrypoint`
 * stamp is `sdk-cli`, `sdk-ts` or `sdk-py`, which is why sessions started from
 * the CloudCLI web UI never showed up there.
 *
 * The only remaining lever is the transcript file itself, so the stamps are
 * rewritten to `cli` after the fact.
 */

/** Entrypoint values the VS Code extension treats as "SDK-driven" and hides. */
const HIDDEN_ENTRYPOINTS = ['sdk-cli', 'sdk-ts', 'sdk-py'] as const;

/** What an interactive `claude` invocation stamps; the extension shows those. */
const VISIBLE_ENTRYPOINT = 'cli';

/**
 * Upper bound on how much of a transcript is scanned per call.
 *
 * The extension only reads the first 64 KiB of a transcript to decide
 * visibility and uses the *first* stamp it finds there, so patching the head
 * is already sufficient. This cap simply keeps a pathologically large
 * transcript from being pulled into memory in full.
 */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;

type EntrypointStampPatch = {
  readonly search: Buffer;
  readonly replacement: Buffer;
};

/**
 * Every replacement is byte-length preserving: JSON tolerates whitespace
 * between a value and the following `,` or `}`, so `"entrypoint":"sdk-cli"`
 * becomes `"entrypoint":"cli"    `. That invariant is what makes it safe to
 * patch a transcript a live CLI is still appending to — offsets never shift
 * and the file is never truncated, so no concurrently written record is lost.
 */
const ENTRYPOINT_STAMP_PATCHES: readonly EntrypointStampPatch[] = ['"entrypoint":"', '"entrypoint": "']
  .flatMap((fieldPrefix) => HIDDEN_ENTRYPOINTS.map((hiddenEntrypoint) => {
    const search = `${fieldPrefix}${hiddenEntrypoint}"`;
    const replacement = `${fieldPrefix}${VISIBLE_ENTRYPOINT}"`.padEnd(search.length, ' ');

    return {
      search: Buffer.from(search, 'utf8'),
      replacement: Buffer.from(replacement, 'utf8'),
    };
  }));

/** Escape hatch for users who would rather CloudCLI never touch transcripts. */
function isRestampEnabled(): boolean {
  const setting = process.env.CLOUDCLI_CLAUDE_VSCODE_HISTORY?.trim().toLowerCase();
  return setting !== 'off' && setting !== '0' && setting !== 'false';
}

/**
 * Rebuilds the transcript path Claude Code writes for one session.
 *
 * Claude derives the project folder by replacing every non-alphanumeric
 * character of the absolute cwd with `-`, so `/home/dk/Repo/my_app` becomes
 * `-home-dk-Repo-my-app`.
 */
function resolveTranscriptPathFromCwd(providerSessionId: string, cwd: string): string {
  const encodedProjectDir = path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encodedProjectDir, `${providerSessionId}.jsonl`);
}

/** Looks up the transcript path the session synchronizer already indexed. */
function readIndexedTranscriptPath(providerSessionId: string): string | null {
  try {
    return sessionsDb.getSessionByProviderSessionId(providerSessionId)?.jsonl_path ?? null;
  } catch {
    // The transcript path is a convenience fallback; a database that is not
    // ready yet must never stop the cwd-derived path from being patched.
    return null;
  }
}

/**
 * Patches every hidden entrypoint stamp in one transcript and returns how many
 * were rewritten. Only the byte ranges that actually change are written back,
 * so a transcript Claude rewrites underneath us can lose at most the stamps of
 * this pass, never any content.
 */
async function restampTranscriptFile(jsonlPath: string): Promise<number> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(jsonlPath, 'r+');
  } catch {
    // No transcript at this path yet, or it is not writable. Both are normal.
    return 0;
  }

  try {
    const { size } = await handle.stat();
    if (size === 0) {
      return 0;
    }

    const scanLength = Math.min(size, MAX_SCAN_BYTES);
    const buffer = Buffer.alloc(scanLength);
    let scanned = 0;
    while (scanned < scanLength) {
      const { bytesRead } = await handle.read(buffer, scanned, scanLength - scanned, scanned);
      if (bytesRead === 0) {
        break;
      }
      scanned += bytesRead;
    }

    let restamped = 0;
    for (const { search, replacement } of ENTRYPOINT_STAMP_PATCHES) {
      let matchOffset = buffer.indexOf(search);
      while (matchOffset !== -1 && matchOffset + search.length <= scanned) {
        await handle.write(replacement, 0, replacement.length, matchOffset);
        restamped += 1;
        matchOffset = buffer.indexOf(search, matchOffset + search.length);
      }
    }

    return restamped;
  } finally {
    await handle.close();
  }
}

/**
 * Restamps a single session's transcript.
 *
 * Consumed by `claude-runtime.provider.js`, which calls it once a turn has
 * finished so the session CloudCLI just drove appears in the VS Code
 * extension's History list. Returns the number of stamps rewritten.
 */
export async function restampClaudeTranscriptEntrypoint(input: {
  providerSessionId: string | null | undefined;
  cwd?: string | null;
}): Promise<number> {
  if (!isRestampEnabled() || !input.providerSessionId) {
    return 0;
  }

  // The cwd-derived path is tried first because it is available immediately,
  // while the indexed path only exists once the filesystem watcher has caught
  // up with a brand-new session.
  const candidatePaths = new Set<string>();
  if (input.cwd) {
    candidatePaths.add(resolveTranscriptPathFromCwd(input.providerSessionId, input.cwd));
  }
  const indexedPath = readIndexedTranscriptPath(input.providerSessionId);
  if (indexedPath) {
    candidatePaths.add(indexedPath);
  }

  let restamped = 0;
  for (const candidatePath of candidatePaths) {
    restamped += await restampTranscriptFile(candidatePath);
  }

  return restamped;
}

/**
 * Restamps the transcripts of every Claude session CloudCLI has started so
 * far, so sessions that predate this fix become visible too.
 *
 * Consumed by `server/index.ts` (through the providers barrel) once per boot,
 * after the initial session synchronization has populated the index. Returns
 * the number of sessions whose transcript was changed.
 */
export async function restampCloudcliClaudeTranscripts(): Promise<number> {
  if (!isRestampEnabled()) {
    return 0;
  }

  const rows = [...sessionsDb.getAllSessions(), ...sessionsDb.getArchivedSessions()];

  let restampedSessions = 0;
  for (const row of rows) {
    if (row.provider !== 'claude' || !row.provider_session_id) {
      continue;
    }

    // Sessions discovered on disk key both columns with the provider-native id;
    // only a session CloudCLI started itself carries an app-allocated
    // `session_id` alongside the provider id it later announced. Restricting
    // the backfill this way leaves transcripts owned by other SDK tools alone.
    if (row.provider_session_id === row.session_id) {
      continue;
    }

    const restamped = await restampClaudeTranscriptEntrypoint({
      providerSessionId: row.provider_session_id,
      cwd: row.project_path,
    });
    if (restamped > 0) {
      restampedSessions += 1;
    }
  }

  return restampedSessions;
}
