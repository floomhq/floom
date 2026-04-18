/**
 * Registry entry emitter. Writes a JSON document to stdout that the platform
 * layer (outside the sandbox) reads and turns into a Postgres row.
 *
 * See h5-h6-recursion-failure-ux.md Option B: the app never touches the
 * database. It just prints JSON. This keeps `floom-deploy` indistinguishable
 * from any other Floom app.
 *
 * The platform layer watches stdout of `slug == 'floom-deploy' && exit == 0`
 * invocations, parses this JSON, and runs the atomic slug swap transaction.
 */
import type { Manifest } from '../runtime/types.ts';

export interface RegistryEntry {
  slug: string;
  templateId: string;
  commitSha?: string;
  manifest: Manifest;
  appUrl: string;
  deployedAt: string;
}

/**
 * Build a registry entry from a successful deploy. Caller can print the
 * result to stdout for the platform layer to pick up.
 */
export function buildRegistryEntry(opts: {
  manifest: Manifest;
  templateId: string;
  commitSha?: string;
  baseUrl?: string;
}): RegistryEntry {
  const slug = slugify(opts.manifest.name);
  const baseUrl = opts.baseUrl ?? 'https://floom.app/a';
  return {
    slug,
    templateId: opts.templateId,
    commitSha: opts.commitSha,
    manifest: opts.manifest,
    appUrl: `${baseUrl}/${slug}`,
    deployedAt: new Date().toISOString(),
  };
}

export function serializeRegistryEntry(entry: RegistryEntry): string {
  return JSON.stringify(entry);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
