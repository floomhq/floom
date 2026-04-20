// Manifest validation. Accepts v1 (single-action, flat) and v2 (multi-action).
// Trimmed port of the marketplace manifest.ts — same normalized shape.
import type {
  ActionSpec,
  InputSpec,
  InputType,
  NormalizedManifest,
  OutputSpec,
  OutputType,
} from '../types.js';

const VALID_RUNTIMES = ['python', 'node'] as const;
type Runtime = (typeof VALID_RUNTIMES)[number];

const INPUT_TYPES: InputType[] = [
  'text',
  'textarea',
  'url',
  'number',
  'enum',
  'boolean',
  'date',
  'file',
];

const OUTPUT_TYPES: OutputType[] = [
  'text',
  'json',
  'table',
  'number',
  'html',
  'markdown',
  'pdf',
  'image',
  'file',
];

export class ManifestError extends Error {
  field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ManifestError';
    this.field = field;
  }
}

function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManifestError(`${field} must be an object`, field);
  }
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ManifestError(`${field} must be a non-empty string`, field);
  }
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new ManifestError(`${field} must be an array of strings`, field);
  }
}

function validateInput(raw: unknown, prefix: string): InputSpec {
  assertObject(raw, prefix);
  assertString(raw.name, `${prefix}.name`);
  assertString(raw.label, `${prefix}.label`);
  if (typeof raw.type !== 'string' || !INPUT_TYPES.includes(raw.type as InputType)) {
    throw new ManifestError(
      `${prefix}.type must be one of: ${INPUT_TYPES.join(', ')}`,
      `${prefix}.type`,
    );
  }
  const spec: InputSpec = {
    name: raw.name,
    label: raw.label,
    type: raw.type as InputType,
  };
  if (raw.required !== undefined) {
    if (typeof raw.required !== 'boolean') {
      throw new ManifestError(`${prefix}.required must be a boolean`, `${prefix}.required`);
    }
    spec.required = raw.required;
  }
  if (raw.default !== undefined) spec.default = raw.default;
  if (raw.placeholder !== undefined && typeof raw.placeholder === 'string') {
    spec.placeholder = raw.placeholder;
  }
  if (raw.description !== undefined && typeof raw.description === 'string') {
    spec.description = raw.description;
  }
  if (spec.type === 'enum') {
    if (!Array.isArray(raw.options) || raw.options.some((o) => typeof o !== 'string')) {
      throw new ManifestError(
        `${prefix}.options must be an array of strings for enum inputs`,
        `${prefix}.options`,
      );
    }
    spec.options = raw.options as string[];
  }
  return spec;
}

function validateOutput(raw: unknown, prefix: string): OutputSpec {
  assertObject(raw, prefix);
  assertString(raw.name, `${prefix}.name`);
  assertString(raw.label, `${prefix}.label`);
  if (typeof raw.type !== 'string' || !OUTPUT_TYPES.includes(raw.type as OutputType)) {
    throw new ManifestError(
      `${prefix}.type must be one of: ${OUTPUT_TYPES.join(', ')}`,
      `${prefix}.type`,
    );
  }
  const spec: OutputSpec = {
    name: raw.name,
    label: raw.label,
    type: raw.type as OutputType,
  };
  if (raw.description !== undefined && typeof raw.description === 'string') {
    spec.description = raw.description;
  }
  return spec;
}

function validateAction(raw: unknown, actionName: string): ActionSpec {
  assertObject(raw, `actions.${actionName}`);
  assertString(raw.label, `actions.${actionName}.label`);
  if (!Array.isArray(raw.inputs)) {
    throw new ManifestError(
      `actions.${actionName}.inputs must be an array`,
      `actions.${actionName}.inputs`,
    );
  }
  if (!Array.isArray(raw.outputs)) {
    throw new ManifestError(
      `actions.${actionName}.outputs must be an array`,
      `actions.${actionName}.outputs`,
    );
  }
  const action: ActionSpec = {
    label: raw.label,
    inputs: raw.inputs.map((input, i) =>
      validateInput(input, `actions.${actionName}.inputs[${i}]`),
    ),
    outputs: raw.outputs.map((output, i) =>
      validateOutput(output, `actions.${actionName}.outputs[${i}]`),
    ),
  };
  if (raw.description !== undefined && typeof raw.description === 'string') {
    action.description = raw.description;
  }
  // Per-action secrets (optional). Set by the OpenAPI ingest pipeline to
  // scope the proxied-runner's required-secret check to the operations
  // that actually reference a given security scheme. Fix for
  // INGEST-SECRETS-GLOBAL (2026-04-16).
  if (raw.secrets_needed !== undefined) {
    assertStringArray(raw.secrets_needed, `actions.${actionName}.secrets_needed`);
    action.secrets_needed = raw.secrets_needed;
  }
  return action;
}

/**
 * Parse + validate a manifest. Accepts both v1.0 (single-action, flat shape)
 * and v2.0 (multi-action). Returns the normalized v2 shape.
 */
