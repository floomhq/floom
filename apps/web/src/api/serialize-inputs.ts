// Runtime-agnostic file-input serializer.
//
// Problem: `JSON.stringify({ inputs })` drops `File` objects to `{}`, so a
// CSV/PDF/image uploaded through the default renderer never reaches the
// app — the Docker runtime never sees the bytes, and the proxied runtime
// only worked because of a separate base64 branch added in 69d036a.
//
// Fix at the root: before JSON.stringify, walk the inputs tree and
// replace every `File` with the serialized envelope below. The Docker
// runner then materializes each envelope to a file on disk and mounts
// the directory into the container; the proxied runner decodes the same
// envelope into a Blob for multipart bodies. One shape, two runtimes.
//
// Envelope:
//   {
//     __file: true,             // discriminator — never clashes with real keys
//     name: string,             // original filename ("data.csv")
//     mime_type: string,        // best-effort MIME (file.type || 'application/octet-stream')
//     size: number,             // bytes
//     content_b64: string,      // base64-encoded file contents
//   }
//
// Recursion: object-type inputs can nest, so we walk plain objects and
// arrays. Primitive values (string, number, boolean, null) pass through.
// Dates / Maps / Sets are passed as-is — JSON.stringify handles Dates and
// drops the others naturally, matching existing behavior.

/** Runtime envelope the server sees on the wire. */
export interface FileEnvelope {
  __file: true;
  name: string;
  mime_type: string;
  size: number;
  content_b64: string;
}

/** Default per-file size cap. 5 MB is large enough for CSVs, PDFs,
 * screenshots, and short audio clips, small enough that a user who drops
 * a 100 MB video gets a clear error instead of a frozen tab and a
 * base64-encoding OOM. Override per call. */
export const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

export class FileInputTooLargeError extends Error {
  /** Key path where the oversized file was found (e.g. "inputs.data"
   * or "inputs.attachments[2]"), so the UI can point the user at the
   * right field instead of a generic "a file was too big". */
  path: string;
  size: number;
  limit: number;
  constructor(path: string, size: number, limit: number) {
    super(
      `File at ${path} is ${formatBytes(size)} — the ${formatBytes(limit)} cap was exceeded.`,
    );
    this.name = 'FileInputTooLargeError';
    this.path = path;
    this.size = size;
    this.limit = limit;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function fileToEnvelope(file: File): Promise<FileEnvelope> {
  const buf = await file.arrayBuffer();
  // Browser-safe base64: chunked to avoid call-stack overflows on large
  // files. 0x8000 = 32 KB chunks keeps String.fromCharCode.apply stable
  // across every browser we care about.
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  // btoa is a browser global. In non-browser callers (tests) they can
  // polyfill it or pass a pre-encoded envelope.
  const content_b64 = btoa(binary);
  return {
    __file: true,
    name: file.name,
    mime_type: file.type || 'application/octet-stream',
    size: file.size,
    content_b64,
  };
}

export interface SerializeOptions {
  /** Per-file byte cap. Defaults to DEFAULT_MAX_FILE_BYTES. */
  maxBytesPerFile?: number;
}

/**
 * Recursively walk `inputs` and replace every `File` with a FileEnvelope.
 * Plain objects and arrays are traversed; primitives pass through.
 *
 * Size cap is enforced BEFORE base64-encoding — a 100 MB video throws
 * immediately instead of blocking the main thread on the encode. The
 * error carries the key path so the caller can surface it on the right
 * input field.
 */
export async function serializeInputs(
  inputs: Record<string, unknown>,
  options: SerializeOptions = {},
): Promise<Record<string, unknown>> {
  const limit = options.maxBytesPerFile ?? DEFAULT_MAX_FILE_BYTES;

  const walk = async (value: unknown, path: string): Promise<unknown> => {
    // File check first — File extends Blob, so this branch also catches
    // File subclasses without matching arbitrary Blobs (the server-side
    // contract is specifically File-shaped: name + type + size).
    if (typeof File !== 'undefined' && value instanceof File) {
      if (value.size > limit) {
        throw new FileInputTooLargeError(path, value.size, limit);
      }
      return fileToEnvelope(value);
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        out.push(await walk(value[i], `${path}[${i}]`));
      }
      return out;
    }
    if (value && typeof value === 'object') {
      // Only walk plain objects. Typed objects (Dates, class instances)
      // fall through to JSON.stringify which handles them or drops them
      // — same behavior as before.
      const proto = Object.getPrototypeOf(value);
      if (proto === Object.prototype || proto === null) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          out[k] = await walk(v, `${path}.${k}`);
        }
        return out;
      }
    }
    return value;
  };

  const result = (await walk(inputs, 'inputs')) as Record<string, unknown>;
  return result;
}
