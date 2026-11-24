import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAllProjectAppsView, buildProjectAppsView } from '@/modules/project-apps/services/project-apps-view.service.js';
import type { ProjectAppRecord } from '@/shared/types.js';

const record = (id: string, repo: string, ports: number[]): ProjectAppRecord => ({
  id, name: id, purpose: '', host: 'local', ports, links: [], healthUrl: '', controls: 'full', controlsReason: '',
  startedBy: '', note: '', runs: '', repo, workdir: repo, codePaths: [], status: 'up', latencyMs: 1, error: null,
  pids: [], uptimeSeconds: null, lastOpened: null, connections: null, ownershipDetail: null, git: null,
  commands: {}, missingScripts: [], alsoInProjects: [],
});

/** Project refs for paths, the id being the folder name. */
const refs = (paths: string[]) => paths.map((projectPath) => ({ projectId: projectPath.split('/').filter(Boolean).pop() ?? '/', projectPath, displayName: projectPath }));

test('the view keeps this project\'s apps and passes every registered port to the chat scan', async () => {
  let seenPorts: number[] = [];
  const view = await buildProjectAppsView('/work/robot-repo', {
    getSnapshot: async () => ({ source: 'dashboard', checkedAt: 5, error: null, apps: [record('a', '/work/robot-repo', [1]), record('b', '/work/webui', [2])] }),
    listProjects: () => refs(['/work/robot-repo', '/work/webui']),
    listProjectTranscripts: () => [],
    collectChatLinks: async (_transcripts, ports) => {
      seenPorts = [...ports];
      return [];
    },
  });
  assert.deepEqual(view.apps.map((a) => a.id), ['a']);
  assert.deepEqual(seenPorts.sort(), [1, 2]);
  assert.equal(view.checkedAt, 5);
});

test('a failing chat scan still returns the registry apps', async () => {
  const view = await buildProjectAppsView('/work/robot-repo', {
    getSnapshot: async () => ({ source: 'registry', checkedAt: 5, error: 'dashboard unreachable', apps: [record('a', '/work/robot-repo', [1])] }),
    listProjects: () => refs(['/work/robot-repo']),
    listProjectTranscripts: () => { throw new Error('db locked'); },
    collectChatLinks: async () => [],
  });
  assert.equal(view.apps.length, 1);
  assert.deepEqual(view.chatLinks, []);
  assert.equal(view.source, 'registry');
});

test('a status-only page that shares another app\'s port still shows under its repo\'s project', async () => {
  // The owner's 2026-11-24 case: tray-grasp-editor is a page of shelf-app's
  // server, registered status-only with `shares_port_with` and no PID of its
  // own, and the state names only its workdir. Both must land in the repo.
  const tray = { ...record('tray-grasp-editor', '/work/pnp', [8802]), controls: 'status-only' as const, startedBy: 'secretary dk-ai-1' };
  const shelf = record('shelf-app', '/work/pnp', [8802]);
  const view = await buildProjectAppsView('/work/pnp', {
    getSnapshot: async () => ({ source: 'dashboard', checkedAt: 1, error: null, apps: [shelf, tray] }),
    listProjects: () => refs(['/work', '/work/pnp', '/home/dk-ai-1']),
    listProjectTranscripts: () => [],
    collectChatLinks: async () => [],
  });
  assert.deepEqual(view.apps.map((a) => [a.id, a.matchedBy]), [['shelf-app', 'path'], ['tray-grasp-editor', 'path']]);
});

test('the all-projects view lists every app once, tagged with its project or with nulls', async () => {
  const view = await buildAllProjectAppsView({
    getSnapshot: async () => ({
      source: 'dashboard', checkedAt: 7, error: null,
      apps: [record('a', '/work/robot-repo/tools', [1]), record('b', '/work/webui/', [2]), record('orphan', '/elsewhere', [3])],
    }),
    listProjects: () => [
      { projectId: 'p-work', projectPath: '/work', displayName: 'work' },
      { projectId: 'p-robot', projectPath: '/work/robot-repo/', displayName: 'robot' },
      { projectId: 'p-web', projectPath: '/work/webui', displayName: 'web ui' },
    ],
  });
  assert.equal(view.checkedAt, 7);
  assert.deepEqual(
    view.apps.map((a) => [a.id, a.projectId, a.projectName, a.matchedBy]),
    [['a', 'p-robot', 'robot', 'path'], ['b', 'p-web', 'web ui', 'path'], ['orphan', null, null, null]],
  );
});

test('an app listing this project in also_in_projects shows here as `also`, linking to its owner', async () => {
  // The owner's 2026-11-24 ask: the tray editor, owned by the pick-and-place
  // repo, also shown in the secretary's project. Its owner still lists it.
  const tray = { ...record('tray-grasp-editor', '/work/pnp', [8802]), alsoInProjects: ['/home/dk-ai-1/'] };
  const other = record('shelf-app', '/work/pnp', [8803]);
  const deps = {
    getSnapshot: async () => ({ source: 'dashboard' as const, checkedAt: 1, error: null, apps: [other, tray] }),
    listProjects: () => refs(['/work/pnp', '/home/dk-ai-1']),
    listProjectTranscripts: () => [],
    collectChatLinks: async () => [],
  };
  const secretary = await buildProjectAppsView('/home/dk-ai-1', deps);
  assert.deepEqual(secretary.apps.map((a) => [a.id, a.matchedBy, a.ownerProject?.projectId]), [['tray-grasp-editor', 'also', 'pnp']]);

  const owner = await buildProjectAppsView('/work/pnp', deps);
  assert.deepEqual(owner.apps.map((a) => [a.id, a.matchedBy, a.ownerProject]), [['shelf-app', 'path', null], ['tray-grasp-editor', 'path', null]]);

  const all = await buildAllProjectAppsView({ getSnapshot: deps.getSnapshot, listProjects: deps.listProjects });
  assert.deepEqual(all.apps.map((a) => [a.id, a.projectId, a.matchedBy]), [['shelf-app', 'pnp', 'path'], ['tray-grasp-editor', 'pnp', 'path']]);
});
