// v16 renderer cascade.
//
// Layer 1 — Creator custom renderer (PR #10 + PR #22 iframe sandbox) is
// handled upstream in RunSurface.tsx and is NOT revisited here. When the
// custom renderer is mounted the cascade below runs inside its children
// as the fallback, so everything still flows to the same entry point.
//
// Layer 2 — `manifest.render.output_component` points at one of the stock
// library components. Extra keys on the `render` object are passed to the
// component as props, with one convention: any key ending in `_field`
// refers to a key on the run output (e.g. `value_field: "uuid"` means
// "pluck output.uuid as the `value` prop").
//
// Layer 3 — Auto-pick from the manifest's declared output types (the real
// path is `manifest.actions[<action>].outputs[]`, not `output_schema` —
// the latter does not exist on any app today).
//
// Layer 3b (2026-04-20, output-cascade-landing-polish) — when Layer 3 has
// no opinion (the common case for OpenAPI-ingested apps where every
// declared output is generic `json`), fall through to shape-based
// heuristics on the runtime value: scalar → ScalarBig, single URL →
// UrlLink, array of strings → StringList, array of objects → RowTable,
// object with one headline field + numeric meta → HeadlineWithMeta, and
// an object with 3+ heterogeneous fields → KeyValueTable. Only if NONE of
// those fit does the caller finally fall into the JsonRaw dump. This
// fixes the product-audit finding that utility apps (uuid, password,
// jwt-decode, word-count, base64) were rendering as raw JSON despite the
// landing's "Not raw JSON" promise.
//
// Layer 4 — `null`, which signals "fall through to the caller's default"
// (the JsonRaw card in OutputPanel.tsx).
// The default `import React` form is intentional: running this file
// under the tsx CLI (classic JSX transform, see
// test/stress/test-renderer-cascade.mjs) needs React in scope. The web
// build uses `jsx: react-jsx` and does not require it, but re-exporting
// keeps `noUnusedLocals` happy in both worlds without a second tsconfig.
import React, { type ReactElement } from 'react';
import type { ActionSpec, AppDetail, OutputSpec, RenderConfig } from '../../lib/types';

export { React };
import { CodeBlock } from './CodeBlock';
import { FileDownload } from './FileDownload';
import { HeadlineWithMeta } from './HeadlineWithMeta';
import { ImageView } from './ImageView';
import { KeyValueTable } from './KeyValueTable';
import { Markdown } from './Markdown';
import { RowTable } from './RowTable';
import { ScalarBig } from './ScalarBig';
import { StringList } from './StringList';
import { TextBig } from './TextBig';
import { UrlLink } from './UrlLink';

type AnyProps = Record<string, unknown>;
type LibraryComponent = (props: AnyProps) => ReactElement | null;

export const OUTPUT_LIBRARY: Record<string, LibraryComponent> = {
  TextBig: TextBig as unknown as LibraryComponent,
  ScalarBig: ScalarBig as unknown as LibraryComponent,
  CodeBlock: CodeBlock as unknown as LibraryComponent,
  Markdown: Markdown as unknown as LibraryComponent,
  FileDownload: FileDownload as unknown as LibraryComponent,
  UrlLink: UrlLink as unknown as LibraryComponent,
  ImageView: ImageView as unknown as LibraryComponent,
  StringList: StringList as unknown as LibraryComponent,
  KeyValueTable: KeyValueTable as unknown as LibraryComponent,
  RowTable: RowTable as unknown as LibraryComponent,
  HeadlineWithMeta: HeadlineWithMeta as unknown as LibraryComponent,
};

function getField(output: unknown, fieldName: string): unknown {
  if (!output || typeof output !== 'object') return undefined;
  return (output as Record<string, unknown>)[fieldName];
}

