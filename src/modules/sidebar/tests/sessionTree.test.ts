import { expect, test } from 'vitest';

import type { Project, SessionWithProvider } from '@/shared/types';
import { buildProjectSessionTree } from '@/modules/sidebar/utils/projectSessionTree';
import {
  compareSessionsByActivity,
  foldChildSessions,
  groupSessionsByRootProject,
  orderRootsByOwnActivity,
  pickProjectEntrySession,
} from '@/modules/sidebar/utils/sessionTree';
import type { ProjectSessions, SessionTreeRow } from '@/modules/sidebar/utils/sessionTree';

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

/**
 * The flattened, depth-tagged tree `foldChildSessions` is handed in the
 * sidebar: sessions newest-first (as `getAllSessions` and the controller's
 * regrouping deliver them), arranged by the fork-tree builder with spawn links
 * on.
 */
const buildSessionTree = (sessions: SessionWithProvider[]): SessionWithProvider[] =>
  buildProjectSessionTree([...sessions].sort(compareSessionsByActivity), 'project', { includeSpawnLinks: true })
    .map((row) => ({ ...row.session, __depth: row.depth }));

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

  expect(readLayout(tree)).toEqual([
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

  expect(readLayout(tree)).toEqual([
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

  expect(readLayout(tree)).toEqual([
    ['local-session', 0],
    ['worker', 0],
  ]);
  // The link itself survives so the row can still be labelled with its parent.
  expect(tree[1].parentSummary).toBe('dk-ai-1 secretary');
});

test('an orphaned child degrades to a top-level row instead of disappearing', () => {
  // Covers a parent that was archived or hard-deleted, and a parent that has
  // simply not been paged in yet.
  const tree = buildSessionTree(createSessions([
    { id: 'kept' },
    { id: 'orphan', parentSessionId: 'deleted-parent' },
  ]));

  expect(readLayout(tree)).toEqual([
    ['kept', 0],
    ['orphan', 0],
  ]);
});

test('a session that points at itself is treated as top-level', () => {
  const tree = buildSessionTree(createSessions([
    { id: 'self', parentSessionId: 'self' },
  ]));

  expect(readLayout(tree)).toEqual([['self', 0]]);
});

test('a two-session cycle still renders both rows exactly once', () => {
  const tree = buildSessionTree(createSessions([
    { id: 'a', parentSessionId: 'b' },
    { id: 'b', parentSessionId: 'a' },
  ]));

  // Which link the loop is opened at is the tree builder's choice; what matters
  // is that both rows render once, one under the other.
  expect(readLayout(tree)).toEqual([
    ['b', 0],
    ['a', 1],
  ]);
});

test('a longer cycle with a tail renders every session exactly once', () => {
  const tree = buildSessionTree(createSessions([
    { id: 'tail', parentSessionId: 'a' },
    { id: 'a', parentSessionId: 'c' },
    { id: 'b', parentSessionId: 'a' },
    { id: 'c', parentSessionId: 'b' },
  ]));

  expect(tree.map((session) => String(session.id)).sort()).toEqual(['a', 'b', 'c', 'tail']);
  // Exactly one row in the broken cycle is promoted to the top level.
  expect(tree.filter((session) => (session.__depth ?? 0) === 0).length).toBe(1);
});

test('stale depth from a previous render is always recomputed', () => {
  const sessions = createSessions([{ id: 'root' }, { id: 'child', parentSessionId: 'root' }]);
  sessions[0].__depth = 7;
  sessions[1].__depth = 7;

  expect(readLayout(buildSessionTree(sessions))).toEqual([
    ['root', 0],
    ['child', 1],
  ]);
});

test('an empty project produces an empty tree', () => {
  expect(buildSessionTree([])).toEqual([]);
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

  expect(readGroup(groups, 'secretary-repo')).toEqual([
    ['secretary', null],
    ['worker', 'worker-repo'],
  ]);
  // The project it really runs in keeps a row of its own, now empty.
  expect(readGroup(groups, 'worker-repo')).toEqual([]);
  // And the tree the sidebar draws from that group nests it.
  expect(buildSessionTree(groups.get('secretary-repo') ?? []).map((session) => session.__depth)).toEqual([0, 1]);
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
  expect(readGroup(beforeLink, 'secretary-repo')).toEqual([['secretary', null]]);
  expect(readGroup(beforeLink, 'worker-repo')).toEqual([['worker', null]]);

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
  expect(readGroup(afterLink, 'secretary-repo')).toEqual([
    ['secretary', null],
    ['worker', 'worker-repo'],
  ]);
  expect(readGroup(afterLink, 'worker-repo')).toEqual([]);
  expect(buildSessionTree(afterLink.get('secretary-repo') ?? []).map((session) => session.__depth)).toEqual([0, 1]);
});

test('a chain of spawns collapses into the project of its root', () => {
  const groups = groupSessionsByRootProject(createProjectSessions([
    ['root-repo', [{ id: 'root' }]],
    ['middle-repo', [{ id: 'middle', parentSessionId: 'root' }]],
    ['leaf-repo', [{ id: 'leaf', parentSessionId: 'middle' }]],
  ]));

  expect(readGroup(groups, 'root-repo')).toEqual([
    ['root', null],
    ['middle', 'middle-repo'],
    ['leaf', 'leaf-repo'],
  ]);
  expect(readGroup(groups, 'middle-repo')).toEqual([]);
  expect(readGroup(groups, 'leaf-repo')).toEqual([]);
});

test('a session whose parent is not loaded stays where it is', () => {
  // Paged out, archived or deleted: moving it would hide it under a parent this
  // client cannot show, so it keeps its own project and its parent label.
  const groups = groupSessionsByRootProject(createProjectSessions([
    ['worker-repo', [{ id: 'worker', parentSessionId: 'never-loaded' }]],
  ]));

  expect(readGroup(groups, 'worker-repo')).toEqual([['worker', null]]);
});

test('sessions already in their parent project are left untagged', () => {
  const groups = groupSessionsByRootProject(createProjectSessions([
    ['repo', [{ id: 'parent' }, { id: 'child', parentSessionId: 'parent' }]],
  ]));

  expect(readGroup(groups, 'repo')).toEqual([
    ['parent', null],
    ['child', null],
  ]);
});

test('a session that points at itself is never moved', () => {
  const groups = groupSessionsByRootProject(createProjectSessions([
    ['repo', [{ id: 'self', parentSessionId: 'self' }]],
  ]));

  expect(readGroup(groups, 'repo')).toEqual([['self', null]]);
});

test('a cycle across projects settles in one group and keeps every row', () => {
  // Only reachable when parent links are written straight into the database.
  const groups = groupSessionsByRootProject(createProjectSessions([
    ['repo-a', [{ id: 'a', parentSessionId: 'b' }]],
    ['repo-b', [{ id: 'b', parentSessionId: 'a' }]],
  ]));

  const rows = [...groups.values()].flat().map((session) => String(session.id)).sort();
  expect(rows).toEqual(['a', 'b']);
});

test('every project gets a group, even one whose sessions all moved away', () => {
  const groups = groupSessionsByRootProject(createProjectSessions([
    ['parent-repo', [{ id: 'parent' }]],
    ['worker-repo', [{ id: 'worker', parentSessionId: 'parent' }]],
    ['empty-repo', []],
  ]));

  expect([...groups.keys()].sort()).toEqual(['empty-repo', 'parent-repo', 'worker-repo']);
});

test('regrouping never mutates the sessions it was given', () => {
  const entries = createProjectSessions([
    ['parent-repo', [{ id: 'parent' }]],
    ['worker-repo', [{ id: 'worker', parentSessionId: 'parent' }]],
  ]);
  const worker = entries[1].sessions[0];

  const groups = groupSessionsByRootProject(entries);

  expect(worker.__ownerProject).toBe(undefined);
  expect(groups.get('parent-repo')?.[1]).not.toBe(worker);
});

/** Distinct, descending activity stamps so sibling order is never ambiguous. */
const minutesAgo = (minutes: number): string =>
  new Date(Date.parse('2026-08-28T12:00:00.000Z') - minutes * 60_000).toISOString();

test('project entry picks a present last-visited session', () => {
  const sessions = createSessions([
    { id: 'newest', lastActivity: minutesAgo(1) },
    { id: 'last-visited', lastActivity: minutesAgo(20) },
  ]);

  expect(pickProjectEntrySession(sessions, 'last-visited')?.id).toBe('last-visited');
});

test('project entry falls back from a stale last-visited id to most recent', () => {
  const sessions = createSessions([
    { id: 'older', lastActivity: minutesAgo(20) },
    { id: 'newest', lastActivity: minutesAgo(1) },
  ]);

  expect(pickProjectEntrySession(sessions, 'deleted')?.id).toBe('newest');
});

test('project entry picks the most recent session when none was visited', () => {
  const sessions = createSessions([
    { id: 'older', lastActivity: minutesAgo(20) },
    { id: 'newest', lastActivity: minutesAgo(1) },
  ]);

  expect(pickProjectEntrySession(sessions, null)?.id).toBe('newest');
});

test('project entry returns null for a project without sessions', () => {
  expect(pickProjectEntrySession([], 'deleted')).toBe(null);
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

  expect(readLayout(tree)).toEqual([
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

  expect(readLayout(tree)).toEqual([
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

  expect(readLayout(tree)).toEqual([
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

  expect(readLayout(tree)).toEqual([
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

test('live children stay on screen and every other one folds onto the parent', () => {
  const rows = foldChildSessions(createAgedFamily([2, 4, 40, 300, 900]), {
    liveSessionIds: new Set(['child-1', 'child-2']),
  });

  expect(readRows(rows)).toEqual([
    ['parent', 0, 'folded:3'],
    ['child-1', 1],
    ['child-2', 1],
  ]);
});

test('a child that wrote a minute ago but is not live folds: recency is not liveness', () => {
  // The owner's screenshot: workers stopped 17 and 35 minutes ago, and one that
  // had just finished, all still on screen. Only the running one stays.
  const rows = foldChildSessions(createAgedFamily([0, 1, 17, 35]), {
    liveSessionIds: new Set(['child-1']),
  });

  expect(readRows(rows)).toEqual([
    ['parent', 0, 'folded:3'],
    ['child-1', 1],
  ]);
});

test('there is no cap on how many live children render', () => {
  const live = new Set(Array.from({ length: 9 }, (_, index) => `child-${index + 1}`));
  const rows = foldChildSessions(createAgedFamily([1, 2, 3, 4, 5, 6, 7, 8, 9, 600]), { liveSessionIds: live });

  expect(readRows(rows)).toEqual([
    ['parent', 0, 'folded:1'],
    ...Array.from({ length: 9 }, (_, index): [string, number] => [`child-${index + 1}`, 1]),
  ]);
});

test('a parent with no live children shows only itself and its arrow', () => {
  expect(readRows(foldChildSessions(createAgedFamily([100, 200, 900])))).toEqual([['parent', 0, 'folded:3']]);
});

test('a parent with nothing to fold carries no arrow', () => {
  const rows = foldChildSessions(createAgedFamily([1, 2]), { liveSessionIds: new Set(['child-1', 'child-2']) });

  expect(readRows(rows)).toEqual([
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
  ]);
});

test('unfolding a parent reveals every child in activity order, and toggling back folds them', () => {
  const sessions = createAgedFamily([2, 40, 300]);
  const liveSessionIds = new Set(['child-1']);

  expect(readRows(foldChildSessions(sessions, { liveSessionIds, expandedParentIds: new Set(['parent']) }))).toEqual([
    ['parent', 0, 'unfolded'],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
  ]);
  expect(readRows(foldChildSessions(sessions, { liveSessionIds, expandedParentIds: new Set() }))).toEqual([
    ['parent', 0, 'folded:2'],
    ['child-1', 1],
  ]);
});

test('a folded child takes its own descendants with it, and the count says so', () => {
  const rows = foldChildSessions(createAgedFamily([2, 300], [
    { id: 'grandchild', parentSessionId: 'child-2', lastActivity: minutesAgo(400) },
  ]), { liveSessionIds: new Set(['child-1']) });

  expect(readRows(rows)).toEqual([
    ['parent', 0, 'folded:2'],
    ['child-1', 1],
  ]);
});

test('a worker\'s own children fold behind the arrow on the worker\'s row', () => {
  const sessions = buildSessionTree(createSessions([
    { id: 'root', lastActivity: minutesAgo(1) },
    { id: 'worker', parentSessionId: 'root', lastActivity: minutesAgo(2) },
    { id: 'idle-worker', parentSessionId: 'root', lastActivity: minutesAgo(500) },
    { id: 'sub-1', parentSessionId: 'worker', lastActivity: minutesAgo(3) },
    { id: 'sub-2', parentSessionId: 'worker', lastActivity: minutesAgo(60) },
    { id: 'sub-3', parentSessionId: 'worker', lastActivity: minutesAgo(90) },
  ]));
  const liveSessionIds = new Set(['worker', 'sub-1']);

  expect(readRows(foldChildSessions(sessions, { liveSessionIds }))).toEqual([
    ['root', 0, 'folded:1'],
    ['worker', 1, 'folded:2'],
    ['sub-1', 2],
  ]);

  expect(readRows(foldChildSessions(sessions, { liveSessionIds, expandedParentIds: new Set(['worker']) }))).toEqual([
    ['root', 0, 'folded:1'],
    ['worker', 1, 'unfolded'],
    ['sub-1', 2],
    ['sub-2', 2],
    ['sub-3', 2],
  ]);
});

test('a live child never folds, however old its last message is', () => {
  const rows = foldChildSessions(createAgedFamily([2, 600]), { liveSessionIds: new Set(['child-2']) });

  expect(readRows(rows)).toEqual([
    ['parent', 0, 'folded:1'],
    ['child-2', 1],
  ]);
});

test('a branch that is live only through a grandchild stays on screen', () => {
  const rows = foldChildSessions(createAgedFamily([2, 400], [
    { id: 'busy-grandchild', parentSessionId: 'child-2', lastActivity: minutesAgo(450) },
  ]), { liveSessionIds: new Set(['busy-grandchild']) });

  expect(readRows(rows)).toEqual([
    ['parent', 0, 'folded:1'],
    ['child-2', 1],
    ['busy-grandchild', 2],
  ]);
});

test('the open session keeps its row though it is not live', () => {
  const rows = foldChildSessions(createAgedFamily([2, 900, 950]), {
    liveSessionIds: new Set(['child-1']),
    pinnedSessionIds: new Set(['child-2']),
  });

  expect(readRows(rows)).toEqual([
    ['parent', 0, 'folded:1'],
    ['child-1', 1],
    ['child-2', 1],
  ]);
});

test('a pinned grandchild keeps the child it hangs from on screen', () => {
  const rows = foldChildSessions(createAgedFamily([2, 300], [
    { id: 'open-grandchild', parentSessionId: 'child-2', lastActivity: minutesAgo(300) },
  ]), { pinnedSessionIds: new Set(['open-grandchild']) });

  expect(readRows(rows)).toEqual([
    ['parent', 0, 'folded:1'],
    ['child-2', 1],
    ['open-grandchild', 2],
  ]);
});

test('no fold is ever left holding a live session', () => {
  const liveSessionIds = new Set(['child-3', 'child-5']);
  const rows = foldChildSessions(createAgedFamily([1, 200, 300, 400, 500, 600]), { liveSessionIds });

  const renderedIds = new Set(rows.map((row) => String(row.session.id)));
  const foldedIds = Array.from({ length: 6 }, (_, index) => `child-${index + 1}`)
    .filter((id) => !renderedIds.has(id));

  expect(foldedIds).toEqual(['child-1', 'child-2', 'child-4', 'child-6']);
  expect(foldedIds.every((id) => !liveSessionIds.has(id))).toBe(true);
  expect(rows[0].childFold?.foldedCount).toBe(4);
});

test('a folded child unfolds itself as soon as it goes live, and folds once its process exits', () => {
  const sessions = createAgedFamily([2, 300]);
  expect(readRows(foldChildSessions(sessions, { liveSessionIds: new Set(['child-1']) }))).toEqual([
    ['parent', 0, 'folded:1'],
    ['child-1', 1],
  ]);
  expect(readRows(foldChildSessions(sessions, { liveSessionIds: new Set(['child-1', 'child-2']) }))).toEqual([
    ['parent', 0],
    ['child-1', 1],
    ['child-2', 1],
  ]);
  expect(readRows(foldChildSessions(sessions, { liveSessionIds: new Set() }))).toEqual([
    ['parent', 0, 'folded:2'],
  ]);
});

test('an unfolded parent survives a re-render in which every child stops', () => {
  const expandedParentIds = new Set(['parent']);
  const expected = [
    ['parent', 0, 'unfolded'],
    ['child-1', 1],
    ['child-2', 1],
    ['child-3', 1],
  ];

  expect(readRows(foldChildSessions(createAgedFamily([2, 200, 900]), {
    expandedParentIds, liveSessionIds: new Set(['child-1']),
  }))).toEqual(expected);
  expect(readRows(foldChildSessions(createAgedFamily([30, 200, 900]), { expandedParentIds }))).toEqual(expected);
});

test('children that are not foldable always render', () => {
  const rows = foldChildSessions(createAgedFamily([100, 200]), {
    isFoldableChild: (session) => session.id === 'child-2',
  });

  expect(readRows(rows)).toEqual([
    ['parent', 0, 'folded:1'],
    ['child-1', 1],
  ]);
});

test('sessions with no children are left alone', () => {
  const rows = foldChildSessions(buildSessionTree(createSessions([
    { id: 'alone', lastActivity: minutesAgo(1) },
  ])));

  expect(readRows(rows)).toEqual([['alone', 0]]);
  expect(foldChildSessions([])).toEqual([]);
});

/** `[id, depth]` rows of a flattened tree, re-ordered by root. */
const orderLayout = (
  sessions: SessionWithProvider[],
  options: Parameters<typeof orderRootsByOwnActivity>[1] = {},
): Array<[string, number]> =>
  orderRootsByOwnActivity(
    sessions.map((session) => ({ session, depth: session.__depth ?? 0 })),
    options,
  ).map((row) => [String(row.session.id), row.depth]);

test('a stale root does not rise on the activity of children that fold away', () => {
  // The owner's "deprecated" secretary: six days old, 25 stopped workers that
  // wrote an hour ago. It used to rank by those workers and hold a place in the
  // project's top three; now it ranks by its own six days.
  const sessions = buildSessionTree(createSessions([
    { id: 'current', lastActivity: minutesAgo(1) },
    { id: 'deprecated', lastActivity: minutesAgo(6 * 24 * 60) },
    { id: 'old-worker-1', parentSessionId: 'deprecated', lastActivity: minutesAgo(50) },
    { id: 'old-worker-2', parentSessionId: 'deprecated', lastActivity: minutesAgo(60) },
    { id: 'tailscale', lastActivity: minutesAgo(2 * 24 * 60) },
  ]));
  expect(readLayout(sessions).map(([id]) => id)).toEqual(['current', 'deprecated', 'old-worker-1', 'old-worker-2', 'tailscale']);

  expect(orderLayout(sessions)).toEqual([
    ['current', 0],
    ['tailscale', 0],
    ['deprecated', 0],
    ['old-worker-1', 1],
    ['old-worker-2', 1],
  ]);
});

test('a live descendant lends its root its own activity, not "now"', () => {
  const sessions = buildSessionTree(createSessions([
    { id: 'recent', lastActivity: minutesAgo(10) },
    { id: 'old-parent', lastActivity: minutesAgo(5000) },
    { id: 'quiet-child', parentSessionId: 'old-parent', lastActivity: minutesAgo(4000) },
    { id: 'live-grandchild', parentSessionId: 'quiet-child', lastActivity: minutesAgo(1) },
    { id: 'old-live-root', lastActivity: minutesAgo(3000) },
  ]));

  // The live grandchild is drawn, so its minute-old write ranks its family
  // first; the root that is live itself keeps its own place and does not jump.
  expect(orderLayout(sessions, { liveSessionIds: new Set(['live-grandchild', 'old-live-root']) })).toEqual([
    ['old-parent', 0],
    ['quiet-child', 1],
    ['live-grandchild', 2],
    ['recent', 0],
    ['old-live-root', 0],
  ]);
});

test('a fork, which never folds, still lends its activity to its root', () => {
  const sessions = buildSessionTree(createSessions([
    { id: 'recent', lastActivity: minutesAgo(10) },
    { id: 'old-parent', lastActivity: minutesAgo(5000) },
    { id: 'fork', parentSessionId: 'old-parent', lastActivity: minutesAgo(1) },
  ]));

  expect(orderLayout(sessions, { isFoldableChild: (session) => session.id !== 'fork' })).toEqual([
    ['old-parent', 0],
    ['fork', 1],
    ['recent', 0],
  ]);
});

test('roots of equal rank keep the order they arrived in', () => {
  const sessions = buildSessionTree(createSessions([
    { id: 'a', lastActivity: minutesAgo(5) },
    { id: 'b', lastActivity: minutesAgo(5) },
    { id: 'c', lastActivity: minutesAgo(5) },
  ]));

  expect(orderLayout(sessions)).toEqual([['a', 0], ['b', 0], ['c', 0]]);
});
