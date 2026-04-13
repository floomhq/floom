/**
 * CLI: end-to-end deploy from a GitHub repo.
 *
 *   tsx scripts/deploy-github.ts <owner/repo> [--branch main] [--no-help-smoke]
 *
 * Outputs a JSON blob on stdout with:
 *   - success: boolean
 *   - manifest: the full auto-detected or user-overridden manifest
 *   - templateId: the paused sandbox id for later runApp calls (if success)
 *   - smokeTestOutput: the smoke test's stdout (if success)
 *   - error, draftManifest, buildLog: on failure
 *
 * Stderr carries the logger output (JSON lines).
 */
import { deployFromGithub } from '../src/deploy/pipeline.ts';
import { loadEnvKey } from './_env.ts';

function parseArgs(argv: string[]): { repo: string; branch?: string; smokeWithHelp: boolean } {
  const positional: string[] = [];
  let branch: string | undefined;
  let smokeWithHelp = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--branch') branch = argv[++i];
    else if (a === '--no-help-smoke') smokeWithHelp = false;
    else positional.push(a);
  }
  if (positional.length === 0) {
    throw new Error('usage: tsx scripts/deploy-github.ts <owner/repo> [--branch main] [--no-help-smoke]');
  }
  return { repo: positional[0]!, branch, smokeWithHelp };
}

async function main() {
  loadEnvKey();
  const { repo, branch, smokeWithHelp } = parseArgs(process.argv.slice(2));

  process.stderr.write(`[deploy] ${repo}${branch ? `@${branch}` : ''}\n`);
  const result = await deployFromGithub(repo, {
    branch,
    smokeWithHelp,
    onStream: (chunk) => process.stderr.write(chunk),
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(2);
});
