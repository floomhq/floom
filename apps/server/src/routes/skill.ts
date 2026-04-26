import { Hono } from 'hono';
import type { Context } from 'hono';
import { db } from '../db.js';
import { hubRouter } from './hub.js';
import type { AppRecord, InputSpec, NormalizedManifest } from '../types.js';

export const skillRouter = new Hono();

const MARKDOWN_CONTENT_TYPE = 'text/markdown; charset=utf-8';
const SUCCESS_CACHE_CONTROL = 'public, max-age=300';

interface HubSkillApp {
  slug: string;
  name: string;
  description: string;
  hero?: boolean;
}

function markdownResponse(
  body: string,
  status: number,
  cacheControl?: string,
): Response {
  const headers: Record<string, string> = {
    'content-type': MARKDOWN_CONTENT_TYPE,
  };
  if (cacheControl) headers['cache-control'] = cacheControl;
  return new Response(body, { status, headers });
}

function getPublicBaseUrl(c: Context): string {
  const originOverride =
    process.env.FLOOM_PUBLIC_ORIGIN || process.env.PUBLIC_URL || '';
  if (originOverride.trim()) {
    return originOverride.replace(/\/+$/, '');
  }
  try {
    return new URL(c.req.url).origin;
  } catch {
    return 'https://floom.dev';
  }
}

function safeManifest(raw: string): NormalizedManifest | null {
  try {
    return JSON.parse(raw) as NormalizedManifest;
  } catch {
    return null;
  }
}

function yamlQuoted(value: string): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return `"${singleLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function pickHeroApps(apps: HubSkillApp[]): HubSkillApp[] {
  const heroes = apps.filter((app) => app.hero);
  if (heroes.length >= 3) return heroes.slice(0, 3);
  const heroSlugs = new Set(heroes.map((app) => app.slug));
  const fill = apps.filter((app) => !heroSlugs.has(app.slug));
  return [...heroes, ...fill].slice(0, 3);
}

function hintFromDescription(desc?: string): string {
  if (!desc) return '';
  const match = desc.match(/(\d+)\s*-\s*(\d+)\s*char/i);
  if (!match) return '';
  return ` ${match[1]}-${match[2]} chars`;
}

function inputTypeLabel(input: InputSpec): string {
  if (input.type === 'number') return 'number';
  if (input.type === 'boolean') return 'boolean';
  if (input.type === 'enum') {
    return input.options && input.options.length > 0
      ? `enum(${input.options.join('|')})`
      : 'string';
  }
  if (input.type === 'url') return 'string(url)';
  if (input.type === 'date') return 'string(date)';
  if (input.type === 'file') return 'file';
  return 'string';
}

function inputContract(inputs: InputSpec[]): string {
  if (!inputs || inputs.length === 0) return '{}';
  const fields = inputs.map((input) => {
    const optional = input.required ? '' : '?';
    const hint = hintFromDescription(input.description);
    return `${input.name}${optional}: ${inputTypeLabel(input)}${hint}`;
  });
  return `{${fields.join(', ')}}`;
}

function exampleInputValue(input: InputSpec): unknown {
  if (input.type === 'number') return 42;
  if (input.type === 'boolean') return true;
  if (input.type === 'enum') return input.options?.[0] ?? 'example';
  if (input.type === 'url') return 'https://example.com';
  if (input.type === 'date') return '2026-04-25';
  if (input.type === 'file') return 'https://example.com/file.txt';
  if (input.name.toLowerCase().includes('pitch')) {
    return 'We help B2B teams automate repetitive ops work with AI.';
  }
  return input.placeholder || 'example';
}

function buildExamplePayload(action: string, inputs: InputSpec[]): string {
  const payloadInputs: Record<string, unknown> = {};
  for (const input of inputs) {
    if (input.required) payloadInputs[input.name] = exampleInputValue(input);
  }
  if (Object.keys(payloadInputs).length === 0 && inputs[0]) {
    payloadInputs[inputs[0].name] = exampleInputValue(inputs[0]);
  }
  return JSON.stringify({ action, inputs: payloadInputs });
}

async function loadHubApps(): Promise<HubSkillApp[]> {
  const res = await hubRouter.fetch(new Request('http://localhost/?sort=default'));
  if (!res.ok) return [];
  const parsed = (await res.json()) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((row): row is HubSkillApp => {
      return (
        typeof row === 'object' &&
        row !== null &&
        typeof (row as HubSkillApp).slug === 'string' &&
        typeof (row as HubSkillApp).name === 'string' &&
        typeof (row as HubSkillApp).description === 'string'
      );
    })
    .map((row) => ({
      slug: row.slug,
      name: row.name,
      description: row.description,
      hero: Boolean(row.hero),
    }));
}

skillRouter.get('/skill.md', async (c) => {
  const baseUrl = getPublicBaseUrl(c);
  const apps = pickHeroApps(await loadHubApps());
  const appLines =
    apps.length > 0
      ? apps
          .map((app) => `- \`${app.slug}\` — ${app.description}`)
          .join('\n')
      : '- No public launch apps are currently available.';

  const body = `---
name: Floom
description: Floom is a runtime for AI apps. Paste any /p/<slug> URL into Claude and the app becomes a tool.
---

Floom is a runtime for AI apps that exposes each app over web, MCP, and HTTP surfaces. Paste a public \`/p/<slug>\` URL into Claude and the app becomes callable as a tool in your workflow.

Launch apps:
${appLines}

Agent quickstart:
- Mint a token while logged into Floom:
  \`curl -sS -X POST ${baseUrl}/api/me/agent-keys -H 'content-type: application/json' -d '{"label":"local-agent","scope":"read-write"}'\`
- Store the returned \`raw_token\` immediately. It is shown once and Floom stores only its SHA-256 hash plus display prefix.
- Send it on headless calls:
  \`Authorization: Bearer floom_agent_<token>\`
- Scopes: \`read\` unlocks discovery/read contexts, \`read-write\` covers read plus run/write surfaces as they land, and \`publish-only\` is reserved for publish/review operations.
- Rate limits: every agent token has its own per-minute quota, default 60/min, stacked on the existing IP and user limits.
- Phase map: read tools shipped in 2B (\`discover_apps\`, \`get_app_skill\`, \`run_app\`, \`get_run\`, \`list_my_runs\`) with REST parity under \`/api/agents/*\`; write tools are coming in 2D; the CLI lands in 2E.

Long-form guide:
\`${baseUrl}/docs/agents/quickstart.md\`

MCP read/run tools:
\`${baseUrl}/docs/agents/mcp-tools.md\`

Install one app as a skill with:
\`${baseUrl}/p/<slug>/skill.md\`
`;

  return markdownResponse(body, 200, SUCCESS_CACHE_CONTROL);
});

