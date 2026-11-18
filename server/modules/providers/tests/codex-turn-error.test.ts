import assert from 'node:assert/strict';
import test from 'node:test';

import { CodexSessionsProvider } from '@/modules/providers/list/codex/codex-sessions.provider.js';
import { parseCodexTurnError } from '@/shared/utils.js';

// Verbatim from a real rollout: Codex nests the API body as a JSON string.
const REJECTED_MODEL_MESSAGE = JSON.stringify({
  type: 'error',
  status: 400,
  error: {
    type: 'invalid_request_error',
    message: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
    code: 'model_not_found',
  },
});

test('parseCodexTurnError unwraps the nested API body and its code', () => {
  for (const input of [REJECTED_MODEL_MESSAGE, { message: REJECTED_MODEL_MESSAGE }, new Error(REJECTED_MODEL_MESSAGE)]) {
    assert.deepEqual(parseCodexTurnError(input), {
      message: "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.",
      code: 'model_not_found',
    });
  }
});

test('parseCodexTurnError passes plain text through and falls back when empty', () => {
  assert.deepEqual(parseCodexTurnError({ message: 'stream disconnected' }), {
    message: 'stream disconnected',
    code: null,
  });
  assert.deepEqual(parseCodexTurnError('{not json'), { message: '{not json', code: null });
  assert.deepEqual(parseCodexTurnError(null, 'Turn failed'), { message: 'Turn failed', code: null });
  assert.deepEqual(parseCodexTurnError({}), { message: 'Codex turn failed', code: null });
});

test('a failed Codex turn normalizes to a readable error tagged with its code', () => {
  const [message] = new CodexSessionsProvider().normalizeMessage(
    { type: 'turn_failed', error: { message: REJECTED_MODEL_MESSAGE } },
    'session-1',
  );

  assert.equal(message?.kind, 'error');
  assert.equal(message?.content, "The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.");
  assert.equal(message?.errorCode, 'model_not_found');
});
