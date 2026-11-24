import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProjectAppsView } from '@/modules/project-apps/services/project-apps-view.service.js';
import type { ProjectAppRecord } from '@/shared/types.js';

const record = (id: string, repo: string, ports: number[]): ProjectAppRecord => ({
  id, name: id, purpose: '', host: 'local', ports, links: [], healthUrl: '', controls: 'full', controlsReason: '',
  startedBy: '', note: '', runs: '', repo, workdir: repo, codePaths: [], status: 'up', latencyMs: 1, error: null,
  pids: [], uptimeSeconds: null, lastOpened: null, connections: null, ownershipDetail: null, git: null,
  commands: {}, missingScripts: [],
});

test('the view keeps this project\'s apps and passes every registered port to the chat scan', async () => {
  let seenPorts: number[] = [];
  const view = await buildProjectAppsView('/work/robot-repo', {
    getSnapshot: async () => ({ source: 'dashboard', checkedAt: 5, error: null, apps: [record('a', '/work/robot-repo', [1]), record('b', '/work/webui', [2])] }),
    listProjectPaths: () => ['/work/robot-repo', '/work/webui'],
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
    listProjectPaths: () => ['/work/robot-repo'],
    listProjectTranscripts: () => { throw new Error('db locked'); },
    collectChatLinks: async () => [],
  });
  assert.equal(view.apps.length, 1);
  assert.deepEqual(view.chatLinks, []);
  assert.equal(view.source, 'registry');
});
