#!/usr/bin/env node
// Slow Echo — a tiny HTTP server with an OpenAPI 3.0 spec that sleeps
// `delay_ms` (default 5000) then echoes its input. Used to prove the Floom
// v0.3.0 async job queue end-to-end.
//
// Run: node examples/slow-echo/server.mjs
// Env:
//   PORT=4101 (default)
//   ECHO_DELAY_MS=5000 (default, overrides the per-request delay fallback)

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 4101);
const DEFAULT_DELAY_MS = Number(process.env.ECHO_DELAY_MS || 5000);

const spec = {
  openapi: '3.0.0',
  info: { title: 'Slow Echo', version: '0.1.0', description: 'Sleep and echo.' },
  servers: [{ url: `http://localhost:${PORT}` }],
  paths: {
    '/echo': {
      post: {
        operationId: 'slow_echo',
        summary: 'Sleep then echo the payload',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  message: { type: 'string', description: 'Message to echo' },
                  delay_ms: { type: 'number', description: 'How long to wait' },
                },
                required: ['message'],
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Echoed payload',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
};

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(spec));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/echo') {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad json' }));
      return;
    }
    const delay = Number(body.delay_ms ?? DEFAULT_DELAY_MS);
    await new Promise((r) => setTimeout(r, delay));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        echoed: body.message ?? null,
        delay_ms: delay,
        received_at: new Date().toISOString(),
      }),
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[slow-echo] listening on http://localhost:${PORT}`);
  console.log(`[slow-echo] spec at  http://localhost:${PORT}/openapi.json`);
});
