/**
 * Manifest schema. A floom.yaml parsed from disk lands here after
 * `parse()`, with fields validated against the runtime/Input/Output unions.
 *
 * The schema intentionally re-exports the Manifest type from the runtime
 * module so there is ONE definition of what a manifest looks like.
 */
import type { Runtime } from './types.ts';

export type { Manifest, Input, InputType, Output, OutputType, Runtime } from './types.ts';

export const ALLOWED_RUNTIMES: Runtime[] = [
  'python3.12',
  'python3.11',
  'node20',
  'node22',
  'go1.22',
  'rust',
  'docker',
  'auto',
];

export const ALLOWED_INPUT_TYPES = ['string', 'number', 'boolean', 'file', 'json'] as const;
export const ALLOWED_OUTPUT_TYPES = ['markdown', 'json', 'html', 'stdout', 'file'] as const;

/**
 * The minimal required fields for a manifest. `validate()` will reject a
 * manifest missing any of them.
 */
export const REQUIRED_FIELDS = ['name', 'runtime', 'run', 'inputs', 'outputs'] as const;
