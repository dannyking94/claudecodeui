import express from 'express';

import type { ProjectAppAction, ProjectAppsServices } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const ACTIONS: readonly ProjectAppAction[] = ['start', 'stop', 'restart'];
// Registry ids are short slugs; anything else never reaches the dashboard.
const APP_ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

function readRequired(value: unknown, name: string, code: string): string {
  const parsed = typeof value === 'string' ? value.trim() : '';
  if (!parsed) {
    throw new AppError(`${name} is required`, { code, statusCode: 400 });
  }
  return parsed;
}

function readAppId(value: unknown): string {
  const appId = readRequired(value, 'app', 'APP_ID_REQUIRED');
  if (!APP_ID_PATTERN.test(appId)) {
    throw new AppError('app id is malformed', { code: 'APP_ID_INVALID', statusCode: 400 });
  }
  return appId;
}

function readAction(value: unknown): ProjectAppAction {
  const action = readRequired(value, 'action', 'ACTION_REQUIRED');
  if (!(ACTIONS as readonly string[]).includes(action)) {
    throw new AppError('action must be start, stop or restart', { code: 'ACTION_INVALID', statusCode: 400 });
  }
  return action as ProjectAppAction;
}

/**
 * Builds the Project Apps router (mounted at `/api/project-apps`) around
 * injected services, so route tests can run against fakes.
 *
 * - `GET /?project=<id>`          the project's apps and chat links
 * - `POST /action {app, action}`  start / stop / restart through the dashboard
 * - `GET /log?app=<id>`           that app's start/stop history
 */
export function createProjectAppsRouter(services: ProjectAppsServices): express.Router {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const projectPath = services.resolveProjectPath(readRequired(req.query.project, 'project', 'PROJECT_ID_REQUIRED'));
      res.json(createApiSuccessResponse(await services.getView(projectPath)));
    }),
  );

  router.post(
    '/action',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await services.runAction(readAppId(body.app), readAction(body.action));
      res.json(createApiSuccessResponse(result));
    }),
  );

  router.get(
    '/log',
    asyncHandler(async (req, res) => {
      res.json(createApiSuccessResponse(await services.getLog(readAppId(req.query.app))));
    }),
  );

  return router;
}
