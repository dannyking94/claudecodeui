import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

/**
 * The palette's files come from the server's filename search for the typed
 * text, so a large project (whose full tree the server refuses with 413) still
 * lists files, and a file far past the first few hundred can be found.
 */

const searchFiles = vi.fn();
const getFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    searchFiles: (...args: unknown[]) => searchFiles(...args),
    getFiles: (...args: unknown[]) => getFiles(...args),
  },
}));

const { useFilesSource } = await import('@/modules/command-palette/hooks/useFilesSource');

const ROOT = '/home/user/big-project';
const PROJECT_FILES = Array.from({ length: 12_000 }, (_, index) => `docs/review/page-${index}.md`);

const reset = () => {
  searchFiles.mockReset();
  getFiles.mockReset();
  getFiles.mockResolvedValue({ ok: false, status: 413, json: async () => ({ error: 'too large' }) });
  searchFiles.mockImplementation(async (_projectId: string, searchQuery: string, limit: number) => ({
    ok: true,
    json: async () => ({
      files: PROJECT_FILES
        .filter((relativePath) => relativePath.includes(searchQuery))
        .slice(0, limit)
        .map((relativePath) => ({
          name: relativePath.split('/').pop(),
          path: `${ROOT}/${relativePath}`,
          relativePath,
        })),
      truncated: true,
      source: 'git',
    }),
  }));
};

test('lists files of a project too large for the full tree, without asking for the tree', async () => {
  reset();
  const { result } = renderHook(() => useFilesSource('p1', true, ''));

  await waitFor(() => assert.equal(result.current.length, 200));
  assert.deepEqual(result.current[0], { name: 'page-0.md', path: `${ROOT}/docs/review/page-0.md` });
  assert.deepEqual(searchFiles.mock.calls[0].slice(0, 3), ['p1', '', 200]);
  assert.equal(getFiles.mock.calls.length, 0);
});

test('searches the server for the typed text, once per pause in typing', async () => {
  reset();
  const { result, rerender } = renderHook(
    ({ text }: { text: string }) => useFilesSource('p1', true, text),
    { initialProps: { text: '' } },
  );
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));

  rerender({ text: 'page-1199' });
  rerender({ text: 'page-11999' });
  rerender({ text: 'page-11999 ' });

  await waitFor(() => assert.deepEqual(result.current, [
    { name: 'page-11999.md', path: `${ROOT}/docs/review/page-11999.md` },
  ]));
  assert.deepEqual(searchFiles.mock.calls.map((call) => call[1]), ['', 'page-11999']);
});

test('does nothing while the palette is closed', async () => {
  reset();
  const { result } = renderHook(() => useFilesSource('p1', false, 'page'));
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 250));
  assert.deepEqual(result.current, []);
  assert.equal(searchFiles.mock.calls.length, 0);
});
