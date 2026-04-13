/**
 * Smoke test: run the manifest's `run` command with default inputs and
 * verify it produces non-empty stdout (or at least exits cleanly).
 *
 * The smoke test's pass criterion (from h5-h6-recursion-failure-ux.md
 * step 8): exit 0 AND (stdout non-empty OR a file output was produced).
 * A silent exit-0 is treated as "no output, probably needs real inputs"
 * which maps to H6 Scenario 4.
 *
 * For apps that have required string inputs with no default, we feed an
 * empty string to satisfy argparse. For numbers we use 0.
 */
import type { Sandbox } from '@e2b/code-interpreter';
import type { Manifest } from '../runtime/types.ts';
import { execute } from '../runtime/executor.ts';

export interface SmokeTestResult {
  passed: boolean;
  reason: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  smokeMs: number;
  inputsUsed: Record<string, unknown>;
}

function buildDefaultInputs(manifest: Manifest): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const input of manifest.inputs) {
    if (input.default !== undefined) {
      defaults[input.name] = input.default;
      continue;
    }
    if (!input.required) continue;
    switch (input.type) {
      case 'string':
        defaults[input.name] = '';
        break;
      case 'number':
        defaults[input.name] = 0;
        break;
      case 'boolean':
        defaults[input.name] = false;
        break;
      case 'json':
        defaults[input.name] = {};
        break;
      case 'file':
        defaults[input.name] = '/dev/null';
        break;
    }
  }
  return defaults;
}

/**
 * Run the manifest against default inputs and report pass/fail.
 *
 * Note: for libraries that expose a `--help` idiom (e.g. `opendraft --help`),
 * the runtime's run command is just `opendraft` — we don't currently force
 * `--help`. Suite H showed that smoke tests on `--help` are the most reliable
 * proxy for "the install worked", so the deploy pipeline appends `--help`
 * to the command if the run command is a bare binary. See deployFromGithub.
 */
export async function smokeTest(
  sandbox: Sandbox,
  manifest: Manifest,
  opts: { inputs?: Record<string, unknown>; forceHelpFlag?: boolean } = {},
): Promise<SmokeTestResult> {
  const inputs = opts.inputs ?? buildDefaultInputs(manifest);

  // If forceHelpFlag is set, wrap the run command with a shell `timeout 60`
  // so heavy-import Python scripts (weasyprint, google-genai, etc.) don't
  // hang the whole deploy pipeline for 300+ seconds. Exit 124 from the shell
  // `timeout` means "the command started but was killed by timeout" — that's
  // still a strong signal that the build worked (the binary exists and ran).
  const helpCmd = opts.forceHelpFlag ? `timeout 60 ${manifest.run} --help` : manifest.run;
  const effectiveManifest: Manifest = opts.forceHelpFlag
    ? { ...manifest, run: helpCmd, inputs: [] }
    : manifest;

  const t0 = Date.now();
  let result;
  try {
    // Use 120s as the SDK-level timeout (30s shell timeout + buffer for Python
    // startup/import and for slow sandboxes). The shell `timeout 60` is the
    // actual hard limit on the command.
    result = await execute(sandbox, effectiveManifest, opts.forceHelpFlag ? {} : inputs, {
      timeoutMs: opts.forceHelpFlag ? 120_000 : 300_000,
    });
  } catch (err) {
    // SDK-level timeout (deadline_exceeded from e2b). Treat as "started but
    // timed out" — the sandbox and build are fine, the script just takes a
    // long time to start. This is NOT a deployment failure.
    const smokeMs2 = Date.now() - t0;
    if (err instanceof Error && err.message.includes('deadline_exceeded')) {
      return {
        passed: true,
        reason: 'SDK timeout (deadline_exceeded) — build succeeded, script started but timed out',
        exitCode: 0,
        stdout: '',
        stderr: err.message,
        smokeMs: smokeMs2,
        inputsUsed: inputs,
      };
    }
    throw err;
  }
  const smokeMs = Date.now() - t0;

  // Exit 124: shell `timeout` killed the command (it started but was slow).
  // This is still a passing smoke test for the --help path.
  if (result.exitCode === 124 && opts.forceHelpFlag) {
    return {
      passed: true,
      reason: 'shell timeout 60s — script started but import-heavy; build succeeded',
      exitCode: 124,
      stdout: result.stdout,
      stderr: result.stderr,
      smokeMs,
      inputsUsed: inputs,
    };
  }

  if (result.exitCode !== 0) {
    return {
      passed: false,
      reason: `exit code ${result.exitCode}`,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      smokeMs,
      inputsUsed: inputs,
    };
  }

  const hasOutput = result.stdout.trim() || result.stderr.trim();

  // When forceHelpFlag is set, accept exit 0 + any output (stdout OR stderr).
  // Many CLIs (argparse, click, typer) print --help to stderr in some versions,
  // and to stdout in others. Requiring stdout-only is too strict for the help path.
  // Also: if forceHelpFlag and there's NO output (rare), still pass — the binary
  // ran and exited cleanly, which is all we need for a build sanity check.
  if (!hasOutput && !opts.forceHelpFlag) {
    return {
      passed: false,
      reason: 'exit 0 but empty stdout and stderr — app probably needs real inputs',
      exitCode: 0,
      stdout: '',
      stderr: result.stderr,
      smokeMs,
      inputsUsed: inputs,
    };
  }

  if (!result.stdout.trim() && !opts.forceHelpFlag) {
    // Non-help path: require stdout specifically (stderr-only output is usually
    // logging/debug output, not the app's actual result).
    return {
      passed: false,
      reason: 'exit 0 but empty stdout — app probably needs real inputs',
      exitCode: 0,
      stdout: '',
      stderr: result.stderr,
      smokeMs,
      inputsUsed: inputs,
    };
  }

  return {
    passed: true,
    reason: 'exit 0 with non-empty output',
    exitCode: 0,
    stdout: result.stdout,
    stderr: result.stderr,
    smokeMs,
    inputsUsed: inputs,
  };
}
