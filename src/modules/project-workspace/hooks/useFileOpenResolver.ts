import { useCallback } from 'react';

import { api } from '@/shared/api';
import type { Project, ProjectFileSearchMatch, ProjectFileSearchResult } from '@/shared/types';

// `diffInfo` is intentionally `any` so this resolver can wrap editor handlers
// that expect a concrete diff payload type as well as generic callers.
type OnFileOpen = (filePath: string, diffInfo?: any, line?: number | null) => void;

// Enough to hold every same-named file in a large project (140 `README.md` in
// the biggest one measured), so the suffix match below sees them all.
const SEARCH_LIMIT = 200;

const normalize = (value: string): string => value.replace(/\\/g, '/');

// Backslashes are already normalized above, so a Windows path arrives as
// `C:/…`; counting it as absolute lets a Windows server resolve it as-is and a
// POSIX one answer an honest 404 instead of opening some other file.
const isAbsoluteRef = (value: string): boolean => /^(\/|[A-Za-z]:\/)/.test(value);

const toSearchTarget = (ref: string): string => normalize(ref).replace(/^\.\//, '').replace(/^\/+/, '');

// References inside chat messages are often bare basenames (`foo.ts`) or partial
// paths (`utils/foo.ts`) rather than full paths, so match by path suffix and
// fall back to filename equality.
const findBestMatch = (files: ProjectFileSearchMatch[], ref: string): string | null => {
  const target = toSearchTarget(ref);
  if (!target) {
    return null;
  }

  const suffixMatch = files.find((file) => {
    const filePath = normalize(file.path);
    return filePath === target || filePath.endsWith(`/${target}`);
  });
  if (suffixMatch) {
    return suffixMatch.path;
  }

  const base = target.split('/').pop() || target;
  return files.find((file) => file.name === base)?.path ?? null;
};

// Asks the server's filename search, which unlike the full tree also answers
// for projects too large to list, and returns [] on any failure so the caller
// falls back to opening the reference as written.
const searchProjectFiles = async (projectId: string, searchQuery: string): Promise<ProjectFileSearchMatch[]> => {
  try {
    const response = await api.searchFiles(projectId, searchQuery, SEARCH_LIMIT);
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as Partial<ProjectFileSearchResult>;
    return Array.isArray(data.files) ? data.files : [];
  } catch {
    return [];
  }
};

/**
 * Wraps an `onFileOpen` handler so a possibly bare/partial file reference is
 * resolved against the project's files before the file is opened in the in-app
 * editor. Used by the project workspace for chat file links. Each reference is
 * looked up by the server's filename search: the whole reference first (which
 * finds every path ending in it), then its basename for the filename fallback.
 */
export function useFileOpenResolver(
  selectedProject: Project | null | undefined,
  onFileOpen: OnFileOpen,
): OnFileOpen {
  const projectId = selectedProject?.projectId;

  const resolveRef = useCallback(async (ref: string): Promise<string | null> => {
    const target = toSearchTarget(ref);
    if (!projectId || !target) {
      return null;
    }
    const pathMatch = findBestMatch(await searchProjectFiles(projectId, target), ref);
    if (pathMatch) {
      return pathMatch;
    }
    const base = target.split('/').pop() || target;
    if (base === target) {
      return null;
    }
    return findBestMatch(await searchProjectFiles(projectId, base), ref);
  }, [projectId]);

  return useCallback(
    (filePath: string, diffInfo?: any, line?: number | null) => {
      // Normalized once and used for every outcome: a reference picked up from
      // link text can carry surrounding whitespace, which the API would take as
      // part of the filename and answer with a 404.
      const ref = normalize(filePath).trim();
      // An absolute path already names one exact file: matching it against the
      // project's files can only send it somewhere else —
      // `/home/user/.config/NOTES.md` used to fall through to the filename
      // match and silently open the project's own `NOTES.md`. A path that
      // exists is unaffected; one that no longer does now reports that instead
      // of opening a same-named file.
      if (isAbsoluteRef(ref)) {
        onFileOpen(ref, diffInfo, line);
        return;
      }
      void resolveRef(ref).then((match) => {
        onFileOpen(match ?? ref, diffInfo, line);
      });
    },
    [resolveRef, onFileOpen],
  );
}
