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

/** Session rows as `[id, depth]`, fold toggles as `['fold:<hidden count>', depth]`. */
const readRows = (rows: SessionTreeRow[]): Array<[string, number]> => rows.map((row) => (
  row.kind === 'session'
    ? [String(row.session.id), row.__depth]
    : [`fold:${row.foldedCount}`, row.__depth]
));

const createFamily = (childCount: number, extra: SessionFixture[] = []): SessionWithProvider[] =>
  buildSessionTree(createSessions([
    { id: 'parent', lastActivity: minutesAgo(1) },
    ...Array.from({ length: childCount }, (_, index) => ({
      id: `child-${index + 1}`,
      parentSessionId: 'parent',
      // Ten minutes apart, so `child-1` is always the most recently active.
      lastActivity: minutesAgo((index + 1) * 10),
    })),
    ...extra,
  ]));

test('a parent shows three children and folds the rest behind a toggle', () => {
  assert.deepEqual(readRows(foldChildSessions(createFamily(5))), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
    ['fold:2', 1],
  ]);
});

test('three or fewer children render without a toggle', () => {
  assert.deepEqual(readRows(foldChildSessions(createFamily(3))), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
  ]);
});

test('a folded child takes its own descendants with it, and the count says so', () => {
  const rows = foldChildSessions(createFamily(4, [
    { id: 'grandchild', parentSessionId: 'child-4', lastActivity: minutesAgo(50) },
  ]));

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
    ['fold:2', 1],
  ]);
});

