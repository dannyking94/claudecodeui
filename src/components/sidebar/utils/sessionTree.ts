import type { SessionWithProvider } from '../types/types';

/**
 * Deepest nesting the sidebar indents. Beyond this, rows keep their real
 * position in the tree but stop moving right, so a long chain of spawned
 * sessions can never squeeze the row content down to nothing.
 */
export const MAX_SESSION_TREE_DEPTH = 4;

const readSessionId = (session: SessionWithProvider): string => String(session.id ?? '');

const readParentSessionId = (session: SessionWithProvider): string => {
  const parentSessionId = session.parentSessionId;
  return typeof parentSessionId === 'string' ? parentSessionId.trim() : '';
};

/**
 * Arranges one project's sessions into a parent/child tree, flattened back to
 * a render-ordered list with a `__depth` on every row.
 *
 * Nesting is resolved strictly against the sessions handed in, which is what
 * keeps the sidebar honest about repositories: a child whose parent lives in
 * another project (the normal case for a session that spawns work elsewhere)
 * finds no parent here and stays a top-level row of the project it actually
 * belongs to, labelled with `parentSummary` instead of moved out of its repo.
 * The same fallback covers a parent that was archived, deleted, or simply not
 * paged in yet — an orphan degrades to an ordinary row rather than vanishing.
 *
 * Cycles (only reachable when parent links were written straight into the
 * database, bypassing the API's cycle check) are broken at the link that
 * closes the loop, so every session is emitted exactly once.
 *
 * Input order is preserved: roots keep the caller's sort, and siblings appear
 * under their parent in that same order.
 */
export const buildSessionTree = (sessions: SessionWithProvider[]): SessionWithProvider[] => {
  const sessionIds = new Set(sessions.map(readSessionId));
  const parentIdBySessionId = new Map<string, string>();

  for (const session of sessions) {
    const sessionId = readSessionId(session);
    const parentSessionId = readParentSessionId(session);
    if (!parentSessionId || parentSessionId === sessionId || !sessionIds.has(parentSessionId)) {
      continue;
    }

    parentIdBySessionId.set(sessionId, parentSessionId);
  }

  // Walk each row's ancestors and cut the link that revisits a node already on
  // the path. Whichever row is examined first decides where the loop is opened,
  // which is arbitrary but stable for a given input order.
  for (const session of sessions) {
    const walkedIds = new Set<string>();
    let currentId = readSessionId(session);

    while (currentId) {
      if (walkedIds.has(currentId)) {
        parentIdBySessionId.delete(currentId);
        break;
      }

      walkedIds.add(currentId);
      currentId = parentIdBySessionId.get(currentId) ?? '';
    }
  }

  const childrenByParentId = new Map<string, SessionWithProvider[]>();
  const rootSessions: SessionWithProvider[] = [];

  for (const session of sessions) {
    const parentSessionId = parentIdBySessionId.get(readSessionId(session));
    if (!parentSessionId) {
      rootSessions.push(session);
      continue;
    }

    const siblings = childrenByParentId.get(parentSessionId);
    if (siblings) {
      siblings.push(session);
    } else {
      childrenByParentId.set(parentSessionId, [session]);
    }
  }

  const orderedSessions: SessionWithProvider[] = [];
  const emittedIds = new Set<string>();

  const emitSubtree = (session: SessionWithProvider, depth: number) => {
    const sessionId = readSessionId(session);
    // Cycles are already broken above; this guard just makes it impossible for
    // a future change to turn a bad link into an infinite render loop.
    if (emittedIds.has(sessionId)) {
      return;
    }

    emittedIds.add(sessionId);
    orderedSessions.push({ ...session, __depth: depth });

    for (const child of childrenByParentId.get(sessionId) ?? []) {
      emitSubtree(child, depth + 1);
    }
  };

  for (const session of rootSessions) {
    emitSubtree(session, 0);
  }

  return orderedSessions;
};

/**
 * Number of rows a top-level session occupies once its descendants are
 * included, given the flattened list `buildSessionTree` produced.
 *
 * The sidebar's "show more" fold counts top-level sessions, so it needs to
 * know how far each one's subtree reaches to avoid cutting between a parent
 * and its children.
 */
export const countSessionSubtreeRows = (
  orderedSessions: SessionWithProvider[],
  startIndex: number,
): number => {
  const rootDepth = orderedSessions[startIndex]?.__depth ?? 0;
  let rowCount = 1;

  while (
    startIndex + rowCount < orderedSessions.length
    && (orderedSessions[startIndex + rowCount].__depth ?? 0) > rootDepth
  ) {
    rowCount += 1;
  }

  return rowCount;
};
