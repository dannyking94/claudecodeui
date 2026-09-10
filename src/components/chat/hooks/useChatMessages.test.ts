import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { createChatMessageConverter } from './useChatMessages';

test('tool images survive live attachment, history conversion, and orphan results', () => {
  const convert = createChatMessageConverter();
  const tool: NormalizedMessage = {
    id: 'read', sessionId: 'session', timestamp: '2026-09-10T00:00:00Z', provider: 'claude',
    kind: 'tool_use', toolId: 'read', toolName: 'Read', toolInput: { file_path: '/tmp/image.png' },
  };
  const result: NormalizedMessage = {
    ...tool, id: 'result', kind: 'tool_result', content: '',
    images: [{ data: 'data:image/png;base64,AAAA' }],
  };
  assert.equal(convert([tool])[0].images, undefined);
  const live = convert([tool, result]);
  assert.equal(live.length, 1);
  assert.equal(live[0].type, 'assistant');
  assert.deepEqual(live[0].images, result.images);
  assert.deepEqual(createChatMessageConverter()([tool, result]), live);
  assert.deepEqual(convert([{ ...result, toolId: undefined }])[0].images, result.images);
});