function pluckString(output: unknown, fieldName: string | undefined): string | undefined {
  if (!fieldName) return undefined;
  const v = getField(output, fieldName);
  if (typeof v === 'string') return v;
  // UUID-style apps return an array of strings; auto-flatten to first item.
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

/**
 * Targets that expect the raw plucked value (array, object, number,
 * boolean) rather than a string. Keeps the "pluck a string" default
 * for historical `value_field` / `code_field` / `bytes_field` consumers
 * but routes list-shaped targets like `items_field` and `rows_field`
 * through so StringList / RowTable receive their native types.
 */
// `value_field` intentionally NOT in here — it has legacy "pluck first
// item of an array as a string" semantics (used by older UUID apps
// pinned to TextBig) that the string path preserves.
const RAW_PLUCK_TARGETS = new Set(['items', 'rows', 'entries', 'meta']);

/**
 * Resolve a RenderConfig against a concrete run output. Any `*_field`
 * key is replaced with its plucked value. Most targets expect a string
 * (see pluckString); list-shaped targets in RAW_PLUCK_TARGETS receive
 * the raw value so e.g. `items_field: 'uuids'` passes the whole array
 * into StringList. Returns `null` if a required field could not be
 * resolved.
 */
function resolveRenderProps(
  render: RenderConfig,
  runOutput: unknown,
): AnyProps | null {
  const props: AnyProps = {};
  for (const [key, raw] of Object.entries(render)) {
    if (key === 'output_component') continue;
    if (key.endsWith('_field') && typeof raw === 'string') {
      const targetKey = key.slice(0, -'_field'.length);
      if (RAW_PLUCK_TARGETS.has(targetKey)) {
        const value = getField(runOutput, raw);
        if (value === undefined) return null;
        props[targetKey] = value;
      } else {
        const value = pluckString(runOutput, raw);
        if (value === undefined) {
          // Missing the referenced field — bail out so the caller can
          // fall through to the next cascade layer instead of rendering
          // an empty card.
          return null;
        }
        props[targetKey] = value;
      }
    } else {
      props[key] = raw;
    }
  }
  return props;
}

interface CascadeArgs {
  app: Pick<AppDetail, 'manifest' | 'slug'>;
  action?: string;
  runOutput: unknown;
  /**
   * Issue #282: RowTable uses these to name the downloaded CSV, e.g.
   * `lead-scorer-<run_id>.csv`. Both are optional — RowTable falls back
   * to a timestamped filename if either is missing.
   */
  runId?: string;
}

export interface CascadeResult {
  kind: 'library' | 'auto' | 'shape' | 'fallback';
  element: ReactElement | null;
}

const MARKDOWN_FIELD_NAMES = ['markdown', 'summary', 'report', 'article'];

// Fields that, when present on an otherwise small object, should be
// promoted as the "headline" in HeadlineWithMeta. Ordered — earlier
// names win. Kept narrow on purpose: we only promote a field when the
// creator clearly meant "this is the answer" (a generated password, a
// result, a summary). Anything else falls through to KeyValueTable.
const HEADLINE_FIELD_NAMES = [
  'password',
  'message',
  'answer',
  'result',
  'text',
  'output',
  'value',
  'summary',
];

function findAction(app: Pick<AppDetail, 'manifest'>, actionKey?: string): ActionSpec | undefined {
  const actions = app.manifest?.actions;
  if (!actions) return undefined;
  if (actionKey && actions[actionKey]) return actions[actionKey];
  // Fall back to the first defined action so pages that do not yet
  // track the invoked action key still render something sensible.
  const first = Object.values(actions)[0];
  return first;
}

// ---------- Layer 3a: schema-driven auto-pick (unchanged pre-v16) ----

function autoPick(outputs: OutputSpec[], runOutput: unknown): ReactElement | null {
  if (!runOutput || typeof runOutput !== 'object') return null;
  const outObj = runOutput as Record<string, unknown>;

  // 1. html preview → FileDownload with inline iframe preview
  const htmlSpec = outputs.find((o) => o.type === 'html');
  if (htmlSpec) {
    const html = outObj[htmlSpec.name];
    if (typeof html === 'string' && html.length > 0) {
      return (
        <FileDownload
          filename={`${htmlSpec.name}.html`}
          mime="text/html"
          bytes={typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(html))) : undefined}
          previewHtml={html}
        />
      );
    }
  }

  // 2. Markdown-style text → Markdown (keeps PR #7 behaviour)
  for (const name of MARKDOWN_FIELD_NAMES) {
    const v = outObj[name];
    if (typeof v === 'string' && v.length > 0) {
      return <Markdown content={v} />;
    }
  }

  // 3. Single string output → code vs text. Language-shaped values
  //    (json / xml) go to CodeBlock regardless of length because
  //    collapsing structure onto one line defeats the point. Short
  //    plain strings → TextBig. Fall through otherwise so the legacy
  //    JSON dump keeps its PR #7 polish.
  const stringOutputs = outputs.filter((o) => o.type === 'text' || o.type === 'markdown');
  if (stringOutputs.length === 1) {
    const spec = stringOutputs[0];
    const v = outObj[spec.name];
    if (typeof v === 'string') {
      const langHint = /^\s*[\[{]/.test(v)
        ? 'json'
        : /^\s*</.test(v)
        ? 'xml'
        : undefined;
      if (langHint) {
        return <CodeBlock code={v} language={langHint} />;
      }
      if (v.length < 200 && !v.includes('\n')) {
        return <TextBig value={v} />;
      }
    }
  }

  return null;
}

// ---------- Layer 3b: shape-driven auto-pick (added 2026-04-20) ------
//
// Runs when Layer 3a returned null. Looks at the runtime value only —
// no schema. Covers the common OpenAPI-ingested shapes (uuid → {uuids:
// [...]}, password → {password, alphabet_size, entropy_bits}, jwt-decode
// → {header, payload, ...}, etc.) which all have a single declared
// output type of `json` and therefore bypass the schema-driven cascade.

// These predicates intentionally return plain `boolean`, NOT a type
// guard. Using `v is string` narrows the variable to `never` in the
// *else* branches of an if-chain, which breaks callers that run more
// than one of them in sequence on the same value. Each call site guards
// with its own `typeof v === 'string'` before indexing.
function looksLikeUrl(v: unknown): boolean {
  return typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());
}

