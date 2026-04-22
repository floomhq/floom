// Server-side counterpart to apps/web/src/api/serialize-inputs.ts.
//
// Two concerns live here:
//
//   1. Envelope validation (isFileEnvelope, assertFileEnvelope) — used
//      by `validateInputs` to accept the `{__file, content_b64, ...}`
//      shape the client produces for any InputSpec of type "file".
//
//   2. Docker materialization (materializeFileInputs) — walks the
//      inputs tree, writes each envelope to a temp dir on disk, and
//      rewrites the input value to the in-container path
//      (/floom/inputs/<name>.<ext>). Returns the host temp dir so the
//      runner can mount it read-only and clean it up afterwards.
//
// The proxied runner also consumes FileEnvelope via buildFormDataFromEnvelope
// — same shape flows through both runtimes.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';

/** On-the-wire envelope produced by apps/web/src/api/serialize-inputs.ts. */
export interface FileEnvelope {
  __file: true;
  name: string;
  mime_type: string;
  size: number;
  content_b64: string;
}

/** Path inside the container where materialized files are mounted. */
export const CONTAINER_INPUTS_DIR = '/floom/inputs';

/**
 * Server-side upper bound. Matches DEFAULT_MAX_FILE_BYTES on the client
 * plus a small slack so a near-limit upload isn't rejected by a rounding
 * mismatch between the client's pre-encode check and the server's
 * post-decode check. The server is the authoritative gate — a hostile
 * client that skipped the client check gets rejected here.
 */
export const SERVER_MAX_FILE_BYTES = 6 * 1024 * 1024;

export class FileEnvelopeError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(`File input "${field}": ${message}`);
    this.name = 'FileEnvelopeError';
    this.field = field;
  }
}

/**
 * Duck-type check for the FileEnvelope shape. We intentionally do NOT
 * assert `__file === true` at this layer — the caller should use the
 * typed asserter below which produces a readable error.
 */
export function isFileEnvelope(value: unknown): value is FileEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.__file === true &&
    typeof v.name === 'string' &&
    typeof v.content_b64 === 'string'
  );
}

/**
 * Validate the envelope strictly. Used by `validateInputs` for
 * InputType === 'file'. Rejects anything that isn't an envelope AND
 * isn't an already-materialized string path (the server may be
 * re-validating a run record where the path was substituted in).
 */
export function assertFileEnvelope(
  field: string,
  value: unknown,
): FileEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FileEnvelopeError(
      field,
      'expected a file upload object { __file, name, content_b64 }',
    );
  }
  const v = value as Record<string, unknown>;
  if (v.__file !== true) {
    throw new FileEnvelopeError(field, 'missing __file discriminator');
  }
  if (typeof v.name !== 'string' || v.name.length === 0) {
    throw new FileEnvelopeError(field, 'missing or empty "name"');
  }
  if (typeof v.content_b64 !== 'string') {
    throw new FileEnvelopeError(field, '"content_b64" must be a string');
  }
  // size is client-declared; we don't trust it for gating (the decoded
  // buffer length is what counts) but we do reject obviously malformed
  // envelopes where size is set and clearly negative or non-finite.
  if (v.size !== undefined && typeof v.size !== 'number') {
    throw new FileEnvelopeError(field, '"size" must be a number when set');
  }
  if (
    v.mime_type !== undefined &&
    typeof v.mime_type !== 'string'
  ) {
    throw new FileEnvelopeError(field, '"mime_type" must be a string when set');
  }
  return {
    __file: true,
    name: v.name,
    mime_type: typeof v.mime_type === 'string' ? v.mime_type : 'application/octet-stream',
    size: typeof v.size === 'number' ? v.size : 0,
    content_b64: v.content_b64,
  };
}

/**
 * Decode the envelope's base64 content into a Buffer. Enforces the
 * server-side size cap on the decoded length — the client cap is an
 * ergonomics gate, this is the real authority.
 */
export function decodeEnvelope(
  field: string,
  envelope: FileEnvelope,
): Buffer {
  let buf: Buffer;
  try {
    buf = Buffer.from(envelope.content_b64, 'base64');
  } catch {
    throw new FileEnvelopeError(field, 'content_b64 is not valid base64');
  }
  if (buf.length > SERVER_MAX_FILE_BYTES) {
    throw new FileEnvelopeError(
      field,
      `decoded file is ${buf.length} bytes, exceeds server cap of ${SERVER_MAX_FILE_BYTES} bytes`,
    );
  }
  return buf;
}

/**
 * Deep clone a plain-object / array tree, replacing any FileEnvelope
 * with the result of `onFile(path, envelope)`. Used by both the docker
 * runner (materialize-and-rewrite) and any future consumer that wants
 * to swap envelopes out for a different shape without mutating the
 * caller's input object.
 *
 * Primitives pass through unchanged. Non-plain objects (class
 * instances) pass through unchanged, matching the client serializer.
 */
export function mapFileEnvelopes(
  inputs: Record<string, unknown>,
  onFile: (path: string, envelope: FileEnvelope) => unknown,
): Record<string, unknown> {
  const walk = (value: unknown, path: string): unknown => {
    if (isFileEnvelope(value)) {
      return onFile(path, value);
    }
    if (Array.isArray(value)) {
      return value.map((v, i) => walk(v, `${path}[${i}]`));
    }
    if (value && typeof value === 'object') {
      const proto = Object.getPrototypeOf(value);
      if (proto === Object.prototype || proto === null) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          out[k] = walk(v, `${path}.${k}`);
        }
        return out;
      }
    }
    return value;
  };
  return walk(inputs, 'inputs') as Record<string, unknown>;
}

