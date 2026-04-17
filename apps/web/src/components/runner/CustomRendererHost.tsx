// W2.2 custom renderer host — lazy-loads /renderer/:slug/bundle.js and
// mounts its default export. Falls back to `children` (the default
// OutputPanel tree) if the bundle fails to load, throws at mount time, or
// is missing.
//
// The bundle is compiled by apps/server/src/services/renderer-bundler.ts
// with `react`, `react-dom`, and `@floom/renderer` externalized, so we
// import it via dynamic import and pass it the default React instance.

import {
  Component,
  Suspense,
  lazy,
  useMemo,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import type { RunRecord } from '../../lib/types';

interface Props {
  slug: string;
  run: RunRecord;
  sourceHash?: string | null;
  children: ReactNode;
}

interface CreatorRenderProps {
  data: unknown;
  schema?: unknown;
  status?: string;
  app?: { slug: string };
}

type CreatorComponent = ComponentType<CreatorRenderProps>;

/**
 * Dynamically import the compiled bundle. We cache the import per
 * (slug, hash) pair so a recompile (new hash) busts the cache without the
 * page having to reload.
 */
const bundleCache = new Map<string, Promise<{ default: CreatorComponent }>>();

function loadBundle(slug: string, hash: string | null | undefined): Promise<{ default: CreatorComponent }> {
  const key = `${slug}@${hash || 'head'}`;
  const cached = bundleCache.get(key);
  if (cached) return cached;
  const bust = hash ? `?v=${hash}` : '';
  const url = `/renderer/${encodeURIComponent(slug)}/bundle.js${bust}`;
  const promise = import(/* @vite-ignore */ url) as Promise<{ default: CreatorComponent }>;
  // Invalidate cache on failure so a retry can re-fetch.
  promise.catch(() => bundleCache.delete(key));
  bundleCache.set(key, promise);
  return promise;
}

export function CustomRendererHost({ slug, run, sourceHash, children }: Props) {
  // Only attempt the custom renderer on successful runs. For errors the
  // built-in ErrorCard is better than a creator's renderer which may or
  // may not handle an error shape.
  const ok = run.status === 'success';
  const LazyRenderer = useMemo(
    () =>
      ok
        ? lazy(async () => {
            const mod = await loadBundle(slug, sourceHash);
            return { default: mod.default };
          })
        : null,
    [slug, sourceHash, ok],
  );

  if (!LazyRenderer) return <>{children}</>;

  return (
    <RendererBoundary fallback={<>{children}</>}>
      <Suspense fallback={<>{children}</>}>
        <LazyRenderer data={run.outputs} status={run.status} app={{ slug }} />
      </Suspense>
    </RendererBoundary>
  );
}

interface BoundaryState {
  errored: boolean;
}

class RendererBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, BoundaryState> {
  state: BoundaryState = { errored: false };

  static getDerivedStateFromError(): BoundaryState {
    return { errored: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[custom-renderer] crashed, falling back to default output panel', error, info);
  }

  render(): ReactNode {
    if (this.state.errored) return <>{this.props.fallback}</>;
    return <>{this.props.children}</>;
  }
}
