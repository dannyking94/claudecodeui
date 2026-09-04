import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

// The middleware resolves JWT_SECRET and the database at import time, so both
// are pinned to throwaway values *before* it is loaded — this suite must never
// read or write a real installation's auth.db.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-auth-middleware-'));
process.env.JWT_SECRET = 'auth-middleware-test-secret';
process.env.DATABASE_PATH = path.join(workDir, 'auth.db');
process.env.VITE_IS_PLATFORM = 'false';

const { closeConnection, initializeDatabase, userDb } = await import('../../database/index.js');
const { AUTH_ERROR_CODES, AUTH_ERROR_HEADER, authenticateToken } = await import(
  '../auth.middleware.js'
);

await initializeDatabase();
const user = userDb.createUser('auth-middleware-test-user', 'not-a-real-hash');

after(() => {
  closeConnection();
  fs.rmSync(workDir, { recursive: true, force: true });
});

type MiddlewareResult = {
  headers: Record<string, string>;
  status: number | null;
  nextCalled: boolean;
};

/** Minimal Express req/res doubles — the middleware only touches these. */
async function runMiddleware(token: string | null): Promise<MiddlewareResult> {
  const headers: Record<string, string> = {};
  let status: number | null = null;
  let nextCalled = false;

  const req = {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    query: {},
  };
  const res = {
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    status(code: number) {
      status = code;
      return res;
    },
    json() {
      return res;
    },
  };

  await authenticateToken(req, res, () => {
    nextCalled = true;
  });

  return { headers, status, nextCalled };
}

/**
 * Mints an HS256 JWT by hand so each case can state its own `exp` and signing
 * key. Hand-rolled rather than via jsonwebtoken because the repo has no
 * @types/jsonwebtoken, and this file — unlike the middleware — is type-checked.
 */
function signToken(
  { expiresInSeconds = 3600, userId = Number(user.id), username = user.username } = {},
  secret = process.env.JWT_SECRET as string,
): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const issuedAt = Math.floor(Date.now() / 1000);
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ userId, username, iat: issuedAt, exp: issuedAt + expiresInSeconds });
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${head}.${body}`)
    .digest('base64url');

  return `${head}.${body}.${signature}`;
}

test('X-Auth-Error is session-expired only for a genuinely expired token', async () => {
  const result = await runMiddleware(signToken({ expiresInSeconds: -60 }));

  assert.equal(result.status, 401);
  assert.equal(result.headers[AUTH_ERROR_HEADER], AUTH_ERROR_CODES.SESSION_EXPIRED);
  assert.equal(result.nextCalled, false);
});

test('X-Auth-Error is no-token when the request carries no token at all', async () => {
  const result = await runMiddleware(null);

  assert.equal(result.status, 401);
  assert.equal(result.headers[AUTH_ERROR_HEADER], AUTH_ERROR_CODES.MISSING_TOKEN);
  assert.notEqual(result.headers[AUTH_ERROR_HEADER], AUTH_ERROR_CODES.SESSION_EXPIRED);
});

test('X-Auth-Error is invalid-token for a malformed value', async () => {
  // The reported bug: a corrupted localStorage value ("jwt malformed" server
  // side) was answered with the same header as a real expiry.
  const result = await runMiddleware('this-is-not-a-jwt');

  assert.equal(result.status, 401);
  assert.equal(result.headers[AUTH_ERROR_HEADER], AUTH_ERROR_CODES.INVALID_TOKEN);
  assert.notEqual(result.headers[AUTH_ERROR_HEADER], AUTH_ERROR_CODES.SESSION_EXPIRED);
});

test('X-Auth-Error is invalid-token for a well-formed token with a bad signature', async () => {
  const result = await runMiddleware(signToken({}, 'a-different-secret'));

  assert.equal(result.status, 401);
  assert.equal(result.headers[AUTH_ERROR_HEADER], AUTH_ERROR_CODES.INVALID_TOKEN);
});

test('X-Auth-Error is unknown-user when the token verifies but the user is gone', async () => {
  const result = await runMiddleware(signToken({ userId: Number(user.id) + 100_000, username: 'deleted' }));

  assert.equal(result.status, 401);
  assert.equal(result.headers[AUTH_ERROR_HEADER], AUTH_ERROR_CODES.UNKNOWN_USER);
  assert.notEqual(result.headers[AUTH_ERROR_HEADER], AUTH_ERROR_CODES.SESSION_EXPIRED);
});

test('a valid token for an existing user passes through with no X-Auth-Error', async () => {
  const result = await runMiddleware(signToken({ expiresInSeconds: 7 * 24 * 3600 }));

  assert.equal(result.nextCalled, true);
  assert.equal(result.status, null);
  assert.equal(result.headers[AUTH_ERROR_HEADER], undefined);
});
