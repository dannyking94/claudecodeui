import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { restampClaudeTranscriptEntrypoint } from '@/modules/providers/list/claude/claude-transcript-entrypoint.provider.js';

const TRANSCRIPT_CWD = '/home/dk/Repo/vivat_mujoco';

type Transcript = {
  sessionId: string;
  cwd: string;
  jsonlPath: string;
  restore: () => void;
};

function transcriptRecord(sessionId: string, entrypoint: string, uuid: string): string {
  return JSON.stringify({
    parentUuid: null,
    userType: 'external',
    entrypoint,
    cwd: TRANSCRIPT_CWD,
    sessionId,
    uuid,
    type: 'user',
  });
}

/**
 * Builds the `~/.claude/projects/<encoded-cwd>/<session>.jsonl` layout under a
 * throwaway home so the restamper resolves a real path from a cwd. The session
 * id is random so the indexed-path fallback can never resolve to a transcript
 * that actually exists on the developer's machine.
 */
async function createTranscript(lines: (sessionId: string) => string[]): Promise<Transcript> {
  const sessionId = randomUUID();
  const fakeHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'cloudcli-entrypoint-'));
  const projectDir = path.join(
    fakeHome,
    '.claude',
    'projects',
    TRANSCRIPT_CWD.replace(/[^a-zA-Z0-9]/g, '-'),
  );
  await fsp.mkdir(projectDir, { recursive: true });

  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
  await fsp.writeFile(jsonlPath, `${lines(sessionId).join('\n')}\n`, 'utf8');

  const realHomedir = os.homedir;
  (os as { homedir: () => string }).homedir = () => fakeHome;

  return {
    sessionId,
    cwd: TRANSCRIPT_CWD,
    jsonlPath,
    restore: () => {
      (os as { homedir: () => string }).homedir = realHomedir;
    },
  };
}

async function readRecords(jsonlPath: string): Promise<Array<{ uuid?: string; entrypoint?: string }>> {
  const contents = await fsp.readFile(jsonlPath, 'utf8');
  return contents
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { uuid?: string; entrypoint?: string });
}

test('claude: SDK entrypoint stamps are rewritten to the value VS Code shows', async () => {
  const { sessionId, cwd, jsonlPath, restore } = await createTranscript((id) => [
    JSON.stringify({ type: 'queue-operation', sessionId: id }),
    transcriptRecord(id, 'sdk-cli', 'u1'),
    transcriptRecord(id, 'sdk-cli', 'u2'),
  ]);

  try {
    const sizeBefore = (await fsp.stat(jsonlPath)).size;
    const restamped = await restampClaudeTranscriptEntrypoint({ providerSessionId: sessionId, cwd });
    assert.equal(restamped, 2);

    const contents = await fsp.readFile(jsonlPath, 'utf8');
    assert.ok(!contents.includes('sdk-cli'));

    // Length-preserving replacement is the invariant that makes it safe to
    // patch a transcript the CLI is still appending to.
    assert.equal((await fsp.stat(jsonlPath)).size, sizeBefore);

    const records = await readRecords(jsonlPath);
    assert.deepEqual(records.map((record) => record.entrypoint), [undefined, 'cli', 'cli']);
  } finally {
    restore();
  }
});

test('claude: restamping an already-patched transcript only touches new records', async () => {
  const { sessionId, cwd, jsonlPath, restore } = await createTranscript((id) => [
    transcriptRecord(id, 'sdk-cli', 'u1'),
  ]);

  try {
    await restampClaudeTranscriptEntrypoint({ providerSessionId: sessionId, cwd });
    const sizeAfterFirstPass = (await fsp.stat(jsonlPath)).size;

    // Stands in for the live CLI continuing to append to the same transcript
    // between two turns.
    const appended = `${transcriptRecord(sessionId, 'sdk-cli', 'u2')}\n`;
    await fsp.appendFile(jsonlPath, appended, 'utf8');

    const restamped = await restampClaudeTranscriptEntrypoint({ providerSessionId: sessionId, cwd });
    assert.equal(restamped, 1);
    assert.equal(
      (await fsp.stat(jsonlPath)).size,
      sizeAfterFirstPass + Buffer.byteLength(appended, 'utf8'),
    );

    const records = await readRecords(jsonlPath);
    assert.deepEqual(records.map((record) => record.uuid), ['u1', 'u2']);
    assert.deepEqual(records.map((record) => record.entrypoint), ['cli', 'cli']);
  } finally {
    restore();
  }
});

test('claude: transcripts written by other entrypoints are left untouched', async () => {
  const { sessionId, cwd, jsonlPath, restore } = await createTranscript((id) => [
    transcriptRecord(id, 'claude-vscode', 'u1'),
  ]);

  try {
    const before = await fsp.readFile(jsonlPath, 'utf8');
    const restamped = await restampClaudeTranscriptEntrypoint({ providerSessionId: sessionId, cwd });

    assert.equal(restamped, 0);
    assert.equal(await fsp.readFile(jsonlPath, 'utf8'), before);
  } finally {
    restore();
  }
});

test('claude: a missing transcript is not an error', async () => {
  const { cwd, restore } = await createTranscript((id) => [transcriptRecord(id, 'sdk-cli', 'u1')]);

  try {
    const restamped = await restampClaudeTranscriptEntrypoint({
      providerSessionId: randomUUID(),
      cwd,
    });
    assert.equal(restamped, 0);
  } finally {
    restore();
  }
});

test('claude: restamping is disabled by CLOUDCLI_CLAUDE_VSCODE_HISTORY=off', async () => {
  const { sessionId, cwd, jsonlPath, restore } = await createTranscript((id) => [
    transcriptRecord(id, 'sdk-cli', 'u1'),
  ]);
  const previous = process.env.CLOUDCLI_CLAUDE_VSCODE_HISTORY;
  process.env.CLOUDCLI_CLAUDE_VSCODE_HISTORY = 'off';

  try {
    const restamped = await restampClaudeTranscriptEntrypoint({ providerSessionId: sessionId, cwd });
    assert.equal(restamped, 0);
    assert.ok((await fsp.readFile(jsonlPath, 'utf8')).includes('sdk-cli'));
  } finally {
    if (previous === undefined) {
      delete process.env.CLOUDCLI_CLAUDE_VSCODE_HISTORY;
    } else {
      process.env.CLOUDCLI_CLAUDE_VSCODE_HISTORY = previous;
    }
    restore();
  }
});
