// Floom renderer contract.
//
// Every Floom renderer (default or custom) is a React component that takes a
// single `RenderProps` object. The shape of RenderProps is borrowed from the
// Vercel AI SDK `parts` state machine: three mutually-exclusive states.
//
//   - `input-available`  : the run is in flight, only inputs exist. Render a
//                          loading state that echoes the inputs if useful.
//   - `output-available` : the run succeeded. `data` carries the parsed
//                          response body, `schema` carries the response
//                          schema (for default renderers to introspect).
//   - `output-error`     : the run failed. `error` carries a structured
//                          error object the renderer can show + retry.
//
// Custom renderers never need to import anything else from this package —
// they can treat `RenderProps` as a pure data contract.

/**
 * The 10 canonical output shapes Floom ships default renderers for. A manifest
 * can pin its output to any one of these via `renderer.output_shape`, or leave
 * it unset and Floom's schema-to-shape discriminator will pick one.
 */
export type OutputShape =
  | 'text'
  | 'markdown'
  | 'code'
  | 'table'
  | 'object'
  | 'image'
  | 'pdf'
  | 'audio'
  | 'stream'
  | 'error';

/**
 * The 14 canonical input shapes Floom ships default renderers for. A manifest
 * can pin any parameter's input to one of these via
 * `x-floom-input-shape: <shape>`, or leave it unset and Floom's
 * schema-to-shape discriminator will pick one.
 */
export type InputShape =
  | 'text'
  | 'textarea'
  | 'code'
  | 'url'
  | 'number'
  | 'enum'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'file'
  | 'image'
  | 'csv'
  | 'multifile'
  | 'json';

export const INPUT_SHAPES: readonly InputShape[] = [
  'text',
  'textarea',
  'code',
  'url',
  'number',
  'enum',
  'boolean',
  'date',
  'datetime',
  'file',
  'image',
  'csv',
  'multifile',
  'json',
] as const;

/**
 * Per-operation UX shape, set by `x-floom-shape` on an OpenAPI operation.
 *
 *   prompt — textarea composer + Claude interprets prose into fields; thread
 *            history with refinement (flyfast, openpaper, research agents).
 *   form   — schema form with `<SchemaInput>` per field + Run button; run-log
 *            history (html-to-pdf, resize-image, csv-transform).
 *   auto   — default: if the op has exactly one field and that field resolves
 *            to `textarea` shape, treat as prompt; else form.
 */
export type AppShape = 'prompt' | 'form' | 'auto';

export const APP_SHAPES: readonly AppShape[] = ['prompt', 'form', 'auto'] as const;

/**
 * A partial JSON Schema (post-dereference). Default renderers introspect this
 * to decide how to display the data (e.g. an `array` of objects with uniform
 * keys becomes a table). Custom renderers usually ignore it.
 */
export interface ResponseSchema {
  type?: string;
  format?: string;
  contentType?: string;
  items?: ResponseSchema;
  properties?: Record<string, ResponseSchema>;
  // Free-form extension fields (x-floom-*, x-display-hint, etc.).
  [key: string]: unknown;
}

/**
 * A partial JSON Schema for a request parameter or request-body field. The
 * input-shape discriminator walks this plus its `x-floom-*` extensions. Same
 * free-form extension bag as `ResponseSchema` so both sides can share code.
 */
export interface ParameterSchema {
  type?: string;
  format?: string;
  /** Preferred OpenAPI 3.1 key; falls back to `contentType` for older specs. */
  contentMediaType?: string;
  contentType?: string;
  enum?: unknown[];
  maxLength?: number;
  minLength?: number;
  items?: ParameterSchema;
  properties?: Record<string, ParameterSchema>;
  // Free-form extension fields (x-floom-input-shape, x-floom-language, etc.).
  [key: string]: unknown;
}

/**
 * Structured error envelope returned for `output-error` state. Matches
 * Floom's run envelope: `{ error, code, details }` plus optional retry
 * callback for UIs that want to wire a "try again" button.
 */
export interface RenderError {
  message: string;
  code?: string;
  details?: unknown;
}

/**
 * Render state machine. Exactly one of these three shapes at a time.
 */
export type RenderState = 'input-available' | 'output-available' | 'output-error';

/**
 * Props passed to every renderer — default or custom.
 *
 * This is the ONLY shape custom renderers need to know about. Treat it as a
 * stable contract: additive changes only, never breaking.
 */
export interface RenderProps {
  /** Current state in the machine. */
  state: RenderState;
  /**
   * The parsed response body when `state === 'output-available'`. Shape depends
   * on the app's response schema. Custom renderers cast to their own type.
   */
  data?: unknown;
  /** Input values when `state === 'input-available'`. */
  inputs?: Record<string, unknown>;
  /** Response schema when available (for default renderers to introspect). */
  schema?: ResponseSchema;
  /** Error envelope when `state === 'output-error'`. */
  error?: RenderError;
  /** Optional retry callback (wired by the host when feasible). */
  onRetry?: () => void;
  /**
   * Loading flag — true when `state === 'input-available'` OR when the host
   * is mid-stream. Renderers that care about stream mode read this.
   */
  loading?: boolean;
}

