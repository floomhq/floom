/**
 * Public detect entry point.
 *
 * Imports the main rules module and re-exports a clean API:
 *   import { detect } from './detect';
 *   const result = detect(repoSnapshot);
 */
export { detect } from './rules.ts';
export type { DetectResult, RepoSnapshot } from './rules.ts';
export type { Runtime } from './types.ts';
export type { FileEntry } from './workdir.ts';
export { detectWorkdir } from './workdir.ts';
export { detectPnpm } from './pnpm-detect.ts';
export { detectUv } from './uv-detect.ts';
export { detectSrcLayout } from './src-layout.ts';
export { detectPhpExtensions, EXT_TO_APT } from './php-ext.ts';
