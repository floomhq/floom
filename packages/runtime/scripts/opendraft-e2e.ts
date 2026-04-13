/**
 * End-to-end proof for OpenDraft via the NEW runtime.
 *
 * Replicates the Suite A OpenDraft row but through the full public
 * deployFromGithub + runApp pipeline:
 *
 *   1. deployFromGithub('federicodeponte/opendraft') -> templateId
 *   2. runApp(manifest, { topic: ... }, secrets, stream) -> captured output
 *   3. Save log to tests/opendraft-e2e.log
 *
 * This is the smoke test for the whole package. If this works end-to-end
 * against the real e2b API with real timing, the architecture holds.
 */
import * as fs from 'node:fs';
import { deployFromGithub, runApp } from '../src/runtime/index.ts';
import { loadEnvKey } from './_env.ts';

async function main() {
  loadEnvKey();

  const logPath = '/opt/floom-e2b-runtime/tests/opendraft-e2e.log';
  fs.mkdirSync('/opt/floom-e2b-runtime/tests', { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: 'w' });
  const log = (s: string) => {
    process.stderr.write(s);
    logStream.write(s);
  };
  const endLog = (code: number) =>
    new Promise<void>((resolve) => {
      logStream.end(() => {
        resolve();
        process.exit(code);
      });
    });

  log(`=== OpenDraft e2e via new runtime ===\n`);
  log(`timestamp: ${new Date().toISOString()}\n\n`);

  // Phase 1: deploy
  log(`[phase1] deployFromGithub federicodeponte/opendraft\n`);
  const t0 = Date.now();
  const deploy = await deployFromGithub('federicodeponte/opendraft', {
    smokeWithHelp: true,
    onStream: (chunk) => log(chunk),
  });
  const deployMs = Date.now() - t0;
  log(`\n[phase1] completed in ${deployMs}ms, success=${deploy.success}\n`);

  if (!deploy.success || !deploy.manifest || !deploy.templateId) {
    log(`\nDEPLOY FAILED: ${deploy.error}\n`);
    if (deploy.buildLog) log(`\nbuild log tail:\n${deploy.buildLog}\n`);
    if (deploy.draftManifest) log(`\ndraft manifest:\n${deploy.draftManifest}\n`);
    if (deploy.smokeTestOutput) log(`\nsmoke output:\n${deploy.smokeTestOutput}\n`);
    await endLog(1);
    return;
  }

  log(`\n[phase1] manifest:\n${JSON.stringify(deploy.manifest, null, 2)}\n`);
  log(`[phase1] templateId: ${deploy.templateId}\n`);

  // Phase 2: runApp with real inputs. OpenDraft's main command doesn't need
  // real inputs to produce output — `opendraft --help` is what the smoke
  // test already ran. For a more realistic proof, we run the bare binary
  // (which prints its usage banner to stdout on stderr). We use the warm
  // templateId from phase 1.
  log(`\n[phase2] runApp warm path via templateId\n`);
  const manifest = deploy.manifest;
  // Force the run command to `--help` since OpenDraft's main entry needs
  // real inputs + a Google API key, and we just want to prove the warm path.
  const warmManifest = { ...manifest, run: `${manifest.run} --help` };

  const t1 = Date.now();
  let streamed = '';
  const runResult = await runApp(
    warmManifest,
    {}, // no inputs — --help ignores them
    {}, // no secrets
    (chunk) => {
      streamed += chunk;
      process.stderr.write(chunk);
    },
    { reuseSandboxId: deploy.templateId },
  );
  const warmMs = Date.now() - t1;

  log(`\n[phase2] completed in ${warmMs}ms\n`);
  log(`[phase2] timing: ${JSON.stringify(runResult.timingMs)}\n`);
  log(`[phase2] exitCode: ${runResult.exitCode}\n`);
  log(`[phase2] output bytes: ${runResult.output.length}\n`);
  log(`[phase2] streamed bytes: ${streamed.length}\n`);
  log(`[phase2] new sandboxId: ${runResult.sandboxId}\n`);

  // Save a summary JSON next to the log
  const summaryPath = '/opt/floom-e2b-runtime/tests/opendraft-e2e.json';
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        deploy: {
          success: deploy.success,
          totalMs: deployMs,
          manifest: deploy.manifest,
          templateId: deploy.templateId,
        },
        warmRun: {
          exitCode: runResult.exitCode,
          timing: runResult.timingMs,
          outputBytes: runResult.output.length,
          outputHead: runResult.output.slice(0, 500),
          sandboxId: runResult.sandboxId,
        },
      },
      null,
      2,
    ),
  );

  log(`\n[summary] saved to ${summaryPath}\n`);
  log(`[summary] total test wall time: ${Date.now() - t0}ms\n`);

  const ok = deploy.success && runResult.exitCode === 0;
  await endLog(ok ? 0 : 1);
}

main().catch((err) => {
  const msg = `fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`;
  process.stderr.write(msg);
  // Try to append to log file if it exists
  try {
    const logPath = '/opt/floom-e2b-runtime/tests/opendraft-e2e.log';
    if (fs.existsSync(logPath)) {
      fs.appendFileSync(logPath, msg);
    }
  } catch { /* ignore */ }
  process.exit(2);
});
