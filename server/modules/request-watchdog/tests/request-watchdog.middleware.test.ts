import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createRequestWatchdog } from '../request-watchdog.middleware.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withApp(
  logs: string[],
  run: (baseUrl: string) => Promise<void>,
) {
  const app = express();
  app.use('/api', createRequestWatchdog({ thresholdMs: 50, log: (message) => logs.push(message) }));
  app.get('/api/fast', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/slow', (_req, res) => { setTimeout(() => res.json({ ok: true }), 120); });
  app.get('/api/never', () => { /* never answers */ });
  app.get('/api/stream', (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); });

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a prompt answer is never reported', async () => {
  const logs: string[] = [];
  await withApp(logs, async (baseUrl) => {
    await (await fetch(`${baseUrl}/api/fast`)).json();
    await sleep(100);
  });
  assert.deepEqual(logs, []);
});

test('a slow answer is reported once stalled and again when it lands', async () => {
  const logs: string[] = [];
  await withApp(logs, async (baseUrl) => {
    await (await fetch(`${baseUrl}/api/slow?token=secret`)).json();
  });
  assert.equal(logs.length, 2);
  assert.match(logs[0], /^\[http\] GET \/api\/slow still unanswered/);
  assert.match(logs[1], /^\[http\] GET \/api\/slow answered after/);
  // Query strings can carry the auth token and must never reach the log.
  assert.ok(logs.every((line) => !line.includes('secret')));
});

test('a request that never answers is named, and so is its abandonment', async () => {
  const logs: string[] = [];
  await withApp(logs, async (baseUrl) => {
    const request = http.get(`${baseUrl}/api/never`);
    request.on('error', () => {});
    await sleep(100);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /GET \/api\/never still unanswered/);
    request.destroy();
    await sleep(50);
  });
  assert.match(logs[1], /GET \/api\/never abandoned by the client/);
});

test('event streams are exempt', async () => {
  const logs: string[] = [];
  await withApp(logs, async (baseUrl) => {
    const request = http.get(`${baseUrl}/api/stream`, { headers: { Accept: 'text/event-stream' } });
    request.on('error', () => {});
    await sleep(100);
    request.destroy();
  });
  assert.deepEqual(logs, []);
});
