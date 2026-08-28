import type { Project } from '../../../types/app';
import type { SessionWithProvider } from '../types/types';

import { getSessionDate } from './utils';

/**
 * Deepest nesting the sidebar indents. Beyond this, rows keep their real
 * position in the tree but stop moving right, so a long chain of spawned
 * sessions can never squeeze the row content down to nothing.
 */
export const MAX_SESSION_TREE_DEPTH = 4;

/** Horizontal offset added per nesting level of the session tree. */
export const NESTED_SESSION_INDENT_PX = 14;

/**
 * Children rendered under one parent before the rest fold behind a toggle.
 *
 * Three mirrors the fold the sidebar already applies to top-level sessions, and
 * keeps one busy parent — an agent that spawned a dozen workers — from burying
 * every other conversation in the project.
 *
 * The cap counts rows that are actually drawn. A child folded away for being at
 * rest never occupies one of these slots, so the cap only bites when more than
 * three children are working at once, and both kinds of folded child are
 * reported by the same single toggle.
 */
export const MAX_VISIBLE_CHILD_SESSIONS = 3;

const readSessionId = (session: SessionWithProvider): string => String(session.id ?? '');

const readParentSessionId = (session: SessionWithProvider): string => {
  const parentSessionId = session.parentSessionId;
  return typeof parentSessionId === 'string' ? parentSessionId.trim() : '';
};

/**
 * When a session was last active, as a number.
 *
 * `getSessionDate` reads `lastActivity` and falls back to `createdAt`, which is
 * the value the row's age badge is rendered from, so an order built on it
 * always agrees with the "2m" / "10hr" the user is reading beside it. Ordering
 * on creation time instead would sink a session that has been working for
 * hours below a newer idle one.
 */
const readActivityTime = (session: SessionWithProvider): number => {
  const activityTime = getSessionDate(session).getTime();
  // An unparseable timestamp sorts last rather than poisoning the comparison
  // with NaN, which would scatter the siblings around it instead.
  return Number.isNaN(activityTime) ? 0 : activityTime;
};

/**
 * Most recently active first. Sessions last active at the same moment keep the
 * order they arrived in, the sort being stable.
 */