// TODO(follow-up): On `/p/:slug`, add an "Install as Claude Skill" CTA that
// copies `/p/:slug/skill.md` as a code block in the app page UI.
skillRouter.get('/p/:slug/skill.md', (c) => {
  const slug = c.req.param('slug');
  const row = db
    .prepare(
      `SELECT * FROM apps
        WHERE slug = ?
          AND status = 'active'
          AND visibility IN ('public_live', 'public')
        LIMIT 1`,
    )
    .get(slug) as AppRecord | undefined;
  if (!row) return markdownResponse('App not found\n', 404);

  const baseUrl = getPublicBaseUrl(c);
  const manifest = safeManifest(row.manifest);
  const actionName =
    (manifest?.primary_action &&
    manifest.actions &&
    manifest.actions[manifest.primary_action]
      ? manifest.primary_action
      : null) ||
    (manifest ? Object.keys(manifest.actions)[0] : 'run') ||
    'run';
  const actionSpec = manifest?.actions?.[actionName];
  const inputs = actionSpec?.inputs || [];
  const contract = inputContract(inputs);
  const exampleBody = buildExamplePayload(actionName, inputs);
  const appDescription = row.description.trim();

  const body = `---
name: ${yamlQuoted(row.name)}
description: ${yamlQuoted(row.description)}
---

${appDescription}
Use this skill when you want Claude to run ${row.name} through Floom's hosted MCP or HTTP runtime.

Action contract:
- \`${slug}\`: \`action=${actionName}, inputs=${contract}\`

Endpoints:
- MCP: \`${baseUrl}/mcp/app/${slug}\`
- HTTP: \`${baseUrl}/api/${slug}/run\`

Example invocation:
\`\`\`bash
curl -sS -X POST ${baseUrl}/api/${slug}/run \\
  -H 'content-type: application/json' \\
  -d '${exampleBody}'
\`\`\`

Run it without installing: ${baseUrl}/p/${slug}
`;

  return markdownResponse(body, 200, SUCCESS_CACHE_CONTROL);
});
