import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

import type { RequestHandler } from 'express';

// The server had no response compression, so every JS chunk and every JSON
// payload crossed the network at full size, which hurts most on a phone.
// This is built on node:zlib instead of the `compression` package so a deploy
// needs no `npm install`. It covers the two kinds of traffic that matter:
// hashed client assets (compressed once, then served from memory) and
// `res.json` bodies. Streams (SSE, websockets, file downloads) are left alone.

type ContentEncoding = 'br' | 'gzip';

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** Bodies smaller than this gain too little to be worth the CPU. */
const MIN_COMPRESSIBLE_BYTES = 1024;
/** Upper bound on cached compressed assets; old builds age out first. */
const ASSET_CACHE_MAX_BYTES = 64 * 1024 * 1024;

const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
};

/**
 * Picks the best encoding the client accepts. Browsers only advertise `br`
 * over HTTPS, so plain-HTTP access (e.g. over a LAN or tailnet IP) gets gzip.
 */
function selectEncoding(acceptEncoding: string | undefined): ContentEncoding | null {
  if (!acceptEncoding) return null;
  const accepted = new Set<string>();
  for (const part of acceptEncoding.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const refused = params.some((param) => /^\s*q=0(?:\.0+)?\s*$/.test(param));
    if (name && !refused) accepted.add(name);
  }
  if (accepted.has('br')) return 'br';
  if (accepted.has('gzip')) return 'gzip';
  return null;
}

function compressBuffer(body: Buffer, encoding: ContentEncoding, level: 'asset' | 'response'): Promise<Buffer> {
  if (encoding === 'br') {
    // Quality 9 is near-max ratio for assets compressed once; 5 keeps
    // per-response latency low.
    const quality = level === 'asset' ? 9 : 5;
    return brotliCompress(body, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: quality,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      },
    });
  }
  return gzip(body, { level: 6 });
}

/**
 * Compresses `res.json` bodies of 1 KB or more.
 *
 * Used by the server entrypoint ahead of the API routers. The body goes out
 * through `res.send`, so Express still sets Content-Length, the ETag (over
 * the encoded bytes) and answers conditional requests with 304.
 */
export const compressJsonResponses: RequestHandler = (req, res, next) => {
  const encoding = selectEncoding(req.headers['accept-encoding']);
  if (!encoding) {
    next();
    return;
  }

  const sendJson = res.json.bind(res);
  res.json = (body?: unknown) => {
    const serialized = JSON.stringify(body);
    if (
      serialized === undefined
      || res.headersSent
      || res.getHeader('Content-Encoding')
      || Buffer.byteLength(serialized) < MIN_COMPRESSIBLE_BYTES
    ) {
      return sendJson(body);
    }

    compressBuffer(Buffer.from(serialized), encoding, 'response').then(
      (compressed) => {
        if (res.headersSent) return;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', encoding);
        res.vary('Accept-Encoding');
        res.send(compressed);
      },
      () => {
        if (!res.headersSent) sendJson(body);
      },
    );
    return res;
  };
  next();
};

type CachedAsset = { body: Buffer; size: number };

/**
 * Serves hashed client assets (`dist/assets/*.js|css`) compressed.
 *
 * Used by the server entrypoint in front of `express.static(dist)`. Each
 * asset is compressed once per (file version, encoding) and kept in memory.
 * Anything it does not handle (other files, missing files, clients without
 * br/gzip) falls through to `express.static`.
 */
export function createCompressedAssetHandler(assetsDirectory: string): RequestHandler {
  const cache = new Map<string, Promise<CachedAsset | null>>();
  const cachedSizes = new Map<string, number>();
  let cachedBytes = 0;

  const loadCompressed = (filePath: string, version: string, encoding: ContentEncoding) => {
    const key = `${filePath}|${version}|${encoding}`;
    let entry = cache.get(key);
    if (!entry) {
      entry = fsPromises.readFile(filePath)
        .then(async (raw) => {
          if (raw.length < MIN_COMPRESSIBLE_BYTES) return null;
          const body = await compressBuffer(raw, encoding, 'asset');
          return { body, size: body.length };
        })
        .catch(() => null);
      cache.set(key, entry);
      void entry.then((asset) => {
        if (!asset || cache.get(key) !== entry) return;
        cachedSizes.set(key, asset.size);
        cachedBytes += asset.size;
        // Map iteration order is insertion order: drop the oldest builds first.
        for (const oldKey of cache.keys()) {
          if (cachedBytes <= ASSET_CACHE_MAX_BYTES) break;
          if (oldKey === key) continue;
          cache.delete(oldKey);
          cachedBytes -= cachedSizes.get(oldKey) ?? 0;
          cachedSizes.delete(oldKey);
        }
      });
    }
    return entry;
  };

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    const encoding = selectEncoding(req.headers['accept-encoding']);
    // Plain file names only: no traversal, no subdirectories.
    const fileName = req.path.replace(/^\//, '');
    const contentType = ASSET_CONTENT_TYPES[path.extname(fileName)];
    if (!encoding || !contentType || !/^[\w.-]+$/.test(fileName)) {
      next();
      return;
    }

    const filePath = path.join(assetsDirectory, fileName);
    fsPromises.stat(filePath)
      .then((stats) => (stats.isFile() ? loadCompressed(filePath, `${stats.mtimeMs}:${stats.size}`, encoding) : null))
      .catch(() => null)
      .then((asset) => {
        if (!asset) {
          next();
          return;
        }
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Encoding', encoding);
        res.setHeader('Content-Length', String(asset.size));
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.vary('Accept-Encoding');
        res.end(req.method === 'HEAD' ? undefined : asset.body);
      }, next);
  };
}
