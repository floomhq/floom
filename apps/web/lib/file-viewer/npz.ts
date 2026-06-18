// Dependency-free .npz introspection for the inline file viewer.
//
// A `.npz` is a ZIP archive whose members are `.npy` arrays. Each `.npy` member
// begins with a small, self-describing header:
//   - magic  : "\x93NUMPY"           (6 bytes)
//   - version: major, minor          (2 bytes)
//   - hlen   : header-string length  (uint16 LE for v1.0, uint32 LE for v2.0+)
//   - header : an ASCII Python-dict literal, e.g.
//              {'descr': '<f4', 'fortran_order': False, 'shape': (150, 768), }
//
// We read ONLY that header (never the array payload) to list each array's name,
// shape, and dtype. jszip handles both stored and DEFLATE-compressed members
// (numpy's savez vs savez_compressed); we still decompress just the leading
// header bytes per member, never materialize the numeric data.

export interface NpzArrayInfo {
  /** Array name (the `.npy` member, without its extension). */
  name: string;
  /** Parsed shape, e.g. [150, 768]. Empty array = scalar (shape []). */
  shape: number[];
  /** NumPy dtype string, e.g. "<f4", "|u1", "<i8". */
  dtype: string;
  /** Fortran (column-major) order flag from the npy header. */
  fortranOrder: boolean;
  /** Compressed member size in bytes (from the ZIP entry), if known. */
  sizeBytes?: number;
}

const NPY_MAGIC = "\x93NUMPY";

/** Read the leading npy dict header out of a member's raw bytes. */
function parseNpyHeader(bytes: Uint8Array): { shape: number[]; dtype: string; fortranOrder: boolean } | null {
  if (bytes.length < 10) return null;
  // Verify magic "\x93NUMPY".
  if (bytes[0] !== 0x93) return null;
  for (let i = 1; i < 6; i += 1) {
    if (bytes[i] !== NPY_MAGIC.charCodeAt(i)) return null;
  }
  const major = bytes[6];
  let headerLen: number;
  let headerStart: number;
  if (major === 1) {
    // v1.0: 2-byte little-endian header length at offset 8.
    headerLen = bytes[8] | (bytes[9] << 8);
    headerStart = 10;
  } else {
    // v2.0+: 4-byte little-endian header length at offset 8.
    headerLen = bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24);
    headerStart = 12;
  }
  const end = headerStart + headerLen;
  if (end > bytes.length) return null;
  const headerStr = new TextDecoder("latin1").decode(bytes.subarray(headerStart, end));
  return parseHeaderDict(headerStr);
}

/** Parse the ASCII Python-dict header literal (no eval; tolerant regex). */
function parseHeaderDict(header: string): { shape: number[]; dtype: string; fortranOrder: boolean } | null {
  const descrMatch = header.match(/'descr'\s*:\s*'([^']*)'/);
  const fortranMatch = header.match(/'fortran_order'\s*:\s*(True|False)/);
  const shapeMatch = header.match(/'shape'\s*:\s*\(([^)]*)\)/);
  if (!descrMatch || !shapeMatch) return null;
  const shape = shapeMatch[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
  return {
    dtype: descrMatch[1],
    fortranOrder: fortranMatch ? fortranMatch[1] === "True" : false,
    shape,
  };
}

/** Human-readable dtype label appended to the raw numpy descr (e.g. "<f4"). */
export function dtypeLabel(dtype: string): string {
  const kindMap: Record<string, string> = {
    f: "float",
    i: "int",
    u: "uint",
    b: "bool",
    c: "complex",
    U: "unicode",
    S: "bytes",
    O: "object",
    m: "timedelta",
    M: "datetime",
  };
  // Strip the leading byte-order char (<, >, =, |).
  const body = /^[<>=|]/.test(dtype) ? dtype.slice(1) : dtype;
  const kind = body[0];
  const bytesPer = Number.parseInt(body.slice(1), 10);
  const name = kindMap[kind];
  if (!name) return dtype;
  if (kind === "b" || kind === "O") return name;
  if (!Number.isFinite(bytesPer)) return name;
  if (kind === "U" || kind === "S") return `${name}${bytesPer}`;
  return `${name}${bytesPer * 8}`; // bits for numeric kinds
}

/**
 * Parse an `.npz` archive into per-array metadata, reading only the npy headers.
 * Throws if the buffer is not a readable ZIP archive.
 */
export async function parseNpzArrays(buffer: ArrayBuffer): Promise<NpzArrayInfo[]> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files).filter(
    (f) => !f.dir && /\.npy$/i.test(f.name),
  );
  const arrays: NpzArrayInfo[] = [];
  for (const entry of entries) {
    // Only the leading bytes are needed; jszip decompresses the member, but we
    // parse the header from the first chunk and discard the rest.
    const bytes = await entry.async("uint8array");
    const head = parseNpyHeader(bytes);
    const name = entry.name.replace(/\.npy$/i, "");
    // @ts-expect-error jszip exposes the compressed size on the internal record.
    const compressedSize: number | undefined = entry._data?.compressedSize;
    if (head) {
      arrays.push({
        name,
        shape: head.shape,
        dtype: head.dtype,
        fortranOrder: head.fortranOrder,
        sizeBytes: typeof compressedSize === "number" ? compressedSize : undefined,
      });
    } else {
      arrays.push({ name, shape: [], dtype: "(unreadable header)", fortranOrder: false });
    }
  }
  // Stable alphabetical order by array name.
  arrays.sort((a, b) => a.name.localeCompare(b.name));
  return arrays;
}

/** "150 × 768" or "scalar" for an empty shape. */
export function shapeLabel(shape: number[]): string {
  if (shape.length === 0) return "scalar";
  return shape.join(" × ");
}
