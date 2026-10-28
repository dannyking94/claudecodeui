import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../../../types/app';
import type { SessionWithProvider } from '../types/types';

import {
  buildSessionTree,
  countSessionSubtreeRows,
  foldChildSessions,
  groupSessionsByRootProject,
  pickProjectEntrySession,
  type ProjectSessions,
  type SessionTreeRow,
} from './sessionTree';
import { RECENT_ACTIVITY_WINDOW_MS } from './utils';

type SessionFixture = {
  id: string;
  parentSessionId?: string | null;
  parentSummary?: string | null;
  parentProjectPath?: string | null;
  lastActivity?: string | null;
  createdAt?: string;
};

const createSessions = (fixtures: SessionFixture[]): SessionWithProvider[] =>
  fixtures.map((fixture) => ({
    summary: fixture.id,
    messageCount: 0,
    lastActivity: '2026-08-26T10:00:00.000Z',
    __provider: 'claude',
    parentSessionId: null,
    parentSummary: null,
    parentProjectPath: null,
    ...fixture,
  })) as SessionWithProvider[];

const readLayout = (sessions: SessionWithProvider[]): Array<[string, number]> =>
  sessions.map((session) => [String(session.id), session.__depth ?? 0]);

test('children are emitted under their parent without moving it', () => {
  // Input order is the sidebar's date-desc sort: the parent sits between two
  // unrelated sessions and must stay there.
  const tree = buildSessionTree(createSessions([
    { id: 'newest' },
    { id: 'parent' },
    { id: 'older' },
    { id: 'child-a', parentSessionId: 'parent' },
    { id: 'child-b', parentSessionId: 'parent' },
  ]));

  assert.deepEqual(readLayout(tree), [
    ['newest', 0],
    ['parent', 0],
    ['child-a', 1],
    ['child-b', 1],
    ['older', 0],
  ]);
});

test('grandchildren keep nesting deeper', () => {
  const tree = buildSessionTree(createSessions([
    { id: 'root' },
    { id: 'child', parentSessionId: 'root' },
    { id: 'grandchild', parentSessionId: 'child' },
  ]));

  assert.deepEqual(readLayout(tree), [
    ['root', 0],
    ['child', 1],
    ['grandchild', 2],
  ]);
});

test('a child whose parent is absent from the list stays a top-level row', () => {
  // Reached whenever the parent is not in the sessions handed in — either it is
  // not loaded, or `groupSessionsByRootProject` had no parent row to move this
  // one towards.
  const tree = buildSessionTree(createSessions([
    { id: 'local-session' },
    {
      id: 'worker',
      parentSessionId: 'secretary-in-other-repo',
      parentSummary: 'dk-ai-1 secretary',
      parentProjectPath: '/home/dk/Repo/cloudcli',
    },
  ]));

  assert.deepEqual(readLayout(tree), [
    ['local-session', 0],
    ['worker', 0],
  ]);
  // The link itself survives so the row can still be labelled with its parent.
  assert.equal(tree[1].parentSummary, 'dk-ai-1 secretary');
});

test('an orphaned child degrades to a top-level row instead of disappearing', () => {
  // Covers a parent that was archived or hard-deleted, and a parent that has
  // simply not been paged in yet.
  const tree = buildSessionTree(createSessions([
    { id: 'kept' },
    { id: 'orphan', parentSessionId: 'deleted-parent' },
  ]));

  assert.deepEqual(readLayout(tree), [
    ['kept', 0],
    ['orphan', 0],
  ]);
});

test('a session that points at itself is treated as top-level', () => {
  const tree = buildSessionTree(createSessions([
    { id: 'self', parentSessionId: 'self' },
  ]));

  assert.deepEqual(readLayout(tree), [['self', 0]]);
});

test('a two-session cycle still renders both rows exactly once', () => {
  const tree = buildSessionTree(createSessions([
    { id: 'a', parentSessionId: 'b' },
    { id: 'b', parentSessionId: 'a' },
  ]));

  assert.deepEqual(readLayout(tree), [
    ['a', 0],
    ['b', 1],
  ]);
});

