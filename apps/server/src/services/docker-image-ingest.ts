// Docker-image ingest pipeline (admin-gated).
//
// Opens the second ingest door for Floom: users who have already built + pushed
// a Docker image (e.g. ghcr.io/floomhq/ig-nano-scout:latest) can register it
// as an app without going through the OpenAPI flow. The docker runner
// (services/docker.ts + services/runner.ts) already knows how to launch a
// `app_type='docker'` app per-request with secrets injected as env vars; this
// pipeline just persists the app row so the runner can find it.
//
// Gating:
//   - Environment flag `FLOOM_ENABLE_DOCKER_PUBLISH=true` must be set. When
//     the flag is off (the default, and always off in prod until we open
//     self-serve in Q2), the ingest path rejects with a clear error so the
//     MCP schema can advertise the field without accidentally exposing the
//     capability.
//   - The MCP tool also applies the standard auth gate + per-user rate limit
//     from `routes/mcp.ts`; callers hit this layer after those pass.
//
// Deferred (Q2, per workplan):
//   - Image scanning / CVE gating
//   - Per-app CPU/memory quotas (the fleet defaults from services/docker.ts
//     apply today: 512m memory, 1 CPU)
//   - Multi-tenant container isolation (user NS, gVisor, etc.)
//
// Secret bindings:
//   - The creator declares `{ "IG_SESSIONID": "<vault-key>" }` at ingest time.
//     The value is the name of a key in the creator's user_secrets vault that
//     should be mirrored into the container's env as IG_SESSIONID at run time.
//   - At runtime the creator-secrets layer (see services/runner.ts) reads the
//     vault value and injects it. We persist the binding as a 'creator_override'
//     policy row + a copy of the plaintext secret in app_creator_secrets for
//     the app's workspace. If the creator hasn't set that vault key yet, we
//     still write the policy row; the run just errors cleanly with
//     missing_secret instead of the creator discovering at run time.
import Docker from 'dockerode';
import { db } from '../db.js';
import { newAppId, newSecretId } from '../lib/ids.js';
import { normalizeManifest, ManifestError } from './manifest.js';
import { slugify, SlugTakenError, deriveSlugSuggestions } from './openapi-ingest.js';
import { setPolicy, setCreatorSecret } from './app_creator_secrets.js';
import * as userSecrets from './user_secrets.js';
import type { NormalizedManifest, SessionContext } from '../types.js';

export const DOCKER_PUBLISH_FLAG = 'FLOOM_ENABLE_DOCKER_PUBLISH';

/**
 * Returns true when operator has explicitly opted in via
 * `FLOOM_ENABLE_DOCKER_PUBLISH=true`. Default is off in every mode (OSS,
 * preview, prod) until Q2 self-serve lands. Any of `1/true/yes/on` (case
 * insensitive) counts as on — matches the pattern used by FLOOM_SEED_APPS.
 */
export function isDockerPublishEnabled(): boolean {
  const raw = process.env[DOCKER_PUBLISH_FLAG];
  if (!raw) return false;
  return /^(1|true|yes|on)$/i.test(raw);
}

export class DockerPublishDisabledError extends Error {
  code = 'docker_publish_disabled' as const;
  constructor() {
    super(
      `Docker-image ingest is disabled on this Floom instance. Set ${DOCKER_PUBLISH_FLAG}=true to enable.`,
    );
    this.name = 'DockerPublishDisabledError';
  }
}

export class DockerImageIngestError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DockerImageIngestError';
    this.code = code;
  }
}

/**
 * A user-supplied binding: container env var name → user_secrets vault key.
 * At run time the creator-override layer reads the vault value and injects it
 * into the container's environment as `envKey`.
 *
 *   { "IG_SESSIONID": "instagram_session_id" }
 *
 * means "when this app runs, look up `instagram_session_id` in the ingesting
 * user's vault and set IG_SESSIONID=<that value> in the container env."
 */
export type SecretBindings = Record<string, string>;

/**
 * Minimum shape we accept in `manifest`. Callers who already know the Floom
 * manifest format can pass one verbatim; the ingest pipeline runs it through
 * `normalizeManifest()` which accepts v1 (single-action) or v2 (multi-action)
 * and normalizes into v2. We add a one-action default when the caller leaves
 * `actions` unset — it's a reasonable guess for the smallest-possible docker
 * apps (e.g. a CLI wrapped as a container that takes JSON on stdin).
 */
