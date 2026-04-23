// HTTP proxy runtime adapter wrapper.
//
// Thin shim around `services/proxied-runner.ts runProxied` so that the
// existing HTTP-proxy runtime satisfies the `RuntimeAdapter` interface
// declared in `adapters/types.ts`. Behavior is unchanged from the live
// dispatch path in `services/runner.ts runProxiedWorker`.
//
// Selected by the factory when `FLOOM_RUNTIME=proxy`. This knob is
// deliberately coarse — the reference server still picks runtime per-app
// at dispatch time based on `app.app_type` ('docker' | 'proxied'). The
// env-var choice here is about "which adapter is wired at the factory
// level", not "which runtime every app runs under". Once the main
// dispatch path migrates to `adapters.runtime.execute`, this adapter
// becomes the explicit implementation for proxy apps.

import type { AppRecord, NormalizedManifest, SessionContext } from '../types.js';
import type { RuntimeAdapter, RuntimeResult } from './types.js';
import { runProxied } from '../services/proxied-runner.js';

export const proxyRuntimeAdapter: RuntimeAdapter = {
  async execute(
    app: AppRecord,
    manifest: NormalizedManifest,
    action: string,
    inputs: Record<string, unknown>,
    secrets: Record<string, string>,
    _ctx: SessionContext,
    _onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<RuntimeResult> {
    const result = await runProxied({
      app,
      manifest,
      action,
      inputs,
      secrets,
    });
    return {
      status: result.status,
      outputs: result.outputs,
      error: result.error,
      error_type: result.error_type,
      upstream_status: result.upstream_status,
      duration_ms: result.duration_ms,
      logs: result.logs,
    };
  },
};