test('a longer cycle with a tail renders every session exactly once', () => {
  const tree = buildSessionTree(createSessions([
    { id: 'tail', parentSessionId: 'a' },
    { id: 'a', parentSessionId: 'c' },
    { id: 'b', parentSessionId: 'a' },
    { id: 'c', parentSessionId: 'b' },
  ]));

  assert.deepEqual(
    tree.map((session) => String(session.id)).sort(),
    ['a', 'b', 'c', 'tail'],
  );
  // Exactly one row in the broken cycle is promoted to the top level.
  assert.equal(tree.filter((session) => (session.__depth ?? 0) === 0).length, 1);
});

test('stale depth from a previous render is always recomputed', () => {
  const sessions = createSessions([{ id: 'root' }, { id: 'child', parentSessionId: 'root' }]);
  sessions[0].__depth = 7;
  sessions[1].__depth = 7;

  assert.deepEqual(readLayout(buildSessionTree(sessions)), [
    ['root', 0],
    ['child', 1],
  ]);
});

test('subtree row counts span a parent and all of its descendants', () => {
  const tree = buildSessionTree(createSessions([
    { id: 'root' },
    { id: 'child', parentSessionId: 'root' },
    { id: 'grandchild', parentSessionId: 'child' },
    { id: 'next-root' },
  ]));

  assert.equal(countSessionSubtreeRows(tree, 0), 3);
  assert.equal(countSessionSubtreeRows(tree, 1), 2);
  assert.equal(countSessionSubtreeRows(tree, 3), 1);
});

test('an empty project produces an empty tree', () => {
  assert.deepEqual(buildSessionTree([]), []);
});

const createProject = (projectId: string): Project => ({
  projectId,
  displayName: projectId,
  fullPath: `/home/dk/Repo/${projectId}`,
}) as Project;

const createProjectSessions = (
  entries: Array<[string, SessionFixture[]]>,
): ProjectSessions[] => entries.map(([projectId, fixtures]) => ({
  project: createProject(projectId),
  sessions: createSessions(fixtures),
}));

const readGroup = (
  groups: Map<string, SessionWithProvider[]>,
  projectId: string,
): Array<[string, string | null]> => (groups.get(projectId) ?? []).map((session) => [
  String(session.id),
  session.__ownerProject?.projectId ?? null,
]);

test('a session moves to the project of the session that spawned it', () => {
  // The worker case: a session launched in its own directory, so cloudcli files
  // it under that directory's project, with the parent link pointing back into
  // the project it was spawned from.
  const groups = groupSessionsByRootProject(createProjectSessions([
    ['secretary-repo', [{ id: 'secretary' }]],
    ['worker-repo', [{ id: 'worker', parentSessionId: 'secretary' }]],
  ]));

  assert.deepEqual(readGroup(groups, 'secretary-repo'), [
    ['secretary', null],
    ['worker', 'worker-repo'],
  ]);
  // The project it really runs in keeps a row of its own, now empty.
  assert.deepEqual(readGroup(groups, 'worker-repo'), []);
  // And the tree the sidebar draws from that group nests it.
  assert.deepEqual(
    buildSessionTree(groups.get('secretary-repo') ?? []).map((session) => session.__depth),
    [0, 1],
  );
});

