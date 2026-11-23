import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * A secretary's row: the owner's message is delivered to its chat bridge, and
 * the secretary answers in its own claude. The open view only learns of that
 * through watcher-driven refreshes, each of which stitches the server's latest
 * page onto the cached history by row id. The secretary's history is long, so
 * every page has older rows behind it and the stitch is the only path.
 *
 * The first refresh usually lands while the wake is still a placeholder; the
 * `read` fills its text in a few seconds later. The server keeps that row's id
 * across the change, and these tests pin that the view then follows it to the
 * reply without a reload (2026-11-23: it stayed stuck on the placeholder).
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

let transcript: NormalizedMessage[] = [];

/** Serves `transcript` the way the history route pages it: newest last, offset from the tail. */
function serveTranscriptPages() {
  sessionMessages.mockImplementation(async (_sessionId: string, options: { limit?: number; offset?: number }) => {
    const limit = options.limit ?? transcript.length;
    const end = Math.max(0, transcript.length - (options.offset ?? 0));
    const start = Math.max(0, end - limit);
    return {
      ok: true,
      json: async () => ({
        data: { messages: transcript.slice(start, end), total: transcript.length, hasMore: start > 0 },
      }),
    };
  });
}

const row = (id: string, second: number, fields: Partial<NormalizedMessage>): NormalizedMessage => ({
  id,
  sessionId: 'secretary',
  provider: 'claude',
  timestamp: new Date(Date.UTC(2026, 10, 23, 5, 0, second)).toISOString(),
  kind: 'text',
  ...fields,
} as NormalizedMessage);

const olderHistory = Array.from({ length: 40 }, (_, index) =>
  row(`old-${index}`, index, { role: index % 2 ? 'assistant' : 'user', content: `earlier ${index}` }));

afterEach(() => {
  sessionMessages.mockReset();
  vi.resetModules();
});

async function openView() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  const view = renderHook(() => useSessionStore());
  await act(async () => {
    await view.result.current.fetchFromServer('secretary', { limit: 20, offset: 0 });
  });
  return view;
}

describe('a secretary reply in an open view', () => {
  it('replaces the wake placeholder and appends the reply without a reload', async () => {
    serveTranscriptPages();
    // Wake written, read not yet.
    transcript = [...olderHistory, row('wake_chat_0', 50, { role: 'user', content: '📬 Message from owner' })];
    const { result } = await openView();

    const contents = () => result.current.getMessages('secretary').map((message) => message.content);
    assert.equal(contents().at(-1), '📬 Message from owner');

    // The read lands: same row, now the owner's text.
    transcript = [...olderHistory, row('wake_chat_0', 50, { role: 'user', content: 'is it done?' })];
    await act(async () => {
      await result.current.refreshLatestFromServer('secretary', { limit: 20 });
    });
    assert.equal(contents().at(-1), 'is it done?');

    // A long turn — more rows than one page — then the reply.
    const work = Array.from({ length: 25 }, (_, index) =>
      row(`work-${index}`, 51 + index, { kind: 'tool_use', toolName: 'Bash', toolId: `toolu_${index}`, toolInput: { command: `step ${index}` } }));
    transcript = [
      ...transcript,
      ...work,
      row('send_chat_reply', 80, { role: 'assistant', content: 'Done — pushed.' }),
    ];
    await act(async () => {
      await result.current.refreshLatestFromServer('secretary', { limit: 20 });
    });

    assert.equal(contents().at(-1), 'Done — pushed.');
    assert.equal(contents().filter((content) => content === 'is it done?').length, 1);
    assert.ok(!contents().includes('📬 Message from owner'));
    // The older history the view had loaded is kept, not dropped.
    assert.ok(contents().includes('earlier 39'));
  });
});
