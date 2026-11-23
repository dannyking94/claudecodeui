import { spawn } from 'node:child_process';

import type { FileTreeVersionedFileLister } from '@/shared/types.js';

/**
 * Git enumeration for the File Tree filename search, injected by the module's
 * production composition root and exercised against real repositories by the
 * service tests. `git ls-files` reads the index and the untracked files git
 * would not ignore, so nested .gitignore files apply and nothing is stat'ed by
 * us; output is NUL-separated and streamed, and the process is killed as soon
 * as the search stops reading or aborts.
 */
export const gitWorkTreeFiles: FileTreeVersionedFileLister = {
  async *listFiles(directoryPath, signal) {
    const child = spawn(
      'git',
      ['-c', 'core.quotePath=off', 'ls-files', '--cached', '--others', '--exclude-standard', '--deduplicate', '-z'],
      { cwd: directoryPath, stdio: ['ignore', 'pipe', 'pipe'], signal },
    );
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode));
    });
    // Rejections are re-raised below once stdout is drained; until then they
    // must not surface as unhandled.
    exited.catch(() => undefined);
    child.stderr.resume();
    child.stdout.setEncoding('utf8');

    try {
      let pendingText = '';
      for await (const chunk of child.stdout as AsyncIterable<string>) {
        const paths = (pendingText + chunk).split('\0');
        pendingText = paths.pop() ?? '';
        for (const relativePath of paths) {
          if (relativePath) yield relativePath;
        }
      }
      const exitCode = await exited;
      if (exitCode !== 0) {
        throw new Error(`git ls-files exited with code ${exitCode} in "${directoryPath}"`);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
  },
};
