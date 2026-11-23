import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { Project, FileTreeNode } from '@/shared/types';

type UseFileTreeDataResult = {
  files: FileTreeNode[];
  loading: boolean;
  error: string | null;
  refreshFiles: () => void;
  // Bumped by every refresh, so consumers that cache a whole-project listing
  // (search) know when to drop it.
  revision: number;
};

type DirectoryListing = {
  path: string;
  entries: FileTreeNode[];
  truncated: boolean;
};

const DEFAULT_LOAD_ERROR = 'Unable to load the file tree for this project.';

// The API reports refusals such as FILE_TREE_TOO_LARGE as { error: message }.
// Surfacing that message tells the user why the tree is missing and what to do
// about it, instead of leaving them with an unexplained empty tree.
function readResponseErrorMessage(responseBody: string): string | null {
  try {
    const parsedBody = JSON.parse(responseBody) as unknown;
    const message = typeof parsedBody === 'object' && parsedBody !== null && 'error' in parsedBody
      ? (parsedBody as { error: unknown }).error
      : null;
    return typeof message === 'string' && message.trim() ? message : null;
  } catch {
    return null;
  }
}

// Node paths are absolute and use the server's own separator.
function parentDirectoryPath(directoryPath: string): string {
  const separatorIndex = Math.max(directoryPath.lastIndexOf('/'), directoryPath.lastIndexOf('\\'));
  return separatorIndex > 0 ? directoryPath.slice(0, separatorIndex) : directoryPath;
}

// Attaches every loaded directory's own listing as its `children`. A directory
// that was never expanded keeps `children` undefined: it has simply not been
// read yet, which is what keeps opening a large project cheap.
function attachLoadedChildren(
  entries: FileTreeNode[],
  listings: Map<string, DirectoryListing>,
): FileTreeNode[] {
  return entries.map((entry) => {
    const listing = entry.type === 'directory' ? listings.get(entry.path) : undefined;
    if (!listing) {
      return entry;
    }
    return {
      ...entry,
      children: attachLoadedChildren(listing.entries, listings),
      ...(listing.truncated ? { truncated: true } : {}),
    };
  });
}

/**
 * Loads the File Tree one directory at a time.
 *
 * The project root is read when the project opens; every other directory is
 * read the first time it appears in `expandedDirs` (a click, a reveal from the
 * chat) and kept while the tab is open. Earlier the tab fetched the whole
 * project to depth 10 on every open, which the server refuses outright (413)
 * above 10,000 visible entries — the owner's largest repositories never showed
 * a tree at all.
 *
 * `autoLoadExpanded` is turned off while a search is active: search expands
 * every matching ancestor, and those come from the search's own listing, so
 * reading each of them one by one would only add requests.
 */
