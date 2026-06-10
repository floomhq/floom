/**
 * Worker manifest (worker.yml) edit helpers — the correctness-critical logic
 * for mutating a worker's `contexts` (Brain) and `connections` (Tools) blocks.
 *
 * Extracted from app/workers/[id]/page.tsx so BOTH the deep editor and the
 * Collection split-pane editor mutate worker.yml through ONE source of truth.
 * A wrong edit here can emit an invalid worker.yml that breaks the worker, so
 * this module is pure and unit-tested.
 */
import { dump as dumpYaml } from "js-yaml";
import type {
  WorkerContextSpec,
  WorkerConnectionSpec,
  WorkerComposioConnection,
} from "@/lib/types";

export function contextSpecName(spec: WorkerContextSpec): string {
  if (typeof spec === "string") return spec;
  return spec.name;
}

export function contextSpecWritable(spec: WorkerContextSpec): boolean {
  return typeof spec === "object" && spec.writeable === true;
}

export function connectionSpecApp(spec: WorkerConnectionSpec): string | null {
  if (typeof spec === "string") return spec;
  if ("composio" in spec && spec.composio?.app) return spec.composio.app;
  if ("app" in spec && spec.app) return spec.app;
  return null;
}

export function connectionSpecAllowedTools(spec: WorkerConnectionSpec): string[] | null {
  if (typeof spec === "string") return null;
  if ("composio" in spec && spec.composio?.allowed_tools?.length) {
    return spec.composio.allowed_tools;
  }
  if ("app" in spec && spec.allowed_tools?.length) {
    return spec.allowed_tools;
  }
  return null;
}

/** Replace a top-level `key:` block in a worker.yml string (append if absent). */
export function replaceTopLevelYamlBlock(yaml: string, key: string, replacement: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*(?:$|\\[)`).test(line));
  if (start === -1) return `${yaml.trimEnd()}\n\n${replacement}\n`;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z_][\w_-]*:\s*/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...replacement.split("\n"), ...lines.slice(end)].join("\n");
}

export function patchBrainContexts(yaml: string, contexts: WorkerContextSpec[]): string {
  const block = dumpYaml(
    { contexts: contexts.length > 0 ? contexts : [] },
    { noRefs: true, lineWidth: -1, sortKeys: false },
  ).trimEnd();
  return replaceTopLevelYamlBlock(yaml, "contexts", block);
}

/** Mirror of patchBrainContexts for the connections block. */
export function patchWorkerConnections(yaml: string, connections: WorkerConnectionSpec[]): string {
  const block = dumpYaml(
    { connections: connections.length > 0 ? connections : [] },
    { noRefs: true, lineWidth: -1, sortKeys: false },
  ).trimEnd();
  return replaceTopLevelYamlBlock(yaml, "connections", block);
}

/**
 * Set (or clear) a worker context's read/write flag, returning a new list.
 * `writeable=false` collapses back to the bare-string (read-only) form.
 */
export function setContextWriteable(
  contexts: WorkerContextSpec[],
  name: string,
  writeable: boolean,
): WorkerContextSpec[] {
  return contexts.map((spec): WorkerContextSpec => {
    if (contextSpecName(spec) !== name) return spec;
    if (!writeable) return name; // read-only = bare string
    const source = typeof spec === "object" ? spec.source : undefined;
    return source ? { name, writeable: true, source } : { name, writeable: true };
  });
}

export function toggleContext(
  contexts: WorkerContextSpec[],
  name: string,
): WorkerContextSpec[] {
  const present = contexts.some((spec) => contextSpecName(spec) === name);
  return present
    ? contexts.filter((spec) => contextSpecName(spec) !== name)
    : [...contexts, name];
}

/**
 * Produce a new connections list where the Composio entry for `slug` has its
 * allowlist set to `tools`, or cleared when `tools` is null.
 *
 * Empty-allowlist semantics (backend declared_composio_connections + the
 * composio_execute gate): `allowed_tools` absent (null) means FULL app access;
 * an explicit list — INCLUDING [] — RESTRICTS to exactly that set (empty blocks
 * everything). So clearing the restriction MUST drop the key (tools === null),
 * never emit [].
 */
export function setComposioAllowlist(
  connections: WorkerConnectionSpec[],
  slug: string,
  tools: string[] | null,
): WorkerConnectionSpec[] {
  const slugKey = slug.toLowerCase();
  let matched = false;
  const next = connections.map((spec): WorkerConnectionSpec => {
    const specApp = connectionSpecApp(spec);
    if (!specApp || specApp.toLowerCase() !== slugKey) return spec;
    matched = true;
    const existingComposio =
      typeof spec === "object" && "composio" in spec ? spec.composio : undefined;
    const base: WorkerComposioConnection = {
      ...(existingComposio ?? {}),
      app: existingComposio?.app ?? specApp,
    };
    if (tools && tools.length > 0) {
      base.allowed_tools = tools;
    } else {
      delete base.allowed_tools;
    }
    return { composio: base };
  });
  if (!matched) return connections;
  return next;
}

/** Add a bare-slug connection if not already declared (case-insensitive). */
export function addConnection(
  connections: WorkerConnectionSpec[],
  slug: string,
): WorkerConnectionSpec[] {
  const key = slug.trim().toLowerCase();
  if (!key) return connections;
  if (connections.some((spec) => (connectionSpecApp(spec) || "").toLowerCase() === key)) {
    return connections;
  }
  return [...connections, key];
}

/** Remove a connection by app slug (case-insensitive). */
export function removeConnection(
  connections: WorkerConnectionSpec[],
  slug: string,
): WorkerConnectionSpec[] {
  const key = slug.toLowerCase();
  return connections.filter((spec) => (connectionSpecApp(spec) || "").toLowerCase() !== key);
}
