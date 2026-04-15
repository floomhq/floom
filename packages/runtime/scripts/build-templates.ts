/**
 * Build pre-baked templates for the top Floom apps.
 *
 * Reads a simple list of repos, deploys each one, and writes a
 * `templates.json` mapping slug -> templateId. The Floom backend can then
 * load this file at boot and use it as the warm-start cache.
 *
 * This is the "pre-bake snapshots for the top 10-20 most-used apps"
 * recommendation from h2-full-tests.md Suite G.
 *
 * Usage:
 *   tsx scripts/build-templates.ts              # uses built-in TOP_APPS
 *   tsx scripts/build-templates.ts foo/bar      # one-off
 *   tsx scripts/build-templates.ts --file apps.txt   # one repo per line
 */
import * as fs from 'node:fs';
import { deployFromGithub } from '../src/deploy/pipeline.ts';
import { loadEnvKey } from './_env.ts';

const TOP_APPS: string[] = [
  'federicodeponte/opendraft',
  'PrefectHQ/fastmcp',
  'LaurieWired/GhidraMCP',
];

async function main() {
  loadEnvKey();

  const args = process.argv.slice(2);
  let repos: string[];
  if (args.length === 0) {
    repos = TOP_APPS;
  } else if (args[0] === '--file') {
    const file = args[1];
    if (!file) throw new Error('--file requires a path');
    repos = fs.readFileSync(file, 'utf-8').split('\n').map((s) => s.trim()).filter(Boolean);
  } else {
    repos = args;
  }

  const registry: Record<string, { templateId: string; deployedAt: string }> = {};

  for (const repo of repos) {
    process.stderr.write(`\n=== building template for ${repo} ===\n`);
    const result = await deployFromGithub(repo);
    if (result.success && result.templateId) {
      registry[repo] = {
        templateId: result.templateId,
        deployedAt: new Date().toISOString(),
      };
      process.stderr.write(`  templateId=${result.templateId}\n`);
    } else {
      process.stderr.write(`  FAILED: ${result.error}\n`);
    }
  }

  const outPath = '/opt/floom-e2b-runtime/templates.json';
  fs.writeFileSync(outPath, JSON.stringify(registry, null, 2));
  process.stderr.write(`\nSaved ${Object.keys(registry).length}/${repos.length} templates to ${outPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(2);
});
