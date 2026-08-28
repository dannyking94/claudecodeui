import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../../../types/app';
import type { SessionWithProvider } from '../types/types';

import {
  buildSessionTree,
  countSessionSubtreeRows,
  groupSessionsByRootProject,
  type ProjectSessions,
} from './sessionTree';

type SessionFixture = {
  id: string;
  parentSessionId?: string | null;
  parentSummary?: string | null;
  parentProjectPath?: string | null;
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
