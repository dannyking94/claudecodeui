import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import express from 'express';

import { compressJsonResponses, createCompressedAssetHandler } from '../http-compression.middleware.js';

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

// fetch() decodes transparently; a raw request shows what went over the wire.
function rawRequest(
  baseUrl: string,
  urlPath: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request(`${baseUrl}${urlPath}`, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function withServer(app: express.Express, run: (baseUrl: string) => Promise<void>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

const largePayload = { messages: Array.from({ length: 200 }, (_, index) => ({ id: `m${index}`, content: 'hello world '.repeat(5) })) };

test('compresses large JSON bodies with the best accepted encoding and keeps ETag revalidation', async () => {
  const app = express();
  app.use(compressJsonResponses);
  app.get('/large', (_req, res) => res.json(largePayload));
  app.get('/small', (_req, res) => res.json({ ok: true }));

  await withServer(app, async (baseUrl) => {
    const gzipped = await rawRequest(baseUrl, '/large', { 'Accept-Encoding': 'gzip, deflate' });
    assert.equal(gzipped.headers['content-encoding'], 'gzip');
    assert.match(String(gzipped.headers.vary), /Accept-Encoding/);
    assert.match(String(gzipped.headers['content-type']), /application\/json/);
    assert.deepEqual(JSON.parse(zlib.gunzipSync(gzipped.body).toString()), largePayload);

    const brotli = await rawRequest(baseUrl, '/large', { 'Accept-Encoding': 'gzip, br' });
    assert.equal(brotli.headers['content-encoding'], 'br');
    assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(brotli.body).toString()), largePayload);

    const revalidated = await rawRequest(baseUrl, '/large', {
      'Accept-Encoding': 'gzip',
      'If-None-Match': String(gzipped.headers.etag),
    });
    assert.equal(revalidated.status, 304);

    const small = await rawRequest(baseUrl, '/small', { 'Accept-Encoding': 'gzip' });
    assert.equal(small.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(small.body.toString()), { ok: true });

    const identity = await rawRequest(baseUrl, '/large', { 'Accept-Encoding': 'gzip;q=0, identity' });
    assert.equal(identity.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(identity.body.toString()), largePayload);
  });
});

test('serves hashed assets compressed and falls through for anything else', async () => {
  const assetsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'http-compression-'));
  const script = `export const value = ${JSON.stringify('x'.repeat(4000))};\n`;
  fs.writeFileSync(path.join(assetsDirectory, 'index-abc123.js'), script);
  fs.writeFileSync(path.join(assetsDirectory, 'tiny-abc123.js'), 'export {};\n');

  const app = express();
  app.use('/assets', createCompressedAssetHandler(assetsDirectory));
  app.use('/assets', express.static(assetsDirectory));

  try {
    await withServer(app, async (baseUrl) => {
      const first = await rawRequest(baseUrl, '/assets/index-abc123.js', { 'Accept-Encoding': 'gzip' });
      assert.equal(first.status, 200);
      assert.equal(first.headers['content-encoding'], 'gzip');
      assert.equal(first.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.match(String(first.headers['content-type']), /javascript/);
      assert.equal(zlib.gunzipSync(first.body).toString(), script);

      const cached = await rawRequest(baseUrl, '/assets/index-abc123.js', { 'Accept-Encoding': 'gzip' });
      assert.deepEqual(cached.body, first.body);

      const head = await rawRequest(baseUrl, '/assets/index-abc123.js', { 'Accept-Encoding': 'gzip' }, 'HEAD');
      assert.equal(head.headers['content-length'], String(first.body.length));
      assert.equal(head.body.length, 0);

      const uncompressed = await rawRequest(baseUrl, '/assets/index-abc123.js');
      assert.equal(uncompressed.headers['content-encoding'], undefined);
      assert.equal(uncompressed.body.toString(), script);

      const tiny = await rawRequest(baseUrl, '/assets/tiny-abc123.js', { 'Accept-Encoding': 'gzip' });
      assert.equal(tiny.headers['content-encoding'], undefined);

      const missing = await rawRequest(baseUrl, '/assets/missing-abc123.js', { 'Accept-Encoding': 'gzip' });
      assert.equal(missing.status, 404);

      const traversal = await rawRequest(baseUrl, '/assets/..%2Fpasswd.js', { 'Accept-Encoding': 'gzip' });
      assert.notEqual(traversal.headers['content-encoding'], 'gzip');
    });
  } finally {
    fs.rmSync(assetsDirectory, { recursive: true, force: true });
  }
});
