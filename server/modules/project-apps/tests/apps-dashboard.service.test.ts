import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { createAppsDashboardClient } from '@/modules/project-apps/services/apps-dashboard.service.js';

// Shapes follow the fleet dashboard's real API: `/` embeds the action token,
// `/api/state` lists apps without repo/code_paths, `/api/action` needs the
// token header and answers 409 when it refuses.
const REGISTRY = JSON.stringify({
  apps: [
    {
      id: 'viewer', name: 'viewer', purpose: 'p', host: 'local', ports: [18001],
      health_url: 'http://127.0.0.1:18001/', links: ['http://192.0.2.1:18001/', 'http://192.0.2.1:18001/scene'],
      repo: '/work/robot-repo', workdir: '/work/robot-repo/tools', code_paths: ['tools/viewer'],
      runs: 'serve', started_by: 'secretary-a', pid_source: { kind: 'json-file', path: '/x' },
      commands: { start: ['bash', 's.sh', 'start'], stop: ['bash', 's.sh', 'stop'] },
      controls: 'full', controls_reason: 'own script',
    },
    {
      id: 'webui', name: 'web ui', purpose: 'q', host: 'local', ports: [18002], health_url: 'http://127.0.0.1:18002/',
      repo: '/work/webui', workdir: '/work/webui', runs: 'unit', pid_source: { kind: 'none' },
      commands: {}, controls: 'status-only', controls_reason: 'owner depends on it',
      also_in_projects: ['/work/secretary-a//'],
    },
  ],
});

type FakeDashboard = { baseUrl: string; actions: Array<{ app: string; action: string }>; rotateToken(): void; close(): Promise<void> };

async function startFakeDashboard(): Promise<FakeDashboard> {
  let token = 'token-1';
  const actions: Array<{ app: string; action: string }> = [];
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown, type = 'application/json') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/') return send(200, `<script>const TOKEN = "${token}";</script>`, 'text/html');
    if (req.method === 'GET' && req.url === '/api/state') {
      return send(200, { now: 1, apps: [
        { id: 'viewer', name: 'viewer', purpose: 'p', host: 'local', ports: [18001], links: ['http://192.0.2.1:18001/'],
          health_url: 'http://127.0.0.1:18001/', controls: 'full', controls_reason: 'own script', runs: 'serve',
          started_by: 'secretary-a', note: '', workdir: '/work/robot-repo/tools', commands: { start: ['bash'] },
          pid_kind: 'json-file', up: true, code: 200, ms: 12.5, error: null, pids: [42], uptime_s: 60,
          ownership: { detail: 'recorded PID 42 alive' }, connections: 1, last_opened: 1700000000,
          git: { branch: 'main', head: 'abc', stale: true, reasons: ['newer commits'] }, missing_scripts: [],
          also_in_projects: ['/home/dk-ai-1/', '/home/dk-ai-1', 'relative/path', 7, null, '  '] },
        { id: 'webui', name: 'web ui', up: false, error: 'refused', ports: [18002], controls: 'status-only', workdir: '/work/webui' },
      ] });
    }
    if (req.method === 'GET' && req.url === '/api/log') {
      return send(200, [
        { ts: '2026-01-01 10:00:00', app: 'viewer', action: 'stop', who: '127.0.0.1', exit: 0, steps: ['ports free'], output_tail: 'ok' },
        { ts: '2026-01-01 09:00:00', app: 'webui', action: 'start', who: '127.0.0.1', refused: 'status-only', exit: null, steps: [] },
      ]);
    }
    if (req.method === 'POST' && req.url === '/api/action') {
      if (req.headers['x-app-dashboard'] !== token) return send(403, { error: 'missing or wrong X-App-Dashboard token' });
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = JSON.parse(raw) as { app: string; action: string };
        actions.push(body);
        if (body.app === 'webui') return send(409, { error: 'webui is status-only: owner depends on it' });
        return send(200, { app: body.app, action: body.action, exit: 0, steps: ['stop: ok', 'health UP'],
          output_tail: '$ bash s.sh start\nstarted', health_after: { up: true } });
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    actions,
    rotateToken: () => { token = `${token}x`; },
    close: () => new Promise((resolve) => { server.close(() => resolve()); }),
  };
}

const registryReader = (files: Record<string, string>) => async (filePath: string) => {
  if (!(filePath in files)) throw new Error('ENOENT');
  return files[filePath];
};

