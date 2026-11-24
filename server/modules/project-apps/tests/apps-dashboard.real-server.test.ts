import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAppsDashboardClient } from '@/modules/project-apps/services/apps-dashboard.service.js';

/**
 * Opt-in contract test against the real fleet dashboard code: set
 * APPS_DASHBOARD_SERVER to its `server.py` (dummy_app.py must sit beside it).
 * It starts a scratch dashboard on a free port with a one-app registry whose
 * app is the dashboard's own dummy server, then starts and stops it through
 * cloudcli's client. Nothing registered on the machine is touched.
 */
const SERVER_PY = process.env.APPS_DASHBOARD_SERVER;

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate().catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

test('start and stop a dummy app through a real dashboard', { skip: !SERVER_PY && 'APPS_DASHBOARD_SERVER not set', timeout: 120_000 }, async () => {
  const serverPy = SERVER_PY as string;
  const dir = await mkdtemp(path.join(tmpdir(), 'apps-dashboard-'));
  const [dashboardPort, appPort] = [await freePort(), await freePort()];
  const appDir = path.join(dir, 'dummy');
  const dummy = path.join(path.dirname(serverPy), 'dummy_app.py');
  const registryPath = path.join(dir, 'apps.json');
  const command = (action: string) => ['python3', dummy, action, '--port', String(appPort), '--dir', appDir];
  await writeFile(registryPath, JSON.stringify({
    apps: [{
      id: 'dummy', name: 'dummy', purpose: 'test target', host: 'local', ports: [appPort],
      health_url: `http://127.0.0.1:${appPort}/`, links: [`http://127.0.0.1:${appPort}/`],
      repo: dir, workdir: dir, runs: 'dummy_app.py', started_by: 'test',
      pid_source: { kind: 'json-file', path: path.join(appDir, 'server.json') },
      commands: { status: command('status'), start: command('start'), stop: command('stop') },
      controls: 'full', controls_reason: 'test', start_waits_for_time_wait: false,
    }],
  }));

  // DK_DASHBOARD_SCOPE=0 keeps the dummy in this test's process tree instead of a systemd scope.
  const dashboard = spawn('python3', [serverPy, 'serve', '--host', '127.0.0.1', '--port', String(dashboardPort),
    '--registry', registryPath, '--state-dir', path.join(dir, 'state'), '--no-robot'], {
    env: { ...process.env, DK_DASHBOARD_SCOPE: '0' },
    stdio: 'ignore',
  });
  const baseUrl = `http://127.0.0.1:${dashboardPort}`;
  const client = createAppsDashboardClient({ baseUrl, registryPaths: [registryPath] });
  try {
    assert.ok(await waitFor(async () => (await fetch(`${baseUrl}/api/health`)).ok, 15_000), 'dashboard did not come up');

    const before = await client.getSnapshot();
    assert.equal(before.source, 'dashboard');
    assert.equal(before.apps[0].status, 'down');
    assert.equal(before.apps[0].repo, dir);

    const started = await client.runAction('dummy', 'start');
    assert.equal(started.refused, null, started.steps.join('\n'));
    assert.equal(started.upAfter, true);
    assert.equal((await client.getSnapshot()).apps[0].status, 'up');

    const stopped = await client.runAction('dummy', 'stop');
    assert.equal(stopped.refused, null, stopped.steps.join('\n'));
    assert.equal(stopped.upAfter, false);

    const log = await client.getLog('dummy');
    assert.deepEqual(log.map((entry) => entry.action), ['stop', 'start']);
  } finally {
    // Stop the dummy if an assertion left it up (its own script stops only its saved PID).
    await client.runAction('dummy', 'stop').catch(() => undefined);
    dashboard.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  }
});
