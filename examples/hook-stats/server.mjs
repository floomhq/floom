#!/usr/bin/env node
// Hook Stats — proxied-mode HTTP server for the Claude Code bash-commands log analyzer.
//
// Exposes:
//   GET  /openapi.json  → OpenAPI 3.0 spec describing the `analyze` operation
//   GET  /health        → liveness probe
//   POST /analyze       → parse an uploaded/pasted bash-commands.log and return stats
//
// Pure Node.js, no external dependencies, no API keys. Drop-in replacement for
// the former docker-hosted bundled app.
//
// Run: node examples/hook-stats/server.mjs
// Env: PORT=4110 (default)

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 4110);

const spec = {
  openapi: '3.0.0',
  info: {
    title: 'Hook Stats',
    version: '0.2.0',
    description:
      'Upload your Claude Code bash command log. Get top commands, git stats, and per-day activity.',
  },
  servers: [{ url: `http://localhost:${PORT}` }],
  paths: {
    '/analyze': {
      post: {
        operationId: 'analyze',
        summary: 'Analyze a bash-commands.log',
        description:
          'Parse an uploaded Claude Code bash-commands.log, or pasted log fallback, and return top commands, git stats, and per-day activity.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['log_file'],
                properties: {
                  log_file: {
                    type: 'string',
                    format: 'binary',
                    description: 'Claude Code bash-commands.log selected from your machine.',
                  },
                  log_content: {
                    type: 'string',
                    description:
                      'Optional pasted log fallback. Each line begins with a [timestamp] prefix.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Log stats',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    total: { type: 'number' },
                    today: { type: 'number' },
                    top_commands: { type: 'array' },
                    git: { type: 'object' },
                    per_day: { type: 'object' },
                    report: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

// ---------- parsing logic ----------

const LOG_LINE_RE = /^\[(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})[^\]]*\]\s*(.*)$/;

function analyzeLog(logContent) {
  const lines = String(logContent || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const perDay = {};
  const commandCounts = new Map();
  const gitOps = new Map();
  const today = new Date().toISOString().slice(0, 10);
  let total = 0;
  let todayCount = 0;
  let gitTotal = 0;

  for (const line of lines) {
    const m = line.match(LOG_LINE_RE);
    if (!m) continue;
    const date = m[1];
    const cmd = m[3].trim();
    if (!cmd) continue;
    total++;
    if (date === today) todayCount++;
    perDay[date] = (perDay[date] || 0) + 1;

    const firstWord = cmd.split(/\s+/)[0] || '';
    commandCounts.set(firstWord, (commandCounts.get(firstWord) || 0) + 1);

    if (firstWord === 'git') {
      const sub = (cmd.split(/\s+/)[1] || '').replace(/[^a-zA-Z_-]/g, '');
      if (sub) {
        gitTotal++;
        gitOps.set(sub, (gitOps.get(sub) || 0) + 1);
      }
    }
  }

  const topCommands = Array.from(commandCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const gitBreakdown = Array.from(gitOps.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  // Last 7 days per_day (today back 6)
  const last7 = {};
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    last7[key] = perDay[key] || 0;
  }

  const topLines = topCommands
    .map((c, i) => `${String(i + 1).padStart(2)}. ${c.name.padEnd(16)} ${c.count}`)
    .join('\n');
  const report = [
    `# Hook Stats`,
    ``,
    `Total commands: ${total}`,
    `Today: ${todayCount}`,
    `Git operations: ${gitTotal}`,
    ``,
    `## Top commands`,
    topLines || '(none)',
    ``,
    `## Last 7 days`,
    Object.entries(last7)
      .map(([d, n]) => `${d}  ${'#'.repeat(Math.min(n, 40))} ${n}`)
      .join('\n'),
  ].join('\n');

  return {
    total,
    today: todayCount,
    top_commands: topCommands,
    git: { total: gitTotal, by_subcommand: gitBreakdown },
    per_day: last7,
    report,
  };
}

// ---------- HTTP plumbing ----------

function decodeUploadedText(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  if (value.__file !== true || typeof value.content_b64 !== 'string') return '';
  try {
    return Buffer.from(value.content_b64, 'base64').toString('utf-8');
  } catch {
    throw new Error(`could not decode uploaded ${fieldName}`);
  }
}

function resolveLogContent(body) {
  const uploaded = decodeUploadedText(body.log_file, 'log_file');
  const pasted = typeof body.log_content === 'string' ? body.log_content : '';
  const value = uploaded || pasted;
  if (!value.trim()) {
    throw new Error("missing required field 'log_file' or pasted log_content");
  }
  return value;
}

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

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://localhost:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/openapi.json') {
      return sendJson(res, 200, spec);
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 'hook-stats' });
    }

    if (req.method === 'POST' && url.pathname === '/analyze') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return sendJson(res, 400, { error: 'invalid json body' });
      }
      let logContent;
      try {
        logContent = resolveLogContent(body);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      const result = analyzeLog(logContent);
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { error: 'not found', path: url.pathname });
  } catch (err) {
    console.error('[hook-stats]', err);
    sendJson(res, 500, { error: 'internal error', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[hook-stats] listening on http://localhost:${PORT}`);
  console.log(`[hook-stats] spec at  http://localhost:${PORT}/openapi.json`);
});