/**
 * Pick a file extension for the materialized path. Prefer the envelope's
 * original filename extension, fall back to a MIME-derived default, then
 * to `.bin` so the container always gets a named file.
 */
function extensionFor(envelope: FileEnvelope): string {
  const fromName = extname(envelope.name);
  if (fromName && fromName.length > 1 && fromName.length <= 8) return fromName;
  const mimeMap: Record<string, string> = {
    'text/csv': '.csv',
    'application/pdf': '.pdf',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/ogg': '.ogg',
    'audio/flac': '.flac',
    'audio/webm': '.webm',
    'audio/mp4': '.m4a',
    'application/json': '.json',
    'text/plain': '.txt',
  };
  return mimeMap[envelope.mime_type] || '.bin';
}

/**
 * Sanitize the input name to a filesystem-safe basename. Inputs are
 * declared in the manifest (validated against /^[a-zA-Z_][a-zA-Z0-9_]*$/
 * upstream), but an input inside a nested object uses a synthetic path
 * like "attachments[0]" which contains brackets — strip them.
 */
function safeBasename(path: string): string {
  // Drop the leading "inputs." prefix introduced by mapFileEnvelopes so
  // the filename matches the logical input name.
  const stripped = path.replace(/^inputs\./, '');
  return stripped.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 96) || 'file';
}

export interface MaterializedInputs {
  /** The rewritten inputs tree — every FileEnvelope has been replaced
   *  with its in-container path (CONTAINER_INPUTS_DIR/<name>.<ext>). */
  inputs: Record<string, unknown>;
  /** Absolute path on the current filesystem where the materialized files
   *  were written. Empty string when there were no file envelopes. */
  hostDir: string;
  /** Absolute path the Docker daemon must bind into the child app
   *  container. In host mode this matches hostDir; in containerized
   *  server mode it points at the host-side mirror of hostDir. */
  mountSource: string;
  /** Cleanup function the caller MUST invoke once the container has
   *  exited. No-op when hostDir is empty. Safe to call multiple times. */
  cleanup: () => void;
}

function resolveMaterializedDirs(runId: string): {
  hostDir: string;
  mountSource: string;
} {
  const suffix = `floom-${runId}`;
  const containerRoot = process.env.FLOOM_FILE_INPUTS_DIR?.trim();
  const hostRoot = process.env.FLOOM_FILE_INPUTS_HOST_DIR?.trim();
  if (containerRoot) {
    return {
      hostDir: join(containerRoot, suffix),
      mountSource: join(hostRoot || containerRoot, suffix),
    };
  }
  const root = join(tmpdir(), suffix);
  return { hostDir: root, mountSource: root };
}

/**
 * Find every FileEnvelope in `inputs`, write it to
 * `<tmpdir>/floom-<runId>/<basename>.<ext>`, and return a copy of
 * `inputs` with each envelope replaced by the in-container path
 * `CONTAINER_INPUTS_DIR/<basename>.<ext>`.
 *
 * The caller is responsible for:
 *   - Mounting `hostDir` at CONTAINER_INPUTS_DIR (read-only) on the
 *     container's HostConfig.Binds.
 *   - Invoking `cleanup()` after the container exits (in a `finally`).
 */
export function materializeFileInputs(
  runId: string,
  inputs: Record<string, unknown>,
): MaterializedInputs {
  // Two-pass: first count envelopes so we don't create a tmp dir for
  // runs that don't have any. This keeps the happy path (no file
  // inputs) zero-overhead.
  let envelopeCount = 0;
  mapFileEnvelopes(inputs, () => {
    envelopeCount++;
    return null; // return value ignored on this pass
  });
  if (envelopeCount === 0) {
    return { inputs, hostDir: '', mountSource: '', cleanup: () => {} };
  }

  const { hostDir, mountSource } = resolveMaterializedDirs(runId);
  mkdirSync(hostDir, { recursive: true, mode: 0o700 });

  // Track basenames used so two file inputs that collapse to the same
  // safe basename don't overwrite each other.
  const usedBasenames = new Set<string>();
  const rewritten = mapFileEnvelopes(inputs, (path, envelope) => {
    const ext = extensionFor(envelope);
    let base = safeBasename(path);
    // De-duplicate basenames. Collisions only happen for nested inputs
    // that strip brackets down to the same identifier — unusual but
    // deterministic.
    let basename = `${base}${ext}`;
    let suffix = 1;
    while (usedBasenames.has(basename)) {
      basename = `${base}_${suffix}${ext}`;
      suffix++;
    }
    usedBasenames.add(basename);

    const hostPath = join(hostDir, basename);
    const bytes = decodeEnvelope(path, envelope);
    writeFileSync(hostPath, bytes, { mode: 0o600 });

    return `${CONTAINER_INPUTS_DIR}/${basename}`;
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      rmSync(hostDir, { recursive: true, force: true });
    } catch {
      // best-effort; tmp is scrubbed by the OS eventually
    }
  };

  return { inputs: rewritten, hostDir, mountSource, cleanup };
}