function looksLikeImage(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  if (/^data:image\/[a-z0-9+.-]+;base64,/i.test(v)) return true;
  if (/^https?:\/\/\S+\.(png|jpg|jpeg|gif|webp|svg)(\?|#|$)/i.test(v.trim())) return true;
  return false;
}

function isArrayOfStrings(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((item) => typeof item === 'string')
  );
}

function isArrayOfFlatObjects(v: unknown): v is Array<Record<string, unknown>> {
  if (!Array.isArray(v) || v.length === 0) return false;
  if (v.length > 500) return false;
  let keySignature: string | null = null;
  for (const item of v.slice(0, 10)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const keys = Object.keys(item).sort().join(',');
    if (keySignature === null) keySignature = keys;
    // Allow slight variation (optional fields) — as long as the first
    // 10 rows share at least half their keys.
    const overlap = keys
      .split(',')
      .filter((k) => keySignature!.split(',').includes(k)).length;
    if (overlap < Math.ceil(keySignature.split(',').length / 2)) return false;
  }
  return true;
}

function pickHeadlineField(
  obj: Record<string, unknown>,
): string | null {
  for (const candidate of HEADLINE_FIELD_NAMES) {
    const v = obj[candidate];
    if (typeof v === 'string' && v.length > 0) return candidate;
  }
  return null;
}

function formatMetaValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? value.toLocaleString('en-US')
      : String(value);
  }
  if (typeof value === 'string') {
    return value.length > 40 ? value.slice(0, 37) + '...' : value;
  }
  return JSON.stringify(value).slice(0, 40);
}

function humanizeKey(key: string): string {
  return key.replace(/[_-]+/g, ' ');
}

/**
 * Runtime-shape auto-pick. Inspects the runtime value and returns a
 * best-fit library component, or null when nothing obvious fits.
 * Exported so OutputPanel.tsx's legacy OutputRenderer (used when no
 * appDetail is available) can reuse the same heuristics before falling
 * into the JsonRaw dump.
 */
