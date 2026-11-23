import { useEffect, useMemo, useState } from 'react';

import { api } from '@/shared/api';
import { collectExpandedDirectoryPaths, filterFileTree } from '@/modules/file-tree/utils/fileTreeUtils';
import type { FileTreeNode } from '@/shared/types';

type UseFileTreeSearchArgs = {
  projectId: string | undefined;
  files: FileTreeNode[];
  searchQuery: string;
  // Changes on every tree refresh; the whole-project listing is dropped then.
  revision: number;
  expandDirectories: (paths: string[]) => void;
};

type UseFileTreeSearchResult = {
  filteredFiles: FileTreeNode[];
};

type ProjectTree = { key: string; files: FileTreeNode[] | null };

export function useFileTreeSearch({
  projectId,
  files,
  searchQuery,
  revision,
  expandDirectories,
}: UseFileTreeSearchArgs): UseFileTreeSearchResult {
  const [projectTree, setProjectTree] = useState<ProjectTree | null>(null);
  const isSearching = searchQuery.trim().length > 0;
  const projectTreeKey = projectId ? `${projectId}:${revision}` : null;

  // The tree on screen holds only the folders the user opened, so a search
  // fetches the whole-project listing once, the first time it is needed. When
  // the server refuses it (a project above its entry limit) `files` is null
  // and the search falls back to the folders already loaded.
  useEffect(() => {
    if (!isSearching || !projectId || !projectTreeKey || projectTree?.key === projectTreeKey) {
      return undefined;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await api.getFiles(projectId, { signal: controller.signal });
        const tree = response.ok ? ((await response.json()) as FileTreeNode[]) : null;
        if (!controller.signal.aborted) {
          setProjectTree({ key: projectTreeKey, files: tree });
        }
      } catch (searchError) {
        if ((searchError as { name?: string }).name !== 'AbortError') {
          setProjectTree({ key: projectTreeKey, files: null });
        }
      }
    })();
    return () => controller.abort();
  }, [isSearching, projectId, projectTree?.key, projectTreeKey]);

  const searchableFiles = projectTree?.key === projectTreeKey && projectTree.files
    ? projectTree.files
    : files;

  // Derived, not stored: mirroring the filter into state made every keystroke
  // (and every tree refresh) cost an extra render, and left `filteredFiles` one
  // render behind `files`.
  const filteredFiles = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return query ? filterFileTree(searchableFiles, query) : files;
  }, [files, searchableFiles, searchQuery]);

  useEffect(() => {
    if (!isSearching) {
      return;
    }
    // Keep search results visible by opening every matching ancestor directory once per query update.
    expandDirectories(collectExpandedDirectoryPaths(filteredFiles));
  }, [expandDirectories, filteredFiles, isSearching]);

  return { filteredFiles };
}
