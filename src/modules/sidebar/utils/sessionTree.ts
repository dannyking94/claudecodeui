import type { Project, SessionWithProvider } from '@/shared/types';
import { getSessionDate } from '@/modules/sidebar/utils/sidebarProjectFormatting';

/**
 * Everything in this file is the sidebar's handling of SPAWNED sessions — a
 * session recorded as the child of the session that launched it
 * (`parentSessionId`), such as a worker started by a secretary. It is layered
 * on top of the fork tree (`projectSessionTree.ts`), which draws the rows:
 * this file decides which project group a spawned session is shown in, which
 * quiet children fold behind their parent's arrow, and how many top-level
 * conversations a project shows before "Show N more".
 *
 * One switch turns all of it off and leaves the plain fork tree:
 *
 *   localStorage.setItem('cloudcli.spawnNesting', 'off')   // then reload
 *   localStorage.removeItem('cloudcli.spawnNesting')       // back on (default)
 */
export const SPAWN_NESTING_STORAGE_KEY = 'cloudcli.spawnNesting';

/** Read once per mount by the sidebar controller and each project's session list. */
export const isSpawnNestingEnabled = (): boolean => {
  try {
    return localStorage.getItem(SPAWN_NESTING_STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
};

/**
 * Top-level conversations shown per project before the rest fold behind
 * "Show N more". Three keeps a project with a long history from pushing every
 * other project off the sidebar, while still covering the "jump back to what I
 * was just doing" case.
 */
export const VISIBLE_SESSION_LIMIT = 3;

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
export const compareSessionsByActivity = (
  left: SessionWithProvider,
  right: SessionWithProvider,
): number => readActivityTime(right) - readActivityTime(left);

/**
 * Chooses the session a project row should open.
 *
 * A remembered session wins while it is still loaded. Otherwise the same
 * activity ordering used by the session tree supplies the freshest fallback.
 */
export const pickProjectEntrySession = (
  sessions: SessionWithProvider[],
  lastVisitedId: string | null,
): SessionWithProvider | null => {
  if (lastVisitedId) {
    const lastVisitedSession = sessions.find(
      (session) => readSessionId(session) === lastVisitedId,
    );
    if (lastVisitedSession) {
      return lastVisitedSession;
    }
  }

  return [...sessions].sort(compareSessionsByActivity)[0] ?? null;
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
 * that the sidebar draws stops at the repository boundary. Grouping by
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
 * The fold a parent row carries for its own children. Present only on a row
 * that has children which are not working — the ones the arrow beside it hides
 * and reveals. A parent whose children are all working has nothing to fold and
 * no arrow.
 */
export type ChildSessionFold = {
  /** Whether the user unfolded this parent: every child is on screen. */
  isExpanded: boolean;
  /**
   * Sessions currently folded away under this parent, descendants of a folded
   * child included. Zero while the parent is expanded.
   *
   * A plain count is the whole of what it reports, because everything folded
   * is quiet by construction: a branch that is running or blocked on the user
   * is never folded here. The sidebar's project-level fold is a different
   * control, it can still take a working row off screen, and it keeps its dots.
   */
  foldedCount: number;
};

/** One rendered row of the sidebar's session list. */
export type SessionTreeRow = {
  __depth: number;
  session: SessionWithProvider;
  /** The fold over this row's children, or null when it has nothing to fold. */
  childFold: ChildSessionFold | null;
};

export type FoldChildSessionsOptions = {
  /** Parents the user unfolded; every one of their children is rendered. */
  expandedParentIds?: ReadonlySet<string>;
  /** Sessions running, or waiting on the user. */
  liveSessionIds?: ReadonlySet<string>;
  /**
   * Sessions blocked on the user — a permission prompt, a question. Normally
   * also in `liveSessionIds`, but merged in here regardless, so that a session
   * stopped at a dialog can never fold away quietly because a caller listed it
   * in only one of the two sets.
   */
  waitingSessionIds?: ReadonlySet<string>;
  /** Sessions that stay on screen whatever their activity — the open one. */
  pinnedSessionIds?: ReadonlySet<string>;
  /**
   * Timestamp from which recorded activity still counts as working, normally
   * `now - RECENT_ACTIVITY_WINDOW_MS`.
   *
   * Left undefined, every child renders and nothing folds — without a clock to
   * measure against there is no recency to read.
   */
  activeSince?: number;
  /**
   * Limits folding to the children this returns true for; every other child
   * always renders. The sidebar passes "was spawned by its parent", so a fork
   * keeps the fork tree's own always-open default. Left undefined, any quiet
   * child may fold.
   */
  isFoldableChild?: (session: SessionWithProvider) => boolean;
};

/**
 * Renders the children that are working and folds every other one behind the
 * arrow on their parent's row.
 *
 * Resting is the default: a child earns its row by showing a signal the sidebar
 * actually observed, never by failing to prove it has finished. There is no
 * "done" here to key on — a session that completes its task does not exit, it
 * sits at its prompt looking exactly like one that is thinking — so the rule is
 * turned around and every visible row is positive evidence of work:
 *
 * - **Running.** The session is in cloudcli's run registry: a turn is in flight
 *   right now.
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
 * There is no cap on the working rows. The owner asked for the active workers
 * on screen and the rest folded, all of them — not "three, then show N more"
 * at the bottom of a list long enough that the toggle scrolls out of reach.
 * That is also why the control is the parent's own row rather than a row
 * after its children: it stays where the eye already is however many children
 * there are.
 *
 * Nothing is hidden. Everything folded is counted on the parent's fold, and
 * folding is recomputed from the sessions handed in each time — so a child
 * that goes quiet folds, and one that writes a message, starts a turn or hits
 * a permission prompt is on screen again at the next render, with no state to
 * invalidate.
 *
 * This is a display filter, applied to the flattened tree on its way to the
 * renderer rather than inside the tree builder: everything else reading the
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
    isFoldableChild,
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

  const subtreeContains = (index: number, ids: ReadonlySet<string> | undefined): boolean => {
    if (!ids || ids.size === 0) {
      return false;
    }

    for (let cursor = index; cursor < subtreeEndIndexes[index]; cursor += 1) {
      if (ids.has(readSessionId(orderedSessions[cursor]))) {
        return true;
      }
    }

    return false;
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
    if (isFoldableChild && !isFoldableChild(orderedSessions[index])) {
      return true;
    }

    if (subtreeContains(index, pinnedSessionIds) || subtreeContains(index, liveOrWaitingSessionIds)) {
      return true;
    }

    // No clock to measure against: render every child rather than folding on a
    // recency nobody supplied.
    return activeSince === undefined || readBranchActivityTime(index) >= activeSince;
  };

  const rows: SessionTreeRow[] = [];

  const emitSubtree = (index: number): void => {
    const row: SessionTreeRow = {
      __depth: depths[index],
      session: orderedSessions[index],
      childFold: null,
    };
    rows.push(row);

    const childIndexes = childIndexesByParentIndex.get(index);
    if (!childIndexes) {
      return;
    }

    const workingChildIndexes = childIndexes.filter(isWorkingBranch);
    const isFoldable = workingChildIndexes.length < childIndexes.length;
    // Expanding is sticky for as long as the sidebar keeps the parent in its
    // set: nothing re-folds under someone who is reading it, not a child going
    // quiet, not the clock passing the recency window.
    const isExpanded = isFoldable
      && (expandedParentIds?.has(readSessionId(orderedSessions[index])) ?? false);
    const visibleChildIndexes = isExpanded ? childIndexes : workingChildIndexes;

    if (isFoldable) {
      row.childFold = {
        isExpanded,
        foldedCount: isExpanded
          ? 0
          : childIndexes
            .filter((childIndex) => !visibleChildIndexes.includes(childIndex))
            .reduce(
              (total, childIndex) => total + (subtreeEndIndexes[childIndex] - childIndex),
              0,
            ),
      };
    }

    for (const childIndex of visibleChildIndexes) {
      emitSubtree(childIndex);
    }
  };

  for (const index of rootIndexes) {
    emitSubtree(index);
  }

  return rows;
};
