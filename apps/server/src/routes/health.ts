import { createRequire } from 'node:module';
import { Hono } from 'hono';
import { db } from '../db.js';

/** Single source of truth: apps/server/package.json (bumped on each release). */
const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

export const healthRouter = new Hono();

healthRouter.get('/', (c) => {
  const appCount = (db.prepare('SELECT COUNT(*) as c FROM apps').get() as { c: number }).c;
  const threadCount = (db.prepare('SELECT COUNT(*) as c FROM run_threads').get() as { c: number }).c;
  return c.json({
    status: 'ok',
    service: 'floom-chat',
    version: pkg.version,
    apps: appCount,
    threads: threadCount,
    timestamp: new Date().toISOString(),
  });
});