test('a parent link that arrives after the row re-nests it without a reload', () => {
  // A worker spawned outside the app is indexed from its first transcript lines,
  // which say nothing about who spawned it; the parent link is written into the
  // database moments later. The sidebar therefore has to survive seeing the row
  // flat first and nest it once the delta carrying `parentSessionId` lands,
  // rather than waiting for a full reload to re-read the tree.
  const spawnedFlat = createProjectSessions([
    ['secretary-repo', [{ id: 'secretary' }]],
    ['worker-repo', [{ id: 'worker' }]],
  ]);

  const beforeLink = groupSessionsByRootProject(spawnedFlat);
  assert.deepEqual(readGroup(beforeLink, 'secretary-repo'), [['secretary', null]]);
  assert.deepEqual(readGroup(beforeLink, 'worker-repo'), [['worker', null]]);

  // The delta upserts the same row in place, now carrying its parent.
  const linked = spawnedFlat.map(({ project, sessions }) => ({
    project,
    sessions: sessions.map((session) => (
      session.id === 'worker'
        ? { ...session, parentSessionId: 'secretary', parentSummary: 'secretary' }
        : session
    )),
  }));

  const afterLink = groupSessionsByRootProject(linked);
  assert.deepEqual(readGroup(afterLink, 'secretary-repo'), [
    ['secretary', null],
    ['worker', 'worker-repo'],
  ]);
  assert.deepEqual(readGroup(afterLink, 'worker-repo'), []);
  assert.deepEqual(
    buildSessionTree(afterLink.get('secretary-repo') ?? []).map((session) => session.__depth),
    [0, 1],
  );
});

test('a chain of spawns collapses into the project of its root', () => {
  const groups = groupSessionsByRootProject(createProjectSessions([
    ['root-repo', [{ id: 'root' }]],
    ['middle-repo', [{ id: 'middle', parentSessionId: 'root' }]],
    ['leaf-repo', [{ id: 'leaf', parentSessionId: 'middle' }]],
  ]));

  assert.deepEqual(readGroup(groups, 'root-repo'), [
    ['root', null],
    ['middle', 'middle-repo'],
    ['leaf', 'leaf-repo'],
  ]);
  assert.deepEqual(readGroup(groups, 'middle-repo'), []);
  assert.deepEqual(readGroup(groups, 'leaf-repo'), []);
});

test('a session whose parent is not loaded stays where it is', () => {
  // Paged out, archived or deleted: moving it would hide it under a parent this
  // client cannot show, so it keeps its own project and its parent label.
  const groups = groupSessionsByRootProject(createProjectSessions([
    ['worker-repo', [{ id: 'worker', parentSessionId: 'never-loaded' }]],
  ]));

  assert.deepEqual(readGroup(groups, 'worker-repo'), [['worker', null]]);
});

test('sessions already in their parent project are left untagged', () => {
  const groups = groupSessionsByRootProject(createProjectSessions([
    ['repo', [{ id: 'parent' }, { id: 'child', parentSessionId: 'parent' }]],
  ]));

  assert.deepEqual(readGroup(groups, 'repo'), [
    ['parent', null],
    ['child', null],
  ]);
});

test('a session that points at itself is never moved', () => {
  const groups = groupSessionsByRootProject(createProjectSessions([
    ['repo', [{ id: 'self', parentSessionId: 'self' }]],
  ]));

  assert.deepEqual(readGroup(groups, 'repo'), [['self', null]]);
});

test('a cycle across projects settles in one group and keeps every row', () => {
  // Only reachable when parent links are written straight into the database.
  const groups = groupSessionsByRootProject(createProjectSessions([
    ['repo-a', [{ id: 'a', parentSessionId: 'b' }]],
    ['repo-b', [{ id: 'b', parentSessionId: 'a' }]],
  ]));

  const rows = [...groups.values()].flat().map((session) => String(session.id)).sort();
  assert.deepEqual(rows, ['a', 'b']);
});

test('every project gets a group, even one whose sessions all moved away', () => {
  const groups = groupSessionsByRootProject(createProjectSessions([
    ['parent-repo', [{ id: 'parent' }]],
    ['worker-repo', [{ id: 'worker', parentSessionId: 'parent' }]],
    ['empty-repo', []],
  ]));

  assert.deepEqual([...groups.keys()].sort(), ['empty-repo', 'parent-repo', 'worker-repo']);
});

test('regrouping never mutates the sessions it was given', () => {
  const entries = createProjectSessions([
    ['parent-repo', [{ id: 'parent' }]],
    ['worker-repo', [{ id: 'worker', parentSessionId: 'parent' }]],
  ]);
  const worker = entries[1].sessions[0];

  const groups = groupSessionsByRootProject(entries);

  assert.equal(worker.__ownerProject, undefined);
  assert.notEqual(groups.get('parent-repo')?.[1], worker);
});