export function shapePick(
  runOutput: unknown,
  ctx?: { appSlug?: string; runId?: string },
): ReactElement | null {
  // Scalar top-level values are already handled by the OutputRenderer's
  // pre-existing "not an object" branch. The shape-pick layer only
  // triggers on objects.
  if (!runOutput || typeof runOutput !== 'object') return null;
  const appSlug = ctx?.appSlug;
  const runId = ctx?.runId;

  // Arrays at the top level. Array of strings → StringList, array of
  // flat objects → RowTable. Anything else falls through.
  if (Array.isArray(runOutput)) {
    if (isArrayOfStrings(runOutput)) {
      return <StringList items={runOutput} />;
    }
    if (isArrayOfFlatObjects(runOutput)) {
      return <RowTable rows={runOutput} appSlug={appSlug} runId={runId} />;
    }
    return null;
  }

  const obj = runOutput as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return null;

  // Single-key objects: unwrap and recurse. A response like
  // `{uuids: ['...']}` is really "the value is the list", not "object
  // with one field". Same for `{result: 42}`, `{url: '...'}` etc.
  if (keys.length === 1) {
    const onlyKey = keys[0];
    const inner = obj[onlyKey];
    const label = humanizeKey(onlyKey);

    if (typeof inner === 'string') {
      if (looksLikeImage(inner)) return <ImageView src={inner} label={label} />;
      if (looksLikeUrl(inner)) return <UrlLink url={inner} label={label} />;
      // Short single-string value → TextBig (same behaviour as the
      // schema-driven path). Keep markdown-ish long strings out of
      // this branch; they'll fall to the Markdown component if they
      // match the Layer 3a markdown field names.
      if (inner.length < 200 && !inner.includes('\n')) {
        return <TextBig value={inner} />;
      }
      // Long single-string value: render as markdown (cheap, safe —
      // react-markdown is already loaded for the Markdown component).
      return <Markdown content={inner} />;
    }
    if (typeof inner === 'number' || typeof inner === 'boolean') {
      return <ScalarBig value={inner} label={label} />;
    }
    if (isArrayOfStrings(inner)) {
      return <StringList items={inner} label={label} />;
    }
    if (isArrayOfFlatObjects(inner)) {
      return <RowTable rows={inner} label={label} appSlug={appSlug} runId={runId} />;
    }
    // Unwrapped value is a nested object — continue with the current
    // object (still falls into the headline / key-value path below
    // using the outer object since we couldn't render the inner).
  }

  // Before-the-table special cases: a single URL / image / preview
  // field dominates the object — surface it on its own.
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (looksLikeImage(v) && keys.length <= 3) {
      return <ImageView src={v as string} label={humanizeKey(key)} />;
    }
    if (looksLikeUrl(v) && keys.length <= 3) {
      return <UrlLink url={v as string} label={humanizeKey(key)} />;
    }
    if (
      (key === 'preview' || key === 'html') &&
      typeof v === 'string' &&
      v.length >= 200
    ) {
      return (
        <FileDownload
          filename={`${key}.html`}
          mime="text/html"
          bytes={typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(v))) : undefined}
          previewHtml={v}
        />
      );
    }
  }

  // Headline-with-meta: one "result-y" string field + a small number of
  // scalar meta fields. Example: {password, length, alphabet_size,
  // entropy_bits} → password is the headline, the rest are chips.
  const headlineKey = pickHeadlineField(obj);
  if (headlineKey) {
    const headline = obj[headlineKey] as string;
    const metaEntries = Object.entries(obj).filter(
      ([k, v]) =>
        k !== headlineKey &&
        (typeof v === 'string' ||
          typeof v === 'number' ||
          typeof v === 'boolean') &&
        (typeof v !== 'string' || v.length <= 60),
    );
    // Only use HeadlineWithMeta when meta fits on a single row of chips
    // (else it's a key/value table). 1..6 small scalar chips is the
    // target; more than that and the chips wrap awkwardly.
    if (metaEntries.length >= 1 && metaEntries.length <= 6) {
      return (
        <HeadlineWithMeta
          headline={headline}
          headlineLabel={humanizeKey(headlineKey)}
          meta={metaEntries.map(([k, v]) => ({
            label: humanizeKey(k),
            value: formatMetaValue(v),
          }))}
        />
      );
    }
    if (metaEntries.length === 0) {
      return <TextBig value={headline} />;
    }
  }

  // Object with 2+ fields of mixed type → KeyValueTable. Beats a raw
  // JSON dump for the common "here's a bag of structured results" case
  // (jwt-decode, hash, word-count).
  if (keys.length >= 2 && keys.length <= 30) {
    return <KeyValueTable entries={Object.entries(obj)} />;
  }

  return null;
}

/**
 * Pick a component to mount for this run. Returns `{kind:'fallback',
 * element: null}` to signal the caller should render its JsonRaw
 * fallback.
 */
export function pickRenderer({ app, action, runOutput, runId }: CascadeArgs): CascadeResult {
  const appSlug = app.slug;
  const render = app.manifest?.render;
  if (render && typeof render.output_component === 'string') {
    const Component = OUTPUT_LIBRARY[render.output_component];
    if (Component) {
      const resolved = resolveRenderProps(render, runOutput);
      if (resolved) {
        // Issue #282: if the manifest pinned RowTable, splice in the
        // download-naming props. Harmless for other components because
        // RowTableProps declares them as optional and they're ignored
        // elsewhere.
        if (render.output_component === 'RowTable') {
          resolved.appSlug = appSlug;
          resolved.runId = runId;
        }
        return { kind: 'library', element: <Component {...resolved} /> };
      }
    }
    // Unknown component name OR missing referenced field → fall through
    // to auto-pick. The manifest is not broken, it's just overspecified
    // relative to the run output.
  }

  const actionSpec = findAction(app, action);
  const outputs = actionSpec?.outputs ?? [];
  const auto = autoPick(outputs, runOutput);
  if (auto) {
    return { kind: 'auto', element: auto };
  }

  // Layer 3b: runtime-shape heuristics. This is what keeps
  // OpenAPI-ingested apps out of the JSON-dump fallback.
  const shape = shapePick(runOutput, { appSlug, runId });
  if (shape) {
    return { kind: 'shape', element: shape };
  }

  return { kind: 'fallback', element: null };
}

// Exported purely so the stress test harness can exercise the helper
// without mounting a full component tree.
export const __test__ = { autoPick, resolveRenderProps, shapePick };
