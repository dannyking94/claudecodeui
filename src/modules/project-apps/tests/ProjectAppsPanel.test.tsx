import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { ProjectApp, ProjectAppsView } from '@/shared/types';

const view = vi.fn();
const all = vi.fn();
const action = vi.fn();
const log = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { projectApps: { view: (id: string) => view(id), all: () => all(), action: (a: string, b: string) => action(a, b), log: (a: string) => log(a) } },
  readApiJson: async (response: { ok: boolean; json: () => Promise<unknown> }) => {
    const body = await response.json() as { error?: string };
    if (!response.ok) throw new Error(body.error ?? 'failed');
    return body;
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string } & Record<string, unknown>) => {
      let text = options?.defaultValue ?? key;
      for (const [name, value] of Object.entries(options ?? {})) text = text.replace(`{{${name}}}`, String(value));
      return text;
    },
  }),
}));

const app = (overrides: Partial<ProjectApp>): ProjectApp => ({
  id: 'viewer', name: 'Viewer', purpose: 'shows the scene', host: 'local', ports: [18001],
  links: ['http://192.0.2.1:18001/', 'http://192.0.2.1:18001/scene'], healthUrl: 'http://127.0.0.1:18001/',
  controls: 'full', controlsReason: 'own script', startedBy: 'secretary-a (serve.sh start)', note: '', runs: '',
  repo: '/work/robot-repo', workdir: '/work/robot-repo', codePaths: [], status: 'up', latencyMs: 18.2, error: null,
  pids: [42], uptimeSeconds: 60, lastOpened: null, connections: 0, ownershipDetail: null, git: null,
  commands: {}, missingScripts: [], alsoInProjects: [], matchedBy: 'path',
  ...overrides,
});

const VIEW: ProjectAppsView = {
  projectPath: '/work/robot-repo',
  source: 'dashboard',
  checkedAt: Date.now(),
  error: null,
  apps: [
    app({}),
    app({ id: 'editor', name: 'Editor', status: 'down', latencyMs: null, ports: [18002], links: ['http://192.0.2.1:18002/'] }),
    app({ id: 'webui', name: 'Web UI', controls: 'status-only', ports: [18003], links: [] }),
  ],
  chatLinks: [{
    origin: 'http://192.0.2.9:18812', url: 'http://192.0.2.9:18812/report.html', port: 18812, paths: ['/report.html'],
    sessionId: 's1', sessionName: 'eval worker', provider: 'claude', mentionedAt: new Date().toISOString(), mentions: 1,
  }],
};

const ok = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) });