/** Distinct, descending activity stamps so sibling order is never ambiguous. */
const minutesAgo = (minutes: number): string =>
  new Date(Date.parse('2026-08-28T12:00:00.000Z') - minutes * 60_000).toISOString();

test('project entry picks a present last-visited session', () => {
  const sessions = createSessions([
    { id: 'newest', lastActivity: minutesAgo(1) },
    { id: 'last-visited', lastActivity: minutesAgo(20) },
  ]);

  assert.equal(pickProjectEntrySession(sessions, 'last-visited')?.id, 'last-visited');
});

test('project entry falls back from a stale last-visited id to most recent', () => {
  const sessions = createSessions([
    { id: 'older', lastActivity: minutesAgo(20) },
    { id: 'newest', lastActivity: minutesAgo(1) },
  ]);

  assert.equal(pickProjectEntrySession(sessions, 'deleted')?.id, 'newest');
});

test('project entry picks the most recent session when none was visited', () => {
  const sessions = createSessions([
    { id: 'older', lastActivity: minutesAgo(20) },
    { id: 'newest', lastActivity: minutesAgo(1) },
  ]);

  assert.equal(pickProjectEntrySession(sessions, null)?.id, 'newest');
});

test('project entry returns null for a project without sessions', () => {
  assert.equal(pickProjectEntrySession([], 'deleted'), null);
});

test('siblings are ordered by activity, most recent first', () => {
  // The sidebar's complaint: a worker active two minutes ago sat below two that
  // had not moved in half a day, purely because of the order they were queried.
  const tree = buildSessionTree(createSessions([
    { id: 'parent', lastActivity: minutesAgo(2) },
    { id: 'twelve-hours', parentSessionId: 'parent', lastActivity: minutesAgo(720) },
    { id: 'ten-hours', parentSessionId: 'parent', lastActivity: minutesAgo(600) },
    { id: 'two-minutes', parentSessionId: 'parent', lastActivity: minutesAgo(2) },
  ]));

  assert.deepEqual(readLayout(tree), [
    ['parent', 0],
    ['two-minutes', 1],
    ['ten-hours', 1],
    ['twelve-hours', 1],
  ]);
});

test('a session with no recorded activity is ordered by when it was created', () => {
  // Same fallback the age badge uses, so the order still matches the label.
  const tree = buildSessionTree(createSessions([
    { id: 'parent', lastActivity: minutesAgo(1) },
    { id: 'active-an-hour-ago', parentSessionId: 'parent', lastActivity: minutesAgo(60) },
    {
      id: 'created-minutes-ago',
      parentSessionId: 'parent',
      lastActivity: null,
      createdAt: minutesAgo(5),
    },
  ]));

  assert.deepEqual(readLayout(tree), [
    ['parent', 0],
    ['created-minutes-ago', 1],
    ['active-an-hour-ago', 1],
  ]);
});

test('siblings last active at the same moment keep the order they arrived in', () => {
  const tree = buildSessionTree(createSessions([
    { id: 'parent' },
    { id: 'first', parentSessionId: 'parent', lastActivity: minutesAgo(30) },
    { id: 'second', parentSessionId: 'parent', lastActivity: minutesAgo(30) },
    { id: 'third', parentSessionId: 'parent', lastActivity: minutesAgo(30) },
  ]));

  assert.deepEqual(readLayout(tree), [
    ['parent', 0],
    ['first', 1],
    ['second', 1],
    ['third', 1],
  ]);
});

test('every level is ordered by activity, not just the first', () => {
  const tree = buildSessionTree(createSessions([
    { id: 'stale-root', lastActivity: minutesAgo(900) },
    { id: 'busy-root', lastActivity: minutesAgo(1) },
    { id: 'old-child', parentSessionId: 'busy-root', lastActivity: minutesAgo(400) },
    { id: 'new-child', parentSessionId: 'busy-root', lastActivity: minutesAgo(3) },
    { id: 'old-grandchild', parentSessionId: 'new-child', lastActivity: minutesAgo(200) },
    { id: 'new-grandchild', parentSessionId: 'new-child', lastActivity: minutesAgo(4) },
  ]));

  assert.deepEqual(readLayout(tree), [
    ['busy-root', 0],
    ['new-child', 1],
    ['new-grandchild', 2],
    ['old-grandchild', 2],
    ['old-child', 1],
    ['stale-root', 0],
  ]);
});