export function useFileTreeData(
  selectedProject: Project | null,
  expandedDirs: Set<string>,
  autoLoadExpanded = true,
): UseFileTreeDataResult {
  const projectId = selectedProject?.projectId;
  const [rootListing, setRootListing] = useState<DirectoryListing | null>(null);
  const [listings, setListings] = useState<Map<string, DirectoryListing>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  // One controller per project: switching project aborts everything still in
  // flight for the previous one, and `generationRef` drops any answer that
  // lands after the switch anyway.
  const abortControllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const inFlightRef = useRef<Set<string>>(new Set());
  // Latest values for `refreshFiles`, which stays referentially stable so the
  // operation hooks that receive it do not re-create their handlers.
  const listingsRef = useRef(listings);
  const expandedDirsRef = useRef(expandedDirs);
  useEffect(() => {
    listingsRef.current = listings;
    expandedDirsRef.current = expandedDirs;
  }, [expandedDirs, listings]);

  const fetchListing = useCallback(async (
    currentProjectId: string,
    directoryPath: string | null,
  ): Promise<DirectoryListing | { error: string }> => {
    const signal = abortControllerRef.current?.signal;
    const response = await api.getDirectoryListing(currentProjectId, directoryPath, { signal });
    if (!response.ok) {
      const errorText = await response.text();
      console.error('File fetch failed:', response.status, errorText);
      return { error: readResponseErrorMessage(errorText) ?? DEFAULT_LOAD_ERROR };
    }
    return (await response.json()) as DirectoryListing;
  }, []);

  const loadDirectory = useCallback(async (directoryPath: string) => {
    if (!projectId || inFlightRef.current.has(directoryPath)) {
      return;
    }
    const generation = generationRef.current;
    inFlightRef.current.add(directoryPath);
    try {
      const result = await fetchListing(projectId, directoryPath);
      if (generation !== generationRef.current) {
        return;
      }
      // A directory that vanished or cannot be read is stored as empty, so an
      // expanded folder does not re-request itself on every render.
      const listing = 'error' in result
        ? { path: directoryPath, entries: [], truncated: false }
        : result;
      setListings((previous) => new Map(previous).set(directoryPath, listing));
    } catch (loadError) {
      if ((loadError as { name?: string }).name !== 'AbortError') {
        console.error('Error fetching directory:', loadError);
      }
    } finally {
      if (generation === generationRef.current) {
        inFlightRef.current.delete(directoryPath);
      }
    }
  }, [fetchListing, projectId]);

  // Project switch: forget the previous project's tree and read the new root.
  useEffect(() => {
    abortControllerRef.current?.abort();
    generationRef.current += 1;
    inFlightRef.current = new Set();
    setRootListing(null);
    setListings(new Map());
    setError(null);

    if (!projectId) {
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const generation = generationRef.current;
    setLoading(true);

    void (async () => {
      try {
        const result = await fetchListing(projectId, null);
        if (generation !== generationRef.current) return;
        if ('error' in result) {
          setError(result.error);
        } else {
          setRootListing(result);
        }
      } catch (loadError) {
        if ((loadError as { name?: string }).name === 'AbortError') return;
        console.error('Error fetching files:', loadError);
        if (generation === generationRef.current) setError(DEFAULT_LOAD_ERROR);
      } finally {
        if (generation === generationRef.current) setLoading(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [fetchListing, projectId]);

  // Read an expanded directory the first time it becomes visible, i.e. once
  // its parent has been read. Deeper expanded folders (a reveal from the chat,
  // the ancestors a finished search left open) then load level by level as
  // each parent arrives, rather than as one burst of requests for folders that
  // are not on screen.
  useEffect(() => {
    if (!autoLoadExpanded || !rootListing) {
      return;
    }
    expandedDirs.forEach((directoryPath) => {
      if (listings.has(directoryPath)) {
        return;
      }
      const parentPath = parentDirectoryPath(directoryPath);
      if (parentPath === rootListing.path || listings.has(parentPath)) {
        void loadDirectory(directoryPath);
      }
    });
  }, [autoLoadExpanded, expandedDirs, listings, loadDirectory, rootListing]);

  // Refresh re-reads the root and every directory that is still open; the
  // current tree stays on screen meanwhile instead of being replaced by the
  // loading state. Collapsed directories are forgotten and re-read on expand.
  const refreshFiles = useCallback(() => {
    if (!projectId) return;
    setRevision((previous) => previous + 1);
    const generation = generationRef.current;
    const openDirectories = [...listingsRef.current.keys()]
      .filter((directoryPath) => expandedDirsRef.current.has(directoryPath));

    void (async () => {
      try {
        const [rootResult, ...directoryResults] = await Promise.all([
          fetchListing(projectId, null),
          ...openDirectories.map((directoryPath) => fetchListing(projectId, directoryPath)),
        ]);
        if (generation !== generationRef.current) return;
        if ('error' in rootResult) {
          setError(rootResult.error);
          return;
        }
        setError(null);
        setRootListing(rootResult);
        const nextListings = new Map<string, DirectoryListing>();
        directoryResults.forEach((result, index) => {
          if (!('error' in result)) {
            nextListings.set(openDirectories[index], result);
          }
        });
        setListings(nextListings);
      } catch (refreshError) {
        if ((refreshError as { name?: string }).name !== 'AbortError') {
          console.error('Error refreshing files:', refreshError);
        }
      }
    })();
  }, [fetchListing, projectId]);

  const files = useMemo(
    () => (rootListing ? attachLoadedChildren(rootListing.entries, listings) : []),
    [listings, rootListing],
  );

  return {
    files,
    loading,
    error,
    refreshFiles,
    revision,
  };
}