export function normalizeManifest(raw: unknown): NormalizedManifest {
  assertObject(raw, 'manifest');
  assertString(raw.name, 'name');
  assertString(raw.description, 'description');

  const version = raw.manifest_version;
  if (version !== '1.0' && version !== '2.0') {
    throw new ManifestError(
      `manifest_version must be "1.0" or "2.0", got ${JSON.stringify(version)}`,
      'manifest_version',
    );
  }

  let runtime: Runtime = 'python';
  if (raw.runtime !== undefined) {
    if (typeof raw.runtime !== 'string' || !VALID_RUNTIMES.includes(raw.runtime as Runtime)) {
      throw new ManifestError(
        `runtime must be one of: ${VALID_RUNTIMES.join(', ')}`,
        'runtime',
      );
    }
    runtime = raw.runtime as Runtime;
  }

  const python_dependencies: string[] = [];
  if (raw.python_dependencies !== undefined) {
    assertStringArray(raw.python_dependencies, 'python_dependencies');
    python_dependencies.push(...raw.python_dependencies);
  }

  const node_dependencies: Record<string, string> = {};
  if (raw.node_dependencies !== undefined) {
    assertObject(raw.node_dependencies, 'node_dependencies');
    for (const [pkg, ver] of Object.entries(raw.node_dependencies)) {
      if (typeof ver !== 'string') {
        throw new ManifestError(
          `node_dependencies.${pkg} must be a version string`,
          `node_dependencies.${pkg}`,
        );
      }
      node_dependencies[pkg] = ver;
    }
  }

  const secrets_needed: string[] = [];
  if (raw.secrets_needed !== undefined) {
    assertStringArray(raw.secrets_needed, 'secrets_needed');
    secrets_needed.push(...raw.secrets_needed);
  }

  let actions: Record<string, ActionSpec>;
  if (version === '1.0') {
    if (!Array.isArray(raw.inputs)) {
      throw new ManifestError('inputs must be an array (v1.0)', 'inputs');
    }
    if (!Array.isArray(raw.outputs)) {
      throw new ManifestError('outputs must be an array (v1.0)', 'outputs');
    }
    actions = {
      run: {
        label: 'Run',
        inputs: raw.inputs.map((input, i) => validateInput(input, `inputs[${i}]`)),
        outputs: raw.outputs.map((output, i) => validateOutput(output, `outputs[${i}]`)),
      },
    };
  } else {
    assertObject(raw.actions, 'actions');
    const rawActions = raw.actions as Record<string, unknown>;
    const names = Object.keys(rawActions);
    if (names.length === 0) {
      throw new ManifestError('actions must contain at least one action', 'actions');
    }
    actions = {};
    for (const name of names) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        throw new ManifestError(
          `action name "${name}" must be a valid identifier`,
          `actions.${name}`,
        );
      }
      actions[name] = validateAction(rawActions[name], name);
    }
  }

  const apt_packages: string[] = [];
  if (raw.apt_packages !== undefined) {
    assertStringArray(raw.apt_packages, 'apt_packages');
    apt_packages.push(...(raw.apt_packages as string[]));
  }

  return {
    name: raw.name,
    description: raw.description,
    actions,
    runtime,
    python_dependencies,
    node_dependencies,
    secrets_needed,
    manifest_version: version as '1.0' | '2.0',
    ...(apt_packages.length > 0 && { apt_packages }),
    ...(typeof raw.license === 'string' && raw.license.trim().length > 0
      ? { license: raw.license.trim() }
      : {}),
  };
}

/**
 * Validate inputs for a specific action against its schema.
 */
export function validateInputs(
  action: ActionSpec,
  rawInputs: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const spec of action.inputs) {
    const value = rawInputs[spec.name];
    if (value === undefined || value === null || value === '') {
      if (spec.required) {
        throw new ManifestError(`Missing required input: ${spec.name}`, spec.name);
      }
      if (spec.default !== undefined) cleaned[spec.name] = spec.default;
      continue;
    }
    if (spec.type === 'number') {
      const n = typeof value === 'number' ? value : Number(value);
      if (Number.isNaN(n)) {
        throw new ManifestError(`Input ${spec.name} must be a number`, spec.name);
      }
      cleaned[spec.name] = n;
    } else if (spec.type === 'boolean') {
      // Plain `Boolean(value)` treats the *string* 'false' as truthy,
      // which is wrong for HTML forms, query params, and any HTTP client
      // that serializes booleans as strings. Audit fn-16 (2026-04-20)
      // flagged this as a silent correctness bug. Accept: actual
      // booleans, the strings 'true'/'false' (case-insensitive), and
      // numeric 0/1. Anything else throws so callers can't quietly
      // get the wrong answer.
      if (typeof value === 'boolean') {
        cleaned[spec.name] = value;
      } else if (typeof value === 'number' && (value === 0 || value === 1)) {
        cleaned[spec.name] = value === 1;
      } else if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true' || normalized === '1') {
          cleaned[spec.name] = true;
        } else if (normalized === 'false' || normalized === '0') {
          cleaned[spec.name] = false;
        } else {
          throw new ManifestError(
            `Input ${spec.name} must be a boolean (true/false)`,
            spec.name,
          );
        }
      } else {
        throw new ManifestError(
          `Input ${spec.name} must be a boolean (true/false)`,
          spec.name,
        );
      }
    } else if (spec.type === 'enum') {
      if (typeof value !== 'string' || !spec.options?.includes(value)) {
        throw new ManifestError(
          `Input ${spec.name} must be one of: ${spec.options?.join(', ')}`,
          spec.name,
        );
      }
      cleaned[spec.name] = value;
    } else {
      cleaned[spec.name] = value;
    }
  }
  return cleaned;
}
