import express from 'express';

import type { createSystemUpdateService } from './system.service.js';

type SystemRouterOptions = {
  isPlatform: boolean;
};

/** Creates thin system routes that delegate update execution to the service. */
export function createSystemRouter(
  systemUpdateService: ReturnType<typeof createSystemUpdateService>,
  options: SystemRouterOptions,
): express.Router {
  const router = express.Router();

  /**
   * Capability probe for host telemetry, checked before the client opens a
   * `system.subscribe` stream.
   *
   * Without it a newer frontend talking to an older, still-running server
   * would send a message that server cannot parse; the resulting
   * `protocol_error` carries no session id, so the chat handler attributes it
   * to whatever session is open and prints it into that transcript.
   *
   * `capability` is echoed back so the client can tell this response apart
   * from the SPA index.html that the catch-all route serves for unknown
   * `/api` paths on older builds.
   */
  router.get('/stats/capability', (_request, response) => {
    response.json({
      capability: 'system-stats',
      supported: true,
      disabled: options.isPlatform,
    });
  });

  router.post('/update', async (_request, response, next) => {
    try {
      const result = await systemUpdateService.updateSystem();
      response.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
