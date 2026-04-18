/**
 * Manifest parser + validator.
 *
 * Reads a YAML string (or file) and validates it into a Manifest. Returns
 * either the typed manifest or a list of validation errors. Never throws
 * on invalid input — the caller (e.g. deployFromGithub) needs the error
 * list to ship back to the user verbatim (H6 Scenario 2).
 */
import { parse as parseYaml } from 'yaml';
import type { Manifest, Input, InputType, Output, OutputType } from './schema.ts';
import {
  ALLOWED_RUNTIMES,
  ALLOWED_INPUT_TYPES,
  ALLOWED_OUTPUT_TYPES,
  REQUIRED_FIELDS,
} from './schema.ts';

export interface ParseResult {
  ok: boolean;
  manifest?: Manifest;
  errors: string[];
}

export function parseManifest(yamlSource: string): ParseResult {
  const errors: string[] = [];
  let raw: unknown;

  try {
    raw = parseYaml(yamlSource);
  } catch (err) {
    return {
      ok: false,
      errors: [`YAML parse error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['Manifest must be a YAML mapping (not a list or scalar)'] };
  }

  const obj = raw as Record<string, unknown>;

  // Required fields
  for (const field of REQUIRED_FIELDS) {
    if (!(field in obj)) {
      errors.push(`missing required field: ${field}`);
    }
  }

  // name
  const name = obj['name'];
  if (name !== undefined && typeof name !== 'string') {
    errors.push('name must be a string');
  }

  // runtime
  const runtime = obj['runtime'];
  if (runtime !== undefined) {
    if (typeof runtime !== 'string' || !ALLOWED_RUNTIMES.includes(runtime as never)) {
      errors.push(
        `runtime must be one of: ${ALLOWED_RUNTIMES.join(', ')} (got ${JSON.stringify(runtime)})`,
      );
    }
  }

  // run
  const run = obj['run'];
  if (run !== undefined && typeof run !== 'string') {
    errors.push('run must be a string');
  }

  // inputs
  const inputs: Input[] = [];
  const inputsRaw = obj['inputs'];
  if (inputsRaw !== undefined) {
    if (!Array.isArray(inputsRaw)) {
      errors.push('inputs must be a list');
    } else {
      inputsRaw.forEach((entry, idx) => {
        if (!entry || typeof entry !== 'object') {
          errors.push(`inputs[${idx}] must be a mapping`);
          return;
        }
        const e = entry as Record<string, unknown>;
        if (typeof e['name'] !== 'string') {
          errors.push(`inputs[${idx}].name must be a string`);
          return;
        }
        const type = e['type'] as string | undefined;
        if (type !== undefined && !ALLOWED_INPUT_TYPES.includes(type as never)) {
          errors.push(
            `inputs[${idx}].type must be one of: ${ALLOWED_INPUT_TYPES.join(', ')}`,
          );
          return;
        }
        const input: Input = {
          name: e['name'],
          type: (type ?? 'string') as InputType,
          required: e['required'] === true,
        };
        if (e['default'] !== undefined) input.default = e['default'];
        if (typeof e['label'] === 'string') input.label = e['label'];
        if (typeof e['description'] === 'string') input.description = e['description'];
        if (typeof e['placeholder'] === 'string') input.placeholder = e['placeholder'];
        if (typeof e['from'] === 'string' && ['argv', 'env', 'stdin'].includes(e['from'])) {
          input.from = e['from'] as 'argv' | 'env' | 'stdin';
        }
        inputs.push(input);
      });
    }
  }

  // outputs
  let output: Output | undefined;
  const outputsRaw = obj['outputs'];
  if (outputsRaw !== undefined) {
    if (!outputsRaw || typeof outputsRaw !== 'object' || Array.isArray(outputsRaw)) {
      errors.push('outputs must be a mapping like { type: stdout }');
    } else {
      const o = outputsRaw as Record<string, unknown>;
      const type = o['type'];
      if (typeof type !== 'string' || !ALLOWED_OUTPUT_TYPES.includes(type as never)) {
        errors.push(
          `outputs.type must be one of: ${ALLOWED_OUTPUT_TYPES.join(', ')}`,
        );
      } else {
        output = { type: type as OutputType };
        if (typeof o['field'] === 'string') output.field = o['field'];
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const manifest: Manifest = {
    name: name as string,
    displayName: typeof obj['displayName'] === 'string' ? obj['displayName'] : (name as string),
    description: typeof obj['description'] === 'string' ? obj['description'] : '',
    creator: typeof obj['creator'] === 'string' ? obj['creator'] : 'unknown',
    runtime: runtime as Manifest['runtime'],
    run: run as string,
    inputs,
    outputs: output ?? { type: 'stdout' },
  };

  if (typeof obj['build'] === 'string') manifest.build = obj['build'];
  if (typeof obj['category'] === 'string') manifest.category = obj['category'];
  if (Array.isArray(obj['secrets'])) {
    manifest.secrets = (obj['secrets'] as unknown[]).filter(
      (s): s is string => typeof s === 'string',
    );
  }
  if (typeof obj['memoryMb'] === 'number') manifest.memoryMb = obj['memoryMb'];
  if (typeof obj['timeout'] === 'string') manifest.timeout = obj['timeout'];
  if (typeof obj['workdir'] === 'string') manifest.workdir = obj['workdir'];
  if (Array.isArray(obj['egressAllowlist'])) {
    manifest.egressAllowlist = (obj['egressAllowlist'] as unknown[]).filter(
      (s): s is string => typeof s === 'string',
    );
  }

  return { ok: true, manifest, errors: [] };
}
