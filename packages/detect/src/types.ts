/**
 * Runtime type — the set of runtimes that Floom's auto-detect can identify.
 * This lives in @floom/detect (the lowest-level package) so that both
 * @floom/manifest and @floom/runtime can import it without circular deps.
 */
export type Runtime =
  | 'python3.12'
  | 'python3.11'
  | 'node20'
  | 'node22'
  | 'go1.22'
  | 'rust'
  | 'docker'
  | 'auto';
