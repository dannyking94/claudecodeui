import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * The Files tab used to fetch the whole project to depth 10 on every open,
 * which the server refuses with 413 above 10,000 visible entries — so the
 * largest repositories showed no tree at all. It now reads the root when it
 * opens and each folder only when that folder is expanded.
 */

const ROOT = '/home/owner/big-repo';

const listings: Record<string, unknown[]> = {
  [ROOT]: [
    { type: 'directory', name: 'docs', path: `${ROOT}/docs` },
    { type: 'directory', name: 'src', path: `${ROOT}/src` },
    { type: 'file', name: 'README.md', path: `${ROOT}/README.md` },
  ],
  [`${ROOT}/docs`]: [
    { type: 'directory', name: 'review', path: `${ROOT}/docs/review` },
    { type: 'file', name: 'index.md', path: `${ROOT}/docs/index.md` },
  ],
};

const getDirectoryListing = vi.fn();
const getFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    getDirectoryListing: (...args: unknown[]) => getDirectoryListing(...args),
    getFiles: (...args: unknown[]) => getFiles(...args),
  },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'big-repo', fullPath: ROOT, path: ROOT };

beforeEach(() => {
  getDirectoryListing.mockReset();
  getDirectoryListing.mockImplementation(async (_projectId: string, directoryPath: string | null) => {
    const path = directoryPath ?? ROOT;
    return { ok: true, json: async () => ({ path, entries: listings[path] ?? [], truncated: false }) };
  });
  getFiles.mockReset();
});

const requestedDirectories = () => getDirectoryListing.mock.calls.map((call) => call[1]);

test('opening the tree reads only the project root, never the whole project', async () => {
  render(<FileTree selectedProject={project} />);

  await waitFor(() => assert.ok(screen.getByText('README.md')));
  assert.deepEqual(requestedDirectories(), [null]);
  assert.equal(getFiles.mock.calls.length, 0);
});

test('expanding a folder reads that folder once, and collapsing keeps it', async () => {
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('docs')));

  fireEvent.click(screen.getByText('docs'));
  await waitFor(() => assert.ok(screen.getByText('index.md')));
  assert.deepEqual(requestedDirectories(), [null, `${ROOT}/docs`]);

  fireEvent.click(screen.getByText('docs'));
  await waitFor(() => assert.equal(screen.queryByText('index.md'), null));
  fireEvent.click(screen.getByText('docs'));
  await waitFor(() => assert.ok(screen.getByText('index.md')));
  // Re-opening a folder already read costs no request; `review` was never opened.
  assert.deepEqual(requestedDirectories(), [null, `${ROOT}/docs`]);
});

test('a refresh keeps the tree on screen and re-reads only the open folders', async () => {
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('docs')));
  fireEvent.click(screen.getByText('docs'));
  await waitFor(() => assert.ok(screen.getByText('index.md')));
  getDirectoryListing.mockClear();

  fireEvent.click(screen.getByTitle(/refresh/i));
  // No loading screen in between: the open folder stays visible.
  assert.ok(screen.getByText('index.md'));
  await waitFor(() => assert.equal(getDirectoryListing.mock.calls.length, 2));
  assert.deepEqual(requestedDirectories().sort(), [`${ROOT}/docs`, null].sort());
});
