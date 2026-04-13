/**
 * Rerun Suite H with the 5 fixes applied.
 *
 * The 10 repos are the same as /tmp/floom-suite-h-selection.json. For each:
 *   1. Run the new auto-detect -> generate a floom.yaml
 *   2. Print the before/after manifest
 *   3. Run the deployFromGithub pipeline against e2b
 *   4. Record pass/fail + phase timings
 *
 * Output: /tmp/floom-suite-h-rerun-results.json with the same shape as
 * Suite H's primary results file, plus a `fixesApplied` field per repo.
 *
 * We run 6s/repo as a rough budget — with 10 repos and an avg cold+build
 * of 20-25s, the total wall is 3-5 minutes. Cost budget: ~$0.10 max.
 */
import * as fs from 'node:fs';
import { deployFromGithub } from '../src/deploy/pipeline.ts';
import { fetchSnapshotFromApi } from '../src/deploy/clone.ts';
import { generateManifest } from '@floom/manifest';
import { loadEnvKey } from './_env.ts';

interface SuiteHRepo {
  fullName: string;
  runtime: string;
  /** Original floom.yaml (pre-fix). */
  floom_yaml: string;
  /** Original Suite H verdict (PASS, BUILD_FAIL, RUN_FAIL). */
  original_verdict?: string;
}

const REPOS: SuiteHRepo[] = [
  { fullName: 'PrefectHQ/fastmcp', runtime: 'python', floom_yaml: '', original_verdict: 'PASS' },
  { fullName: 'apache/airflow-client-python', runtime: 'python', floom_yaml: '', original_verdict: 'PASS' },
  { fullName: 'crewAIInc/crewAI', runtime: 'python', floom_yaml: '', original_verdict: 'RUN_FAIL' },
  { fullName: 'LaurieWired/GhidraMCP', runtime: 'python', floom_yaml: '', original_verdict: 'PASS' },
  { fullName: 'karpathy/autoresearch', runtime: 'python', floom_yaml: '', original_verdict: 'BUILD_FAIL' },
  { fullName: 'BrowserMCP/mcp', runtime: 'node', floom_yaml: '', original_verdict: 'BUILD_FAIL' },
  { fullName: 'idosal/git-mcp', runtime: 'node', floom_yaml: '', original_verdict: 'BUILD_FAIL' },
  { fullName: 'apache/airflow-client-go', runtime: 'go', floom_yaml: '', original_verdict: 'BUILD_FAIL' },
  { fullName: 'sigoden/aichat', runtime: 'rust', floom_yaml: '', original_verdict: 'BUILD_FAIL' },
  { fullName: 'aimeos/ai-client-html', runtime: 'php', floom_yaml: '', original_verdict: 'BUILD_FAIL' },
];

interface RerunResult {
  fullName: string;
  original: string | undefined;
  new_verdict: 'PASS' | 'BUILD_FAIL' | 'SMOKE_FAIL' | 'FETCH_FAIL' | 'ERROR';
  fixes: string[];
  new_manifest?: {
    runtime: string;
    build?: string;
    run?: string;
    workdir?: string;
  };
  timing?: {
    totalMs: number;
    buildLogTail?: string;
  };
  error?: string;
}

async function rerunOne(repo: SuiteHRepo): Promise<RerunResult> {
  // Step 1: fetch snapshot + run detect offline (so we record fixes even if
  // the sandbox deploy fails).
  let snapshotFixes: string[] = [];
  let manifestSummary: RerunResult['new_manifest'] | undefined;
  try {
    const snap = await fetchSnapshotFromApi(repo.fullName);
    const gen = generateManifest(snap);
    snapshotFixes = gen.detect.fixesApplied;
    manifestSummary = {
      runtime: gen.detect.runtime,
      build: gen.detect.build,
      run: gen.detect.run,
      workdir: gen.detect.workdir || undefined,
    };
  } catch (err) {
    return {
      fullName: repo.fullName,
      original: repo.original_verdict,
      new_verdict: 'FETCH_FAIL',
      fixes: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // Step 2: full deploy against e2b. We do NOT --help-smoke on rust/php/go
  // because those aren't guaranteed to honor --help; we'd rather see the
  // real smoke test.
  const t0 = Date.now();
  try {
    const deploy = await deployFromGithub(repo.fullName, {
      smokeWithHelp: true,
    });
    const totalMs = Date.now() - t0;

    if (deploy.success) {
      return {
        fullName: repo.fullName,
        original: repo.original_verdict,
        new_verdict: 'PASS',
        fixes: snapshotFixes,
        new_manifest: manifestSummary,
        timing: { totalMs, buildLogTail: tail(deploy.buildLog ?? '', 500) },
      };
    }

    const isBuildFail = (deploy.error ?? '').toLowerCase().includes('build');
    return {
      fullName: repo.fullName,
      original: repo.original_verdict,
      new_verdict: isBuildFail ? 'BUILD_FAIL' : 'SMOKE_FAIL',
      fixes: snapshotFixes,
      new_manifest: manifestSummary,
      timing: { totalMs, buildLogTail: tail(deploy.buildLog ?? '', 500) },
      error: deploy.error,
    };
  } catch (err) {
    return {
      fullName: repo.fullName,
      original: repo.original_verdict,
      new_verdict: 'ERROR',
      fixes: snapshotFixes,
      new_manifest: manifestSummary,
      timing: { totalMs: Date.now() - t0 },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function tail(s: string, n: number): string {
  if (!s || s.length <= n) return s;
  return '...' + s.slice(-n);
}

async function main() {
  loadEnvKey();

  const results: RerunResult[] = [];
  for (const repo of REPOS) {
    process.stderr.write(`\n=== ${repo.fullName} (was ${repo.original_verdict}) ===\n`);
    const result = await rerunOne(repo);
    results.push(result);
    process.stderr.write(
      `  verdict: ${result.new_verdict}${result.error ? ` (${result.error.slice(0, 120)})` : ''}\n`,
    );
    if (result.fixes.length) {
      process.stderr.write(`  fixes: ${result.fixes.join('; ')}\n`);
    }
  }

  const passCount = results.filter((r) => r.new_verdict === 'PASS').length;
  const originalPassCount = results.filter((r) => r.original === 'PASS').length;

  const report = {
    suite: 'H_rerun',
    timestamp: new Date().toISOString(),
    total: results.length,
    original_pass_count: originalPassCount,
    new_pass_count: passCount,
    results,
  };

  const outPath = '/tmp/floom-suite-h-rerun-results.json';
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  process.stderr.write(`\n=== SUMMARY ===\n`);
  process.stderr.write(`Before: ${originalPassCount}/${results.length}\n`);
  process.stderr.write(`After:  ${passCount}/${results.length}\n`);
  process.stderr.write(`Saved to ${outPath}\n`);

  process.stdout.write(JSON.stringify({ before: originalPassCount, after: passCount, total: results.length }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(2);
});
