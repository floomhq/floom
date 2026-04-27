#!/usr/bin/env node
// Floom This - Day 7 deterministic intake app.
//
// Pure Node.js sidecar for proxied Floom registration. No npm dependencies,
// no model calls, no secrets. It converts a public repo plus optional context
// into a deterministic Floom app intake card.
//
// Run: node examples/floom-this/server.mjs
// Env: PORT=4117 (default)

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 4117);
const HOST = process.env.HOST || '127.0.0.1';
const BASE_PATH = '/floom-this';
const PUBLIC_BASE = process.env.PUBLIC_BASE || `http://localhost:${PORT}`;
const MAX_BODY_BYTES = 1_048_576;

const INPUT_TYPES = new Set([
  'text',
  'url',
  'file',
  'json',
  'csv',
  'image',
  'audio',
  'video',
  'repo',
  'mixed',
]);

const spec = {
  openapi: '3.0.0',
  info: {
    title: 'Floom This',
    version: '0.1.0',
    description:
      'Deterministic intake app that turns a public repo or script workflow into a Floom app plan.',
  },
  servers: [{ url: `${PUBLIC_BASE}${BASE_PATH}` }],
  paths: {
    '/analyze': {
      post: {
        operationId: 'analyzeFloomThis',
        summary: 'Analyze a repo or script workflow for Floom app intake',
        description:
          'Returns a zero-token deterministic intake card with score, slug, inputs, outputs, build plan, and next step.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['repo_url'],
                properties: {
                  repo_url: {
                    type: 'string',
                    format: 'uri',
                    description: 'Public GitHub repository URL, for example https://github.com/floomhq/floom.',
                  },
                  script_description: {
                    type: 'string',
                    description:
                      'Optional context: which script, CLI command, workflow, or manual process to turn into an app.',
                  },
                  input_type: {
                    type: 'string',
                    description:
                      'Optional enum-ish input hint such as text, url, file, json, csv, image, audio, video, repo, or mixed.',
                  },
                  desired_output: {
                    type: 'string',
                    description: 'Optional desired output format or end-user result.',
                  },
                  contact: {
                    type: 'string',
                    description: 'Optional owner or contact for follow-up.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Floom intake recommendation',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: [
                    'floomability_score',
                    'suggested_app_slug',
                    'required_inputs',
                    'suggested_outputs',
                    'build_plan',
                    'next_step',
                    'share_card',
                    'repo_summary',
                  ],
                  properties: {
                    floomability_score: { type: 'number' },
                    suggested_app_slug: { type: 'string' },
                    required_inputs: { type: 'array', items: { type: 'string' } },
                    suggested_outputs: { type: 'array', items: { type: 'string' } },
                    build_plan: { type: 'array', items: { type: 'string' } },
                    next_step: { type: 'string' },
                    share_card: { type: 'string' },
                    repo_summary: { type: 'string' },
                  },
                },
              },
            },
          },
          400: {
            description: 'Invalid request',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { error: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    },
  },
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(httpError(413, 'payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, 'invalid json body'));
      }
    });

    req.on('error', reject);
  });
}

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

function words(value) {
  return cleanText(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function toSlug(value) {
  const stop = new Set([
    'a',
    'an',
    'and',
    'app',
    'for',
    'from',
    'in',
    'into',
    'of',
    'on',
    'or',
    'script',
    'that',
    'the',
    'this',
    'to',
    'tool',
    'with',
    'workflow',
  ]);
  const parts = words(value)
    .filter((word) => word.length > 1 && !stop.has(word))
    .slice(0, 4);
  return parts.length ? parts.join('-').slice(0, 48) : 'floom-this-app';
}

function parseGithubRepoUrl(value) {
  const raw = cleanText(value);
  if (!raw) throw httpError(400, "missing required field 'repo_url'");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw httpError(400, 'repo_url must be a valid GitHub repository URL');
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'github.com') throw httpError(400, 'repo_url must be a github.com repository URL');
  const [owner, repoWithSuffix] = url.pathname.split('/').filter(Boolean);
  if (!owner || !repoWithSuffix) throw httpError(400, 'repo_url must include owner and repo');
  const repo = repoWithSuffix.replace(/\.git$/i, '');
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

async function fetchGithubText(url) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github.raw',
      'user-agent': 'floom-launch-week',
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return '';
  const text = await res.text();
  return text.slice(0, 16_000);
}

async function fetchGithubJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'floom-launch-week',
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) return null;
  return res.json();
}