/**
 * Rendered rows as `[id, depth]`, with a third entry on a row that carries a
 * fold over its children: `'folded:<hidden count>'` or `'unfolded'`.
 */
const readRows = (rows: SessionTreeRow[]): Array<[string, number] | [string, number, string]> =>
  rows.map((row) => {
    const id = String(row.session.id);
    if (!row.childFold) {
      return [id, row.__depth];
    }

    return [
      id,
      row.__depth,
      row.childFold.isExpanded ? 'unfolded' : `folded:${row.childFold.foldedCount}`,
    ];
  });

/**
 * The cutoff the sidebar passes when it folds children that are at rest: the
 * same ten minutes the row's own "recently active" dot is drawn from, so a
 * child folds only once it has stopped claiming to be recently active.
 */
const ACTIVE_SINCE = Date.parse('2026-08-28T12:00:00.000Z') - RECENT_ACTIVITY_WINDOW_MS;

/** A parent whose children were last active the given number of minutes ago. */
const createAgedFamily = (
  childAgesInMinutes: readonly number[],
  extra: SessionFixture[] = [],
): SessionWithProvider[] => buildSessionTree(createSessions([
  { id: 'parent', lastActivity: minutesAgo(1) },
  ...childAgesInMinutes.map((minutes, index) => ({
    id: `child-${index + 1}`,
    parentSessionId: 'parent',
    lastActivity: minutesAgo(minutes),
  })),
  ...extra,
]));

test('active children stay on screen and every inactive one folds onto the parent', () => {
  // The owner's sidebar: two workers still writing, three that reported and
  // went quiet. No "three, then show more" — all three quiet ones fold.
  const rows = foldChildSessions(createAgedFamily([2, 4, 40, 300, 900]), {
    activeSince: ACTIVE_SINCE,
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0, 'folded:3'],
    ['child-1', 1],
    ['child-2', 1],
  ]);
});

test('there is no cap on how many active children render', () => {
  // Nine children written to within the window and one at rest: all nine
  // render, and the arrow holds only the resting one.
  const rows = foldChildSessions(createAgedFamily([1, 2, 3, 4, 5, 6, 7, 8, 9, 600]), {
    activeSince: ACTIVE_SINCE,
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0, 'folded:1'],
    ...Array.from({ length: 9 }, (_, index): [string, number] => [`child-${index + 1}`, 1]),
  ]);
});

test('a parent whose children are all inactive shows only itself and its arrow', () => {
  const rows = foldChildSessions(createAgedFamily([100, 200, 900]), {
    activeSince: ACTIVE_SINCE,
  });

  assert.deepEqual(readRows(rows), [['parent', 0, 'folded:3']]);
});

test('a parent with nothing to fold carries no arrow', () => {
  const rows = foldChildSessions(createAgedFamily([1, 2]), { activeSince: ACTIVE_SINCE });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
  ]);
});

test('unfolding a parent reveals every inactive child in activity order', () => {
  const rows = foldChildSessions(createAgedFamily([2, 40, 300]), {
    activeSince: ACTIVE_SINCE,
    expandedParentIds: new Set(['parent']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0, 'unfolded'],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
  ]);
});

test('toggling the parent back folds the inactive children again', () => {
  const sessions = createAgedFamily([2, 40, 300]);
  const unfolded = foldChildSessions(sessions, {
    activeSince: ACTIVE_SINCE,
    expandedParentIds: new Set(['parent']),
  });
  const refolded = foldChildSessions(sessions, {
    activeSince: ACTIVE_SINCE,
    expandedParentIds: new Set(),
  });

  assert.equal(unfolded.length, 4);
  assert.deepEqual(readRows(refolded), [
    ['parent', 0, 'folded:2'],
    ['child-1', 1],
  ]);
});

