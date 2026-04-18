import { Hono } from 'hono';
import { SERVER_VERSION } from '../lib/server-version.js';
import { db } from '../db.js';

export const healthRouter = new Hono();

healthRouter.get('/', (c) => {
  const appCount = (db.prepare('SELECT COUNT(*) as c FROM apps').get() as { c: number }).c;
  const threadCount = (db.prepare('SELECT COUNT(*) as c FROM run_threads').get() as { c: number }).c;
  return c.json({
    status: 'ok',
    service: 'floom-chat',
    version: SERVER_VERSION,
    apps: appCount,
    threads: threadCount,
    timestamp: new Date().toISOString(),
  });
});
