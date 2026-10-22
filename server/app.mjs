/** HTTP server assembly: router + application handler. */
import http from 'node:http';
import { Router, createApp } from './core/http.mjs';
import { config as defaultConfig } from './config.mjs';
import { getDb } from './core/db.mjs';
import { logger as defaultLogger } from './core/logger.mjs';
import { mountRoutes } from './routes/index.mjs';

export function buildRouter() {
  const router = new Router();
  mountRoutes(router);
  return router;
}

export function createServerApp({ config = defaultConfig, logger = defaultLogger, db = getDb() } = {}) {
  const router = buildRouter();
  const handler = createApp({ router, config, logger, db });
  return http.createServer(handler);
}