/**
 * Shape of the manifest.renderer field in apps.yaml. Parsed by openapi-ingest.
 *
 *   renderer:
 *     kind: component        # "default" or "component"
 *     entry: ./renderer.tsx  # path relative to the manifest, required for "component"
 *     output_shape: table    # optional pin — one of OutputShape
 */
export interface RendererManifest {
  kind: 'default' | 'component';
  /** Source file relative to the manifest. Required when kind === 'component'. */
  entry?: string;
  /** Optional pin: force a specific default output shape even when a custom component ships (used as the error-fallback). */
  output_shape?: OutputShape;
  /** Optional global pin for all request inputs on this operation. Per-parameter `x-floom-input-shape` wins over this. */
  input_shape?: InputShape;
  /** Optional pin for the operation-level UX mode. Parsed from `x-floom-shape` by the ingest pipeline; defaults to `auto`. */
  shape?: AppShape;
}

/**
 * Result of compiling a creator's renderer.tsx via the renderer bundler.
 */
export interface BundleResult {
  slug: string;
  bundlePath: string;
  bytes: number;
  outputShape: OutputShape;
  compiledAt: string;
  sourceHash: string;
}

/**
 * Validate a parsed renderer manifest entry. Returns the canonical shape on
 * success, throws with a human-readable message on failure. Pure: does not
 * touch the filesystem. Used by the ingest + test suites.
 */
