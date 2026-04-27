#!/usr/bin/env node
// Session Recall — proxied-mode HTTP server for Claude Code session analysis.
//
// Exposes 3 operations that mirror the original bundled app:
//   POST /search   — keyword search across events
//   POST /recent   — last N human/assistant messages
//   POST /report   — retry loops, error categories, suggested rules
//
// Pure Node.js, no external dependencies, no API keys. Drop-in replacement for
// the former docker-hosted bundled app.
//
// Run: node examples/session-recall/server.mjs
// Env: PORT=4112 (default)

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 4112);

const spec = {
  openapi: '3.0.0',
  info: {
    title: 'Session Recall',
    version: '0.2.0',
    description:
      'Upload and analyze Claude Code session transcripts. Keyword search, recent messages, and retry-loop report.',
  },
  servers: [{ url: `http://localhost:${PORT}` }],
  paths: {
    '/search': {
      post: {
        operationId: 'search',
        summary: 'Keyword search across a session',
        description:
          'AND-logic keyword search across the events of an uploaded Claude Code session .jsonl file.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['jsonl_session_file', 'keywords'],
                properties: {
                  jsonl_session_file: {
                    type: 'string',
                    format: 'binary',
                    description: 'Claude Code .jsonl session file selected from your machine.',
                  },
                  jsonl_session: {
                    type: 'string',
                    description: 'Optional pasted JSONL fallback.',
                  },
                  keywords: {
                    type: 'string',
                    description: 'Space or comma separated keywords. ALL must match.',
                  },
                  max_results: {
                    type: 'number',
                    description: 'Maximum number of matches to return.',
                    default: 15,
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Matches',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    matches: { type: 'string' },
                    total: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/recent': {
      post: {
        operationId: 'recent',
        summary: 'Last N human/assistant messages',
        description:
          'Return the last N user/assistant turns from a session, skipping tool noise.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['jsonl_session_file'],
                properties: {
                  jsonl_session_file: {
                    type: 'string',
                    format: 'binary',
                    description: 'Claude Code .jsonl session file selected from your machine.',
                  },
                  jsonl_session: {
                    type: 'string',
                    description: 'Optional pasted JSONL fallback.',
                  },
                  count: { type: 'number', default: 20 },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Recent messages',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { messages: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
    '/report': {
      post: {
        operationId: 'report',
        summary: 'Session retry + error report',
        description:
          'Analyze retry loops, errors, corrections, and inflated self-scores. Suggests CLAUDE.md rules and MEMORY.md entries.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['jsonl_session_file'],
                properties: {
                  jsonl_session_file: {
                    type: 'string',
                    format: 'binary',
                    description: 'Claude Code .jsonl session file selected from your machine.',
                  },
                  jsonl_session: {
                    type: 'string',
                    description: 'Optional pasted JSONL fallback.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Session report',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    stats: { type: 'object' },
                    retry_loops: { type: 'array' },
                    error_categories: { type: 'object' },
                    suggested_rules: { type: 'array' },
                    suggested_memories: { type: 'array' },
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

// ---------- parsing ----------

function parseJsonl(raw) {
  const events = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      // skip
    }
  }
  return events;
}

function eventText(e) {
  // Try common shapes: {message: {content: string | array}}, {text}, {content}
  const msg = e.message || e;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (!c) return '';
        if (typeof c === 'string') return c;
        if (c.text) return c.text;
        if (c.type === 'tool_use') return `[tool_use:${c.name || '?'}]`;
        if (c.type === 'tool_result') {
          const inner = c.content;
          if (typeof inner === 'string') return inner;
          if (Array.isArray(inner)) return inner.map((x) => (x && x.text) || '').join(' ');
          return '';
        }
        return '';
      })
      .join(' ');
  }
  if (typeof msg.text === 'string') return msg.text;
  return '';
}

function eventRole(e) {
  return (
    e.type ||
    (e.message && e.message.role) ||
    e.role ||
    (e.tool_use ? 'tool_use' : 'unknown')
  );
}

function splitKeywords(s) {
  return String(s || '')
    .split(/[\s,]+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

function search(jsonl, keywordsRaw, maxResults = 15) {
  const events = parseJsonl(jsonl);
  const kws = splitKeywords(keywordsRaw);
  if (!kws.length) return { matches: '', total: 0 };
  const out = [];
  for (const e of events) {
    const text = eventText(e).toLowerCase();
    if (!text) continue;
    if (kws.every((k) => text.includes(k))) {
      const role = eventRole(e);
      const ts = e.timestamp || e.created_at || '';
      const preview = eventText(e).slice(0, 260).replace(/\s+/g, ' ');
      out.push(`[${ts}] ${role}: ${preview}`);
      if (out.length >= maxResults) break;
    }
  }
  return { matches: out.join('\n\n'), total: out.length };
}

function recent(jsonl, count = 20) {
  const events = parseJsonl(jsonl);
  const keep = [];
  for (let i = events.length - 1; i >= 0 && keep.length < count; i--) {
    const e = events[i];
    const role = eventRole(e);
    if (role !== 'user' && role !== 'assistant' && role !== 'human') continue;
    const text = eventText(e);
    if (!text) continue;
    const ts = e.timestamp || e.created_at || '';
    keep.push(`[${ts}] ${role}: ${text.slice(0, 600).replace(/\s+/g, ' ')}`);
  }
  return { messages: keep.reverse().join('\n\n') };
}

function report(jsonl) {
  const events = parseJsonl(jsonl);
  const stats = {
    total_events: events.length,
    user_messages: 0,
    assistant_messages: 0,
    tool_calls: 0,
    errors: 0,
  };
  const retryLoops = [];
  const errorCategories = new Map();
  const suggestedRules = [];
  const suggestedMemories = [];

  let lastAssistantText = '';
  let repeatCount = 0;

  for (const e of events) {
    const role = eventRole(e);
    const text = eventText(e);
    if (role === 'user' || role === 'human') stats.user_messages++;
    else if (role === 'assistant') {
      stats.assistant_messages++;
      // crude retry-loop detection
      const head = text.slice(0, 160);
      if (head && head === lastAssistantText) {
        repeatCount++;
        if (repeatCount === 2) {
          retryLoops.push({ preview: head, count: 3 });
          suggestedRules.push(
            'Stop retrying the same approach after 2 failures. Switch strategy or escalate.',
          );
        }
      } else {
        repeatCount = 0;
        lastAssistantText = head;
      }
    }
    // tool_use / tool_result
    const msg = e.message || e;
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (!c) continue;
        if (c.type === 'tool_use') stats.tool_calls++;
        if (c.type === 'tool_result' && c.is_error) {
          stats.errors++;
          const inner = typeof c.content === 'string' ? c.content : JSON.stringify(c.content || '');
          const cat = inner.slice(0, 40).replace(/\s+/g, ' ');
          errorCategories.set(cat, (errorCategories.get(cat) || 0) + 1);
        }
      }
    }
  }

  if (stats.errors > 5) {
    suggestedRules.push(
      `Session hit ${stats.errors} tool errors. Check Error Recovery in CLAUDE.md.`,
    );
  }
  if (retryLoops.length) {
    suggestedMemories.push(
      `Observed ${retryLoops.length} retry loop(s) in this session. Consider adding a "switch approach after 2 failures" note.`,
    );
  }

  return {
    stats,
    retry_loops: retryLoops,
    error_categories: Object.fromEntries(errorCategories),
    suggested_rules: Array.from(new Set(suggestedRules)),
    suggested_memories: suggestedMemories,
  };
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

function resolveJsonlSession(body) {
  const uploaded = decodeUploadedText(body.jsonl_session_file, 'jsonl_session_file');
  const pasted = typeof body.jsonl_session === 'string' ? body.jsonl_session : '';
  const value = uploaded || pasted;
  if (!value.trim()) {
    throw new Error("missing required field 'jsonl_session_file' or pasted jsonl_session");
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

    if (req.method === 'GET' && url.pathname === '/openapi.json') return sendJson(res, 200, spec);
    if (req.method === 'GET' && url.pathname === '/health')
      return sendJson(res, 200, { ok: true, service: 'session-recall' });

    if (req.method === 'POST' && url.pathname === '/search') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return sendJson(res, 400, { error: 'invalid json body' });
      }
      if (typeof body.keywords !== 'string') {
        return sendJson(res, 400, {
          error: "missing required field 'keywords'",
        });
      }
      let jsonlSession;
      try {
        jsonlSession = resolveJsonlSession(body);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      return sendJson(res, 200, search(jsonlSession, body.keywords, Number(body.max_results) || 15));
    }

    if (req.method === 'POST' && url.pathname === '/recent') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return sendJson(res, 400, { error: 'invalid json body' });
      }
      let jsonlSession;
      try {
        jsonlSession = resolveJsonlSession(body);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      return sendJson(res, 200, recent(jsonlSession, Number(body.count) || 20));
    }

    if (req.method === 'POST' && url.pathname === '/report') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return sendJson(res, 400, { error: 'invalid json body' });
      }
      let jsonlSession;
      try {
        jsonlSession = resolveJsonlSession(body);
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
      return sendJson(res, 200, report(jsonlSession));
    }

    sendJson(res, 404, { error: 'not found', path: url.pathname });
  } catch (err) {
    console.error('[session-recall]', err);
    sendJson(res, 500, { error: 'internal error', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[session-recall] listening on http://localhost:${PORT}`);
  console.log(`[session-recall] spec at  http://localhost:${PORT}/openapi.json`);
});