beforeEach(() => {
  view.mockReset().mockResolvedValue(ok(VIEW));
  action.mockReset().mockResolvedValue(ok({ app: 'viewer', action: 'stop', refused: null, exit: 0, steps: ['ports free', 'health still DOWN after 45s'], outputTail: '', upAfter: false }));
  log.mockReset().mockResolvedValue(ok([]));
  all.mockReset().mockResolvedValue(ok({
    source: 'dashboard', checkedAt: Date.now(), error: null,
    apps: [
      { ...app({}), projectId: 'p1', projectPath: '/work/robot-repo', projectName: 'robot' },
      { ...app({ id: 'tray', name: 'Tray editor', controls: 'status-only', ports: [8802] }), projectId: 'p2', projectPath: '/work/pick-and-place', projectName: 'pick-and-place' },
      { ...app({ id: 'stray', name: 'Stray', ports: [9] }), matchedBy: null, projectId: null, projectPath: null, projectName: null },
    ],
  }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function renderPanel(onOpenSession = vi.fn(), onOpenProject = vi.fn()) {
  const { ProjectAppsPanel } = await import('@/modules/project-apps/ProjectAppsPanel');
  render(
    <ProjectAppsPanel
      selectedProject={{ projectId: 'p1', displayName: 'robot', fullPath: '/work/robot-repo' }}
      onOpenSession={onOpenSession}
      onOpenProject={onOpenProject}
    />,
  );
  await screen.findByTestId('app-card-viewer');
  return onOpenSession;
}

test('the header counts live apps and names the down ones; down apps sort first', async () => {
  await renderPanel();
  assert.ok(screen.getByText(/2\/3 live/));
  assert.ok(screen.getByText(/1 down: Editor/));
  const cards = screen.getAllByRole('article').map((card) => card.getAttribute('data-testid'));
  assert.equal(cards[0], 'app-card-editor');
  assert.equal(view.mock.calls[0][0], 'p1');
});

test('cards show sub-path chips and only offer the actions that fit the status', async () => {
  await renderPanel();
  const viewer = screen.getByTestId('app-card-viewer');
  assert.ok(viewer.textContent?.includes('/scene'));
  assert.ok(viewer.textContent?.includes('live · 18ms'));
  assert.equal(viewer.querySelector('[aria-label="Start"]'), null);
  assert.ok(viewer.querySelector('[aria-label="Stop"]'));
  const editor = screen.getByTestId('app-card-editor');
  assert.ok(editor.querySelector('[aria-label="Start"]'));
  assert.equal(editor.querySelector('[aria-label="Stop"]'), null);
  // status-only apps get no manage buttons at all
  assert.equal(screen.getByTestId('app-card-webui').querySelector('[aria-label="Restart"]'), null);
});

test('stop asks first, then posts through the proxy and shows the outcome', async () => {
  await renderPanel();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  const stop = screen.getByTestId('app-card-viewer').querySelector('[aria-label="Stop"]') as HTMLButtonElement;
  fireEvent.click(stop);
  assert.equal(action.mock.calls.length, 0);
  await act(async () => { fireEvent.click(stop); });
  await waitFor(() => assert.deepEqual(action.mock.calls[0], ['viewer', 'stop']));
  assert.equal(confirm.mock.calls.length, 2);
  await screen.findByText(/stop: health still DOWN/);
});

test('chat links render as their own cards and open their session', async () => {
  const onOpenSession = await renderPanel();
  const card = screen.getByTestId('chat-link-card');
  assert.ok(card.textContent?.includes('192.0.2.9:18812'));
  fireEvent.click(screen.getByText('eval worker'));
  assert.deepEqual(onOpenSession.mock.calls[0], ['s1']);
});

test('the filter narrows both sections', async () => {
  await renderPanel();
  fireEvent.change(screen.getByPlaceholderText('Filter…'), { target: { value: 'editor' } });
  assert.equal(screen.queryByTestId('app-card-viewer'), null);
  assert.ok(screen.getByTestId('app-card-editor'));
  assert.equal(screen.queryByTestId('chat-link-card'), null);
});

test('a registry fallback says start/stop is unavailable', async () => {
  view.mockResolvedValue(ok({ ...VIEW, source: 'registry', error: 'dashboard unreachable', apps: VIEW.apps.map((a) => ({ ...a, status: 'unknown' })) }));
  await renderPanel();
  assert.ok(screen.getByText(/dashboard is unreachable/));
  assert.ok(screen.getByText(/from apps.json/));
});

test('"All projects" lists every app grouped by project, this one first and unclaimed apps last', async () => {
  const onOpenProject = vi.fn();
  await renderPanel(vi.fn(), onOpenProject);
  await act(async () => { fireEvent.click(screen.getByText('All projects')); });
  await screen.findByTestId('app-card-tray');
  const groups = screen.getAllByTestId('project-apps-group').map((group) => group.textContent ?? '');
  assert.equal(groups.length, 3);
  assert.ok(groups[0].startsWith('robot'));
  assert.ok(groups[1].startsWith('pick-and-place'));
  assert.ok(groups[2].startsWith('No project'));
  // No chat-link scan across projects, and no request for this project's view after the switch.
  assert.equal(screen.queryByTestId('chat-link-card'), null);
  assert.equal(all.mock.calls.length, 1);
  // Only another project's group offers to open it.
  const openButtons = screen.getAllByText('Open project');
  assert.equal(openButtons.length, 1);
  fireEvent.click(openButtons[0]);
  assert.equal(onOpenProject.mock.calls[0][0].projectId, 'p2');
});

test('the filter in "All projects" also matches the project name', async () => {
  await renderPanel();
  await act(async () => { fireEvent.click(screen.getByText('All projects')); });
  await screen.findByTestId('app-card-tray');
  fireEvent.change(screen.getByPlaceholderText('Filter…'), { target: { value: 'pick-and' } });
  assert.ok(screen.getByTestId('app-card-tray'));
  assert.equal(screen.queryByTestId('app-card-viewer'), null);
});

test('an empty project points to the all-projects scope', async () => {
  view.mockResolvedValue(ok({ ...VIEW, apps: [], chatLinks: [] }));
  const { ProjectAppsPanel } = await import('@/modules/project-apps/ProjectAppsPanel');
  render(<ProjectAppsPanel selectedProject={{ projectId: 'p1', displayName: 'robot', fullPath: '/work/robot-repo' }} onOpenSession={vi.fn()} onOpenProject={vi.fn()} />);
  const link = await screen.findByText('Show apps of all projects');
  await act(async () => { fireEvent.click(link); });
  await screen.findByTestId('app-card-tray');
});

test('an app listed here via also_in_projects says so and links to its owning project', async () => {
  const tray = app({
    id: 'tray', name: 'Tray editor', controls: 'status-only', ports: [8802], repo: '/work/pick-and-place', workdir: '/work/pick-and-place',
    alsoInProjects: ['/work/robot-repo'], matchedBy: 'also',
    ownerProject: { projectId: 'p2', projectPath: '/work/pick-and-place', displayName: 'pick-and-place' },
  });
  view.mockResolvedValue(ok({ ...VIEW, apps: [...VIEW.apps, tray] }));
  const onOpenProject = vi.fn();
  await renderPanel(vi.fn(), onOpenProject);
  const hint = await screen.findByTestId('app-also-hint');
  assert.ok(screen.getByTestId('app-card-tray').contains(hint));
  assert.match(hint.textContent ?? '', /also listed here/);
  // Only the `also` card carries the hint; the project's own apps do not.
  assert.equal(screen.getAllByTestId('app-also-hint').length, 1);
  fireEvent.click(screen.getByText(/pick-and-place/));
  assert.equal(onOpenProject.mock.calls[0][0].projectId, 'p2');
  assert.equal(onOpenProject.mock.calls[0][0].fullPath, '/work/pick-and-place');
});