async function inspectRepo(repoUrl) {
  const parsed = parseGithubRepoUrl(repoUrl);
  const apiBase = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
  const [repo, readme, packageJson] = await Promise.all([
    fetchGithubJson(apiBase),
    fetchGithubText(`${apiBase}/readme`),
    fetchGithubText(`${apiBase}/contents/package.json`),
  ]);
  if (!repo) throw httpError(404, 'GitHub repository could not be fetched or is private');

  let packageName = '';
  let scripts = [];
  try {
    if (packageJson) {
      const pkg = JSON.parse(packageJson);
      packageName = cleanText(pkg.name);
      scripts = Object.keys(pkg.scripts || {}).slice(0, 8);
    }
  } catch {
    // package.json can be absent or not JSON in non-JS repos.
  }

  return {
    ...parsed,
    name: cleanText(repo.name) || parsed.repo,
    description: cleanText(repo.description),
    language: cleanText(repo.language),
    topics: Array.isArray(repo.topics) ? repo.topics.slice(0, 8) : [],
    stars: Number(repo.stargazers_count || 0),
    packageName,
    scripts,
    readmePreview: cleanText(readme).slice(0, 2200),
  };
}

function normalizeInputType(inputType, description) {
  const raw = cleanText(inputType).toLowerCase();
  if (INPUT_TYPES.has(raw)) return raw;

  const text = ` ${description.toLowerCase()} `;
  if (/\b(repo|github|gitlab|branch|pull request|diff)\b/.test(text)) return 'repo';
  if (/\b(csv|spreadsheet|xlsx|sheet)\b/.test(text)) return 'csv';
  if (/\b(json|api payload|webhook)\b/.test(text)) return 'json';
  if (/\b(url|link|website|page)\b/.test(text)) return 'url';
  if (/\b(file|pdf|document|upload)\b/.test(text)) return 'file';
  if (/\b(image|screenshot|photo)\b/.test(text)) return 'image';
  return raw || 'text';
}

function inferRequiredInputs(inputType, hasRepo, hasContact) {
  const inputs = hasRepo ? ['repo_url'] : ['script_description'];
  if (!hasRepo && inputType === 'repo') inputs.push('repo_url');
  if (inputType !== 'text' && !(hasRepo && inputType === 'repo')) {
    inputs.push(inputType === 'mixed' ? 'input_payload' : `${inputType}_input`);
  }
  if (hasContact) inputs.push('contact');
  return Array.from(new Set(inputs));
}

function inferOutputs(desiredOutput, description) {
  const requested = cleanText(desiredOutput);
  if (requested) {
    return Array.from(new Set([requested, 'execution_summary', 'next_action']));
  }

  const text = description.toLowerCase();
  if (/\b(score|rank|grade|prioriti[sz]e)\b/.test(text)) {
    return ['score', 'rationale', 'recommended_action'];
  }
  if (/\b(report|audit|analy[sz]e|review)\b/.test(text)) {
    return ['summary_report', 'findings', 'recommendations'];
  }
  if (/\b(generate|create|draft|write)\b/.test(text)) {
    return ['generated_result', 'assumptions', 'revision_notes'];
  }
  return ['result', 'explanation', 'next_action'];
}

function scoreFloomability({ description, inputType, desiredOutput, hasRepo }) {
  const text = description.toLowerCase();
  let score = 42;

  if (description.length >= 80) score += 14;
  else if (description.length >= 35) score += 8;

  if (desiredOutput) score += 12;
  if (hasRepo) score += 8;
  if (INPUT_TYPES.has(inputType)) score += 8;
  if (/\b(repeat|daily|weekly|every|batch|automate|manual|checklist)\b/.test(text)) score += 10;
  if (/\b(input|output|return|produce|generate|score|classify)\b/.test(text)) score += 8;
  if (/\b(api|database|oauth|login|payment|browser|scrape)\b/.test(text)) score -= 6;

  return Math.max(1, Math.min(100, score));
}

