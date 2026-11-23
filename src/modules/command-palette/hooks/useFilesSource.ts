import { useEffect, useState } from 'react';

import { api } from '@/shared/api';
import { useApiSource } from '@/modules/command-palette/hooks/useApiSource';
import type { ProjectFileSearchResult } from '@/shared/types';

export type FileResult = {
  path: string;
  name: string;
};

// Rows asked of the server per query. The palette's own fuzzy filter then
// narrows them further as the user keeps typing before the next answer lands.
const MAX_FILES = 200;
// One request per pause in typing rather than per keystroke.
const QUERY_DEBOUNCE_MS = 150;

/**
 * Files for the command palette, from the server's filename search for the
 * text typed so far. The palette used to flatten the full project tree, which
 * the server refuses for large projects, and only ever offered its first 500
 * files; the search covers the whole project and returns the best matches.
 */
export function useFilesSource(projectId: string | undefined, enabled: boolean, searchText: string) {
  // The query the last request was sent for; it trails `searchText` by the
  // debounce so a burst of keystrokes costs one request.
  const [debouncedQuery, setDebouncedQuery] = useState(() => searchText.trim());

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(searchText.trim()), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchText]);

  return useApiSource<FileResult, Partial<ProjectFileSearchResult>>({
    enabled: enabled && !!projectId,
    deps: [projectId, debouncedQuery],
    fetcher: (signal) => api.searchFiles(projectId!, debouncedQuery, MAX_FILES, { signal }),
    parse: (data) => (Array.isArray(data?.files)
      ? data.files.map((file) => ({ path: file.path, name: file.name }))
      : []),
  });
}
