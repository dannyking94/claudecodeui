import assert from 'node:assert/strict';

import { render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard for the wiring, not the maths: a directory reference clicked
 * in the chat reaches the tree as the model wrote it — relative to the project
 * root — while every node here is keyed by its absolute path. Rendering the
 * real tree is what proves the two ends still meet.
 */

const ROOT = '/home/odoo/workspace/personal';

// The tree is read one folder at a time, so the mock answers per directory.
const listings: Record<string, unknown[]> = {
  [ROOT]: [{ type: 'directory', name: 'decisions', path: `${ROOT}/decisions` }],
  [`${ROOT}/decisions`]: [
    { type: 'directory', name: 'archive', path: `${ROOT}/decisions/archive` },
    { type: 'file', name: '0001-first.md', path: `${ROOT}/decisions/0001-first.md` },
  ],
  [`${ROOT}/decisions/archive`]: [{ type: 'file', name: '0000-old.md', path: `${ROOT}/decisions/archive/0000-old.md` }],
};

vi.mock('@/shared/api', () => ({
  api: {
    getDirectoryListing: async (_projectId: string, directoryPath: string | null) => {
      const path = directoryPath ?? ROOT;
      return { ok: true, json: async () => ({ path, entries: listings[path] ?? [], truncated: false }) };
    },
  },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'personal', fullPath: ROOT, path: ROOT };

test('a relative directory reference expands that folder in the tree', async () => {
  render(<FileTree selectedProject={project} revealDirectory={{ path: 'decisions/' }} />);

  await waitFor(() => assert.ok(screen.getByText('decisions')));
  // Visible only because the folder was expanded for us.
  await waitFor(() => assert.ok(screen.getByText('0001-first.md')));
});

test('a folder nobody asked for stays closed', async () => {
  render(<FileTree selectedProject={project} revealDirectory={null} />);

  await waitFor(() => assert.ok(screen.getByText('decisions')));
  assert.equal(screen.queryByText('0001-first.md'), null);
});

test('a nested reference opens each level as the folder above it is read', async () => {
  render(<FileTree selectedProject={project} revealDirectory={{ path: 'decisions/archive/' }} />);

  await waitFor(() => assert.ok(screen.getByText('0000-old.md')));
});
