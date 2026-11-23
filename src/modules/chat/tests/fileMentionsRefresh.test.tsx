import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent, RefObject } from 'react';
import { test, vi } from 'vitest';

import type { Project, ProjectFileSearchResult } from '@/shared/types';

/**
 * The `@` dropdown asks the server's filename search for what is typed, so it
 * works on projects whose full tree the server refuses (413 above 10,000
 * entries), and a file added since the last search (an upload, an agent edit,
 * a terminal command — #1367) is offered by the next one.
 */

const searchFiles = vi.fn();
const getFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    searchFiles: (...args: unknown[]) => searchFiles(...args),
    getFiles: (...args: unknown[]) => getFiles(...args),
  },
}));

const { useFileMentions } = await import('@/modules/chat/hooks/useFileMentions');

const ROOT = '/home/user/project';
const project: Project = { projectId: 'p1', displayName: 'project', fullPath: ROOT };

const searchResponse = (relativePaths: string[]) => {
  const body: ProjectFileSearchResult = {
    files: relativePaths.map((relativePath) => ({
      name: relativePath.split('/').pop() ?? relativePath,
      path: `${ROOT}/${relativePath}`,
      relativePath,
    })),
    truncated: false,
    source: 'git',
  };
  return { ok: true, json: async () => body };
};

// Answers like the server: every file whose relative path contains the query.
const serveProject = (relativePaths: string[]) => {
  searchFiles.mockImplementation(async (_projectId: string, searchQuery: string, limit: number) =>
    searchResponse(relativePaths.filter((relativePath) => relativePath.toLowerCase().includes(searchQuery.toLowerCase())).slice(0, limit)),
  );
};

// A search response the test resolves by hand, to hold a request in flight.
const deferredSearchResponse = () => {
  let resolve: (relativePaths: string[]) => void = () => {};
  const promise = new Promise<ReturnType<typeof searchResponse>>((resolvePromise) => {
    resolve = (relativePaths) => resolvePromise(searchResponse(relativePaths));
  });
  return { promise, resolve };
};

const keyEvent = (key: string) =>
  ({ key, preventDefault: () => {} }) as unknown as KeyboardEvent<HTMLTextAreaElement>;

const queries = () => searchFiles.mock.calls.map((call) => call[1] as string);

const renderMentions = () => {
  const textareaRef: RefObject<HTMLTextAreaElement> = { current: null };
  const hook = renderHook(
    ({ input }: { input: string }) =>
      useFileMentions({ selectedProject: project, input, setInput: vi.fn(), textareaRef }),
    { initialProps: { input: '' } },
  );

  // Mirrors the composer: the input changes and the caret follows it.
  const type = (input: string) => {
    hook.rerender({ input });
    act(() => {
      hook.result.current.setCursorPosition(input.length);
    });
  };

  const shownNames = () => hook.result.current.filteredFiles.map((file) => file.name);

  return { ...hook, type, shownNames };
};

const reset = () => {
  searchFiles.mockReset();
  getFiles.mockReset();
  getFiles.mockResolvedValue({ ok: false, status: 413, json: async () => ({ error: 'too large' }) });
};

test('a file deep in a project too large for the full tree is offered, without asking for the tree', async () => {
  reset();
  serveProject(Array.from({ length: 12_000 }, (_, index) => `docs/review/page-${index}.md`));

  const { result, type, shownNames } = renderMentions();
  type('see @page-11999');

  await waitFor(() => assert.deepEqual(shownNames(), ['page-11999.md']));
  assert.equal(result.current.filteredFiles[0].path, 'docs/review/page-11999.md');
  assert.equal(result.current.filteredFiles[0].relativePath, `${ROOT}/docs/review/page-11999.md`);
  assert.equal(searchFiles.mock.calls[0][0], 'p1');
  assert.equal(getFiles.mock.calls.length, 0);
});

test('nothing is fetched until `@` is typed', async () => {
  reset();
  serveProject(['a.txt']);

  const { type } = renderMentions();
  type('hello');
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 200));
  assert.equal(searchFiles.mock.calls.length, 0);
});

test('a file added after one search shows up in the next', async () => {
  reset();
  const files = ['a.txt'];
  serveProject(files);

  const { type, shownNames } = renderMentions();
  type('@');
  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));

  files.push('uploaded.txt');
  type('@ ');
  type('@ @upl');
  await waitFor(() => assert.deepEqual(shownNames(), ['uploaded.txt']));
});

