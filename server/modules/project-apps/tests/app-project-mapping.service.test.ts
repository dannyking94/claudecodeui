import assert from 'node:assert/strict';
import test from 'node:test';

import { findAppProject, selectProjectApps } from '@/modules/project-apps/services/app-project-mapping.service.js';

const app = (overrides: Partial<{ id: string; repo: string; workdir: string; codePaths: string[]; startedBy: string }>) => ({
  id: 'viewer',
  repo: '/work/robot-repo',
  workdir: '/work/robot-repo',
  codePaths: [] as string[],
  startedBy: '',
  ...overrides,
});

const PROJECTS = ['/work', '/work/robot-repo', '/work/secretary-a', '/work/secretary-b', '/work/webui'];

test('an app belongs to the project containing its repo, not the session that started it', () => {
  const assignment = findAppProject(app({ startedBy: 'secretary secretary-a (serve.sh start)' }), PROJECTS);
  assert.deepEqual(assignment, { projectPath: '/work/robot-repo', matchedBy: 'path' });
});

test('the most specific project wins over a parent folder project', () => {
  assert.equal(findAppProject(app({}), ['/work', '/work/robot-repo'])?.projectPath, '/work/robot-repo');
  assert.equal(findAppProject(app({}), ['/work'])?.projectPath, '/work');
});

test('a workdir or code path inside a sub-project places the app there', () => {
  const withSubdir = app({ workdir: '/work/robot-repo/real/console' });
  assert.equal(findAppProject(withSubdir, [...PROJECTS, '/work/robot-repo/real/console'])?.projectPath, '/work/robot-repo/real/console');
  const withCodePath = app({ workdir: '/remote/elsewhere', codePaths: ['tools/viewer'] });
  assert.equal(findAppProject(withCodePath, ['/work/robot-repo/tools'])?.projectPath, '/work/robot-repo/tools');
});

test('a remote workdir still maps by repo', () => {
  const remote = app({ workdir: '/home/robot/app/repo/real' });
  assert.equal(findAppProject(remote, PROJECTS)?.projectPath, '/work/robot-repo');
});

test('a sibling folder sharing a name prefix does not match', () => {
  assert.equal(findAppProject(app({ repo: '/work/webui-old', workdir: '/work/webui-old' }), ['/work/webui']), null);
});

test('with no path match the project named in started_by takes it', () => {
  const orphan = app({ repo: '/srv/other', workdir: '/srv/other', startedBy: 'secretary secretary-b, relaunched' });
  assert.deepEqual(findAppProject(orphan, PROJECTS), { projectPath: '/work/secretary-b', matchedBy: 'started-by' });
  // Whole words only: "secretary-a" must not match inside "secretary-ab".
  assert.equal(findAppProject(app({ repo: '/srv/x', workdir: '/srv/x', startedBy: 'secretary-ab' }), ['/work/secretary-a']), null);
});

test('an app matching nothing is in no project', () => {
  assert.equal(findAppProject(app({ repo: '/srv/x', workdir: '/srv/x', startedBy: 'unknown owner' }), PROJECTS), null);
});

test('the root project only matches exactly', () => {
  assert.equal(findAppProject(app({}), ['/']), null);
});

test('selectProjectApps keeps only the apps whose home is the requested project', () => {
  const apps = [
    app({ id: 'a' }),
    app({ id: 'b', repo: '/work/webui', workdir: '/work/webui' }),
    app({ id: 'c', repo: '/srv/x', workdir: '/srv/x', startedBy: 'worker of secretary-a' }),
  ];
  assert.deepEqual(selectProjectApps(apps, '/work/robot-repo', PROJECTS).map((a) => a.id), ['a']);
  assert.deepEqual(selectProjectApps(apps, '/work/secretary-a', PROJECTS).map((a) => [a.id, a.matchedBy]), [['c', 'started-by']]);
  // The parent folder project gets none of them: each has a more specific home.
  assert.deepEqual(selectProjectApps(apps, '/work', PROJECTS), []);
});
