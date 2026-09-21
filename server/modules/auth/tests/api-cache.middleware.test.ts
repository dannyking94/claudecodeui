import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { preventApiResponseStorage } from '../api-cache.middleware.js';

test('API success, errors and revalidation prohibit storage without changing static caching', async () => {
  const app = express();
  app.use('/api', preventApiResponseStorage);
  app.get('/api/projects', (_req, res) => res.json({ projects: [] }));
  app.get('/api/protected', (_req, res) => res.status(401).json({ error: 'no-token' }));
  app.get('/asset.js', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send('asset');
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${baseUrl}/api/projects`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const revalidated = await fetch(`${baseUrl}/api/projects`, {
      headers: { 'If-None-Match': response.headers.get('etag')! },
    });
    assert.equal(revalidated.headers.get('cache-control'), 'no-store');
    const denied = await fetch(`${baseUrl}/api/protected`);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    const asset = await fetch(`${baseUrl}/asset.js`);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