function buildPlan({ slug, inputType, outputs, hasRepo, repo }) {
  const plan = [
    `Define the ${slug} request schema around ${inputType} input${hasRepo ? ' and repo_url' : ' and script_description'}.`,
    'Implement deterministic validation, normalization, and result formatting.',
    `Return ${outputs.join(', ')} plus a compact share card for handoff.`,
    'Add OpenAPI metadata and smoke tests for success, validation, and health routes.',
  ];
  if (hasRepo) {
    const repoHint = repo?.scripts?.length
      ? `Detected package scripts: ${repo.scripts.join(', ')}.`
      : 'Inspect the repository entrypoint and map the current script behavior to a proxied endpoint.';
    plan.splice(1, 0, repoHint);
  }
  return plan;
}

async function analyze(body) {
  const repoUrl = cleanText(body.repo_url);
  const repo = await inspectRepo(repoUrl);
  const contact = cleanText(body.contact);
  const desiredOutput = cleanText(body.desired_output);
  const scriptDescription = cleanText(body.script_description);
  const repoContext = [
    repo.name,
    repo.description,
    repo.language,
    repo.topics.join(' '),
    repo.packageName,
    repo.scripts.join(' '),
    scriptDescription,
    repo.readmePreview,
  ]
    .filter(Boolean)
    .join(' ');
  const inputType = normalizeInputType(body.input_type, repoContext);
  const slug = toSlug(scriptDescription || repo.name || repo.repo);
  const outputs = inferOutputs(desiredOutput, repoContext);
  const requiredInputs = inferRequiredInputs(inputType, Boolean(repoUrl), Boolean(contact));
  const floomabilityScore = scoreFloomability({
    description: repoContext,
    inputType,
    desiredOutput,
    hasRepo: Boolean(repoUrl),
  });
  const plan = buildPlan({
    slug,
    inputType,
    outputs,
    hasRepo: Boolean(repoUrl),
    repo,
  });
  const nextStep =
    floomabilityScore >= 75
      ? `Build ${slug} as a proxied Floom app with the listed inputs and outputs.`
      : `Tighten the input contract and expected output for ${slug} before implementation.`;

  return {
    floomability_score: floomabilityScore,
    suggested_app_slug: slug,
    required_inputs: requiredInputs,
    suggested_outputs: outputs,
    build_plan: plan,
    next_step: nextStep,
    repo_summary: [
      `${repo.owner}/${repo.repo}`,
      repo.description || 'No repository description provided.',
      repo.language ? `Primary language: ${repo.language}` : '',
      repo.scripts.length ? `Scripts: ${repo.scripts.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    share_card: [
      `Floom This: ${slug}`,
      `Score: ${floomabilityScore}/100`,
      `Input: ${inputType}`,
      `Outputs: ${outputs.join(', ')}`,
      `Repo: ${repo.url}`,
      contact ? `Contact: ${contact}` : 'Contact: not provided',
    ].join('\n'),
  };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 'floom-this' });
    }

    if (req.method === 'GET' && url.pathname === `${BASE_PATH}/openapi.json`) {
      return sendJson(res, 200, spec);
    }

    if (
      req.method === 'POST' &&
      (url.pathname === '/analyze' || url.pathname === `${BASE_PATH}/analyze`)
    ) {
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, err.statusCode || 400, { error: err.message || 'invalid request body' });
      }

      try {
        return sendJson(res, 200, await analyze(body));
      } catch (err) {
        return sendJson(res, err.statusCode || 500, { error: err.message || 'internal error' });
      }
    }

    return sendJson(res, 404, { error: 'not found', path: url.pathname });
  } catch (err) {
    console.error('[floom-this]', err);
    return sendJson(res, 500, { error: 'internal error', message: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[floom-this] listening on http://${HOST}:${PORT}`);
  console.log(`[floom-this] spec at http://${HOST}:${PORT}${BASE_PATH}/openapi.json`);
});
