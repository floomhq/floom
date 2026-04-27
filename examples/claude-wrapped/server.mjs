#!/usr/bin/env node
// Claude Wrapped — proxied-mode HTTP server for the Claude Code session analyzer.
//
// Exposes:
//   GET  /openapi.json → OpenAPI 3.0 spec
//   GET  /health       → liveness probe
//   POST /generate     → parse uploaded/pasted Claude Code .jsonl files and generate
//                        a Spotify-Wrapped-style HTML report
//
// Pure Node.js, no external dependencies, no API keys. Drop-in replacement for
// the former docker-hosted bundled app.
//
// Run: node examples/claude-wrapped/server.mjs
// Env: PORT=4111 (default)

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 4111);

const spec = {
  openapi: '3.0.0',
  info: {
    title: 'Claude Wrapped',
    version: '0.2.0',
    description:
      'Spotify Wrapped for Claude Code. Upload an exported session JSONL file and visualize your AI coding stats.',
  },
  servers: [{ url: `http://localhost:${PORT}` }],
  paths: {
    '/generate': {
      post: {
        operationId: 'generate',
        summary: 'Generate a Claude Code Wrapped report',
        description:
          'Parse an uploaded Claude Code session JSONL file, or pasted JSONL fallback, and return a Spotify-Wrapped-style HTML report.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['jsonl_sessions_file'],
                properties: {
                  jsonl_sessions_file: {
                    type: 'string',
                    format: 'binary',
                    description: 'Claude Code .jsonl session file selected from your machine.',
                  },
                  jsonl_sessions: {
                    type: 'string',
                    description:
                      'Optional pasted JSONL fallback. Separate multiple sessions with a line of only ---',
                  },
                  author: {
                    type: 'string',
                    description: 'Display name for the report header.',
                    default: 'Claude Code User',
                  },
                  project_slug: {
                    type: 'string',
                    description: 'Slug used to group sessions under one project bucket.',
                    default: 'my-project',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'HTML report with headline stats',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sessions: { type: 'number' },
                    html: { type: 'string' },
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

// ---------- parser ----------

function splitSessions(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const groups = [[]];
  for (const line of lines) {
    if (line.trim() === '---') {
      groups.push([]);
    } else {
      groups[groups.length - 1].push(line);
    }
  }
  return groups
    .map((g) => g.join('\n').trim())
    .filter(Boolean);
}

function parseSession(raw) {
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      // skip malformed line
    }
  }
  return events;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function analyzeWrapped({ jsonlSessions, author, projectSlug }) {
  const sessions = splitSessions(jsonlSessions);
  let totalEvents = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  const tools = new Map();
  let firstTimestamp = null;
  let lastTimestamp = null;

  for (const s of sessions) {
    const events = parseSession(s);
    totalEvents += events.length;
    for (const e of events) {
      const ts = e.timestamp || e.created_at;
      if (ts) {
        if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
        if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
      }
      const type = e.type || e.role || (e.message && e.message.role);
      if (type === 'user' || type === 'human') userMessages++;
      else if (type === 'assistant') assistantMessages++;
      // tool call detection
      const content = e.message && e.message.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item && item.type === 'tool_use' && item.name) {
            toolCalls++;
            tools.set(item.name, (tools.get(item.name) || 0) + 1);
          }
        }
      }
      if (e.tool_use) {
        toolCalls++;
        const n = e.tool_use.name || 'unknown';
        tools.set(n, (tools.get(n) || 0) + 1);
      }
    }
  }

  const topTools = Array.from(tools.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const headline = `${escapeHtml(author)}'s ${escapeHtml(projectSlug)} Wrapped`;
  const toolRows = topTools.length
    ? topTools
        .map(
          ([name, count]) =>
            `<li><strong>${escapeHtml(name)}</strong> <span>${count} calls</span></li>`,
        )
        .join('')
    : '<li><em>No tool calls detected</em></li>';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${headline}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #0b0b0f; color: #e6e6e6; }
  .wrap { max-width: 640px; margin: 0 auto; padding: 48px 24px; }
  h1 { font-size: 40px; line-height: 1.1; margin: 0 0 8px; background: linear-gradient(135deg,#ff6b6b,#ffd166); -webkit-background-clip: text; background-clip: text; color: transparent; }
  h2 { font-size: 18px; text-transform: uppercase; letter-spacing: 0.08em; margin: 32px 0 12px; color: #ffd166; }
  .stat { display: flex; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #22222a; font-size: 16px; }
  .stat strong { color: #fff; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #22222a; }
  li span { color: #ffd166; }
  footer { margin-top: 40px; text-align: center; color: #666; font-size: 12px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>${headline}</h1>
    <p>${sessions.length} session${sessions.length === 1 ? '' : 's'} parsed, ${totalEvents} events total.</p>

    <h2>Conversation</h2>
    <div class="stat"><span>You said</span><strong>${userMessages}</strong></div>
    <div class="stat"><span>Claude replied</span><strong>${assistantMessages}</strong></div>
    <div class="stat"><span>Tools called</span><strong>${toolCalls}</strong></div>

    <h2>Top tools</h2>
    <ul>${toolRows}</ul>

    <h2>Timespan</h2>
    <div class="stat"><span>First event</span><strong>${escapeHtml(firstTimestamp || '—')}</strong></div>
    <div class="stat"><span>Last event</span><strong>${escapeHtml(lastTimestamp || '—')}</strong></div>

    <footer>Claude Wrapped · generated by Floom proxied example</footer>
  </div>
</body>
</html>`;

  return { sessions: sessions.length, html };
}

// ---------- HTTP ----------

function decodeUploadedText(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  if (value.__file !== true || typeof value.content_b64 !== 'string') return '';
  try {
    return Buffer.from(value.content_b64, 'base64').toString('utf-8');
  } catch {
    throw new Error(`could not decode uploaded ${fieldName}`);
  }
}

function resolveJsonlSessions(body) {
  const uploaded = decodeUploadedText(body.jsonl_sessions_file, 'jsonl_sessions_file');
  const pasted = typeof body.jsonl_sessions === 'string' ? body.jsonl_sessions : '';
  const value = uploaded || pasted;
  if (!value.trim()) {
    throw new Error("missing required field 'jsonl_sessions_file' or pasted jsonl_sessions");
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
      return sendJson(res, 200, { ok: true, service: 'claude-wrapped' });
    }
    if (req.method === 'POST' && url.pathname === '/generate') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return sendJson(res, 400, { error: 'invalid json body' });
      }
      let jsonlSessions;
      try {
        jsonlSessions = resolveJsonlSessions(body);
      } catch (error) {
        return sendJson(res, 400, {
          error: error.message,
        });
      }
      const result = analyzeWrapped({
        jsonlSessions,
        author: body.author || 'Claude Code User',
        projectSlug: body.project_slug || 'my-project',
      });
      return sendJson(res, 200, result);
    }
    sendJson(res, 404, { error: 'not found', path: url.pathname });
  } catch (err) {
    console.error('[claude-wrapped]', err);
    sendJson(res, 500, { error: 'internal error', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[claude-wrapped] listening on http://localhost:${PORT}`);
  console.log(`[claude-wrapped] spec at  http://localhost:${PORT}/openapi.json`);
});