function synthesizeDefaultManifest(
  name: string,
  description: string,
  secrets: string[],
): NormalizedManifest {
  return {
    name,
    description: description || `${name} (Docker image)`,
    actions: {
      run: {
        label: 'Run',
        inputs: [
          {
            name: 'body',
            label: 'Input',
            type: 'textarea',
            required: false,
            description: 'JSON input for the container. Leave blank to run with no inputs.',
          },
        ],
        outputs: [{ name: 'response', label: 'Response', type: 'json' }],
      },
    },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: secrets,
    manifest_version: '2.0',
  };
}

/**
 * Parse the registry hostname out of an image reference. Docker's convention:
 *   - The first `/`-separated segment is a registry hostname only if it
 *     contains a `.` (domain) or `:` (port). Otherwise it's a Docker Hub
 *     namespace and the registry defaults to `docker.io`.
 *   - A ref with no `/` at all (e.g. `alpine`) is implicit `docker.io`.
 *
 * Examples:
 *   ghcr.io/openpaper-dev/ig-nano-scout:cli-v1 → "ghcr.io"
 *   registry.example.com:5000/team/app:v1      → "registry.example.com:5000"
 *   docker.io/library/alpine:latest            → "docker.io"
 *   library/alpine                             → "docker.io"
 *   alpine:3.19                                → "docker.io"
 */
export function parseRegistry(imageRef: string): string {
  const firstSlash = imageRef.indexOf('/');
  if (firstSlash === -1) return 'docker.io';
  const prefix = imageRef.slice(0, firstSlash);
  if (prefix.includes('.') || prefix.includes(':')) return prefix;
  return 'docker.io';
}

/**
 * Look up auth credentials for a registry from the FLOOM_REGISTRY_AUTH env var.
 *
 * Format: JSON map keyed by registry hostname:
 *   FLOOM_REGISTRY_AUTH='{"ghcr.io": {"username":"...","serveraddress":"ghcr.io","password":"<PAT>"}}'
 *
 * Returns undefined when the env var is unset, malformed, or has no entry for
 * the requested registry. Callers pull unauthenticated in that case, which is
 * the correct behavior for public images. We swallow JSON parse errors
 * deliberately: a malformed env var should not blow up the ingest path, and
 * the operator will see the 401 from the downstream pull if they intended
 * auth.
 *
 * NOTE: never log the returned object — it contains a PAT / password.
 */
export function loadRegistryAuth(registry: string): Docker.AuthConfig | undefined {
  const raw = process.env.FLOOM_REGISTRY_AUTH;
  if (!raw) return undefined;
  try {
    const map = JSON.parse(raw) as Record<string, Docker.AuthConfig>;
    return map[registry];
  } catch {
    return undefined;
  }
}

/**
 * Pull a remote image into the local daemon. Idempotent — if the image is
 * already present the daemon reports "Image is up to date" and we return.
 *
 * `docker pull` is a streaming operation; dockerode returns a response stream
 * and we drain it via `modem.followProgress`. Errors inside the stream (e.g.
 * "unauthorized: authentication required" for private registries) surface as
 * an `errorDetail` event rather than a stream error, so we explicitly look for
 * either shape.
 *
 * Private registries: the daemon's HTTP API always re-contacts the registry
 * (even when the image is cached locally) and does NOT read
 * `/root/.docker/config.json` on the daemon host, so we must pass credentials
 * explicitly as `authconfig`. We resolve them from FLOOM_REGISTRY_AUTH keyed
 * by the registry hostname parsed from the image ref. If no entry matches
 * (public images, Docker Hub without a login) we pull unauthenticated.
 */
