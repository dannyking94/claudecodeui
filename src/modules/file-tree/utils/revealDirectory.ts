import type { FileTreeNode } from '@/shared/types';

// A reference written inside a chat message carries neither a canonical
// separator nor a canonical shape, so trailing slashes, `./` prefixes and
// Windows separators are levelled before anything is compared.
const normalizePath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

const isAbsolutePath = (value: string): boolean => /^(\/|[A-Za-z]:\/)/.test(value);

/**
 * The paths to expand, root first, so `reference` becomes visible in the file
 * tree, and whether the walk is `settled`.
 *
 * Each level is looked up by name in the tree that is already loaded, rather
 * than composed as a string: an in-chat reference is usually relative
 * (`decisions/`, as the model wrote it) while every node is keyed by the
 * absolute path the server built with its own platform separator. Expansion
 * stops at the last level actually present, so a folder hidden by `.gitignore`
 * still opens as far as the tree goes.
 *
 * The tree is read one folder at a time, so a level can be missing only
 * because its parent has not been read yet. `settled` is false in that case:
 * expanding the returned paths reads the next level, and the caller asks
 * again once it arrives. It is true when every segment was found, or when the
 * walk stopped inside a folder that has been read and holds no such entry.
 */
export function directoryRevealProgress(
  files: FileTreeNode[],
  projectPath: string,
  reference: string,
): { paths: string[]; settled: boolean } {
  const root = normalizePath(projectPath);
  const target = normalizePath(reference);

  let relative = target;
  if (isAbsolutePath(target)) {
    if (!target.startsWith(`${root}/`)) {
      // Either the project root itself (nothing to expand) or a path outside
      // it — `/workspace/apple` must not be read as a child of `/workspace/app`.
      return { paths: [], settled: true };
    }
    relative = target.slice(root.length + 1);
  }

  const paths: string[] = [];
  // `undefined` means the current level exists but has not been read.
  let level: FileTreeNode[] | undefined = files;
  for (const segment of relative.split('/').filter(Boolean)) {
    if (!level) {
      return { paths, settled: false };
    }
    const directory: FileTreeNode | undefined = level.find(
      (node) => node.type === 'directory' && node.name === segment,
    );
    if (!directory) {
      return { paths, settled: true };
    }
    paths.push(directory.path);
    level = directory.children;
  }

  return { paths, settled: true };
}