test('a folded child takes its own descendants with it, and the count says so', () => {
  const rows = foldChildSessions(createAgedFamily([2, 300], [
    { id: 'grandchild', parentSessionId: 'child-2', lastActivity: minutesAgo(400) },
  ]), {
    activeSince: ACTIVE_SINCE,
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0, 'folded:2'],
    ['child-1', 1],
  ]);
});

test('a worker\'s own children fold behind the arrow on the worker\'s row', () => {
  // Nested level: the worker is active, two of its children are not. Each
  // parent carries its own fold, and unfolding one leaves the other alone.
  const sessions = buildSessionTree(createSessions([
    { id: 'root', lastActivity: minutesAgo(1) },
    { id: 'worker', parentSessionId: 'root', lastActivity: minutesAgo(2) },
    { id: 'idle-worker', parentSessionId: 'root', lastActivity: minutesAgo(500) },
    { id: 'sub-1', parentSessionId: 'worker', lastActivity: minutesAgo(3) },
    { id: 'sub-2', parentSessionId: 'worker', lastActivity: minutesAgo(60) },
    { id: 'sub-3', parentSessionId: 'worker', lastActivity: minutesAgo(90) },
  ]));

  assert.deepEqual(readRows(foldChildSessions(sessions, { activeSince: ACTIVE_SINCE })), [
    ['root', 0, 'folded:1'],
    ['worker', 1, 'folded:2'],
    ['sub-1', 2],
  ]);

  assert.deepEqual(readRows(foldChildSessions(sessions, {
    activeSince: ACTIVE_SINCE,
    expandedParentIds: new Set(['worker']),
  })), [
    ['root', 0, 'folded:1'],
    ['worker', 1, 'unfolded'],
    ['sub-1', 2],
    ['sub-2', 2],
    ['sub-3', 2],
  ]);
});

