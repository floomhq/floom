import type { AppRecord, NormalizedManifest } from '../types.js';

const KNOWN_SOURCE_REPOS: Record<string, string> = {
  'blast-radius': 'https://github.com/floomhq/floom/tree/main/examples/blast-radius',
  'claude-wrapped': 'https://github.com/floomhq/floom/tree/main/examples/claude-wrapped',
  'dep-check': 'https://github.com/floomhq/floom/tree/main/examples/dep-check',
  'hook-stats': 'https://github.com/floomhq/floom/tree/main/examples/hook-stats',
  'session-recall': 'https://github.com/floomhq/floom/tree/main/examples/session-recall',
  'ig-nano-scout': 'https://github.com/floomhq/floom/tree/main/examples/ig-nano-scout',
};

export function buildAppSourceInfo(
  app: AppRecord,
  manifest: NormalizedManifest | null,
  baseUrl: string,
) {
  const origin = baseUrl.replace(/\/+$/, '');
  const repositoryUrl = KNOWN_SOURCE_REPOS[app.slug] ?? null;
  const actions = manifest ? Object.keys(manifest.actions) : [];
  const license = manifest?.license ?? null;
  const openapiSpecAvailable = Boolean(app.openapi_spec_cached);

  return {
    slug: app.slug,
    repository_url: repositoryUrl,
    repository_label: repositoryUrl
      ? repositoryUrl.replace('https://github.com/', '')
      : null,
    license,
    manifest: manifest
      ? {
          name: manifest.name,
          description: manifest.description,
          runtime: manifest.runtime,
          actions,
          secrets_needed: manifest.secrets_needed ?? [],
          primary_action: manifest.primary_action ?? null,
          render: manifest.render ?? null,
        }
      : null,
    openapi_spec_url: app.openapi_spec_url ?? null,
    openapi_spec_available: openapiSpecAvailable,
    raw_openapi_url: openapiSpecAvailable
      ? `${origin}/api/hub/${encodeURIComponent(app.slug)}/openapi.json`
      : null,
    install: {
      mcp_url: `${origin}/mcp/app/${app.slug}`,
      api_run_url: `${origin}/api/${app.slug}/run`,
      claude_skill_command: `claude skill add ${origin}/p/${app.slug}`,
      curl_example: `curl -X POST ${origin}/api/${app.slug}/run -H "Authorization: Bearer YOUR_TOKEN" -d '{}'`,
    },
    self_host: {
      docker_image: app.docker_image ?? `ghcr.io/floomhq/${app.slug}:latest`,
      docker_command: `docker run -e GEMINI_BYOK=$KEY -p 3000:3000 ghcr.io/floomhq/${app.slug}:latest`,
    },
  };
}
