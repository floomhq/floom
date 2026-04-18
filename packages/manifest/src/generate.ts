/**
 * Manifest generator.
 *
 * Given a RepoSnapshot (files + README + description), run auto-detect and
 * produce a Manifest. If detection is incomplete, return a draft manifest
 * as a YAML string with `?` comments on the uncertain fields — this is the
 * H6 Scenario 2 convention.
 */
import type { Manifest } from './schema.ts';
import { detect } from '@floom/detect';
import type { RepoSnapshot, DetectResult } from '@floom/detect';

export interface GenerateResult {
  /** Fully-formed manifest, or undefined if detection couldn't produce one. */
  manifest?: Manifest;
  /** YAML string of the manifest (with ? comments if incomplete). */
  yaml: string;
  /** True if manifest is missing at least one required field. */
  isDraft: boolean;
  /** The detect result, surfaced for diagnostics. */
  detect: DetectResult;
}

/**
 * Generate a manifest from a repo snapshot. Always returns a YAML string.
 * The `isDraft` flag tells the caller whether to treat the result as a
 * ready-to-run manifest or a draft to show the user.
 */
export function generateManifest(
  repo: RepoSnapshot,
  overrides: Partial<Manifest> = {},
): GenerateResult {
  const det = detect(repo);

  const name = overrides.name ?? deriveNameFromRepo(repo.fullName);
  const displayName = overrides.displayName ?? name;
  const description = overrides.description ?? (repo.description ?? '');
  const creator = overrides.creator ?? (repo.fullName?.split('/')[0] ?? 'unknown');

  const detectedRuntime = det.runtime; // union includes 'php' | 'ruby' | 'unknown'
  const build = overrides.build ?? det.build;
  const run = overrides.run ?? det.run;
  const workdir = overrides.workdir ?? (det.workdir || undefined);

  const isDraft =
    detectedRuntime === 'unknown'
    || !run
    || det.unknownPhpExtensions !== undefined;

  // php/ruby/unknown are not in the Manifest's Runtime enum — coerce to 'auto'
  // so schema validation passes. The build/run commands carry the runtime
  // semantics anyway.
  const coercedFromDetect: Manifest['runtime'] =
    detectedRuntime === 'php' || detectedRuntime === 'ruby' || detectedRuntime === 'unknown'
      ? 'auto'
      : detectedRuntime;
  const manifestRuntime: Manifest['runtime'] = overrides.runtime ?? coercedFromDetect;

  const manifest: Manifest = {
    name,
    displayName,
    description,
    creator,
    runtime: manifestRuntime,
    ...(build ? { build } : {}),
    run: run ?? 'echo "TODO: set run command"',
    inputs: overrides.inputs ?? [],
    outputs: overrides.outputs ?? { type: 'stdout' },
    ...(overrides.secrets ? { secrets: overrides.secrets } : {}),
    ...(overrides.memoryMb ? { memoryMb: overrides.memoryMb } : {}),
    ...(overrides.timeout ? { timeout: overrides.timeout } : {}),
    ...(workdir ? { workdir } : {}),
    ...(overrides.category ? { category: overrides.category } : {}),
  };

  const yaml = toYaml(manifest, det, isDraft);
  return {
    manifest: isDraft ? undefined : manifest,
    yaml,
    isDraft,
    detect: det,
  };
}

function deriveNameFromRepo(fullName: string | undefined): string {
  if (!fullName) return 'unnamed-app';
  const parts = fullName.split('/');
  const base = parts[parts.length - 1]!;
  return base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
}

/**
 * Serialise a manifest to YAML by hand (not via the yaml lib) because we
 * need to interleave `#?` comments on uncertain fields for the draft mode.
 */
function toYaml(manifest: Manifest, det: DetectResult, isDraft: boolean): string {
  const lines: string[] = [];
  if (isDraft) {
    lines.push('# DRAFT: this manifest was auto-generated. Fields marked with `# ?` are uncertain.');
    lines.push(`# Detection notes: ${det.notes.join('; ')}`);
    if (det.fixesApplied.length) {
      lines.push(`# Fixes applied: ${det.fixesApplied.join('; ')}`);
    }
    if (det.warnings.length) {
      lines.push(`# Warnings: ${det.warnings.join('; ')}`);
    }
    lines.push('');
  }

  lines.push(`name: ${manifest.name}`);
  lines.push(`displayName: ${q(manifest.displayName)}`);
  if (manifest.description) lines.push(`description: ${q(manifest.description)}`);
  lines.push(`creator: ${manifest.creator}`);
  const runtimeLine = `runtime: ${manifest.runtime}`;
  lines.push(
    det.runtime === 'unknown' ? `${runtimeLine}     # ? auto-detect failed` : runtimeLine,
  );
  if (manifest.workdir) lines.push(`workdir: ${manifest.workdir}`);
  if (manifest.build) {
    lines.push(`build: ${q(manifest.build)}`);
  } else if (isDraft) {
    lines.push(`build: ""     # ? no build command detected`);
  }
  if (manifest.run) {
    lines.push(
      `run: ${q(manifest.run)}${!det.run ? '     # ? run command inferred' : ''}`,
    );
  } else {
    lines.push(`run: ""     # ? no run command detected, please set`);
  }

  if (manifest.inputs.length === 0) {
    lines.push('inputs: []');
  } else {
    lines.push('inputs:');
    for (const inp of manifest.inputs) {
      lines.push(`  - name: ${inp.name}`);
      lines.push(`    type: ${inp.type}`);
      lines.push(`    required: ${inp.required}`);
      if (inp.label) lines.push(`    label: ${q(inp.label)}`);
    }
  }

  lines.push(`outputs:`);
  lines.push(`  type: ${manifest.outputs.type}`);
  if (manifest.outputs.field) lines.push(`  field: ${manifest.outputs.field}`);

  if (manifest.secrets && manifest.secrets.length) {
    lines.push('secrets:');
    for (const s of manifest.secrets) lines.push(`  - ${s}`);
  }
  if (manifest.memoryMb) lines.push(`memoryMb: ${manifest.memoryMb}`);
  if (manifest.timeout) lines.push(`timeout: ${manifest.timeout}`);

  return lines.join('\n') + '\n';
}

/** Quote a string for YAML. We always use double quotes to keep it simple. */
function q(s: string): string {
  if (/^[\w./:-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