async function pullImage(
  docker: Docker,
  imageRef: string,
  timeoutMs: number,
): Promise<void> {
  const registry = parseRegistry(imageRef);
  const authconfig = loadRegistryAuth(registry);
  const stream = await docker.pull(imageRef, authconfig ? { authconfig } : {});

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new DockerImageIngestError(
          'pull_timeout',
          `Pulling ${imageRef} timed out after ${Math.round(timeoutMs / 1000)}s`,
        ),
      );
    }, timeoutMs);

    docker.modem.followProgress(
      stream,
      (err, output) => {
        clearTimeout(timer);
        if (err) {
          reject(
            new DockerImageIngestError(
              'pull_failed',
              `Pull failed for ${imageRef}: ${err.message || err}`,
            ),
          );
          return;
        }
        const errEvent = (output || []).find(
          (e: { errorDetail?: unknown; error?: unknown }) =>
            e.errorDetail || e.error,
        );
        if (errEvent) {
          const msg =
            (typeof errEvent.error === 'string' ? errEvent.error : null) ||
            (errEvent.errorDetail &&
            typeof (errEvent.errorDetail as { message?: string }).message === 'string'
              ? (errEvent.errorDetail as { message: string }).message
              : null) ||
            'Pull failed';
          reject(new DockerImageIngestError('pull_failed', msg));
          return;
        }
        resolve();
      },
      () => {
        // progress events are noisy; we don't surface them in the current
        // MCP response. When the UI ramp lands we'll stream them to the
        // publish page instead.
      },
    );
  });
}

/**
 * Read the image's metadata after it's been pulled so callers don't have to
 * duplicate docker knowledge client-side. Surfaces description (via
 * `org.opencontainers.image.description` label) and exposed env var names —
 * both useful hints for the operator but strictly optional.
 */
interface ImageMeta {
  description?: string;
  envNames: string[];
}

async function inspectImage(docker: Docker, imageRef: string): Promise<ImageMeta> {
  try {
    const info = await docker.getImage(imageRef).inspect();
    const labels = info.Config?.Labels || {};
    const description =
      labels['org.opencontainers.image.description'] ||
      labels['io.floom.description'] ||
      undefined;
    const envPairs: string[] = info.Config?.Env || [];
    const envNames = envPairs
      .map((pair: string) => pair.split('=')[0])
      .filter((name: string) => name && !name.startsWith('PATH'));
    return { description, envNames };
  } catch {
    // Inspect is best-effort — a missing/unauthorized image will have been
    // caught during pull. If inspect itself fails we just move on with the
    // minimum viable metadata.
    return { envNames: [] };
  }
}

