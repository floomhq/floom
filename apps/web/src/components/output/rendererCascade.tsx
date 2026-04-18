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
// Layer 4 — `null`, which signals "fall through to the caller's default"
// (currently the legacy inline renderer in OutputPanel.tsx, which keeps
// PR #7 polish intact).
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
import { Markdown } from './Markdown';
import { TextBig } from './TextBig';

type AnyProps = Record<string, unknown>;
type LibraryComponent = (props: AnyProps) => ReactElement | null;

export const OUTPUT_LIBRARY: Record<string, LibraryComponent> = {
  TextBig: TextBig as unknown as LibraryComponent,
  CodeBlock: CodeBlock as unknown as LibraryComponent,
  Markdown: Markdown as unknown as LibraryComponent,
  FileDownload: FileDownload as unknown as LibraryComponent,
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
 * Resolve a RenderConfig against a concrete run output. Any `*_field`
 * key is replaced with its plucked string value. Other keys pass
 * through. Returns `null` if a required field could not be resolved.
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
      const value = pluckString(runOutput, raw);
      if (value === undefined) {
        // Missing the referenced field — bail out so the caller can
        // fall through to the next cascade layer instead of rendering
        // an empty card.
        return null;
      }
      props[targetKey] = value;
    } else {
      props[key] = raw;
    }
  }
  return props;
}

interface CascadeArgs {
  app: Pick<AppDetail, 'manifest'>;
  action?: string;
  runOutput: unknown;
}

export interface CascadeResult {
  kind: 'library' | 'auto' | 'fallback';
  element: ReactElement | null;
}

const MARKDOWN_FIELD_NAMES = ['markdown', 'summary', 'report', 'article'];

function findAction(app: Pick<AppDetail, 'manifest'>, actionKey?: string): ActionSpec | undefined {
  const actions = app.manifest?.actions;
  if (!actions) return undefined;
  if (actionKey && actions[actionKey]) return actions[actionKey];
  // Fall back to the first defined action so pages that do not yet
  // track the invoked action key still render something sensible.
  const first = Object.values(actions)[0];
  return first;
}

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

/**
 * Pick a component to mount for this run. Returns `{kind:'fallback',
 * element: null}` to signal the caller should render its pre-v16
 * default (keeps PR #7 polish intact for apps that have not opted in).
 */
export function pickRenderer({ app, action, runOutput }: CascadeArgs): CascadeResult {
  const render = app.manifest?.render;
  if (render && typeof render.output_component === 'string') {
    const Component = OUTPUT_LIBRARY[render.output_component];
    if (Component) {
      const resolved = resolveRenderProps(render, runOutput);
      if (resolved) {
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

  return { kind: 'fallback', element: null };
}

// Exported purely so the stress test harness can exercise the helper
// without mounting a full component tree.
export const __test__ = { autoPick, resolveRenderProps };