export function parseRendererManifest(raw: unknown): RendererManifest {
  if (raw === null || raw === undefined) return { kind: 'default' };
  if (typeof raw !== 'object') {
    throw new Error(
      `renderer: expected object, got ${typeof raw}. Set "renderer: { kind: component, entry: ./renderer.tsx }" in apps.yaml.`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind ?? 'default';
  if (kind !== 'default' && kind !== 'component') {
    throw new Error(
      `renderer.kind must be "default" or "component", got ${JSON.stringify(kind)}`,
    );
  }
  const result: RendererManifest = { kind };
  if (kind === 'component') {
    if (typeof obj.entry !== 'string' || obj.entry.length === 0) {
      throw new Error(
        'renderer.kind=component requires an "entry" path (relative to the manifest)',
      );
    }
    // Reject absolute paths and traversal to keep the bundler in a sandbox.
    if (/^(\/|[a-z]:)/i.test(obj.entry) || obj.entry.includes('..')) {
      throw new Error(
        `renderer.entry must be a relative path without .. segments, got ${JSON.stringify(obj.entry)}`,
      );
    }
    result.entry = obj.entry;
  }
  if (obj.output_shape !== undefined) {
    const shape = obj.output_shape;
    const allowed: OutputShape[] = [
      'text',
      'markdown',
      'code',
      'table',
      'object',
      'image',
      'pdf',
      'audio',
      'stream',
      'error',
    ];
    if (typeof shape !== 'string' || !allowed.includes(shape as OutputShape)) {
      throw new Error(
        `renderer.output_shape must be one of ${allowed.join(', ')}, got ${JSON.stringify(shape)}`,
      );
    }
    result.output_shape = shape as OutputShape;
  }
  if (obj.input_shape !== undefined) {
    const shape = obj.input_shape;
    if (typeof shape !== 'string' || !INPUT_SHAPES.includes(shape as InputShape)) {
      throw new Error(
        `renderer.input_shape must be one of ${INPUT_SHAPES.join(', ')}, got ${JSON.stringify(shape)}`,
      );
    }
    result.input_shape = shape as InputShape;
  }
  if (obj.shape !== undefined) {
    const shape = obj.shape;
    if (typeof shape !== 'string' || !APP_SHAPES.includes(shape as AppShape)) {
      throw new Error(
        `renderer.shape must be one of ${APP_SHAPES.join(', ')}, got ${JSON.stringify(shape)}`,
      );
    }
    result.shape = shape as AppShape;
  }
  return result;
}

/**
 * Pure discriminator: walk a response schema and pick the best default output
 * shape. Precedence:
 *   1. Explicit `x-floom-output-shape` vendor extension wins.
 *   2. Stream content types (`text/event-stream`, `application/x-ndjson`).
 *   3. Image/PDF/audio content types.
 *   4. `type: array` with uniform object items → `table`.
 *   5. `type: object` → `object`.
 *   6. `type: string` with `format: markdown` → `markdown`.
 *   7. `type: string` with `x-floom-language` → `code`.
 *   8. Everything else → `text`.
 *
 * Never throws. Unknown schemas fall through to `text`.
 */
export function pickOutputShape(schema: ResponseSchema | undefined | null): OutputShape {
  if (!schema || typeof schema !== 'object') return 'text';

  const ext = (schema as Record<string, unknown>)['x-floom-output-shape'];
  if (typeof ext === 'string') {
    const allowed: OutputShape[] = [
      'text',
      'markdown',
      'code',
      'table',
      'object',
      'image',
      'pdf',
      'audio',
      'stream',
      'error',
    ];
    if (allowed.includes(ext as OutputShape)) return ext as OutputShape;
  }

  const ct = (schema.contentType || (schema as Record<string, unknown>)['content-type']) as
    | string
    | undefined;
  if (typeof ct === 'string') {
    const lower = ct.toLowerCase();
    if (lower === 'text/event-stream' || lower === 'application/x-ndjson') return 'stream';
    if (lower.startsWith('image/')) return 'image';
    if (lower === 'application/pdf') return 'pdf';
    if (lower.startsWith('audio/')) return 'audio';
    if (lower === 'text/markdown') return 'markdown';
  }

  if (schema.type === 'array') {
    const items = schema.items;
    if (items && items.type === 'object') return 'table';
    if (items && items.properties) return 'table';
    // array of primitives: still render as a simple table with one column.
    return 'table';
  }

  if (schema.type === 'object') return 'object';

  if (schema.type === 'string') {
    if (schema.format === 'markdown') return 'markdown';
    if ((schema as Record<string, unknown>)['x-floom-language']) return 'code';
  }

  return 'text';
}

/**
 * Pure discriminator: walk a parameter schema and pick the best default input
 * shape. Precedence (first match wins):
 *
 *   1. Explicit `x-floom-input-shape` vendor extension.
 *   2. `type: string, format: binary, contentMediaType: text/csv`  → csv
 *   3. `type: string, format: binary, contentMediaType: image/*`   → image
 *   4. `type: string, format: binary`                               → file
 *   5. `type: array,  items.format: binary`                         → multifile
 *   6. `type: string, format: date`                                 → date
 *   7. `type: string, format: date-time`                            → datetime
 *   8. `type: string, format: uri`                                  → url
 *   9. `type: string, enum`                                         → enum
 *  10. `type: string, contentMediaType: application/json`           → json
 *  11. `type: string, x-floom-language`                             → code
 *  12. `type: string, maxLength > 200` | `x-floom-multiline: true`  → textarea
 *  13. `type: string`                                               → text
 *  14. `type: number | type: integer`                               → number
 *  15. `type: boolean`                                              → boolean
 *
 * Never throws. Unknown schemas fall through to `text`.
 */
export function pickInputShape(schema: ParameterSchema | undefined | null): InputShape {
  if (!schema || typeof schema !== 'object') return 'text';

  const bag = schema as Record<string, unknown>;

  // 1. explicit vendor extension wins
  const ext = bag['x-floom-input-shape'];
  if (typeof ext === 'string' && INPUT_SHAPES.includes(ext as InputShape)) {
    return ext as InputShape;
  }

  const ct =
    typeof schema.contentMediaType === 'string'
      ? schema.contentMediaType.toLowerCase()
      : typeof schema.contentType === 'string'
      ? schema.contentType.toLowerCase()
      : undefined;

  // 2-4. file-family shapes (binary)
  if (schema.type === 'string' && schema.format === 'binary') {
    if (ct === 'text/csv') return 'csv';
    if (ct && ct.startsWith('image/')) return 'image';
    return 'file';
  }

  // 5. multifile
  if (schema.type === 'array' && schema.items) {
    const item = schema.items;
    const itemCt =
      typeof item.contentMediaType === 'string'
        ? item.contentMediaType.toLowerCase()
        : typeof item.contentType === 'string'
        ? item.contentType.toLowerCase()
        : undefined;
    if (item.type === 'string' && item.format === 'binary') {
      if (itemCt === 'text/csv') return 'csv';
      if (itemCt && itemCt.startsWith('image/')) return 'image';
      return 'multifile';
    }
  }

  // 6-13. string sub-shapes
  if (schema.type === 'string') {
    if (schema.format === 'date') return 'date';
    if (schema.format === 'date-time') return 'datetime';
    if (schema.format === 'uri' || schema.format === 'url') return 'url';
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return 'enum';
    if (ct === 'application/json') return 'json';
    if (bag['x-floom-language']) return 'code';
    const multiline = bag['x-floom-multiline'];
    if (multiline === true || (typeof schema.maxLength === 'number' && schema.maxLength > 200)) {
      return 'textarea';
    }
    return 'text';
  }

  // 14-15. primitives
  if (schema.type === 'number' || schema.type === 'integer') return 'number';
  if (schema.type === 'boolean') return 'boolean';

  return 'text';
}

/**
 * Resolve a per-operation `AppShape`. Given the op's declared shape and the
 * list of resolved `InputShape`s (post-`pickInputShape`), compute whether this
 * surface should render in prompt or form mode.
 *
 *   - `prompt`        → returns `prompt` unconditionally
 *   - `form`          → returns `form` unconditionally
 *   - `auto` (default)→ `prompt` if there is exactly one field AND that field
 *                       is `textarea` or `text`; else `form`.
 *
 * Callers can pass `undefined` / `null` for the op shape to mean `auto`.
 */
export function resolveAppShape(
  opShape: AppShape | undefined | null,
  inputShapes: readonly InputShape[],
): Exclude<AppShape, 'auto'> {
  if (opShape === 'prompt' || opShape === 'form') return opShape;
  if (inputShapes.length === 1) {
    const only = inputShapes[0];
    if (only === 'textarea' || only === 'text') return 'prompt';
  }
  return 'form';
}