test('snapshot comes from the dashboard, with repo/code_paths merged from the registry', async () => {
  const fake = await startFakeDashboard();
  try {
    const client = createAppsDashboardClient({ baseUrl: fake.baseUrl, registryPaths: ['/reg.json'], readText: registryReader({ '/reg.json': REGISTRY }) });
    const snapshot = await client.getSnapshot();
    assert.equal(snapshot.source, 'dashboard');
    assert.equal(snapshot.error, null);
    const viewer = snapshot.apps.find((a) => a.id === 'viewer');
    assert.equal(viewer?.status, 'up');
    assert.equal(viewer?.latencyMs, 12.5);
    assert.equal(viewer?.repo, '/work/robot-repo');
    assert.deepEqual(viewer?.codePaths, ['tools/viewer']);
    assert.equal(viewer?.git?.stale, true);
    assert.equal(viewer?.lastOpened, 1700000000);
    const webui = snapshot.apps.find((a) => a.id === 'webui');
    assert.equal(webui?.status, 'down');
    assert.equal(webui?.controls, 'status-only');
    // also_in_projects: absolute strings only, trailing slashes trimmed, deduplicated;
    // from the state when it carries the field, else from the registry entry.
    assert.deepEqual(viewer?.alsoInProjects, ['/home/dk-ai-1']);
    assert.deepEqual(webui?.alsoInProjects, ['/work/secretary-a']);
  } finally {
    await fake.close();
  }
});

test('when the dashboard is down the registry is read and every app is unknown', async () => {
  const fake = await startFakeDashboard();
  const deadUrl = fake.baseUrl;
  await fake.close();
  const client = createAppsDashboardClient({ baseUrl: deadUrl, registryPaths: ['/reg.json'], readText: registryReader({ '/reg.json': REGISTRY }) });
  const snapshot = await client.getSnapshot();
  assert.equal(snapshot.source, 'registry');
  assert.match(snapshot.error ?? '', /unreachable/);
  assert.deepEqual(snapshot.apps.map((a) => [a.id, a.status]), [['viewer', 'unknown'], ['webui', 'unknown']]);
  assert.equal(snapshot.apps[0].repo, '/work/robot-repo');
  assert.deepEqual(snapshot.apps[0].links, ['http://192.0.2.1:18001/', 'http://192.0.2.1:18001/scene']);
  assert.deepEqual(snapshot.apps.map((a) => a.alsoInProjects), [[], ['/work/secretary-a']]);
});

test('with neither dashboard nor registry the snapshot is empty and says why', async () => {
  const client = createAppsDashboardClient({
    baseUrl: 'http://127.0.0.1:9',
    registryPaths: [],
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
  });
  const snapshot = await client.getSnapshot();
  assert.equal(snapshot.source, 'none');
  assert.deepEqual(snapshot.apps, []);
  assert.match(snapshot.error ?? '', /no registry file configured/);
});

test('runAction scrapes the page token, posts the action and re-fetches a rotated token once', async () => {
  const fake = await startFakeDashboard();
  try {
    const client = createAppsDashboardClient({ baseUrl: fake.baseUrl, registryPaths: [] });
    const started = await client.runAction('viewer', 'start');
    assert.equal(started.refused, null);
    assert.equal(started.exit, 0);
    assert.equal(started.upAfter, true);
    assert.deepEqual(started.steps, ['stop: ok', 'health UP']);

    fake.rotateToken();
    const stopped = await client.runAction('viewer', 'stop');
    assert.equal(stopped.exit, 0);
    // The stale-token attempt was refused before it reached the action log.
    assert.deepEqual(fake.actions, [{ app: 'viewer', action: 'start' }, { app: 'viewer', action: 'stop' }]);
  } finally {
    await fake.close();
  }
});

test('a refusal from the dashboard is returned, not thrown', async () => {
  const fake = await startFakeDashboard();
  try {
    const client = createAppsDashboardClient({ baseUrl: fake.baseUrl, registryPaths: [] });
    const result = await client.runAction('webui', 'restart');
    assert.match(result.refused ?? '', /status-only/);
    assert.equal(result.exit, null);
  } finally {
    await fake.close();
  }
});

test('runAction against an unreachable dashboard is a 503', async () => {
  const client = createAppsDashboardClient({ baseUrl: 'http://127.0.0.1:9', registryPaths: [], fetchImpl: async () => { throw new Error('down'); } });
  await assert.rejects(client.runAction('viewer', 'stop'), (error: { statusCode?: number }) => error.statusCode === 503);
});

test('getLog returns only the requested app, newest first as the dashboard sends it', async () => {
  const fake = await startFakeDashboard();
  try {
    const client = createAppsDashboardClient({ baseUrl: fake.baseUrl, registryPaths: [] });
    const log = await client.getLog('viewer');
    assert.equal(log.length, 1);
    assert.equal(log[0].action, 'stop');
    assert.equal(log[0].outputTail, 'ok');
  } finally {
    await fake.close();
  }
});
