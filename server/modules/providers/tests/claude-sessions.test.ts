import assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const SESSION_ID = 'session-1';

const SKILL_BODY = [
  'Base directory for this skill: /tmp/claude/bundled-skills/2.1.220/abc123/claude-api',
  '',
  '# Building LLM-Powered Applications with Claude',
  '',
  'This skill helps you build LLM-powered applications with Claude.',
].join('\n');

test('claude: injected skill bodies are hidden even without the isMeta flag', () => {
  const provider = new ClaudeSessionsProvider();

  // The live SDK stream omits `isMeta`, so the payload has to be recognised by
  // its content or it renders as a giant user bubble mid-run.
  const live = provider.normalizeMessage(
    {
      uuid: 'u1',
      timestamp: '2026-07-28T10:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: SKILL_BODY }] },
    },
    SESSION_ID,
  );
  assert.deepEqual(live, []);

  const persisted = provider.normalizeMessage(
    {
      uuid: 'u2',
      timestamp: '2026-07-28T10:00:00.000Z',
      isMeta: true,
      message: { role: 'user', content: [{ type: 'text', text: SKILL_BODY }] },
    },
    SESSION_ID,
  );
  assert.deepEqual(persisted, []);
});

test('claude: the Skill tool result itself still reaches the UI', () => {
  const provider = new ClaudeSessionsProvider();

  const messages = provider.normalizeMessage(
    {
      uuid: 'u3',
      timestamp: '2026-07-28T10:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Launching skill: claude-api' }],
      },
    },
    SESSION_ID,
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'tool_result');
  assert.equal(messages[0].toolId, 'toolu_1');
});

test('claude: image coordinate companions are hidden even without the isMeta flag', () => {
  const provider = new ClaudeSessionsProvider();
  const companion = '[Image: original 2247x928, displayed at 2000x826. Multiply coordinates by 1.12 to map to original image.]';
  for (const content of [companion, [{ type: 'text', text: companion }]]) {
    for (const isMeta of [undefined, true]) {
      assert.deepEqual(provider.normalizeMessage({
        type: 'user', isMeta, message: { role: 'user', content },
      }, SESSION_ID), []);
    }
  }
  for (const content of ['[Image: my diagram]', `${companion} Please explain.`, `Explain ${companion}`]) {
    const messages = provider.normalizeMessage({ message: { role: 'user', content } }, SESSION_ID);
    assert.equal(messages[0].content, content);
  }
});

test('claude: tool result images become attachments while text and non-image formats are preserved', () => {
  const provider = new ClaudeSessionsProvider();
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const normalize = (content: unknown) => provider.normalizeMessage({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-image', content, is_error: true }] },
  }, SESSION_ID);

  for (const content of [[image], [{ type: 'text', text: 'before' }, image, { type: 'text', text: 'after' }, image]]) {
    const messages = normalize(content);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'tool_result');
    assert.equal(messages[0].toolId, 'read-image');
    assert.equal(messages[0].isError, true);
    assert.equal(messages[0].content, content.length === 1 ? '' : 'before\nafter');
    assert.deepEqual(messages[0].images, content.filter((block) => block.type === 'image')
      .map(() => ({ data: 'data:image/png;base64,AAAA' })));
  }
  for (const content of ['plain result', [{ type: 'text', text: 'plain result' }], [],
    [{ type: 'image', source: { type: 'url', url: 'https://example.com/image.png' } }]]) {
    const [message] = normalize(content);
    assert.equal(message.content, typeof content === 'string' ? content : JSON.stringify(content));
    assert.equal(message.images, undefined);
  }
});