test('a running child never folds, however old its last message is', () => {
  // A worker mid-turn writes nothing to its transcript while it thinks, so its
  // timestamp keeps ageing. A run in flight outranks any clock.
  const rows = foldChildSessions(createAgedFamily([2, 600]), {
    activeSince: ACTIVE_SINCE,
    liveSessionIds: new Set(['child-2']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
  ]);
});

test('a child blocked on the user stays on screen although nothing is streaming', () => {
  const rows = foldChildSessions(createAgedFamily([2, 300]), {
    activeSince: ACTIVE_SINCE,
    liveSessionIds: new Set(['child-2']),
    waitingSessionIds: new Set(['child-2']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
  ]);
});

test('a blocked child listed only as waiting is still never folded', () => {
  const rows = foldChildSessions(createAgedFamily([1, 400]), {
    activeSince: ACTIVE_SINCE,
    waitingSessionIds: new Set(['child-2']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
  ]);
});

test('a branch that is live only through a grandchild stays on screen', () => {
  const rows = foldChildSessions(createAgedFamily([2, 400], [
    { id: 'busy-grandchild', parentSessionId: 'child-2', lastActivity: minutesAgo(450) },
  ]), {
    activeSince: ACTIVE_SINCE,
    liveSessionIds: new Set(['busy-grandchild']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['busy-grandchild', 2],
  ]);
});

test('a quiet child stays on screen for the grandchild still writing under it', () => {
  const rows = foldChildSessions(createAgedFamily([2, 400], [
    { id: 'busy-grandchild', parentSessionId: 'child-2', lastActivity: minutesAgo(1) },
  ]), {
    activeSince: ACTIVE_SINCE,
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['busy-grandchild', 2],
  ]);
});

test('the open session keeps its row after it goes quiet', () => {
  const rows = foldChildSessions(createAgedFamily([2, 900, 950]), {
    activeSince: ACTIVE_SINCE,
    pinnedSessionIds: new Set(['child-2']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0, 'folded:1'],
    ['child-1', 1],
    ['child-2', 1],
  ]);
});

test('a pinned grandchild keeps the child it hangs from on screen', () => {
  const rows = foldChildSessions(createAgedFamily([2, 300], [
    { id: 'open-grandchild', parentSessionId: 'child-2', lastActivity: minutesAgo(300) },
  ]), {
    activeSince: ACTIVE_SINCE,
    pinnedSessionIds: new Set(['open-grandchild']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['open-grandchild', 2],
  ]);
});

test('no fold is ever left holding a live session', () => {
  // Why the fold carries a count and no dots.
  const liveSessionIds = new Set(['child-3', 'child-5']);
  const rows = foldChildSessions(createAgedFamily([1, 200, 300, 400, 500, 600]), {
    activeSince: ACTIVE_SINCE,
    liveSessionIds,
    waitingSessionIds: new Set(['child-5']),
  });

  const renderedIds = new Set(rows.map((row) => String(row.session.id)));
  const foldedIds = Array.from({ length: 6 }, (_, index) => `child-${index + 1}`)
    .filter((id) => !renderedIds.has(id));

  assert.deepEqual(foldedIds, ['child-2', 'child-4', 'child-6']);
  assert.ok(foldedIds.every((id) => !liveSessionIds.has(id)));
  assert.equal(rows[0].childFold?.foldedCount, 3);
});

test('a folded child unfolds itself as soon as it writes again', () => {
  // A worker given more work after it reported must not stay buried because it
  // was quiet once. Nothing is remembered between calls.
  const quiet = foldChildSessions(createAgedFamily([2, 300]), { activeSince: ACTIVE_SINCE });
  assert.deepEqual(readRows(quiet), [
    ['parent', 0, 'folded:1'],
    ['child-1', 1],
  ]);

  const writingAgain = foldChildSessions(createAgedFamily([2, 0]), { activeSince: ACTIVE_SINCE });
  assert.deepEqual(readRows(writingAgain), [
    ['parent', 0],
    ['child-2', 1],
    ['child-1', 1],
  ]);
});

test('a folded child unfolds itself as soon as it starts running', () => {
  const rows = foldChildSessions(createAgedFamily([2, 300]), {
    activeSince: ACTIVE_SINCE,
    liveSessionIds: new Set(['child-2']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
  ]);
});

test('an unfolded parent survives a re-render that replaces every session object', () => {
  // The sidebar rebuilds its rows from scratch on every websocket refresh. The
  // expansion is held by parent id, so a user reading the folded children is
  // never re-folded under by a refresh, a child going quiet, or the clock.
  const expandedParentIds = new Set(['parent']);
  const expected = [
    ['parent', 0, 'unfolded'],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
  ];

  const firstRender = foldChildSessions(createAgedFamily([2, 200, 900]), {
    activeSince: ACTIVE_SINCE,
    expandedParentIds,
  });
  assert.deepEqual(readRows(firstRender), expected);

  // Fresh session objects, same ids — and the first child has now gone quiet.
  const secondRender = foldChildSessions(createAgedFamily([30, 200, 900]), {
    activeSince: ACTIVE_SINCE,
    expandedParentIds,
  });
  assert.deepEqual(readRows(secondRender), expected);
});

test('with no cutoff supplied nothing folds for being quiet', () => {
  assert.deepEqual(readRows(foldChildSessions(createAgedFamily([100, 200, 900, 1000]))), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
    ['child-4', 1],
  ]);
});

test('subtree row counts measure what the fold left on screen', () => {
  // The project-level fold measures top-level sessions this way.
  const rows = foldChildSessions(createAgedFamily([2, 300], [
    { id: 'second-root', lastActivity: minutesAgo(5) },
  ]), {
    activeSince: ACTIVE_SINCE,
  });

  assert.equal(countSessionSubtreeRows(rows, 0), 2);
});

test('sessions with no children are left alone', () => {
  const rows = foldChildSessions(buildSessionTree(createSessions([
    { id: 'alone', lastActivity: minutesAgo(1) },
  ])));

  assert.deepEqual(readRows(rows), [['alone', 0]]);
  assert.deepEqual(foldChildSessions([]), []);
});
