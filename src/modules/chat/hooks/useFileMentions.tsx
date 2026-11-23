import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, KeyboardEvent, RefObject, SetStateAction } from 'react';

import { api } from '@/shared/api';
import { escapeRegExp } from '@/modules/chat/utils/chatFormatting';
import type { Project, ProjectFileSearchResult } from '@/shared/types';

export type MentionableFile = {
  name: string;
  path: string;
  relativePath?: string;
};

type UseFileMentionsOptions = {
  selectedProject: Project | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement>;
};

// The dropdown shows 10 rows; a few more let the local filter below keep
// rows on screen while the next answer for a longer query is in flight.
const MENTION_SEARCH_LIMIT = 50;
// One search per pause in typing rather than per keystroke.
const MENTION_SEARCH_DEBOUNCE_MS = 120;

// True when both lists hold the same files in the same order.
const haveSameFiles = (left: MentionableFile[], right: MentionableFile[]) =>
  left.length === right.length &&
  left.every(
    (file, index) => file.path === right[index].path && file.relativePath === right[index].relativePath,
  );

export function useFileMentions({ selectedProject, input, setInput, textareaRef }: UseFileMentionsOptions) {
  const projectId = selectedProject?.projectId;
  const [fileList, setFileList] = useState<MentionableFile[]>([]);
  const [fileMentions, setFileMentions] = useState<string[]>([]);
  const [filteredFiles, setFilteredFiles] = useState<MentionableFile[]>([]);
  const [showFileDropdown, setShowFileDropdown] = useState(false);
  const [selectedFileIndex, setSelectedFileIndex] = useState(-1);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [atSymbolPosition, setAtSymbolPosition] = useState(-1);
  // The file-list request still in flight. Starting a new one aborts it, so an
  // older response can never overwrite a newer list.
  const fileListRequestRef = useRef<AbortController | null>(null);

  const loadProjectFiles = useCallback(async (targetProjectId: string, searchQuery: string) => {
    fileListRequestRef.current?.abort();
    const abortController = new AbortController();
    fileListRequestRef.current = abortController;

    try {
      // The server searches the whole project for the query (the full tree it
      // used to send is refused for large projects), keyed by DB projectId.
      const response = await api.searchFiles(targetProjectId, searchQuery, MENTION_SEARCH_LIMIT, {
        signal: abortController.signal,
      });
      if (!response.ok) {
        return;
      }

      const data = (await response.json()) as Partial<ProjectFileSearchResult>;
      if (abortController.signal.aborted) {
        return;
      }
      const nextFileList: MentionableFile[] = (Array.isArray(data.files) ? data.files : []).map((file) => ({
        name: file.name,
        path: file.relativePath,
        relativePath: file.path,
      }));
      // Keeping the same array when nothing changed stops the filter effect
      // below from re-running and resetting the highlighted row.
      setFileList((previousFileList) =>
        haveSameFiles(previousFileList, nextFileList) ? previousFileList : nextFileList,
      );
    } catch (error) {
      // Ignore aborts from newer requests and rapid project switches; we only care about the latest request.
      if ((error as { name?: string })?.name === 'AbortError') {
        return;
      }
      console.error('Error fetching files:', error);
    }
  }, []);

  useEffect(() => {
    setFileList([]);
    setFilteredFiles([]);
    return () => {
      fileListRequestRef.current?.abort();
    };
  }, [projectId]);

  // The `@` query under the caret: the text between the last `@` before the
  // caret and the caret, or null when there is no `@` or a space ended it.
  const mentionQuery = useMemo(() => {
    const textBeforeCursor = input.slice(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');
    if (lastAtIndex === -1) {
      return null;
    }
    const textAfterAt = textBeforeCursor.slice(lastAtIndex + 1);
    return textAfterAt.includes(' ') ? null : textAfterAt;
  }, [input, cursorPosition]);

  // Asked afresh for each query once typing pauses, so files created since the
  // last search (uploads, agent edits, the terminal) are offered too. Rows from
  // the previous answer stay visible, narrowed by the filter below, until the
  // new one lands.
  useEffect(() => {
    if (!showFileDropdown || !projectId || mentionQuery === null) {
      return;
    }
    const handle = setTimeout(() => {
      void loadProjectFiles(projectId, mentionQuery);
    }, MENTION_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [showFileDropdown, projectId, mentionQuery, loadProjectFiles]);

  useEffect(() => {
    if (mentionQuery === null) {
      setShowFileDropdown(false);
      setAtSymbolPosition(-1);
      return;
    }

    setAtSymbolPosition(input.slice(0, cursorPosition).lastIndexOf('@'));
    setShowFileDropdown(true);
    setSelectedFileIndex(-1);

    const lowerQuery = mentionQuery.toLowerCase();
    const matchingFiles = fileList
      .filter(
        (file) =>
          file.name.toLowerCase().includes(lowerQuery) ||
          file.path.toLowerCase().includes(lowerQuery),
      )
      .slice(0, 10);

    setFilteredFiles(matchingFiles);
  }, [mentionQuery, input, cursorPosition, fileList]);

  const activeFileMentions = useMemo(() => {
    if (!input || fileMentions.length === 0) {
      return [];
    }
    return fileMentions.filter((path) => input.includes(path));
  }, [fileMentions, input]);

  const sortedFileMentions = useMemo(() => {
    if (activeFileMentions.length === 0) {
      return [];
    }
    const uniqueMentions = Array.from(new Set(activeFileMentions));
    return uniqueMentions.sort((mentionA, mentionB) => mentionB.length - mentionA.length);
  }, [activeFileMentions]);

  const fileMentionRegex = useMemo(() => {
    if (sortedFileMentions.length === 0) {
      return null;
    }
    const pattern = sortedFileMentions.map(escapeRegExp).join('|');
    return new RegExp(`(${pattern})`, 'g');
  }, [sortedFileMentions]);

  const fileMentionSet = useMemo(() => new Set(sortedFileMentions), [sortedFileMentions]);

  const renderInputWithMentions = useCallback(
    (text: string) => {
      if (!text) {
        return '';
      }
      if (!fileMentionRegex) {
        return text;
      }

      const parts = text.split(fileMentionRegex);
      return parts.map((part, index) =>
        fileMentionSet.has(part) ? (
          <span
            key={`mention-${index}`}
            className="-ml-0.5 rounded-md bg-blue-200/70 box-decoration-clone px-0.5 text-transparent dark:bg-blue-300/40"
          >
            {part}
          </span>
        ) : (
          <span key={`text-${index}`}>{part}</span>
        ),
      );
    },
    [fileMentionRegex, fileMentionSet],
  );

  const selectFile = useCallback(
    (file: MentionableFile) => {
      const textBeforeAt = input.slice(0, atSymbolPosition);
      const textAfterAtQuery = input.slice(atSymbolPosition);
      const spaceIndex = textAfterAtQuery.indexOf(' ');
      const textAfterQuery = spaceIndex !== -1 ? textAfterAtQuery.slice(spaceIndex) : '';

      const newInput = `${textBeforeAt}${file.path} ${textAfterQuery}`;
      const newCursorPosition = textBeforeAt.length + file.path.length + 1;

      if (textareaRef.current && !textareaRef.current.matches(':focus')) {
        textareaRef.current.focus();
      }

      setInput(newInput);
      setCursorPosition(newCursorPosition);
      setFileMentions((previousMentions) =>
        previousMentions.includes(file.path) ? previousMentions : [...previousMentions, file.path],
      );

      setShowFileDropdown(false);
      setAtSymbolPosition(-1);

      if (!textareaRef.current) {
        return;
      }

      requestAnimationFrame(() => {
        if (!textareaRef.current) {
          return;
        }
        textareaRef.current.setSelectionRange(newCursorPosition, newCursorPosition);
        if (!textareaRef.current.matches(':focus')) {
          textareaRef.current.focus();
        }
      });
    },
    [input, atSymbolPosition, textareaRef, setInput],
  );

  const handleFileMentionsKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showFileDropdown) {
        return false;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        // The caret is still inside the `@` query, so a refetch landing after
        // this would re-open the dropdown (or first show it, when nothing
        // matched yet) and take the next Enter. Drop it; re-opening the
        // dropdown fetches again.
        fileListRequestRef.current?.abort();
        setShowFileDropdown(false);
        return true;
      }

      if (filteredFiles.length === 0) {
        return false;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex < filteredFiles.length - 1 ? previousIndex + 1 : 0,
        );
        return true;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedFileIndex((previousIndex) =>
          previousIndex > 0 ? previousIndex - 1 : filteredFiles.length - 1,
        );
        return true;
      }

      if (event.key === 'Tab' || event.key === 'Enter') {
        event.preventDefault();
        if (selectedFileIndex >= 0) {
          selectFile(filteredFiles[selectedFileIndex]);
        } else if (filteredFiles.length > 0) {
          selectFile(filteredFiles[0]);
        }
        return true;
      }

      return false;
    },
    [showFileDropdown, filteredFiles, selectedFileIndex, selectFile],
  );

  return {
    showFileDropdown,
    filteredFiles,
    selectedFileIndex,
    renderInputWithMentions,
    selectFile,
    setCursorPosition,
    handleFileMentionsKeyDown,
  };
}
