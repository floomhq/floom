/**
 * Suite H fix #1: pnpm workspace protocol detection.
 *
 * BrowserMCP/mcp failed because its package.json has `workspace:*` in a dep
 * version, which is a pnpm-specific syntax. `npm install` errors with
 * `Unsupported URL Type "workspace:"`.
 *
 * Rule: if package.json (anywhere in the tree, but typically at workdir)
 * contains `workspace:` in ANY dep version, or has a top-level `workspaces`
 * array, the package manager is pnpm. We flip the build command accordingly.
 *
 * Secondary signal: presence of `pnpm-lock.yaml` or `pnpm-workspace.yaml`.
 * Either alone is enough.
 */

export interface PnpmDetectInput {
  /** package.json contents, parsed or raw. */
  packageJsonRaw?: string;
  /** Sibling files in the same directory. */
  siblingFiles?: string[];
}

export interface PnpmDetectResult {
  isPnpmWorkspace: boolean;
  reason: string;
}

export function detectPnpm(input: PnpmDetectInput): PnpmDetectResult {
  const siblings = new Set(input.siblingFiles ?? []);

  if (siblings.has('pnpm-lock.yaml')) {
    return { isPnpmWorkspace: true, reason: 'pnpm-lock.yaml present' };
  }
  if (siblings.has('pnpm-workspace.yaml')) {
    return { isPnpmWorkspace: true, reason: 'pnpm-workspace.yaml present' };
  }

  const raw = input.packageJsonRaw;
  if (!raw) {
    return { isPnpmWorkspace: false, reason: 'no package.json' };
  }

  // Cheap syntactic check first — avoids a full JSON parse if there's no
  // chance of a match.
  if (!raw.includes('workspace:')) {
    // Still need to check for a top-level "workspaces" array, which is also
    // a strong pnpm/yarn workspaces signal.
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && 'workspaces' in parsed) {
        return { isPnpmWorkspace: true, reason: 'top-level "workspaces" field' };
      }
    } catch {
      // fall through
    }
    return { isPnpmWorkspace: false, reason: 'no workspace markers' };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const depFields = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    for (const field of depFields) {
      const deps = parsed[field];
      if (!deps || typeof deps !== 'object') continue;
      for (const version of Object.values(deps as Record<string, unknown>)) {
        if (typeof version === 'string' && version.startsWith('workspace:')) {
          return { isPnpmWorkspace: true, reason: `${field} uses workspace: protocol` };
        }
      }
    }
  } catch {
    // If package.json is malformed, trust the substring match — the SUbstring
    // only appears in workspace:* contexts in practice.
    return {
      isPnpmWorkspace: true,
      reason: 'package.json is malformed but contains "workspace:"',
    };
  }

  return { isPnpmWorkspace: false, reason: 'no workspace: deps' };
}
