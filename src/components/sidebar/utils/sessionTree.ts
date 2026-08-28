import type { Project } from '../../../types/app';
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

/** One project together with the sessions the sidebar has loaded for it. */
export type ProjectSessions = {
  project: Project;
  sessions: SessionWithProvider[];
};

/**
 * Regroups every loaded session into the project of the session it descends
 * from, so a spawned session renders under its parent even when the two run in
 * different repositories.
 *
 * The sidebar is project → sessions, and a session's project is its working
 * directory. A session that spawns work elsewhere — an agent given its own
 * worktree, a worker launched in another checkout — therefore lands in a
 * project row of its own, far from the session that started it, and the tree
 * that `buildSessionTree` draws stops at the repository boundary. Grouping by
 * the ROOT of the parent chain instead of by the child's own directory is what
 * lets that tree cross it.
 *
 * A moved row is tagged with `__ownerProject`, the project it actually runs in,
 * for two reasons: the row still has to name its repository (it is no longer
 * implied by the group it sits in), and every action on it — opening it,
 * renaming, deleting — must address the project that owns it, not the one it is
 * being displayed under.
 *
 * Only links whose parent is loaded move a row. A parent that is archived,
 * deleted, or not yet paged in leaves its child exactly where it was, which is
 * also what keeps this safe against a partially loaded sidebar: a row can be
 * flat for a moment, never in two groups at once and never missing.
 *
 * Cycles cannot be created through the API, but can be written straight into
 * the database; the walk breaks at the first session it revisits, so the loop
 * settles in one group rather than spinning.
 */
export const groupSessionsByRootProject = (
  projectSessions: ProjectSessions[],
): Map<string, SessionWithProvider[]> => {
  const projectIdBySessionId = new Map<string, string>();
  const parentIdBySessionId = new Map<string, string>();

  for (const { project, sessions } of projectSessions) {
    for (const session of sessions) {
      const sessionId = readSessionId(session);
      if (!sessionId) {
        continue;
      }

      projectIdBySessionId.set(sessionId, project.projectId);
      const parentSessionId = readParentSessionId(session);
      if (parentSessionId && parentSessionId !== sessionId) {
        parentIdBySessionId.set(sessionId, parentSessionId);
      }
    }
  }

  // Every session on one chain shares its root's project, so each walk fills the
  // cache for all of them: the whole regrouping stays linear in sessions loaded.
  const rootProjectIdBySessionId = new Map<string, string>();
  const resolveRootProjectId = (sessionId: string): string => {
    const walkedIds: string[] = [];
    const seenIds = new Set<string>();
    let currentId = sessionId;
    let rootProjectId = projectIdBySessionId.get(sessionId) ?? '';

    while (currentId && !seenIds.has(currentId)) {
      const cachedProjectId = rootProjectIdBySessionId.get(currentId);
      if (cachedProjectId) {
        rootProjectId = cachedProjectId;
        break;
      }

      seenIds.add(currentId);
      walkedIds.push(currentId);
      rootProjectId = projectIdBySessionId.get(currentId) ?? rootProjectId;

      const parentId = parentIdBySessionId.get(currentId) ?? '';
      if (!parentId || !projectIdBySessionId.has(parentId)) {
        break;
      }

      currentId = parentId;
    }

    for (const walkedId of walkedIds) {
      rootProjectIdBySessionId.set(walkedId, rootProjectId);
    }

    return rootProjectId;
  };

  const sessionsByProjectId = new Map<string, SessionWithProvider[]>();
  const appendSession = (projectId: string, session: SessionWithProvider) => {
    const group = sessionsByProjectId.get(projectId);
    if (group) {
      group.push(session);
      return;
    }

    sessionsByProjectId.set(projectId, [session]);
  };

  for (const { project, sessions } of projectSessions) {
    // Seeds the group so a project whose sessions all moved away still resolves
    // to an empty list rather than to "not grouped, use the raw sessions".
    if (!sessionsByProjectId.has(project.projectId)) {
      sessionsByProjectId.set(project.projectId, []);
    }

    for (const session of sessions) {
      const sessionId = readSessionId(session);
      const rootProjectId = sessionId ? resolveRootProjectId(sessionId) : '';
      if (!rootProjectId || rootProjectId === project.projectId) {
        appendSession(project.projectId, session);
        continue;
      }

      appendSession(rootProjectId, { ...session, __ownerProject: project });
    }
  }

  return sessionsByProjectId;
};

/**
 * Arranges one project's sessions into a parent/child tree, flattened back to
 * a render-ordered list with a `__depth` on every row.
 *
 * Nesting is resolved strictly against the sessions handed in: a child whose
 * parent is not in this list stays a top-level row, labelled with
 * `parentSummary` so it still says what spawned it. That covers a parent which
 * was archived, deleted, or simply not paged in yet — an orphan degrades to an
 * ordinary row rather than vanishing. Children whose parent lives in ANOTHER
 * project reach this function already regrouped by
 * `groupSessionsByRootProject`, so they arrive alongside their parent and nest
 * like any other child.
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
