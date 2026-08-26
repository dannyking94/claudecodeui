import assert from 'node:assert/strict';
import test from 'node:test';

import type { SessionWithProvider } from '../types/types';

import { buildSessionTree, countSessionSubtreeRows } from './sessionTree';

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

test('a child whose parent lives in another project stays a top-level row', () => {
  // The normal case for a worker session: the spawning session is indexed
  // under a different repository, so it is absent from this project's list.
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