test('a running child renders beside its three idle siblings, not instead of one', () => {
  // The oldest child by activity, and working right now. It used to take the
  // third slot off an idle sibling; it is now drawn outside the cap, so all
  // four render — still in activity order, so the rows read newest-first.
  const rows = foldChildSessions(createFamily(4), {
    liveSessionIds: new Set(['child-4']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
    ['child-4', 1],
  ]);
});

test('a branch that is live only through a grandchild overflows the cap too', () => {
  // `child-4` is quiet itself; the work is one level down. The cap reads the
  // branch, so the pair renders outside it just like a running child would.
  const rows = foldChildSessions(createFamily(4, [
    { id: 'busy-grandchild', parentSessionId: 'child-4', lastActivity: minutesAgo(45) },
  ]), {
    liveSessionIds: new Set(['busy-grandchild']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
    ['child-4', 1],
    ['busy-grandchild', 2],
  ]);
});

test('when every child is live every one of them shows, cap or no cap', () => {
  // The rule the owner asked for: show all the ones that are running. Five
  // working children are five rows, and there is nothing left to fold.
  const rows = foldChildSessions(createFamily(5), {
    liveSessionIds: new Set(['child-1', 'child-2', 'child-3', 'child-4', 'child-5']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
    ['child-4', 1],
    ['child-5', 1],
  ]);
});

test('the open session is never the row a fold takes away', () => {
  // It has fallen to last by activity while the user is reading it.
  const rows = foldChildSessions(createFamily(5), {
    pinnedSessionIds: new Set(['child-5']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    // Claims a slot rather than adding a row: still three children on screen.
    ['child-5', 1],
    ['fold:2', 1],
  ]);
});

test('a pinned grandchild keeps the child it hangs from on screen', () => {
  const rows = foldChildSessions(createFamily(5, [
    { id: 'open-grandchild', parentSessionId: 'child-5', lastActivity: minutesAgo(300) },
  ]), {
    pinnedSessionIds: new Set(['open-grandchild']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['child-5', 1],
    ['open-grandchild', 2],
    ['fold:2', 1],
  ]);
});

test('an expanded parent shows every child and keeps a toggle to fold them back', () => {
  const rows = foldChildSessions(createFamily(5), {
    expandedParentIds: new Set(['parent']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
    ['child-4', 1],
    ['child-5', 1],
    ['fold:0', 1],
  ]);
});

test('the cap applies at every depth of the tree', () => {
  const rows = foldChildSessions(buildSessionTree(createSessions([
    { id: 'root', lastActivity: minutesAgo(1) },
    { id: 'child', parentSessionId: 'root', lastActivity: minutesAgo(2) },
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `grandchild-${index + 1}`,
      parentSessionId: 'child',
      lastActivity: minutesAgo((index + 1) * 10),
    })),
  ])));

  assert.deepEqual(readRows(rows), [
    ['root', 0],
    ['child', 1],
    ['grandchild-1', 2],
    ['grandchild-2', 2],
    ['grandchild-3', 2],
    ['fold:1', 2],
  ]);
});

test('a fold toggle counts as part of the subtree it sits in', () => {
  // The project-level fold measures top-level sessions this way, so a toggle
  // must never be left stranded on the far side of that cut.
  const rows = foldChildSessions(createFamily(5));

  assert.equal(countSessionSubtreeRows(rows, 0), 5);
});

test('sessions with no children are left alone', () => {
  const rows = foldChildSessions(buildSessionTree(createSessions([
    { id: 'alone', lastActivity: minutesAgo(1) },
  ])));

  assert.deepEqual(readRows(rows), [['alone', 0]]);
  assert.deepEqual(foldChildSessions([]), []);
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

test('children that have gone quiet fold away and the working ones stay on screen', () => {
  // The sidebar the owner watches: two workers still writing, two that reported
  // and went quiet. Resting is the default, so only the working pair renders.
  const rows = foldChildSessions(createAgedFamily([2, 4, 40, 300]), {
    activeSince: ACTIVE_SINCE,
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['fold:2', 1],
  ]);
});

test('a running child never folds, however old its last message is', () => {
  // The dangerous case: a worker mid-turn writes nothing to its transcript
  // while it thinks, so its timestamp keeps ageing. A run in flight outranks
  // any clock.
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
  // Stopped at a permission dialog: not running, transcript untouched for five
  // hours, and the one row the user has to reach. It must not fold.
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

test('blocked and running children all render, and the cap still holds the idle ones', () => {
  // The two budgets side by side. Five children are running or blocked and
  // four more are on screen only for being recent: every live one is drawn,
  // and the three slots left over go to the recent ones by activity. Blocked
  // no longer has to outrank merely running — neither can lose a row.
  const rows = foldChildSessions(createAgedFamily([1, 2, 3, 4, 5, 6, 7, 8, 9]), {
    activeSince: ACTIVE_SINCE,
    liveSessionIds: new Set(['child-1', 'child-3', 'child-5', 'child-7', 'child-9']),
    waitingSessionIds: new Set(['child-9']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
    ['child-4', 1],
    ['child-5', 1],
    ['child-6', 1],
    ['child-7', 1],
    ['child-9', 1],
    ['fold:1', 1],
  ]);
});

test('no child toggle is ever left holding a live session', () => {
  // Why the toggle carries a count and no dots. Nine recent children, five of
  // them running or blocked, and one more at rest: between them the cap and
  // the resting fold take three rows off screen, and not one is live.
  const liveSessionIds = new Set(['child-1', 'child-3', 'child-5', 'child-7', 'child-9']);
  const rows = foldChildSessions(createAgedFamily([1, 2, 3, 4, 5, 6, 7, 8, 9, 600]), {
    activeSince: ACTIVE_SINCE,
    liveSessionIds,
    waitingSessionIds: new Set(['child-9']),
  });

  const renderedIds = new Set(
    rows.flatMap((row) => (row.kind === 'session' ? [String(row.session.id)] : [])),
  );
  const foldedIds = Array.from({ length: 10 }, (_, index) => `child-${index + 1}`)
    .filter((id) => !renderedIds.has(id));

  assert.deepEqual(foldedIds, ['child-8', 'child-10']);
  assert.ok(foldedIds.every((id) => !liveSessionIds.has(id)));
  // And one toggle stands for all of it, so the count on it is the whole story.
  const toggles = rows.filter((row) => row.kind === 'foldedChildren');
  assert.equal(toggles.length, 1);
  assert.equal(toggles[0].kind === 'foldedChildren' && toggles[0].foldedCount, 2);
});

test('a resting child never takes a capped slot from a working one', () => {
  // `stale-runner` is the oldest child by activity but is running right now,
  // and the two quiet ones sort above it. Resting children are filtered out
  // before the cap counts, so both working children render and neither quiet
  // one costs a slot.
  const rows = foldChildSessions(buildSessionTree(createSessions([
    { id: 'parent', lastActivity: minutesAgo(1) },
    { id: 'fresh', parentSessionId: 'parent', lastActivity: minutesAgo(1) },
    { id: 'quiet-a', parentSessionId: 'parent', lastActivity: minutesAgo(60) },
    { id: 'quiet-b', parentSessionId: 'parent', lastActivity: minutesAgo(70) },
    { id: 'stale-runner', parentSessionId: 'parent', lastActivity: minutesAgo(600) },
  ])), {
    activeSince: ACTIVE_SINCE,
    liveSessionIds: new Set(['stale-runner']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['fresh', 1],
    ['stale-runner', 1],
    ['fold:2', 1],
  ]);
});

test('both kinds of folded child are counted by the same single toggle', () => {
  // Five working children and two at rest: one toggle, one count, so the cap
  // and the resting fold cannot disagree about what is off screen.
  const rows = foldChildSessions(createAgedFamily([1, 2, 3, 4, 5, 90, 900]), {
    activeSince: ACTIVE_SINCE,
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
    ['fold:4', 1],
  ]);
  assert.equal(rows.filter((row) => row.kind === 'foldedChildren').length, 1);
});

test('the open session keeps its row after it goes quiet', () => {
  const rows = foldChildSessions(createAgedFamily([2, 900]), {
    activeSince: ACTIVE_SINCE,
    pinnedSessionIds: new Set(['child-2']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
  ]);
});

test('a quiet child stays on screen for the grandchild still working under it', () => {
  // The working row cannot be drawn without the branch it hangs from.
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

test('a folded child unfolds itself as soon as it writes again', () => {
  // A worker given more work after it reported must not stay buried because it
  // was quiet once. Nothing is remembered between calls, so the next render
  // with a fresh timestamp brings it straight back.
  const quiet = foldChildSessions(createAgedFamily([2, 300]), { activeSince: ACTIVE_SINCE });
  assert.deepEqual(readRows(quiet), [
    ['parent', 0],
    ['child-1', 1],
    ['fold:1', 1],
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

test('an expanded parent survives a re-render that replaces every session object', () => {
  // The sidebar rebuilds its rows from scratch on every websocket refresh. The
  // expansion is held by parent id, so a user reading the folded children is
  // never re-folded under by a refresh, a child going quiet, or the clock.
  const expandedParentIds = new Set(['parent']);
  const expected: Array<[string, number]> = [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
    ['fold:0', 1],
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

test('an expanded parent whose children are all at rest keeps a toggle to fold them back', () => {
  const rows = foldChildSessions(createAgedFamily([100, 200]), {
    activeSince: ACTIVE_SINCE,
    expandedParentIds: new Set(['parent']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['fold:0', 1],
  ]);
});

test('with no cutoff supplied nothing folds for being quiet', () => {
  // Recency is only judged against a clock the caller passes; without one the
  // cap is the only thing that folds anything.
  assert.deepEqual(readRows(foldChildSessions(createAgedFamily([100, 200, 900]))), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
  ]);
});

test('a blocked child listed only as waiting is still never folded', () => {
  // The guarantee has to hold on the util's own terms: a caller that names a
  // session as blocked without also putting it in the running set must not lose
  // that row — and, now that being live means overflowing the cap rather than
  // winning a slot, must not cost a recent sibling one either.
  const rows = foldChildSessions(createAgedFamily([1, 2, 3, 400]), {
    activeSince: ACTIVE_SINCE,
    waitingSessionIds: new Set(['child-4']),
  });

  assert.deepEqual(readRows(rows), [
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
    ['child-4', 1],
  ]);
});