test('typing a query quickly sends one search, for the final text', async () => {
  reset();
  serveProject(['a.txt', 'b.txt']);

  const { type, shownNames } = renderMentions();
  type('@');
  type('@a');
  type('@a.');
  type('@a.t');

  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));
  assert.deepEqual(queries(), ['a.t']);
});

test('the previous rows stay visible, narrowed, while the next search is in flight', async () => {
  reset();
  serveProject(['a.txt', 'ab.txt', 'b.txt']);

  const { type, shownNames } = renderMentions();
  type('@a');
  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt', 'ab.txt']));

  const pending = deferredSearchResponse();
  searchFiles.mockReturnValueOnce(pending.promise);
  type('@ab');
  assert.deepEqual(shownNames(), ['ab.txt']);
  await waitFor(() => assert.deepEqual(queries(), ['a', 'ab']));

  await act(async () => {
    pending.resolve(['ab.txt', 'sub/abc.txt']);
  });
  await waitFor(() => assert.deepEqual(shownNames(), ['ab.txt', 'abc.txt']));
});

test('an older search that lands after a newer one cannot overwrite it', async () => {
  reset();
  const olderSearch = deferredSearchResponse();
  const newerSearch = deferredSearchResponse();
  searchFiles.mockReturnValueOnce(olderSearch.promise);
  searchFiles.mockReturnValueOnce(newerSearch.promise);

  const { type, shownNames } = renderMentions();
  type('@n');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  type('@ne');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));

  // The newer request superseded the older one.
  const olderSignal = (searchFiles.mock.calls[0][3] as { signal: AbortSignal }).signal;
  assert.equal(olderSignal.aborted, true);

  await act(async () => {
    newerSearch.resolve(['newer.txt']);
  });
  await waitFor(() => assert.deepEqual(shownNames(), ['newer.txt']));

  await act(async () => {
    olderSearch.resolve(['n-older.txt']);
  });
  assert.deepEqual(shownNames(), ['newer.txt']);
});

test('a search that lands after Escape dismissed the dropdown does not re-open it', async () => {
  reset();
  serveProject(['a.txt']);

  const { result, type, shownNames } = renderMentions();
  type('mail me at foo@');
  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));

  const pending = deferredSearchResponse();
  searchFiles.mockReturnValueOnce(pending.promise);
  type('mail me at foo@a');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));
  assert.equal(result.current.showFileDropdown, true);

  act(() => {
    result.current.handleFileMentionsKeyDown(keyEvent('Escape'));
  });
  assert.equal(result.current.showFileDropdown, false);

  // Let the search, which brings a changed list, finish completely.
  await act(async () => {
    pending.resolve(['a.txt', 'a-new.txt']);
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 200));
  });

  // Still dismissed, so the next Enter reaches the composer and sends the message.
  assert.equal(result.current.showFileDropdown, false);
  let enterHandled = true;
  act(() => {
    enterHandled = result.current.handleFileMentionsKeyDown(keyEvent('Enter'));
  });
  assert.equal(enterHandled, false);
  assert.equal(searchFiles.mock.calls.length, 2);

  // Typing on inside the query re-opens the dropdown, which searches again.
  serveProject(['a.txt', 'a-new.txt']);
  type('mail me at foo@a-');
  await waitFor(() => assert.deepEqual(shownNames(), ['a-new.txt']));
  assert.equal(searchFiles.mock.calls.length, 3);
});

test('Escape before any file matched stops a late search from showing the dropdown', async () => {
  reset();
  const pending = deferredSearchResponse();
  searchFiles.mockReturnValueOnce(pending.promise);

  const { result, type, shownNames } = renderMentions();
  type('mail foo@zz');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  assert.deepEqual(shownNames(), []);

  act(() => {
    result.current.handleFileMentionsKeyDown(keyEvent('Escape'));
  });

  // The search brings a matching file.
  await act(async () => {
    pending.resolve(['zz-new.txt']);
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
  });

  assert.equal(result.current.showFileDropdown, false);
  let enterHandled = true;
  act(() => {
    enterHandled = result.current.handleFileMentionsKeyDown(keyEvent('Enter'));
  });
  assert.equal(enterHandled, false);
});
