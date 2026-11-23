import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard: an absolute path must open the file it names.
 *
 * `findBestMatch` falls back to matching by filename, which is what makes bare
 * references like `foo.ts` work. Applied to an absolute path it silently
 * rewrote the reference: asking for `/home/user/.config/CLAUDE.md` opened the
 * project's own `CLAUDE.md` — a different file, with no error, indistinguishable
 * from the right one.
 */

const searchFiles = vi.fn();
const getFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    searchFiles: (...args: unknown[]) => searchFiles(...args),
    getFiles: (...args: unknown[]) => getFiles(...args),
  },
}));

const { useFileOpenResolver } = await import('@/modules/project-workspace/hooks/useFileOpenResolver');

const ROOT = '/home/odoo/workspace/personal';
const project: Project = { projectId: 'p1', displayName: 'personal', fullPath: ROOT };

const defaultFiles = ['CLAUDE.md', 'src/foo.ts'];

// Answers like the server's filename search: files whose relative path
// contains the query, shortest path first.
const serveProject = (relativePaths: string[]) => {
  searchFiles.mockImplementation(async (_projectId: string, searchQuery: string, limit: number) => ({
    ok: true,
    json: async () => ({
      files: relativePaths
        .filter((relativePath) => relativePath.toLowerCase().includes(searchQuery.toLowerCase()))
        .sort((left, right) => left.length - right.length)
        .slice(0, limit)
        .map((relativePath) => ({
          name: relativePath.split('/').pop(),
          path: `${ROOT}/${relativePath}`,
          relativePath,
        })),
      truncated: false,
      source: 'git',
    }),
  }));
};

const setup = (relativePaths: string[] = defaultFiles) => {
  searchFiles.mockReset();
  getFiles.mockReset();
  // The full tree is what large projects are refused; the resolver must not need it.
  getFiles.mockResolvedValue({ ok: false, status: 413, json: async () => ({ error: 'too large' }) });
  serveProject(relativePaths);
  const onFileOpen = vi.fn();
  const { result } = renderHook(() => useFileOpenResolver(project, onFileOpen));
  return { resolve: result.current, onFileOpen };
};

test('an absolute path outside the project is passed through untouched', async () => {
  const { resolve, onFileOpen } = setup();
  resolve('/home/odoo/.claude/CLAUDE.md');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], '/home/odoo/.claude/CLAUDE.md');
  // It does not even need a search, so no request goes out.
  assert.equal(searchFiles.mock.calls.length, 0);
});

test('an absolute path inside the project resolves to itself, as before', async () => {
  const { resolve, onFileOpen } = setup();
  resolve(`${ROOT}/src/foo.ts`);
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);
});

test('partial references still match against the project files', async () => {
  const { resolve, onFileOpen } = setup();
  resolve('foo.ts');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);

  const second = setup();
  second.resolve('src/foo.ts');
  await waitFor(() => assert.equal(second.onFileOpen.mock.calls.length, 1));
  assert.equal(second.onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);
});

test('diffInfo and line survive the absolute-path shortcut', async () => {
  const { resolve, onFileOpen } = setup();
  const diffInfo = { old_string: 'a', new_string: 'b' };
  resolve('/home/odoo/.claude/CLAUDE.md', diffInfo, 150);
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.deepEqual(onFileOpen.mock.calls[0].slice(1), [diffInfo, 150]);
});

test('surrounding whitespace never reaches the API as part of the path', async () => {
  const { resolve, onFileOpen } = setup();
  resolve('  /home/odoo/.claude/CLAUDE.md ');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], '/home/odoo/.claude/CLAUDE.md');

  const second = setup();
  second.resolve('nope.ts ');
  await waitFor(() => assert.equal(second.onFileOpen.mock.calls.length, 1));
  assert.equal(second.onFileOpen.mock.calls[0][0], 'nope.ts');
});

test('a bare name resolves inside a project too large for the full tree', async () => {
  const largeProject = [
    ...Array.from({ length: 12_000 }, (_, index) => `docs/review/page-${index}.md`),
    'tools/dgn_eval/report_builder.py',
  ];
  const { resolve, onFileOpen } = setup(largeProject);
  resolve('report_builder.py');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/tools/dgn_eval/report_builder.py`);
  assert.equal(getFiles.mock.calls.length, 0);
});

test('a partial path whose folder does not exist falls back to the filename', async () => {
  const { resolve, onFileOpen } = setup(['lib/foo.ts']);
  resolve('src/foo.ts');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/lib/foo.ts`);
  assert.deepEqual(searchFiles.mock.calls.map((call) => call[1]), ['src/foo.ts', 'foo.ts']);
});

test('a failed search opens the reference as written', async () => {
  const { resolve, onFileOpen } = setup();
  searchFiles.mockReset();
  searchFiles.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
  resolve('foo.ts');
  await waitFor(() => assert.equal(onFileOpen.mock.calls.length, 1));
  assert.equal(onFileOpen.mock.calls[0][0], 'foo.ts');
});