const compareSessionsByActivity = (
  left: SessionWithProvider,
  right: SessionWithProvider,
): number => readActivityTime(right) - readActivityTime(left);

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
 * Rows come out most recently active first at every level, not just the top,
 * with sessions last active at the same moment keeping the order they arrived
 * in. Roots are sorted rather than left in input order because
 * `groupSessionsByRootProject` hands over the concatenation of several
 * projects' lists, and two date-sorted lists joined end to end are not sorted;
 * for a project whose sessions all stayed put the sort is a no-op, the caller
 * having already ordered them the same way.
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

  rootSessions.sort(compareSessionsByActivity);
  for (const siblings of childrenByParentId.values()) {
    siblings.sort(compareSessionsByActivity);
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
 * and its children. Rows are read by depth alone, so this also measures a
 * subtree that `foldChildSessions` has put a toggle row inside.
 */
export const countSessionSubtreeRows = (
  orderedRows: readonly { __depth?: number }[],
  startIndex: number,
): number => {
  const rootDepth = orderedRows[startIndex]?.__depth ?? 0;
  let rowCount = 1;

  while (
    startIndex + rowCount < orderedRows.length
    && (orderedRows[startIndex + rowCount].__depth ?? 0) > rootDepth
  ) {
    rowCount += 1;
  }

  return rowCount;
};

/**
 * One row of the sidebar's session list: a session, or the toggle standing in
 * for the children folded away under the row above it.
 *
 * Both carry `__depth` so `countSessionSubtreeRows` can measure a subtree that
 * contains a toggle, and so the toggle indents like the children it hides.
 */
export type SessionTreeRow =
  | {
      kind: 'session';
      __depth: number;
      session: SessionWithProvider;
    }
  | {
      kind: 'foldedChildren';
      __depth: number;
      parentSessionId: string;
      /**
       * Sessions currently folded away under this parent, descendants of a
       * folded child included. Zero while the parent is expanded, which is how
       * the toggle knows to offer folding them back up.
       */
      foldedCount: number;
      /** How many of those are running or waiting on the user. */
      foldedLiveCount: number;
      /**
       * How many of those are blocked on the user — a subset of
       * `foldedLiveCount`. A session stopped at a permission dialog is the one
       * row the user most needs to reach, so a toggle holding one has to say
       * so rather than counting it as an ordinary hidden session.
       */
      foldedWaitingCount: number;
    };

export type FoldChildSessionsOptions = {
  /** Parents the user opened; every one of their children is rendered. */
  expandedParentIds?: ReadonlySet<string>;
  /** Sessions running, or waiting on the user. */
  liveSessionIds?: ReadonlySet<string>;
  /**
   * Sessions blocked on the user — a permission prompt, a question. Normally
   * also in `liveSessionIds`, but merged in here regardless, so that a session
   * stopped at a dialog can never fold away quietly because a caller listed it
   * in only one of the two sets.
   *
   * It is named apart from the running sessions because it is not streaming and
   * would otherwise read as quiet: it takes a capped slot ahead of a merely
   * running sibling, and a toggle that ends up holding one has to report it.
   */
  waitingSessionIds?: ReadonlySet<string>;
  /** Sessions that stay on screen whatever their activity — the open one. */
  pinnedSessionIds?: ReadonlySet<string>;
  /**
   * Timestamp from which recorded activity still counts as working, normally
   * `now - RECENT_ACTIVITY_WINDOW_MS`.
   *
   * Left undefined, every child renders and only the cap folds anything —
   * without a clock to measure against there is no recency to read.
   */
  activeSince?: number;
  /** Defaults to `MAX_VISIBLE_CHILD_SESSIONS`. */
  visibleChildLimit?: number;
};

/**
 * Renders the children that are working and folds the rest behind a single
 * toggle row placed at the end of that parent's visible children.
 *
 * Resting is the default: a child earns its row by showing a signal the sidebar
 * actually observed, never by failing to prove it has finished. There is no
 * "done" here to key on — a session that completes its task does not exit, it
 * sits at its prompt looking exactly like one that is thinking — so the rule is
 * turned around and every visible row is positive evidence of work:
 *
 * - **Running.** The session is in cloudcli's run registry: a turn is in flight
 *   right now. The strongest signal there is, and the only one that means
 *   "streaming this second".
 * - **Waiting on the user.** Stopped at a permission dialog or a question. It
 *   is not streaming and its transcript may not have moved for an hour, but it
 *   is the row the user most needs to reach, so it counts as working.
 * - **Recently active.** Its transcript was written to within the window the
 *   caller passes as `activeSince`. This is what covers a session cloudcli did
 *   not launch — a worker driven from a terminal is never in the run registry,
 *   but the file watcher syncs its `lastActivity` within seconds of every
 *   message it writes.
 * - **Open.** Not evidence of work, but folding the row the user is reading
 *   would be its own bug.
 *
 * A branch is judged as a whole: a quiet parent holding a working grandchild
 * renders, because the working row cannot be drawn without it.
 *
 * Nothing is hidden. Everything folded is counted on the toggle, which reports
 * separately when it is holding something running or blocked, and folding is
 * recomputed from the sessions handed in each time — so a child that goes quiet
 * folds, and one that writes a message, starts a turn or hits a permission
 * prompt is on screen again at the next render, with no state to invalidate.
 *
 * The cap is applied after that filter, to the working children only:
 *
 * 1. A branch holding a pinned session — the one the user has open — always
 *    renders, so opening a session can never be what makes it vanish once a
 *    sibling overtakes it. It claims a slot rather than adding a row.
 * 2. Branches blocked on the user come next, then merely running ones: when
 *    there are more working children than slots, the ones that need the user to
 *    act outrank the ones that need nothing from them.
 * 3. The rest fill up in tree order, which `buildSessionTree` already left
 *    sorted by activity.
 *
 * The survivors are rendered back in tree order, so the rows still read most
 * recently active first beside their age badges.
 *
 * This is a display filter, applied to the flattened tree on its way to the
 * renderer rather than inside `buildSessionTree`: everything else reading the
 * tree — session counts, id lookups, the project-level fold — still sees every
 * loaded session, and nothing here can make a row unreachable.
 *
 * A row's parent is read from the depths in the flattened list — the nearest
 * row above it one level shallower — which keeps this in step with what is
 * actually drawn and makes folding a child fold its descendants with it.
 */
export const foldChildSessions = (
  orderedSessions: SessionWithProvider[],
  options: FoldChildSessionsOptions = {},
): SessionTreeRow[] => {
  const {
    activeSince,
    expandedParentIds,
    liveSessionIds,
    waitingSessionIds,
    pinnedSessionIds,
    visibleChildLimit = MAX_VISIBLE_CHILD_SESSIONS,
  } = options;

  // Everything that is running or blocked, whichever set the caller put it in.
  const liveOrWaitingSessionIds = !waitingSessionIds?.size
    ? liveSessionIds
    : !liveSessionIds?.size
      ? waitingSessionIds
      : new Set([...liveSessionIds, ...waitingSessionIds]);

  const depths = orderedSessions.map((session) => Math.max(Math.trunc(session.__depth ?? 0), 0));

  // Every subtree is a contiguous run in the flattened list, so one backward
  // pass gives each row the index its descendants end at.
  const subtreeEndIndexes: number[] = new Array(orderedSessions.length);
  for (let index = orderedSessions.length - 1; index >= 0; index -= 1) {
    let endIndex = index + 1;
    while (endIndex < orderedSessions.length && depths[endIndex] > depths[index]) {
      endIndex = subtreeEndIndexes[endIndex];
    }

    subtreeEndIndexes[index] = endIndex;
  }

  const rootIndexes: number[] = [];
  const childIndexesByParentIndex = new Map<number, number[]>();
  const latestIndexByDepth: number[] = [];

  depths.forEach((depth, index) => {
    const parentIndex = depth > 0 ? latestIndexByDepth[depth - 1] : undefined;
    latestIndexByDepth[depth] = index;
    // Anything recorded deeper belongs to a branch already left behind, so a
    // row that skips a level is rendered flat rather than attached to it.
    latestIndexByDepth.length = depth + 1;

    if (parentIndex === undefined) {
      rootIndexes.push(index);
      return;
    }

    const siblings = childIndexesByParentIndex.get(parentIndex);
    if (siblings) {
      siblings.push(index);
      return;
    }

    childIndexesByParentIndex.set(parentIndex, [index]);
  });

  const countInSubtree = (index: number, ids: ReadonlySet<string> | undefined): number => {
    if (!ids || ids.size === 0) {
      return 0;
    }

    let matches = 0;
    for (let cursor = index; cursor < subtreeEndIndexes[index]; cursor += 1) {
      if (ids.has(readSessionId(orderedSessions[cursor]))) {
        matches += 1;
      }
    }

    return matches;
  };

  /**
   * The freshest activity anywhere in a branch. Read across the whole subtree
   * so a quiet parent is kept on screen by a child that is still writing —
   * otherwise the working row would have nothing to hang from.
   */
  const readBranchActivityTime = (index: number): number => {
    let latestActivityTime = 0;
    for (let cursor = index; cursor < subtreeEndIndexes[index]; cursor += 1) {
      latestActivityTime = Math.max(latestActivityTime, readActivityTime(orderedSessions[cursor]));
    }

    return latestActivityTime;
  };

  /**
   * Whether a branch has shown any of the signals that earn a row. Every one of
   * them is something observed — a run in the registry, a prompt waiting on the
   * user, a message written, the session being open — never an inference that
   * the work behind a quiet session is over.
   */
  const isWorkingBranch = (index: number): boolean => {
    if (
      countInSubtree(index, pinnedSessionIds) > 0
      || countInSubtree(index, liveOrWaitingSessionIds) > 0
    ) {
      return true;
    }

    // No clock to measure against: fall back to rendering every child, capped,
    // rather than folding on a recency nobody supplied.
    return activeSince === undefined || readBranchActivityTime(index) >= activeSince;
  };

  const selectVisibleChildIndexes = (childIndexes: number[]): number[] => {
    const workingIndexes = childIndexes.filter(isWorkingBranch);
    if (workingIndexes.length <= visibleChildLimit) {
      return workingIndexes;
    }

    const pinnedIndexes = workingIndexes.filter((index) => countInSubtree(index, pinnedSessionIds) > 0);
    const otherIndexes = workingIndexes.filter((index) => !pinnedIndexes.includes(index));
    const isWaiting = (index: number) => countInSubtree(index, waitingSessionIds) > 0;
    const isLive = (index: number) => countInSubtree(index, liveOrWaitingSessionIds) > 0;
    const priorityIndexes = [
      ...otherIndexes.filter((index) => isWaiting(index)),
      ...otherIndexes.filter((index) => !isWaiting(index) && isLive(index)),
      ...otherIndexes.filter((index) => !isWaiting(index) && !isLive(index)),
    ];
    const freeSlotCount = Math.max(visibleChildLimit, pinnedIndexes.length) - pinnedIndexes.length;
    const visibleIndexes = new Set([
      ...pinnedIndexes,
      ...priorityIndexes.slice(0, Math.max(freeSlotCount, 0)),
    ]);

    return childIndexes.filter((index) => visibleIndexes.has(index));
  };

  const rows: SessionTreeRow[] = [];

  const emitSubtree = (index: number): void => {
    rows.push({ kind: 'session', __depth: depths[index], session: orderedSessions[index] });

    const childIndexes = childIndexesByParentIndex.get(index);
    if (!childIndexes) {
      return;
    }

    const parentSessionId = readSessionId(orderedSessions[index]);
    const isExpanded = expandedParentIds?.has(parentSessionId) ?? false;
    const selectedChildIndexes = selectVisibleChildIndexes(childIndexes);
    // Expanding is sticky for as long as the sidebar keeps the parent in its
    // set: nothing re-folds under someone who is reading it, not a child going
    // quiet, not the clock passing the recency window.
    const visibleChildIndexes = isExpanded ? childIndexes : selectedChildIndexes;

    for (const childIndex of visibleChildIndexes) {
      emitSubtree(childIndex);
    }

    const foldedChildIndexes = childIndexes.filter(
      (childIndex) => !visibleChildIndexes.includes(childIndex),
    );
    // An expanded parent keeps its toggle with nothing behind it, otherwise
    // there would be no way to fold the children back up.
    const isFoldable = selectedChildIndexes.length < childIndexes.length;
    if (foldedChildIndexes.length === 0 && !(isExpanded && isFoldable)) {
      return;
    }

    rows.push({
      kind: 'foldedChildren',
      __depth: depths[index] + 1,
      parentSessionId,
      foldedCount: foldedChildIndexes.reduce(
        (total, childIndex) => total + (subtreeEndIndexes[childIndex] - childIndex),
        0,
      ),
      foldedLiveCount: foldedChildIndexes.reduce(
        (total, childIndex) => total + countInSubtree(childIndex, liveOrWaitingSessionIds),
        0,
      ),
      foldedWaitingCount: foldedChildIndexes.reduce(
        (total, childIndex) => total + countInSubtree(childIndex, waitingSessionIds),
        0,
      ),
    });
  };

  for (const index of rootIndexes) {
    emitSubtree(index);
  }

  return rows;
};
