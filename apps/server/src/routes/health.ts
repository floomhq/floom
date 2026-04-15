import { Hono } from 'hono';
import { db } from '../db.js';

export const healthRouter = new Hono();

healthRouter.get('/', (c) => {
  const appCount = (db.prepare('SELECT COUNT(*) as c FROM apps').get() as { c: number }).c;
  const threadCount = (db.prepare('SELECT COUNT(*) as c FROM chat_threads').get() as { c: number }).c;
  return c.json({
    status: 'ok',
    service: 'floom-chat',
    version: '0.3.1',
    apps: appCount,
    threads: threadCount,
    timestamp: new Date().toISOString(),
  });
});