// Docker image reference: `[registry/]namespace/repo[:tag][@digest]`.
// We enforce a conservative shape so callers don't pass something weird that
// the daemon will silently reinterpret. Matches images like:
//   alpine
//   alpine:3.19
//   ghcr.io/floomhq/ig-nano-scout:latest
//   ghcr.io/floomhq/ig-nano-scout@sha256:abcd...
//   registry.example.com:5000/team/app:v1
const DOCKER_REF_PATTERN =
  /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?)+(?::[a-zA-Z0-9._-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/i;

function validateImageRef(ref: string): void {
  if (!ref || ref.length > 512) {
    throw new DockerImageIngestError(
      'invalid_image_ref',
      'docker_image_ref must be a non-empty string, max 512 chars',
    );
  }
  // The regex above requires at least one "/" — also accept single-component
  // tags like `alpine:3.19` (Docker Hub default). Flex the check so a plain
  // one-component ref is allowed.
  const simpleTag = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?(?::[a-zA-Z0-9._-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/i;
  if (!DOCKER_REF_PATTERN.test(ref) && !simpleTag.test(ref)) {
    throw new DockerImageIngestError(
      'invalid_image_ref',
      `docker_image_ref "${ref}" does not look like a valid image reference (expected [registry/]namespace/repo[:tag][@digest]).`,
    );
  }
}

/**
 * Top-level: pull the image, persist the app row, wire up secret bindings.
 * Gated by `isDockerPublishEnabled()` — callers must gate upstream too so the
 * MCP schema field can be hidden.
 *
 * Returns the persisted slug, name, and created flag. Throws
 * `DockerPublishDisabledError` when the flag is off, `SlugTakenError` when the
 * slug collides with another workspace's app, `ManifestError` when the caller
 * passes a bad manifest, and `DockerImageIngestError` for pull/validate failures.
 */
export async function ingestAppFromDockerImage(args: {
  docker_image_ref: string;
  name?: string;
  description?: string;
  slug?: string;
  category?: string;
  /**
   * Caller-supplied Floom manifest. Optional — if absent we synthesize a
   * minimal one-action manifest. Shape is whatever `normalizeManifest`
   * accepts (v1 single-action or v2 multi-action).
   */
  manifest?: unknown;
  /**
   * Map of container env var name → vault key in the caller's user_secrets.
   * Each binding becomes a creator_override policy row + a copy of the
   * current vault value in app_creator_secrets. If the caller has no vault
   * row for a referenced key we persist the binding anyway; runs will error
   * with missing_secret until the vault is populated.
   */
  secret_bindings?: SecretBindings;
  workspace_id: string;
  author_user_id: string;
  /**
   * Visibility override. Defaults to 'private' for cloud workspaces (so
   * user-published apps never land in the public hub by accident) and
   * 'public' for the synthetic 'local' workspace (OSS mode).
   */
  visibility?: 'public' | 'private' | 'auth-required';
  /**
   * Injected by tests to swap the Docker client for a mock. Production
   * callers leave this undefined and we build a default client against the
   * local daemon — same as services/docker.ts + services/seed.ts.
   */
  dockerClient?: Docker;
  /** Test hook: override the default pull timeout (10 min). */
  pullTimeoutMs?: number;
  /** Test hook: skip the actual pull (use when the image is already local). */
  skipPull?: boolean;
  /** Test hook: skip the actual inspect call. */
  skipInspect?: boolean;
  /** Session context — used to look up the caller's vault for secret bindings. */
  ctx?: SessionContext;
}): Promise<{ slug: string; name: string; created: boolean }> {
  if (!isDockerPublishEnabled()) {
    throw new DockerPublishDisabledError();
  }

  validateImageRef(args.docker_image_ref);

  const docker = args.dockerClient || new Docker();
  const pullTimeoutMs = args.pullTimeoutMs ?? 10 * 60 * 1000;

  if (!args.skipPull) {
    await pullImage(docker, args.docker_image_ref, pullTimeoutMs);
  }

  const meta: ImageMeta = args.skipInspect
    ? { envNames: [] }
    : await inspectImage(docker, args.docker_image_ref);

  // Derive name + slug. Prefer caller overrides, else fall back to the image
  // repo portion (e.g. `ig-nano-scout` for ghcr.io/floomhq/ig-nano-scout:latest).
  const repoName = extractRepoName(args.docker_image_ref);
  const name = args.name || repoName;
  const slug = slugify(args.slug || name);

  // Build manifest. When caller supplies one we run it through
  // `normalizeManifest` so the schema is guaranteed good; when they don't we
  // synthesize a minimal one-action default.
  const declaredSecrets = Object.keys(args.secret_bindings || {});
  let manifest: NormalizedManifest;
  if (args.manifest !== undefined) {
    try {
      manifest = normalizeManifest(args.manifest);
    } catch (err) {
      if (err instanceof ManifestError) throw err;
      throw new DockerImageIngestError(
        'manifest_invalid',
        `manifest failed validation: ${(err as Error).message}`,
      );
    }
    // Merge in bindings-declared secrets so the runner gates on them even
    // if the caller forgot to list them in `secrets_needed`. De-dupe.
    const unionSecrets = new Set([...(manifest.secrets_needed || []), ...declaredSecrets]);
    manifest = { ...manifest, secrets_needed: Array.from(unionSecrets) };
  } else {
    manifest = synthesizeDefaultManifest(
      name,
      args.description || meta.description || '',
      declaredSecrets,
    );
  }

  // Slug collision guard. Mirrors ingestAppFromSpec: same workspace can
  // re-publish to update the row; other workspaces get a SlugTakenError with
  // three recovery suggestions so the UI can render pills.
  const existing = db
    .prepare('SELECT id, workspace_id, visibility FROM apps WHERE slug = ?')
    .get(slug) as { id: string; workspace_id: string; visibility: string } | undefined;
  if (
    existing &&
    existing.workspace_id !== args.workspace_id &&
    existing.workspace_id !== 'local'
  ) {
    throw new SlugTakenError(slug, deriveSlugSuggestions(slug));
  }

  // Visibility: default to private for cloud workspaces, public for OSS 'local'.
  let visibility: 'public' | 'private' | 'auth-required';
  if (args.visibility !== undefined) {
    visibility = args.visibility;
  } else if (existing) {
    visibility =
      (existing.visibility as 'public' | 'private' | 'auth-required') || 'private';
  } else {
    visibility = args.workspace_id === 'local' ? 'public' : 'private';
  }

  const description =
    args.description ||
    (args.manifest ? manifest.description : meta.description) ||
    `${name} (Docker image)`;

  const manifestJson = JSON.stringify(manifest);

  let appId: string;
  let created: boolean;

  if (existing) {
    appId = existing.id;
    created = false;
    db.prepare(
      `UPDATE apps SET
         name=?, description=?, manifest=?, category=?, app_type='docker',
         docker_image=?, base_url=NULL, auth_type=NULL, auth_config=NULL,
         openapi_spec_url=NULL, openapi_spec_cached=NULL, visibility=?,
         is_async=0, webhook_url=NULL, timeout_ms=NULL, retries=0,
         async_mode=NULL, workspace_id=?, author=?, updated_at=datetime('now')
       WHERE slug=?`,
    ).run(
      name,
      description,
      manifestJson,
      args.category || null,
      args.docker_image_ref,
      visibility,
      args.workspace_id,
      args.author_user_id,
      slug,
    );
  } else {
    appId = newAppId();
    created = true;
    db.prepare(
      `INSERT INTO apps (
         id, slug, name, description, manifest, status, docker_image, code_path,
         category, author, icon, app_type, base_url, auth_type, auth_config,
         openapi_spec_url, openapi_spec_cached, visibility, is_async,
         webhook_url, timeout_ms, retries, async_mode, workspace_id
       ) VALUES (
         ?, ?, ?, ?, ?, 'active', ?, ?,
         ?, ?, NULL, 'docker', NULL, NULL, NULL,
         NULL, NULL, ?, 0,
         NULL, NULL, 0, NULL, ?
       )`,
    ).run(
      appId,
      slug,
      name,
      description,
      manifestJson,
      args.docker_image_ref,
      // code_path is unused when docker_image is set (same as seed.ts); we
      // store a placeholder so the NOT NULL constraint is satisfied.
      `docker-image:${slug}`,
      args.category || null,
      args.author_user_id,
      visibility,
      args.workspace_id,
    );
  }

  // Wire secret bindings. Each (envKey → vaultKey) becomes:
  //   1. a placeholder row in `secrets` so the per-app secrets UI sees it
  //   2. a 'creator_override' policy row so the runner uses the creator's value
  //   3. a copy of the current vault plaintext in `app_creator_secrets`
  //      (re-encrypted under the app's workspace DEK). Absent vault row ⇒
  //      skip step 3; runs will surface missing_secret until the creator
  //      populates their vault and republishes.
  if (args.secret_bindings && Object.keys(args.secret_bindings).length > 0) {
    const insertSecret = db.prepare(
      `INSERT OR IGNORE INTO secrets (id, name, value, app_id) VALUES (?, ?, ?, ?)`,
    );
    for (const [envKey, vaultKey] of Object.entries(args.secret_bindings)) {
      insertSecret.run(newSecretId(), envKey, '', appId);
      setPolicy(appId, envKey, 'creator_override');

      // Best-effort: copy the caller's current vault value into creator storage.
      // If no vault row exists OR we have no session ctx (OSS tests), we skip.
      if (args.ctx) {
        try {
          const plaintext = userSecrets.get(args.ctx, vaultKey);
          if (plaintext && plaintext.length > 0) {
            setCreatorSecret(appId, args.workspace_id, envKey, plaintext);
          }
        } catch (err) {
          // Vault errors are cosmetic at ingest time; the run itself will
          // surface missing_secret cleanly. Log once, don't fail the ingest.
          console.warn(
            `[docker-image-ingest] ${slug}: failed to copy vault key "${vaultKey}" into creator storage: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  return { slug, name, created };
}

/**
 * Pull the repo name out of a docker reference so we can slug-ify it.
 *   ghcr.io/floomhq/ig-nano-scout:latest  → "ig-nano-scout"
 *   floomhq/ig-nano-scout                 → "ig-nano-scout"
 *   alpine:3.19                           → "alpine"
 *   alpine@sha256:...                     → "alpine"
 */
function extractRepoName(ref: string): string {
  // Strip tag + digest.
  let clean = ref.split('@')[0];
  const lastColon = clean.lastIndexOf(':');
  const lastSlash = clean.lastIndexOf('/');
  // A ':' after the last '/' is a tag separator; a ':' before it is a port.
  if (lastColon > lastSlash) {
    clean = clean.slice(0, lastColon);
  }
  const parts = clean.split('/');
  return parts[parts.length - 1] || ref;
}
