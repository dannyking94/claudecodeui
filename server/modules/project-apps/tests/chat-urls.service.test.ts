import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createChatLinkCollector, extractAppUrls, readAgentText } from '@/modules/project-apps/services/chat-urls.service.js';

test('extractAppUrls keeps addresses with a port, an IPv4 host or localhost', () => {
  const text = [
    'Viewer is up at http://192.0.2.10:8812/report.html.',
    'Also **http://localhost:5173/** and (http://198.51.100.7/status), see https://github.com/org/repo.',
    'Docs: https://example.com/page and `http://127.0.0.1:8790/api/state`',
  ].join('\n');
  assert.deepEqual(extractAppUrls(text), [
    'http://192.0.2.10:8812/report.html',
    'http://localhost:5173/',
    'http://198.51.100.7/status',
    'http://127.0.0.1:8790/api/state',
  ]);
});

test('extractAppUrls drops the hash and placeholders', () => {
  assert.deepEqual(extractAppUrls('open http://192.0.2.1:9000/view#cam2 or http://<host>:8000/'), ['http://192.0.2.1:9000/view']);
});

test('readAgentText reads Claude assistant text and reply-tool text, not tool commands', () => {
  const claude = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-01-02T03:04:05Z',
    message: { content: [
      { type: 'text', text: 'see http://192.0.2.1:8000/' },
      { type: 'tool_use', name: 'reply', input: { text: 'ready: http://192.0.2.1:8001/' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'curl http://192.0.2.1:9999/' } },
    ] },
  });
  const said = readAgentText(claude);
  assert.equal(said?.timestamp, '2026-01-02T03:04:05Z');
  assert.deepEqual(extractAppUrls(said?.text ?? ''), ['http://192.0.2.1:8000/', 'http://192.0.2.1:8001/']);
});

test('readAgentText reads Codex assistant messages and ignores user and tool output', () => {
  const codex = JSON.stringify({
    type: 'response_item',
    timestamp: '2026-01-02T03:04:05Z',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'at http://192.0.2.2:7000/' }] },
  });
  assert.match(readAgentText(codex)?.text ?? '', /7000/);
  const user = JSON.stringify({ type: 'user', message: { content: 'http://192.0.2.2:7001/' } });
  const toolOutput = JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: 'http://192.0.2.2:7002/' } });
  assert.equal(readAgentText(user), null);
  assert.equal(readAgentText(toolOutput), null);
  assert.equal(readAgentText('not json http://x'), null);
});

test('collectChatLinks groups by origin, skips registered ports and rescans only grown files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chat-links-'));
  try {
    const line = (ts: string, text: string) => `${JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } })}\n`;
    const first = path.join(dir, 'a.jsonl');
    const second = path.join(dir, 'b.jsonl');
    await writeFile(first, line('2026-01-01T00:00:00Z', 'http://192.0.2.5:8812/report.html and registered http://192.0.2.5:8801/'));
    await writeFile(second, line('2026-01-02T00:00:00Z', 'newer: http://192.0.2.5:8812/plot.html'));

    const { collectChatLinks } = createChatLinkCollector();
    const transcripts = [
      { sessionId: 's1', sessionName: 'first', provider: 'claude', jsonlPath: first },
      { sessionId: 's2', sessionName: null, provider: 'codex', jsonlPath: second },
      { sessionId: 's3', sessionName: null, provider: 'claude', jsonlPath: path.join(dir, 'missing.jsonl') },
    ];
    const links = await collectChatLinks(transcripts, new Set([8801]));
    assert.equal(links.length, 1);
    assert.equal(links[0].origin, 'http://192.0.2.5:8812');
    assert.equal(links[0].url, 'http://192.0.2.5:8812/plot.html');
    assert.deepEqual(links[0].paths, ['/plot.html', '/report.html']);
    assert.equal(links[0].sessionId, 's2');
    assert.equal(links[0].mentions, 2);

    await appendFile(first, line('2026-01-03T00:00:00Z', 'dev server http://localhost:5173/'));
    const updated = await collectChatLinks(transcripts, new Set([8801]));
    assert.deepEqual(updated.map((l) => l.origin), ['http://localhost:5173', 'http://192.0.2.5:8812']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
