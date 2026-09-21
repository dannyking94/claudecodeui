import type { RequestHandler } from 'express';

// Used by the server entrypoint before API parsing/auth so even errors cannot
// be cached with authentication headers that a browser might later replay.
export const preventApiResponseStorage: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};
